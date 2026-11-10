// networkStatus(): is devnet up, is it the chain we think it is, and can the numbers be trusted.
//
// Rules (RULES.md section 1):
// - Unknown is null. Health "unknown" is never shown as "ok".
// - Health is "ok" only when every check ran and passed (section 1.1).
// - reset_detected is false only when the faucet and the RPC both report the pinned genesis.
//   Any source with a different genesis makes it true. Not enough evidence makes it null.
// - Disagreements between sources go in `conflicts`, in plain words.
import type { FaucetHealthBody, Health, HttpResult, NetworkStatus, RpcHead, ServiceStatus } from "./types.js";
import type { Source } from "./source.js";

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
  /** The previous snapshot's finalized head on the same chain, to catch rollbacks and stalls. */
  previous?: { genesis: string; finalized_height: number; finalized_hash: string; observed_at: string } | null;
}

/** A 0x + 64 hex hash in lower case, or null when absent or malformed. */
export function normalizeHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase();
  return HASH_RE.test(v) ? v : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

// RULES.md 1.1: a time must carry its zone (Z or an offset). Date.parse would read a time without
// one in the machine's own zone, so the same input could be fresh on one machine and stale on
// another.
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Milliseconds since the epoch for an ISO 8601 time with a zone, or null. */
export function parseZoned(t: unknown): number | null {
  if (typeof t !== "string" || !ZONED.test(t)) return null;
  const v = Date.parse(t);
  return Number.isFinite(v) ? v : null;
}

function secondsBetween(earlier: unknown, later: unknown): number | null {
  const a = parseZoned(earlier);
  const b = parseZoned(later);
  return a !== null && b !== null ? (b - a) / 1000 : null;
}

export function classifyFaucet(r: HttpResult<FaucetHealthBody>): NetworkStatus["faucet"] {
  const body = r.body && typeof r.body === "object" ? r.body : null;
  const ready = body && typeof body.ready === "boolean" ? body.ready : null;
  const limits =
    body && body.limits && typeof body.limits === "object" && !Array.isArray(body.limits) ? body.limits : null;
  let health: Health;
  let detail: string | null;
  if (r.http === null) {
    health = "unknown";
    detail = r.error ?? "no response";
  } else if (!body) {
    health = r.http >= 500 ? "down" : "unknown";
    detail = `http ${r.http} with no readable body`;
  } else if (body.status === "ok" && ready === true) {
    // A body that says ok on an error status is not ok: the HTTP status wins.
    if (r.http === 200) {
      health = "ok";
      detail = null;
    } else {
      health = "degraded";
      detail = `body says ok but http ${r.http}`;
    }
  } else if (body.status === "degraded" || body.status === "down" || ready === false) {
    health = body.status === "down" ? "down" : "degraded";
    detail = `status ${String(body.status ?? "missing")}, ready ${String(ready)}, http ${r.http}`;
  } else {
    health = "unknown";
    detail = `unrecognized health body, http ${r.http}`;
  }
  return { health, http: r.http, detail, observed_at: r.fetched_at, ready, limits };
}

export function classifyGateway(r: HttpResult<unknown>): ServiceStatus {
  let health: Health;
  let detail: string | null = null;
  if (r.http === null) {
    health = "unknown";
    detail = r.error ?? "no response";
  } else if (r.http === 200) {
    health = "ok";
  } else if (r.http === 429 || r.http === 503) {
    health = "degraded";
    detail = `http ${r.http}`;
  } else if (r.http >= 500) {
    health = "down";
    detail = `http ${r.http}`;
  } else {
    health = "degraded";
    detail = `http ${r.http}`;
  }
  return { health, http: r.http, detail, observed_at: r.fetched_at };
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

export function classifyRpc(
  head: RpcHead,
  o: Required<Pick<StatusOptions, "now" | "staleAfterSeconds" | "maxFinalityLag">>,
  conflicts: string[],
  previous: StatusOptions["previous"],
  genesis: string | null,
): NetworkStatus["rpc"] {
  const finalized = head.finalized && nonNegativeInt(head.finalized.number) !== null && normalizeHash(head.finalized.hash)
    ? { number: head.finalized.number, hash: normalizeHash(head.finalized.hash) as string }
    : null;
  const best = nonNegativeInt(head.best_number);
  const nothing = head.genesis_hash === null && head.finalized === null && head.best_number === null;
  if (nothing) {
    return {
      health: head.error ? "down" : "unknown",
      http: null,
      detail: head.error ?? "no rpc head",
      observed_at: head.observed_at,
      stale: null,
    };
  }
  // A failed check makes health degraded. A check that could not run makes it unknown,
  // unless another check failed. Nothing missing is ever counted as passing.
  const problems: string[] = [];
  const cannotRun: string[] = [];
  if (head.error) problems.push(`read error: ${head.error}`);
  if (genesis === null) problems.push("no valid genesis hash");
  let stale: boolean | null = null;
  const age = secondsBetween(head.observed_at, o.now);
  if (age === null) {
    cannotRun.push(head.observed_at === null ? "no observed_at, so the head age is unknown" : "observed_at does not parse as a time with a zone, so the head age is unknown");
  } else if (age < 0) {
    conflicts.push(`rpc head observed_at ${head.observed_at} is later than the snapshot time ${o.now}`);
    problems.push("head observed_at is later than the snapshot time");
  } else {
    stale = age > o.staleAfterSeconds;
    if (stale) problems.push(`head is ${Math.round(age)}s old`);
  }
  if (previous && finalized && genesis !== null && previous.genesis === genesis) {
    if (finalized.number < previous.finalized_height) {
      conflicts.push(
        `finalized height went backwards from ${previous.finalized_height} to ${finalized.number} on the same genesis`,
      );
      problems.push("finalized height went backwards");
    } else if (finalized.number === previous.finalized_height && finalized.hash !== previous.finalized_hash) {
      conflicts.push(`finalized block ${finalized.number} changed hash since the previous snapshot`);
      problems.push("finalized block changed");
    } else if (finalized.number === previous.finalized_height) {
      const since = secondsBetween(previous.observed_at, o.now);
      if (since !== null && since > o.staleAfterSeconds) {
        stale = true;
        problems.push(`finalized height stuck at ${finalized.number} for ${Math.round(since)}s`);
      }
    }
  }
  if (finalized && best !== null) {
    if (best < finalized.number) {
      conflicts.push(`best block ${best} is below finalized block ${finalized.number}`);
      problems.push("best below finalized");
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
    observed_at: head.observed_at,
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

export async function networkStatus(source: Source, opts: StatusOptions): Promise<NetworkStatus> {
  const pinned = normalizeHash(opts.pinnedGenesis);
  if (pinned === null) throw new Error("pinnedGenesis must be 0x followed by 64 hex characters");
  if (parseZoned(opts.now) === null) throw new Error("now must be an ISO 8601 time with a zone, such as 2026-11-09T23:47:41Z");
  const o = {
    now: opts.now,
    staleAfterSeconds: opts.staleAfterSeconds ?? 120,
    maxFinalityLag: opts.maxFinalityLag ?? 30,
  };
  const [health, chain, gateway, head] = await Promise.all([
    source.faucetHealth(),
    source.faucetChain(),
    source.gatewayModels(),
    source.rpcHead(),
  ]);
  const conflicts: string[] = [];

  const rawFaucetGenesis = chain.body && typeof chain.body === "object" ? chain.body.genesisHash : undefined;
  const faucetGenesis = normalizeHash(rawFaucetGenesis);
  if (rawFaucetGenesis !== undefined && faucetGenesis === null) {
    conflicts.push("faucet /chain genesisHash is malformed");
  }
  const rpcGenesis = normalizeHash(head.genesis_hash);
  if (head.genesis_hash !== null && rpcGenesis === null) {
    conflicts.push("rpc genesis hash is malformed");
  }
  if (faucetGenesis !== null && rpcGenesis !== null && faucetGenesis !== rpcGenesis) {
    conflicts.push(`faucet genesis ${faucetGenesis} differs from rpc genesis ${rpcGenesis}`);
  }

  const rpc = classifyRpc(head, o, conflicts, opts.previous ?? null, rpcGenesis);
  const finalizedValid =
    head.finalized && nonNegativeInt(head.finalized.number) !== null && normalizeHash(head.finalized.hash) !== null;
  const finalizedHeight = finalizedValid ? (head.finalized as { number: number }).number : null;
  const finalizedHash = finalizedValid ? normalizeHash((head.finalized as { hash: string }).hash) : null;
  const bestHeight = nonNegativeInt(head.best_number);
  const lag =
    finalizedHeight !== null && bestHeight !== null && bestHeight >= finalizedHeight ? bestHeight - finalizedHeight : null;

  return {
    schema: "flop-observatory/network-status@0",
    observed_at: opts.now,
    trust: source.trust,
    genesis: { pinned, faucet: faucetGenesis, rpc: rpcGenesis },
    reset_detected: resetDetected(pinned, faucetGenesis, rpcGenesis),
    conflicts,
    finalized_height: finalizedHeight,
    finalized_hash: finalizedHash,
    best_height: bestHeight,
    finality_lag: lag,
    runtime_version: nonNegativeInt(head.runtime_spec_version),
    rpc,
    gateway: applyFreshness(classifyGateway(gateway), "gateway", o, conflicts),
    faucet: applyFreshness(classifyFaucet(health), "faucet", o, conflicts),
  };
}
