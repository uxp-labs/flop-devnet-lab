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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CensusRefused, census } from "./census.js";
import { DriftSpecError, drift } from "./drift.js";
import { escrowStates } from "./escrow.js";
import { writeFeeds } from "./feed.js";
import { renderPage } from "./page.js";
import { buildSnapshot } from "./snapshot.js";
import { FixtureSource } from "./source.js";
import { DEVNET_GENESIS, networkStatus } from "./status.js";
import { appendSnapshot, hashSnapshot } from "./store.js";
import type { Snapshot } from "./types.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Args = { _: string[]; flags: Map<string, string[]> };

function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`);
      const list = out.flags.get(a) ?? [];
      list.push(v as string);
      out.flags.set(a, list);
      i++;
    } else out._.push(a);
  }
  return out;
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
  if (!/^\d+$/.test(s)) fail(`${k} must be a non-negative integer`);
  return Number(s);
};

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd) fail("usage: flop-observatory <status|escrow|census|drift|snapshot> ...");

  if (cmd === "status") {
    const src = FixtureSource.fromDir(need(a, "--fixtures"));
    print(await networkStatus(src, { pinnedGenesis: src.data.meta.pinned_genesis ?? DEVNET_GENESIS, now: one(a, "--now") ?? src.data.meta.now }));
    return;
  }

  if (cmd === "escrow") {
    const src = FixtureSource.fromDir(need(a, "--fixtures"));
    const ids = a.flags.get("--id") ?? src.data.meta.escrow_ids ?? fail("no --id and no escrow_ids in meta.json");
    print(
      escrowStates(ids, await src.eventPages(), {
        pinnedGenesis: src.data.meta.pinned_genesis ?? DEVNET_GENESIS,
        finalizedHeight: null,
        observedAt: one(a, "--now") ?? src.data.meta.now,
        trust: src.trust,
      }),
    );
    return;
  }

  if (cmd === "census") {
    const src = FixtureSource.fromDir(need(a, "--fixtures"));
    const meta = src.data.meta;
    const from = int(one(a, "--from"), "--from") ?? meta.census_request?.from_block;
    const to = int(one(a, "--to"), "--to") ?? meta.census_request?.to_block;
    if (from === undefined || to === undefined) fail("no --from/--to and no census_request in meta.json");
    print(
      runCensus(await src.eventPages(), {
        pinnedGenesis: one(a, "--genesis") ?? meta.pinned_genesis ?? DEVNET_GENESIS,
        requested: { from_block: from, to_block: to },
        observedAt: one(a, "--now") ?? meta.now,
        trust: src.trust,
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
    let escrows = null;
    if (escrowDir) {
      const src = FixtureSource.fromDir(escrowDir);
      escrows = { source: src, ids: src.data.meta.escrow_ids ?? fail(`${escrowDir}/meta.json has no escrow_ids`) };
    }
    let censusPart = null;
    if (censusDir) {
      const src = FixtureSource.fromDir(censusDir);
      const req = src.data.meta.census_request ?? fail(`${censusDir}/meta.json has no census_request`);
      censusPart = {
        label: src.label,
        report: runCensus(await src.eventPages(), {
          pinnedGenesis: src.data.meta.pinned_genesis ?? pinned,
          requested: req,
          observedAt: now,
          trust: src.trust,
        }),
      };
    }
    let driftPart = null;
    if (driftDir) {
      driftPart = { label: `fixture:${FixtureSource.fromDir(driftDir).data.meta.scenario}`, report: await driftFor(driftDir, one(a, "--spec"), now) };
    }
    const fresh = await buildSnapshot(
      { status, escrows, census: censusPart, drift: driftPart },
      { pinnedGenesis: pinned, now, sourceSha: one(a, "--source-sha") ?? null },
    );
    const log = one(a, "--log");
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
    writeFileSync(join(out, "pin.json"), JSON.stringify(snap.pin, null, 2) + "\n");
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
