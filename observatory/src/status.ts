// networkStatus(): is devnet up, is it the chain we think it is, and can the numbers be trusted.
//
// Rules (RULES.md section 1):
// - Unknown is null. Health "unknown" is never shown as "ok".
// - Health is "ok" only when every check ran and passed (section 1.1).
// - reset_detected is false only when the faucet and the RPC both report the pinned genesis, from
//   usable readings, and the RPC's finalized height is known not to be stuck. Any usable source
//   with a different genesis makes it true. Not enough evidence makes it null.
// - Disagreements between sources go in `conflicts`, in plain words.
import type { FaucetHealthBody, Health, HttpResult, NetworkStatus, RpcHead, ServiceStatus } from "./types.js";
import type { Source } from "./source.js";
import { isSafeInt, parseZoned, secondsBetween } from "./strict.js";

/**
 * FLOP devnet genesis, as pinned by imd-flop (imd-flop/src/networks.ts) and read from
 * faucet.flop.network/chain on 2026-11-09. A test checks the two pins stay equal.
 */
export const DEVNET_GENESIS = "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631";

const HASH_RE = /^0x[0-9a-f]{64}$/;

export interface StatusOptions {
  pinnedGenesis: string;
  /** Snapshot time (ISO 8601). Passed in so reruns are identical. */
  now: string;
  /** An RPC head older than this many seconds is stale. Default 120. */
  staleAfterSeconds?: number;
  /** A finalized head this many blocks behind best is degraded. Default 30. */
  maxFinalityLag?: number;
  /**
   * Finalized heads from earlier snapshots, oldest first, to catch rollbacks, changed hashes and
   * stalls. Only those on the same genesis as this reading count (RULES.md 1.1). One head or a list.
   */
  previous?: PreviousHead | readonly PreviousHead[] | null;
  /**
   * The snapshot time of every earlier snapshot in the log, oldest first, whatever it read. One
   * later than this snapshot's time means the log runs backwards (RULES.md 1.1).
   */
  earlierTimes?: readonly (string | null)[] | null;
  /**
   * The best height every earlier snapshot in the log read, with its RPC genesis, oldest first,
   * whether or not it also read a finalized head (RULES.md 1.1: a best height that falls further
   * than the lag limit on the same genesis).
   */
  earlierBest?: readonly EarlierBest[] | null;
}

/** One earlier snapshot's runtime version and the RPC genesis it read it on (RULES.md 1.1, the spec floor). */
export interface EarlierSpec {
  genesis: string;
  runtime_version: number;
}

/**
 * The anchor (RULES.md 1.1): the latest finalized head an earlier snapshot logged on the pinned
 * genesis. A live run reads the block hash at its height back and compares it with this hash.
 */
export interface Anchor {
  height: number;
  hash: string;
}

/** One earlier snapshot's best height and the RPC genesis it read it on. */
export interface EarlierBest {
  genesis: string;
  best_height: number;
}

/** One earlier snapshot's finalized head, as its status recorded it. Its time may be null. */
export interface PreviousHead {
  genesis: string;
  finalized_height: number;
  finalized_hash: string;
  observed_at: string | null;
}

/**
 * A 0x + 64 hex hash written in lower case, or null when absent or malformed. Hashes are compared
 * exactly as written, as census clause 5 and section 2 say, so another spelling is malformed.
 */
export function normalizeHash(value: unknown): string | null {
  return typeof value === "string" && HASH_RE.test(value) ? value : null;
}

/** Any error value at all, an empty string included, is an error (RULES.md 1.1). */
function hasError(e: unknown): boolean {
  return e !== null && e !== undefined;
}

/**
 * A reading's error. A reading with no error key at all does not say whether it failed, so it
 * counts as a failed one (RULES.md 1.1).
 */
export function errorOf(r: unknown): unknown {
  return r !== null && typeof r === "object" && "error" in r ? (r as { error: unknown }).error : "the reading has no error field";
}

/** A reading time as given when it is a string, else null: the interface carries strings only. */
function timeField(t: unknown): string | null {
  return typeof t === "string" ? t : null;
}

/** An HTTP status that is a whole number, else null. */
function httpField(h: unknown): number | null {
  return isSafeInt(h) ? h : null;
}

/**
 * Why a reading has no HTTP status to judge, or null when it has one: no response (its read error
 * when it gives one), or a status that is not a whole number, said as such and never as the value
 * it holds (third IMD audit J9). The faucet, the gateway and the /chain reading all read it so.
 */
function noStatus(r: HttpResult<unknown>): string | null {
  if (r.http === null) return hasError(errorOf(r)) ? String(errorOf(r)) : "no response";
  return httpField(r.http) === null ? "http status is not a whole number" : null;
}

/**
 * The head as the status reads it: every field the interface names, one the reading left out as
 * null, as a reading that read nothing writes it (RULES.md 1.1), so a missing key is never taken
 * for a value that failed a check (third IMD audit J5). Its error is kept as given, or left out,
 * since a reading with no error key counts as a failed one. A head that is not an object read
 * nothing, and says so.
 */
function headOf(raw: unknown): RpcHead {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { genesis_hash: null, finalized: null, best_number: null, runtime_spec_version: null, observed_at: null, error: null, unreadable: "the rpc head is not an object" };
  }
  const r = raw as Partial<Record<keyof RpcHead, unknown>>;
  return {
    genesis_hash: r.genesis_hash ?? null,
    finalized: r.finalized ?? null,
    best_number: r.best_number ?? null,
    runtime_spec_version: r.runtime_spec_version ?? null,
    observed_at: r.observed_at ?? null,
    ...("error" in r ? { error: r.error } : {}),
    ...(typeof r.unreadable === "string" ? { unreadable: r.unreadable } : {}),
  } as RpcHead;
}

/** A safe integer (clause 14, src/strict.ts) that is not negative, or null. */
function nonNegativeInt(value: unknown): number | null {
  return isSafeInt(value) && value >= 0 ? value : null;
}

// Times and their ages: shared strict parsing (src/strict.ts), RULES.md 1.1.
export { parseZoned } from "./strict.js";

/** A 5xx status, the server's own failure (RULES.md 1.1); 600 and up are no such thing. */
const serverError = (http: number): boolean => http >= 500 && http <= 599;

export function classifyFaucet(r: HttpResult<FaucetHealthBody>): NetworkStatus["faucet"] {
  const body = r.body && typeof r.body === "object" ? r.body : null;
  const ready = body && typeof body.ready === "boolean" ? body.ready : null;
  // The interface carries numbers and booleans in limits; any other value voids them all.
  const rawLimits = body && body.limits && typeof body.limits === "object" && !Array.isArray(body.limits) ? body.limits : null;
  const limits =
    rawLimits && Object.values(rawLimits).every((v) => typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) ? rawLimits : null;
  const http = httpField(r.http);
  let health: Health;
  let detail: string | null;
  if (http === null) {
    health = "unknown";
    detail = noStatus(r);
  } else if (!body) {
    health = serverError(http) ? "down" : "unknown";
    detail = `http ${http} with no readable body`;
  } else if (body.status === "ok" && ready === true) {
    // A body that says ok on an error status is not ok: the HTTP status wins.
    if (http === 200) {
      health = "ok";
      detail = null;
    } else {
      health = "degraded";
      detail = `body says ok but http ${http}`;
    }
  } else if (body.status === "degraded" || body.status === "down" || ready === false) {
    health = body.status === "down" ? "down" : "degraded";
    detail = `status ${String(body.status ?? "missing")}, ready ${String(ready)}, http ${http}`;
  } else {
    health = "unknown";
    detail = `unrecognized health body, http ${http}`;
  }
  // A reading that came with an error is a failed read, never ok (RULES.md 1.1).
  if (http !== null && hasError(errorOf(r))) {
    if (health === "ok") health = "degraded";
    detail = [detail, `read error: ${String(errorOf(r))}`].filter((d) => d !== null).join("; ");
  }
  return { health, http, detail, observed_at: timeField(r.fetched_at), ready, limits };
}

export function classifyGateway(r: HttpResult<unknown>): ServiceStatus {
  const http = httpField(r.http);
  let health: Health;
  let detail: string | null = null;
  if (http === null) {
    health = "unknown";
    detail = noStatus(r);
  } else if (http === 200) {
    health = "ok";
  } else if (http === 429 || http === 503) {
    health = "degraded";
    detail = `http ${http}`;
  } else if (serverError(http)) {
    health = "down";
    detail = `http ${http}`;
  } else {
    health = "degraded";
    detail = `http ${http}`;
  }
  // A reading that came with an error is a failed read, never ok (RULES.md 1.1).
  if (http !== null && hasError(errorOf(r))) {
    if (health === "ok") health = "degraded";
    detail = [detail, `read error: ${String(errorOf(r))}`].filter((d) => d !== null).join("; ");
  }
  return { health, http, detail, observed_at: timeField(r.fetched_at) };
}

/**
 * RULES.md 1.1, faucet and gateway freshness: an ok reading stays ok only when its time parses,
 * is not later than the snapshot time, and is at most the stale limit old.
 */
export function applyFreshness<T extends ServiceStatus>(
  svc: T,
  name: string,
  o: { now: string; staleAfterSeconds: number },
  conflicts: string[],
): T {
  const age = secondsBetween(svc.observed_at, o.now);
  // A reading from the future is a conflict whatever its health; it only lowers an ok.
  if (age !== null && age < 0) {
    conflicts.push(`${name} reading time ${String(svc.observed_at)} is later than the snapshot time ${o.now}`);
    return svc.health === "ok" ? { ...svc, health: "degraded", detail: `${name} reading time is later than the snapshot time` } : svc;
  }
  if (svc.health !== "ok") return svc;
  if (age === null) {
    return { ...svc, health: "unknown", detail: `no parsable reading time, so the ${name} reading's age is unknown` };
  }
  if (age > o.staleAfterSeconds) {
    return { ...svc, health: "degraded", detail: `${name} reading is ${Math.round(age)}s old` };
  }
  return svc;
}

/**
 * What classifyRpc finds about a head beyond its health. contradicted: it contradicts itself or an
 * earlier snapshot. stuck: its finalized height has not moved for longer than the stale limit
 * (true), moved or is new to the log (false), or could not be checked, since an earlier head time
 * at this height does not parse (null).
 */
export interface HeadFlags {
  contradicted: boolean;
  stuck: boolean | null;
}

export function classifyRpc(
  head: RpcHead,
  o: Required<Pick<StatusOptions, "now" | "staleAfterSeconds" | "maxFinalityLag">>,
  conflicts: string[],
  previous: StatusOptions["previous"],
  genesis: string | null,
  /** What the checks found beyond health: see HeadFlags. */
  flags: HeadFlags = { contradicted: false, stuck: false },
  earlierTimes: StatusOptions["earlierTimes"] = null,
  earlierBest: StatusOptions["earlierBest"] = null,
): NetworkStatus["rpc"] {
  // Every earlier head on this genesis counts, in log order, so a snapshot in between with no RPC
  // reading (or one on another genesis) cannot hide a rollback.
  const earlier = (previous === null || previous === undefined ? [] : Array.isArray(previous) ? previous : [previous]) as readonly PreviousHead[];
  const sameGenesis = genesis === null ? [] : earlier.filter((p) => p.genesis === genesis);
  const finalized = head.finalized && nonNegativeInt(head.finalized.number) !== null && normalizeHash(head.finalized.hash)
    ? { number: head.finalized.number, hash: normalizeHash(head.finalized.hash) as string }
    : null;
  const best = nonNegativeInt(head.best_number);
  const nothing = head.genesis_hash === null && head.finalized === null && head.best_number === null;
  const age = secondsBetween(head.observed_at, o.now);
  const error = errorOf(head);
  if (age !== null && age < 0) {
    // A reading time later than the snapshot time is a conflict whatever the reading holds.
    conflicts.push(`rpc head observed_at ${String(head.observed_at)} is later than the snapshot time ${o.now}`);
    flags.contradicted = true;
  }
  // A log that runs backwards: an earlier snapshot taken, or an earlier head read, later than this
  // snapshot's time. Checked whatever this head holds, so a snapshot with no reading still sees it.
  let backwards = false;
  for (const t of earlierTimes ?? []) {
    const d = secondsBetween(t, o.now);
    if (d !== null && d < 0) {
      conflicts.push(`an earlier snapshot was taken at ${String(t)}, later than this snapshot time ${o.now}`);
      backwards = true;
      break;
    }
  }
  if (!backwards) {
    for (const p of earlier) {
      const t = secondsBetween(p.observed_at, o.now);
      if (t !== null && t < 0) {
        conflicts.push(`an earlier snapshot read the rpc head at ${String(p.observed_at)}, later than this snapshot time ${o.now}`);
        backwards = true;
        break;
      }
    }
  }
  if (backwards) flags.contradicted = true;
  if (nothing) {
    return {
      health: hasError(error) ? "down" : "unknown",
      http: null,
      detail: hasError(error) ? String(error) : typeof head.unreadable === "string" ? head.unreadable : "no rpc head",
      observed_at: timeField(head.observed_at),
      stale: null,
    };
  }
  // A failed check makes health degraded. A check that could not run makes it unknown,
  // unless another check failed. Nothing missing is ever counted as passing.
  const problems: string[] = [];
  const cannotRun: string[] = [];
  if (hasError(error)) problems.push(`read error: ${String(error)}`);
  if (genesis === null) problems.push("no valid genesis hash");
  let stale: boolean | null = null;
  if (age === null) {
    cannotRun.push(head.observed_at === null ? "no observed_at, so the head age is unknown" : "observed_at does not parse as a time with a zone, so the head age is unknown");
  } else if (age < 0) {
    problems.push("head observed_at is later than the snapshot time");
  } else {
    stale = age > o.staleAfterSeconds;
    if (stale) problems.push(`head is ${Math.round(age)}s old`);
  }
  if (backwards) problems.push("an earlier snapshot is later than this one");
  // Finality never goes back: the highest finalized height any earlier snapshot saw on this
  // genesis is the floor, for this head's finalized height and for its best height alike. A head
  // whose best height is below the floor contradicts history even when it has no finalized head
  // (a chain restarted from the same spec keeps its genesis and starts again near block 0).
  // A fold, not one call with every height as an argument, which throws past about 120,000 of them.
  const highest = sameGenesis.length > 0 ? sameGenesis.reduce((m, p) => Math.max(m, p.finalized_height), -Infinity) : null;
  // With a valid finalized head, a best height under the floor is already a rollback or best below
  // finalized; this catches the head that has no valid finalized head at all.
  if (highest !== null && best !== null && best < highest && finalized === null) {
    conflicts.push(`best block ${best} is below the finalized height ${highest} an earlier snapshot saw on this genesis`);
    problems.push("best height is below an earlier finalized height");
    flags.contradicted = true;
  }
  // Every earlier best height is a floor too, less the lag limit (round 8 review L1): a
  // reorganisation undoes only blocks that are not final, and a healthy head has at most the lag
  // limit of them, so a best height that falls further on the same genesis is a restart, a node
  // still syncing or a rollback. It counts whether or not either head read a finalized head, so a
  // restart after a finality stall is seen too (round 10 review L4). That fails closed: after a
  // stall, a reorganisation that drops a long fork leaves the head unusable until the best height
  // is back within the lag limit of the highest one seen (round 9 review L5).
  const bestSeen = genesis === null ? [] : (earlierBest ?? []).filter((p) => p.genesis === genesis).map((p) => p.best_height);
  const highestBest = bestSeen.length > 0 ? bestSeen.reduce((m, h) => Math.max(m, h), -Infinity) : null;
  if (highestBest !== null && best !== null && best < highestBest - o.maxFinalityLag) {
    conflicts.push(`best block ${best} is more than ${o.maxFinalityLag} blocks below the best block ${highestBest} an earlier snapshot saw on this genesis`);
    problems.push("best height fell further than the lag limit below an earlier best height");
    flags.contradicted = true;
  }
  if (finalized && highest !== null) {
    const changed = sameGenesis.find((p) => p.finalized_height === finalized.number && p.finalized_hash !== finalized.hash);
    // Stuck since the oldest of the latest run of snapshots at this same height. A time there that
    // does not parse means the check cannot run.
    let since: number | null = null;
    let sinceUnknown = false;
    for (let i = sameGenesis.length - 1; i >= 0 && (sameGenesis.at(i) as PreviousHead).finalized_height === finalized.number; i--) {
      since = secondsBetween((sameGenesis.at(i) as PreviousHead).observed_at, o.now);
      if (since === null) sinceUnknown = true;
    }
    if (finalized.number < highest) {
      conflicts.push(`finalized height went backwards from ${highest} to ${finalized.number} on the same genesis`);
      problems.push("finalized height went backwards");
      flags.contradicted = true;
    } else if (changed) {
      conflicts.push(`finalized block ${finalized.number} changed hash since the previous snapshot`);
      problems.push("finalized block changed");
      flags.contradicted = true;
    }
    // Whether the height is stuck is asked of every head, one that rolled back or changed hash too
    // (eleventh rerun): rpc.stale says how long the run at this height has held, whatever else the
    // head contradicts.
    if (sinceUnknown) {
      flags.stuck = null;
      // Whether the height is stuck is unknown, so a fresh head is no longer known not to be stale
      // (RULES.md 1.1, tenth rerun U2): a gate that waits for stale false waits here too.
      if (stale === false) stale = null;
      cannotRun.push("an earlier snapshot at this finalized height has a head time that does not parse, so whether the height is stuck is unknown");
    } else if (since !== null && since > o.staleAfterSeconds) {
      stale = true;
      flags.stuck = true;
      problems.push(`finalized height stuck at ${finalized.number} for ${Math.round(since)}s`);
    }
  }
  if (finalized && best !== null) {
    if (best < finalized.number) {
      conflicts.push(`best block ${best} is below finalized block ${finalized.number}`);
      problems.push("best below finalized");
      flags.contradicted = true;
    } else if (best - finalized.number > o.maxFinalityLag) {
      problems.push(`finality lag ${best - finalized.number} blocks`);
    }
  }
  if (finalized === null) problems.push("no valid finalized head");
  if (best === null) problems.push("no valid best height");
  const health: Health = problems.length > 0 ? "degraded" : cannotRun.length > 0 ? "unknown" : "ok";
  const notes = [...problems, ...cannotRun];
  return {
    health,
    http: null,
    detail: notes.length ? notes.join("; ") : null,
    observed_at: timeField(head.observed_at),
    stale,
  };
}

/**
 * true when any source reports a genesis other than the pinned one; false only when both
 * the faucet and the RPC report the pinned genesis; null when there is not enough evidence.
 */
export function resetDetected(pinned: string, faucet: string | null, rpc: string | null): boolean | null {
  const known = [faucet, rpc].filter((g): g is string => g !== null);
  if (known.some((g) => g !== pinned)) return true;
  if (faucet !== null && rpc !== null) return false;
  return null;
}

/**
 * A head reading fit to count toward reset_detected and to bound escrow evidence: no read error,
 * and a reading time that parses, is not later than the snapshot time and is at most the stale
 * limit old (RULES.md 1.1 and section 2).
 */
export function rpcHeadUsable(head: RpcHead, now: string, staleAfterSeconds = 120): boolean {
  const age = secondsBetween(head.observed_at, now);
  return !hasError(errorOf(head)) && age !== null && age >= 0 && age <= staleAfterSeconds;
}

/** The faucet's detail also says why its /chain reading does not count, so that reason shows somewhere. */
function withChainNote(faucet: NetworkStatus["faucet"], why: string | null): NetworkStatus["faucet"] {
  if (why === null) return faucet;
  const note = `the /chain reading does not count: ${why}`;
  return { ...faucet, detail: faucet.detail === null ? note : `${faucet.detail}; ${note}` };
}

export async function networkStatus(source: Source, opts: StatusOptions): Promise<NetworkStatus> {
  return (await assessNetwork(source, opts)).status;
}

/**
 * The status, and whether its RPC head is usable: no read error, a fresh head time that is not
 * later than the snapshot, a valid finalized head and best height (so every check against them
 * ran), and no contradiction of itself or of an earlier snapshot (a rollback, a changed finalized
 * hash, a best height below finalized or below an earlier finalized height, a log that runs
 * backwards). Only a usable head counts toward reset_detected, and only a usable head on the
 * pinned genesis bounds escrow evidence.
 */
export async function assessNetwork(source: Source, opts: StatusOptions): Promise<{ status: NetworkStatus; rpcUsable: boolean }> {
  const pinned = normalizeHash(opts.pinnedGenesis);
  if (pinned === null) throw new Error("pinnedGenesis must be 0x followed by 64 lower case hex characters");
  if (parseZoned(opts.now) === null) throw new Error("now must be an ISO 8601 time with a zone, such as 2026-11-09T23:47:41Z");
  const o = {
    now: opts.now,
    staleAfterSeconds: opts.staleAfterSeconds ?? 120,
    maxFinalityLag: opts.maxFinalityLag ?? 30,
  };
  const [health, chain, gateway, rawHead] = await Promise.all([
    source.faucetHealth(),
    source.faucetChain(),
    source.gatewayModels(),
    source.rpcHead(),
  ]);
  const head = headOf(rawHead);
  const conflicts: string[] = [];

  // RULES.md 1.1: the faucet genesis counts toward reset_detected only from a usable /chain
  // reading: HTTP 200, no error, and a reading time that parses, is not later than the snapshot
  // time and is fresh. genesis.faucet still shows what any reading said, as genesis.rpc does, and a
  // reading that names another genesis is a conflict even when it does not count.
  const chainAge = secondsBetween(chain.fetched_at, o.now);
  if (chainAge !== null && chainAge < 0) {
    conflicts.push(`faucet /chain reading time ${String(chain.fetched_at)} is later than the snapshot time ${o.now}`);
  }
  const chainError = errorOf(chain);
  const chainUnusable =
    noStatus(chain) ??
    (chain.http !== 200
      ? `http ${String(chain.http)}`
      : hasError(chainError)
        ? `read error: ${String(chainError)}`
        : chainAge === null
          ? "no parsable reading time"
          : chainAge < 0
            ? "reading time later than the snapshot time"
            : chainAge > o.staleAfterSeconds
              ? `reading is ${Math.round(chainAge)}s old`
              : null);
  const chainUsable = chainUnusable === null;
  const rawFaucetGenesis = chain.body && typeof chain.body === "object" ? chain.body.genesisHash : undefined;
  const shownFaucetGenesis = normalizeHash(rawFaucetGenesis);
  if (rawFaucetGenesis !== undefined && shownFaucetGenesis === null) {
    conflicts.push("faucet /chain genesisHash is malformed");
  }
  const faucetGenesis = chainUsable ? shownFaucetGenesis : null;
  // A usable reading that names no genesis, or a malformed one, gives reset_detected nothing to
  // go on, so the faucet's detail says why (round 8 review L2).
  const chainNote =
    chainUnusable ?? (shownFaucetGenesis !== null ? null : rawFaucetGenesis === undefined ? "it names no genesisHash" : "its genesisHash is malformed");
  if (!chainUsable && shownFaucetGenesis !== null && shownFaucetGenesis !== pinned) {
    conflicts.push(`faucet /chain reading that does not count (${chainUnusable}) reports genesis ${shownFaucetGenesis}, not the pinned genesis`);
  }
  const rpcGenesis = normalizeHash(head.genesis_hash);
  if (head.genesis_hash !== null && rpcGenesis === null) {
    conflicts.push("rpc genesis hash is malformed");
  }
  // RULES.md 1.1: the RPC genesis counts toward reset_detected only from a usable head reading,
  // the same gate as the faucet /chain. genesis.rpc still shows what the head said.
  const fresh = rpcHeadUsable(head, o.now, o.staleAfterSeconds);
  if (shownFaucetGenesis !== null && rpcGenesis !== null && shownFaucetGenesis !== rpcGenesis) {
    conflicts.push(`faucet genesis ${shownFaucetGenesis} differs from rpc genesis ${rpcGenesis}`);
  }

  const flags: HeadFlags = { contradicted: false, stuck: false };
  const rpc = classifyRpc(head, o, conflicts, opts.previous ?? null, rpcGenesis, flags, opts.earlierTimes ?? null, opts.earlierBest ?? null);
  const finalizedValid =
    head.finalized && nonNegativeInt(head.finalized.number) !== null && normalizeHash(head.finalized.hash) !== null;
  const finalizedHeight = finalizedValid ? (head.finalized as { number: number }).number : null;
  const finalizedHash = finalizedValid ? normalizeHash((head.finalized as { hash: string }).hash) : null;
  const bestHeight = nonNegativeInt(head.best_number);
  // Every check against the finalized head and the best height must have run (RULES.md 1.1).
  const rpcUsable = fresh && !flags.contradicted && finalizedHeight !== null && bestHeight !== null;
  const lag =
    finalizedHeight !== null && bestHeight !== null && bestHeight >= finalizedHeight ? bestHeight - finalizedHeight : null;
  // RULES.md 1.1: a usable head's genesis counts toward reset_detected, and toward false only once
  // its finalized height is known not to be stuck. Unknown is never good news, so a stall, or a
  // stuck check that could not run, leaves the answer open (third IMD audit J11); another genesis
  // counts either way. The head still bounds escrow evidence: a finalized height stays final
  // however long it holds, and a lower bound only keeps more evidence waiting.
  const rpcForReset = rpcUsable && (flags.stuck === false || rpcGenesis !== pinned) ? rpcGenesis : null;

  const status: NetworkStatus = {
    schema: "flop-observatory/network-status@0",
    observed_at: opts.now,
    trust: source.trust,
    genesis: { pinned, faucet: shownFaucetGenesis, rpc: rpcGenesis },
    reset_detected: resetDetected(pinned, faucetGenesis, rpcForReset),
    conflicts,
    finalized_height: finalizedHeight,
    finalized_hash: finalizedHash,
    best_height: bestHeight,
    finality_lag: lag,
    runtime_version: nonNegativeInt(head.runtime_spec_version),
    rpc,
    gateway: applyFreshness(classifyGateway(gateway), "gateway", o, conflicts),
    faucet: withChainNote(applyFreshness(classifyFaucet(health), "faucet", o, conflicts), chainNote),
  };
  return { status, rpcUsable };
}
