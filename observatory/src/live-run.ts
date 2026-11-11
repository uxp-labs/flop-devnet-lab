// One live run of network status: read the published log, read the network once through a
// transport, write what was read and what it means into a fresh output folder, and say how the
// run ended. src/live-bin.ts hands it the network; a test hands it a tape.
//
// The published log is the log/ folder of the data branch (src/history.ts reads it). The new
// snapshot is built on every snapshot in it, so the checks against earlier snapshots in
// src/status.ts run over real history, and it follows the log's last line in one chain. A log that
// cannot be read, whose chain breaks, or that holds a line this code cannot check is refused: the
// run reads nothing from the network and writes no snapshot. It never starts a new log over it.
//
// The output folder holds, and nothing else:
//   snapshots.jsonl  the one new line of the log: the snapshot, with the seq and prev_hash that
//                    follow the log's last line (src/store.ts). It is what the publish job appends.
//   status.json, escrows.json, census.json, drift.json, snapshot.json   the feeds (src/feed.ts)
//   tape.jsonl       every request and its answer, in order (src/tape.ts)
//   run.json         when the run started and ended, the source revision if given, which case the
//                    published log was in (src/history.ts), and how the run ended
//   SHA256SUMS       the sha256 of every other file, as sha256sum writes it
//
// How a run ends (EXIT):
//   0  a truthful snapshot was written, whatever it says of each service
//   3  it was written, and it holds a reset signal: reset_detected true, or a conflict
//   4  the read only guard or the transport refused a request
//   1  the run broke before a snapshot was written, or the published log was refused
//   2  the command was given wrong flags, or an output folder that is not empty
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { feedText, writeFeeds } from "./feed.js";
import { attemptLog } from "./guard.js";
import { type History, earlierOf, readHistory, usable } from "./history.js";
import { LiveSource } from "./live-source.js";
import { buildSnapshot } from "./snapshot.js";
import { EXIT, commandText, readFlags, sumsText } from "./run-command.js";
import { DEVNET_GENESIS } from "./status.js";
import { logLine, sealSnapshot } from "./store.js";
import { Recorder } from "./tape.js";
import type { Transport } from "./transport.js";
import type { Snapshot } from "./types.js";

export const RUN_SCHEMA = "flop-observatory/live-run@1";

export interface LiveArgs {
  out: string;
  /** The published log: a folder of day files. One that does not exist is a first run. */
  log: string;
  sourceSha: string | null;
}

/**
 * The flags: --out <folder>, --log <folder> (the published log), and --source-sha <revision> when
 * known. --log is always given, so a run never forgets its history by a flag left out. Read as the command line
 * reads its own (src/cli.ts): each flag is --name followed by its value as the next argument, so
 * --name=value, an unknown flag, one given twice, an empty value or one that starts with -- and a
 * stray argument are each refused. Gives the reason as a string when refused.
 */
export function parseLiveArgs(argv: readonly string[]): LiveArgs | string {
  const got = readFlags(argv, ["--out", "--log", "--source-sha"], "live");
  if (typeof got === "string") return got;
  const out = got.get("--out");
  if (out === undefined) return "missing --out";
  const log = got.get("--log");
  if (log === undefined) return "missing --log";
  return { out, log, sourceSha: got.get("--source-sha") ?? null };
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
    seq: s.seq,
    prev_hash: s.prev_hash,
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

/** What run.json says of the published log: its case, in words, and what was read of it. */
export function historyRecord(h: History | null): { state: string; detail: string; files: number; snapshots: number; last_hash: string | null } {
  if (h === null) return { state: "not read", detail: "the run broke before the published log was read", files: 0, snapshots: 0, last_hash: null };
  return { state: h.state, detail: h.detail, files: h.files.length, snapshots: h.snapshots.length, last_hash: h.snapshots.at(-1)?.hash ?? null };
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
  let history: History | null = null;
  try {
    // The published log first: a run that cannot build on it reads nothing from the network.
    history = readHistory(o.log);
    if (usable(history)) {
      // The inputs of the checks against earlier snapshots, the anchor among them: the source reads
      // it back by its height, and the status judges what it read against the logged hash.
      const earlier = earlierOf(history.snapshots, DEVNET_GENESIS);
      const source = new LiveSource(recorder, earlier.anchor?.height ?? null);
      await source.read();
      // The snapshot time is taken once every reading is in, so no reading is later than it.
      const now = recorder.now();
      const fresh = await buildSnapshot({ status: source }, { pinnedGenesis: DEVNET_GENESIS, now, sourceSha: o.sourceSha, ...earlier });
      snapshot = sealSnapshot(fresh, history.snapshots.at(-1));
      writeFileSync(join(o.out, "snapshots.jsonl"), logLine(snapshot));
      writeFeeds(o.out, snapshot);
    }
  } catch (e) {
    broke = e instanceof Error ? e.message : String(e);
  } finally {
    recorder.close();
  }
  const refused = attemptLog().slice(before);
  const signal = snapshot === null ? null : resetSignal(snapshot);
  let code: number;
  let reason: string;
  if (history !== null && !usable(history)) {
    code = EXIT.crashed;
    reason = `the published log was refused (${history.state}), so nothing was read and no snapshot was written: ${history.detail}`;
  } else if (refused.length > 0) {
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
      history: historyRecord(history),
      snapshot_hash: snapshot?.hash ?? null,
    }),
  );
  writeFileSync(join(o.out, "SHA256SUMS"), sumsText(o.out));
  return { code, reason, snapshot, notice: snapshot === null ? null : noticeLine(snapshot) };
}
