#!/usr/bin/env node
// FLOP Observatory command line. M0 reads saved fixtures only: there is no live mode.
//
//   flop-observatory status   --fixtures <dir> [--now <iso>]
//   flop-observatory escrow   --fixtures <dir> [--id <0x..>]... [--now <iso>]
//   flop-observatory census   --fixtures <dir> [--genesis <0x..>] [--from <n> --to <n>] [--now <iso>]
//   flop-observatory drift    --fixtures <dir> [--spec <yaml>] [--now <iso>]
//   flop-observatory snapshot --status <dir> [--escrows <dir>] [--census <dir>] [--drift <dir>]
//                             --out <dir> [--log <file>] [--now <iso>] [--source-sha <sha>]
//
// JSON goes to stdout. Errors go to stderr with exit 2 for bad usage or input.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CensusRefused, census, checkRequest } from "./census.js";
import { DriftSpecError, drift } from "./drift.js";
import { escrowStates, isHash32 } from "./escrow.js";
import { feedText, writeFeeds } from "./feed.js";
import { renderPage } from "./page.js";
import { buildSnapshot } from "./snapshot.js";
import { FixtureSource } from "./source.js";
import { DEVNET_GENESIS, type EarlierBest, networkStatus, type PreviousHead } from "./status.js";
import { appendSnapshot, hashSnapshot, readSnapshots, verifyChain } from "./store.js";
import { parseZoned } from "./strict.js";
import type { Snapshot } from "./types.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The flags each command reads. A flag in many may be given more than once, any other once. */
const COMMANDS = new Map<string, { one: readonly string[]; many: readonly string[] }>([
  ["status", { one: ["--fixtures", "--now"], many: [] }],
  ["escrow", { one: ["--fixtures", "--now"], many: ["--id"] }],
  ["census", { one: ["--fixtures", "--genesis", "--from", "--to", "--now"], many: [] }],
  ["drift", { one: ["--fixtures", "--spec", "--now"], many: [] }],
  ["snapshot", { one: ["--status", "--escrows", "--census", "--drift", "--out", "--log", "--now", "--source-sha"], many: [] }],
]);

type Args = { cmd: string; flags: Map<string, string[]> };

/**
 * The command and its flags. Every flag is --name followed by its value as the next argument, so
 * --name=value, a name the command does not read, a flag given twice, a flag with no value (none
 * given, an empty one, or another flag) and an argument that is no flag's value are each refused,
 * for census as a refusal of the request. An empty value is refused because an unset shell
 * variable gives one, and it would read as the flag left out (round 9 review L3). --now must be a
 * time with a zone. tools/recount.py reads its flags by the same rules (RULES.md 3.1 clause 16).
 */
function parse(argv: readonly string[]): Args {
  const rest = [...argv];
  const cmd = rest.shift();
  const known = cmd === undefined ? undefined : COMMANDS.get(cmd);
  if (cmd === undefined || known === undefined) fail("usage: flop-observatory <status|escrow|census|drift|snapshot> ...");
  const refuse = (why: string): never => fail(cmd === "census" ? `census refused (request): ${why}` : why);
  const flags = new Map<string, string[]>();
  while (rest.length > 0) {
    const a = rest.shift() as string;
    if (!a.startsWith("--")) refuse(`${JSON.stringify(a)} is no flag's value; every argument is --name followed by its value`);
    if (a.includes("=")) refuse(`${JSON.stringify(a)}: give a flag's value as the next argument, not after =`);
    if (!known.one.includes(a) && !known.many.includes(a)) refuse(`${a} is not a flag ${cmd} reads`);
    if (flags.has(a) && !known.many.includes(a)) refuse(`${a} is given twice`);
    const v = rest.shift();
    if (v === undefined || v === "" || v.startsWith("--")) refuse(`${a} needs a value`);
    if (a === "--now" && parseZoned(v) === null) refuse(`--now must be an ISO 8601 time with a zone, such as 2026-11-09T23:47:41Z`);
    flags.set(a, [...(flags.get(a) ?? []), v as string]);
  }
  return { cmd, flags };
}

function fail(msg: string): never {
  process.stderr.write(`flop-observatory: ${msg}\n`);
  process.exit(2);
}

const one = (a: Args, k: string): string | undefined => a.flags.get(k)?.at(-1);
const need = (a: Args, k: string): string => one(a, k) ?? fail(`missing ${k}`);
const print = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
const int = (s: string | undefined, k: string): number | undefined => {
  if (s === undefined) return undefined;
  // ASCII digits only, the recount's reading too (RULES.md 3.1 clause 16): a refusal of the request.
  if (!/^[0-9]+$/.test(s)) fail(`census refused (request): ${k} must be a non-negative integer`);
  return Number(s);
};

/**
 * Escrow ids to look up, each once and each 0x plus 64 hex, the one form get_escrow_state answers
 * for (round 8 review I2), so the page, the feeds and the MCP server hold the same ids. Ids compare
 * in lower case, as escrow results show them, so the same escrow listed twice (in either case)
 * refuses rather than giving two cards with one key.
 */
function distinctIds(ids: unknown, where: string): string[] {
  if (!Array.isArray(ids) || ids.length === 0) fail(`${where}: escrow ids must be a non-empty list`);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isHash32(id)) fail(`${where}: escrow id ${JSON.stringify(id)} is not 0x plus 64 hex`);
    const k = id.toLowerCase();
    if (seen.has(k)) fail(`${where}: escrow id ${id} is listed twice`);
    seen.add(k);
  }
  return ids as string[];
}

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const cmd = a.cmd;

  if (cmd === "status") {
    const src = FixtureSource.fromDir(need(a, "--fixtures"));
    print(await networkStatus(src, { pinnedGenesis: src.data.meta.pinned_genesis ?? DEVNET_GENESIS, now: one(a, "--now") ?? src.data.meta.now }));
    return;
  }

  if (cmd === "escrow") {
    const src = FixtureSource.fromDir(need(a, "--fixtures"));
    const flagged = a.flags.get("--id");
    const ids = distinctIds(flagged ?? src.data.meta.escrow_ids ?? fail("no --id and no escrow_ids in meta.json"), flagged ? "--id" : "meta.json");
    print(
      escrowStates(ids, await src.eventPages(), {
        pinnedGenesis: src.data.meta.pinned_genesis ?? DEVNET_GENESIS,
        finalizedHeight: null,
        observedAt: one(a, "--now") ?? src.data.meta.now,
        trust: src.trust,
        unreadablePages: await src.eventPageErrors(),
      }),
    );
    return;
  }

  if (cmd === "census") {
    // RULES.md 3.1 clause 16: a request problem is named first, so a range given on the command
    // line is checked before the scenario folder is read. A folder that cannot be read, or holds no
    // readable meta.json, is an input problem, as in the recount.
    const fromFlag = int(one(a, "--from"), "--from");
    const toFlag = int(one(a, "--to"), "--to");
    if (fromFlag !== undefined && toFlag !== undefined) {
      try {
        checkRequest({ from_block: fromFlag, to_block: toFlag });
      } catch (e) {
        if (e instanceof CensusRefused) fail(e.message);
        throw e;
      }
    }
    // The folder flag left out is a request problem, as the recount's missing --dir is (clause 16).
    const dir = one(a, "--fixtures") ?? fail("census refused (request): missing --fixtures");
    let src: FixtureSource;
    try {
      src = FixtureSource.fromDir(dir);
    } catch (e) {
      fail(`census refused (input): ${(e as Error).message}`);
    }
    const meta = src.data.meta;
    const from = fromFlag ?? meta.census_request?.from_block;
    const to = toFlag ?? meta.census_request?.to_block;
    if (from === undefined || to === undefined) fail("no --from/--to and no census_request in meta.json");
    print(
      runCensus(await src.eventPages(), {
        pinnedGenesis: one(a, "--genesis") ?? meta.pinned_genesis ?? DEVNET_GENESIS,
        requested: { from_block: from, to_block: to },
        observedAt: one(a, "--now") ?? meta.now,
        trust: src.trust,
        unreadablePages: await src.eventPageErrors(),
      }),
    );
    return;
  }

  if (cmd === "drift") {
    const dir = need(a, "--fixtures");
    print(await driftFor(dir, one(a, "--spec"), one(a, "--now")));
    return;
  }

  if (cmd === "snapshot") {
    const status = FixtureSource.fromDir(need(a, "--status"));
    const out = need(a, "--out");
    const now = one(a, "--now") ?? status.data.meta.now;
    const pinned = status.data.meta.pinned_genesis ?? DEVNET_GENESIS;
    const escrowDir = one(a, "--escrows");
    const censusDir = one(a, "--census");
    const driftDir = one(a, "--drift");
    // A snapshot describes one chain: every part must be pinned to the snapshot's genesis.
    const samePin = (src: FixtureSource, dir: string): FixtureSource => {
      const g = src.data.meta.pinned_genesis;
      if (g !== undefined && g !== pinned) fail(`${dir} is pinned to genesis ${g}, but the snapshot is pinned to ${pinned}`);
      return src;
    };
    let escrows = null;
    if (escrowDir) {
      const src = samePin(FixtureSource.fromDir(escrowDir), escrowDir);
      escrows = { source: src, ids: distinctIds(src.data.meta.escrow_ids ?? fail(`${escrowDir}/meta.json has no escrow_ids`), `${escrowDir}/meta.json`) };
    }
    let censusPart = null;
    if (censusDir) {
      const src = samePin(FixtureSource.fromDir(censusDir), censusDir);
      const req = src.data.meta.census_request ?? fail(`${censusDir}/meta.json has no census_request`);
      censusPart = {
        label: src.label,
        report: runCensus(await src.eventPages(), {
          pinnedGenesis: pinned,
          requested: req,
          observedAt: now,
          trust: src.trust,
          unreadablePages: await src.eventPageErrors(),
        }),
      };
    }
    let driftPart = null;
    if (driftDir) {
      const src = samePin(FixtureSource.fromDir(driftDir), driftDir);
      driftPart = { label: `fixture:${src.data.meta.scenario}`, report: await driftFor(driftDir, one(a, "--spec"), now) };
    }
    const log = one(a, "--log");
    // RULES.md 1.1: the rollback, changed hash and stuck height checks need the earlier snapshots.
    // They come from the log, and only after the log's whole hash chain verifies. Every snapshot
    // that recorded a finalized head counts, oldest first, so one in between with no RPC reading
    // cannot hide a rollback; the status checks use those on the same genesis.
    const previous: PreviousHead[] = [];
    const earlierTimes: (string | null)[] = [];
    const earlierBest: EarlierBest[] = [];
    if (log && existsSync(log)) {
      const broken = verifyChain(log);
      if (broken !== null) fail(`snapshot log ${log} is broken at line ${broken}; it is never extended or trusted`);
      for (const { status: st, observed_at: taken } of readSnapshots(log)) {
        // Every earlier snapshot's own time, whatever it read, so a log that runs backwards shows.
        earlierTimes.push(typeof taken === "string" ? taken : null);
        // Every best height on a genesis counts, with or without a finalized head (round 8 review L1).
        if (st.genesis.rpc !== null && st.best_height !== null) earlierBest.push({ genesis: st.genesis.rpc, best_height: st.best_height });
        // A head time is needed only for the stuck check, so a snapshot without one still counts.
        if (st.genesis.rpc !== null && st.finalized_height !== null && st.finalized_hash !== null) {
          previous.push({
            genesis: st.genesis.rpc,
            finalized_height: st.finalized_height,
            finalized_hash: st.finalized_hash,
            observed_at: st.rpc.observed_at,
          });
        }
      }
    }
    const fresh = await buildSnapshot(
      { status, escrows, census: censusPart, drift: driftPart },
      { pinnedGenesis: pinned, now, sourceSha: one(a, "--source-sha") ?? null, previous, earlierTimes, earlierBest },
    );
    let snap: Snapshot;
    if (log) {
      mkdirSync(dirname(log), { recursive: true });
      snap = appendSnapshot(log, fresh);
    } else {
      const unhashed = { ...fresh, seq: 0, prev_hash: null };
      snap = { ...unhashed, hash: hashSnapshot(unhashed) };
    }
    mkdirSync(out, { recursive: true });
    writeFeeds(out, snap);
    writeFileSync(join(out, "index.html"), renderPage(snap));
    // The feed format, keys sorted, so pin.json has one spelling the output check can hold it to.
    writeFileSync(join(out, "pin.json"), feedText(snap.pin));
    print({ hash: snap.hash, seq: snap.seq, observed_at: snap.observed_at, trust: snap.trust, pin: snap.pin, out });
    return;
  }

  fail(`unknown command ${cmd}`);
}

function runCensus(pages: unknown[], opts: Parameters<typeof census>[1]) {
  try {
    return census(pages, opts);
  } catch (e) {
    if (e instanceof CensusRefused) fail(e.message);
    throw e;
  }
}

/** Drift for one fixture directory. The spec is --spec, or meta.params_spec relative to the directory. */
async function driftFor(dir: string, specPath: string | undefined, now: string | undefined) {
  const src = FixtureSource.fromDir(dir);
  const rel = specPath ?? (src.data.meta.params_spec ? resolve(dir, src.data.meta.params_spec) : undefined);
  if (!rel) fail(`no --spec and no params_spec in ${dir}/meta.json`);
  let text: string;
  try {
    text = readFileSync(rel as string, "utf8");
  } catch (e) {
    fail(`cannot read spec ${rel}: ${(e as Error).message}`);
  }
  try {
    return drift(text, await src.runtimeConstants(), {
      observedAt: now ?? src.data.meta.now,
      trust: src.trust,
      // Relative to the package, so the report is the same in any clone.
      specSource: relative(PKG, resolve(rel as string)),
    });
  } catch (e) {
    if (e instanceof DriftSpecError) fail(e.message);
    throw e;
  }
}

main().catch((e) => fail((e as Error).message));
