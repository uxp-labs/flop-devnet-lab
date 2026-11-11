// One live run of network status: read once through a transport, write what was read and what it
// means into a fresh output folder, and say how the run ended. src/live-bin.ts hands it the
// network; a test hands it a tape.
//
// The output folder holds, and nothing else:
//   snapshots.jsonl  a log of one line: the snapshot, seq 0 (src/store.ts). No run reads an
//                    earlier run's log: this step keeps no memory between runs.
//   status.json, escrows.json, census.json, drift.json, snapshot.json   the feeds (src/feed.ts)
//   tape.jsonl       every request and its answer, in order (src/tape.ts)
//   run.json         when the run started and ended, the source revision if given, and how it ended
//   SHA256SUMS       the sha256 of every other file, as sha256sum writes it
//
// How a run ends (EXIT):
//   0  a truthful snapshot was written, whatever it says of each service
//   3  it was written, and it holds a reset signal: reset_detected true, or a conflict
//   4  the read only guard or the transport refused a request
//   1  the run broke before a snapshot was written
//   2  the command was given wrong flags, or an output folder that is not empty
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { feedText, writeFeeds } from "./feed.js";
import { readRegularFile } from "./files.js";
import { attemptLog } from "./guard.js";
import { LiveSource } from "./live-source.js";
import { buildSnapshot } from "./snapshot.js";
import { DEVNET_GENESIS } from "./status.js";
import { appendSnapshot } from "./store.js";
import { Recorder } from "./tape.js";
import type { Transport } from "./transport.js";
import type { Snapshot } from "./types.js";

export const EXIT = { ok: 0, crashed: 1, usage: 2, reset: 3, refused: 4 } as const;

export const RUN_SCHEMA = "flop-observatory/live-run@0";

export interface LiveArgs {
  out: string;
  sourceSha: string | null;
}

/**
 * The flags: --out <folder>, and --source-sha <revision> when known. Read as the command line
 * reads its own (src/cli.ts): each flag is --name followed by its value as the next argument, so
 * --name=value, an unknown flag, one given twice, an empty value or one that starts with -- and a
 * stray argument are each refused. Gives the reason as a string when refused.
 */
export function parseLiveArgs(argv: readonly string[]): LiveArgs | string {
  const known = ["--out", "--source-sha"];
  const got = new Map<string, string>();
  const rest = [...argv];
  while (rest.length > 0) {
    const a = rest.shift() as string;
    if (!a.startsWith("--")) return `${JSON.stringify(a)} is no flag's value; every argument is --name followed by its value`;
    if (a.includes("=")) return `${JSON.stringify(a)}: give a flag's value as the next argument, not after =`;
    if (!known.includes(a)) return `${a} is not a flag the live command reads`;
    if (got.has(a)) return `${a} is given twice`;
    const v = rest.shift();
    if (v === undefined || v === "" || v.startsWith("--")) return `${a} needs a value`;
    got.set(a, v);
  }
  const out = got.get("--out");
  if (out === undefined) return "missing --out";
  return { out, sourceSha: got.get("--source-sha") ?? null };
}

export interface RunOptions extends LiveArgs {
  /** The clock for run.json's start and end. The snapshot's time comes from the transport. */
  clock: () => string;
}

export interface RunResult {
  code: number;
  reason: string;
  snapshot: Snapshot | null;
  /** The one line for the run log, in the GitHub Actions notice format, when a snapshot was written. */
  notice: string | null;
}

/** A value made safe for a workflow command's message: %, CR and LF escaped as GitHub reads them. */
export function commandText(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** The notice line: what the snapshot says, in one compact JSON object. */
export function noticeLine(s: Snapshot): string {
  const st = s.status;
  const line = JSON.stringify({
    trust: st.trust,
    genesis_pinned: st.genesis.pinned,
    genesis_rpc: st.genesis.rpc,
    genesis_faucet: st.genesis.faucet,
    reset_detected: st.reset_detected,
    finalized_height: st.finalized_height,
    best_height: st.best_height,
    runtime_version: st.runtime_version,
    rpc: st.rpc.health,
    faucet: st.faucet.health,
    gateway: st.gateway.health,
    snapshot_hash: s.hash,
  });
  return `::notice title=networkStatus::${commandText(line)}`;
}

/** The reset signal a snapshot holds, in words, or null: reset_detected true, or any conflict. */
export function resetSignal(s: Snapshot): string | null {
  if (s.status.reset_detected === true) return "reset_detected is true";
  const n = s.status.conflicts.length;
  if (n > 0) return `the status holds ${n} conflict${n === 1 ? "" : "s"}: ${s.status.conflicts.join("; ")}`;
  return null;
}

/** SHA256SUMS: the sha256 of every other file in the folder, sorted by name, as sha256sum writes it. */
export function sumsText(dir: string): string {
  return readdirSync(dir)
    .filter((n) => n !== "SHA256SUMS")
    .sort()
    .map((n) => `${createHash("sha256").update(readRegularFile(join(dir, n))).digest("hex")}  ${n}\n`)
    .join("");
}

export async function runLive(transport: Transport, o: RunOptions): Promise<RunResult> {
  if (existsSync(o.out) && readdirSync(o.out).length > 0) {
    transport.close();
    return { code: EXIT.usage, reason: `the output folder ${o.out} is not empty; a live run writes only into a new one`, snapshot: null, notice: null };
  }
  mkdirSync(o.out, { recursive: true });
  const startedAt = o.clock();
  const before = attemptLog().length;
  const recorder = new Recorder(transport);
  let snapshot: Snapshot | null = null;
  let broke: string | null = null;
  try {
    const source = new LiveSource(recorder);
    await source.read();
    // The snapshot time is taken once every reading is in, so no reading is later than it.
    const now = recorder.now();
    const fresh = await buildSnapshot({ status: source }, { pinnedGenesis: DEVNET_GENESIS, now, sourceSha: o.sourceSha });
    snapshot = appendSnapshot(join(o.out, "snapshots.jsonl"), fresh);
    writeFeeds(o.out, snapshot);
  } catch (e) {
    broke = e instanceof Error ? e.message : String(e);
  } finally {
    recorder.close();
  }
  const refused = attemptLog().slice(before);
  const signal = snapshot === null ? null : resetSignal(snapshot);
  let code: number;
  let reason: string;
  if (refused.length > 0) {
    code = EXIT.refused;
    reason = `refused: ${refused.map((a) => `${a.kind} ${a.what}`).join("; ")}`;
  } else if (broke !== null || snapshot === null) {
    code = EXIT.crashed;
    reason = `the run broke before a snapshot was written: ${broke ?? "no snapshot"}`;
  } else if (signal !== null) {
    code = EXIT.reset;
    reason = `reset signal: ${signal}`;
  } else {
    code = EXIT.ok;
    reason = "a truthful snapshot was written";
  }
  writeFileSync(join(o.out, "tape.jsonl"), recorder.text());
  writeFileSync(
    join(o.out, "run.json"),
    feedText({
      schema: RUN_SCHEMA,
      started_at: startedAt,
      ended_at: o.clock(),
      source_sha: o.sourceSha,
      exit_code: code,
      exit_reason: reason,
      snapshot_hash: snapshot?.hash ?? null,
    }),
  );
  writeFileSync(join(o.out, "SHA256SUMS"), sumsText(o.out));
  return { code, reason, snapshot, notice: snapshot === null ? null : noticeLine(snapshot) };
}
