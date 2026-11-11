// The earlier snapshots a new snapshot is built on (RULES.md 1.1 and section 7).
//
// earlierOf is the one owner of how a log's snapshots become the inputs the status checks against
// earlier snapshots read: previous, earlierTimes, earlierBest, earlierSpec and the anchor, the one
// earlier finalized block a live run reads back (RULES.md 1.1). The snapshot command passes it the
// snapshots of its --log file; a live run passes it the published log, read by readHistory. The
// checks themselves stay in src/status.ts.
//
// readHistory reads the published log (a folder of day files, src/store.ts readDayLog) and says
// which of these it found. Only the first three give a run something to build on:
//   absent      the folder does not exist: no earlier snapshot, a first run
//   empty       the folder holds no day file: no earlier snapshot either
//   read        every line was read, the chain verifies, and every snapshot passes the checks the
//               MCP binary holds a snapshot to (src/snapshot-check.ts)
//   unreadable  a file or a line is not what the publish job writes
//   broken      a line does not follow the one before it
//   unchecked   a line is in the chain but is no snapshot this code can check
// A refused log is never read as no log: the run writes no snapshot (src/live-run.ts).
import { checkSnapshot } from "./snapshot-check.js";
import type { Anchor, EarlierBest, EarlierSpec, PreviousHead } from "./status.js";
import { LogRefused, readDayLog } from "./store.js";
import type { Snapshot } from "./types.js";

export interface Earlier {
  previous: PreviousHead[];
  earlierTimes: (string | null)[];
  earlierBest: EarlierBest[];
  earlierSpec: EarlierSpec[];
  /** The latest finalized head logged on the pinned genesis, or null when none was. */
  anchor: Anchor | null;
}

/**
 * The inputs the checks against earlier snapshots read, from every earlier snapshot, oldest first.
 * Every snapshot that recorded a finalized head counts, so one in between with no RPC reading
 * cannot hide a rollback; the status checks use those on the same genesis. pinned is the genesis
 * the anchor must be on.
 */
export function earlierOf(snapshots: readonly Snapshot[], pinned: string): Earlier {
  const previous: PreviousHead[] = [];
  const earlierTimes: (string | null)[] = [];
  const earlierBest: EarlierBest[] = [];
  const earlierSpec: EarlierSpec[] = [];
  for (const { status: st, observed_at: taken } of snapshots) {
    // Every earlier snapshot's own time, whatever it read, so a log that runs backwards shows.
    earlierTimes.push(typeof taken === "string" ? taken : null);
    // Every best height on a genesis counts, with or without a finalized head (round 8 review L1).
    if (st.genesis.rpc !== null && st.best_height !== null) earlierBest.push({ genesis: st.genesis.rpc, best_height: st.best_height });
    // Every runtime version read on a genesis: the runtime is upgraded in place, never downgraded.
    if (st.genesis.rpc !== null && st.runtime_version !== null) earlierSpec.push({ genesis: st.genesis.rpc, runtime_version: st.runtime_version });
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
  // The anchor: the latest of those heads on the pinned genesis, read back by its height.
  const last = previous.findLast((p) => p.genesis === pinned);
  const anchor = last === undefined ? null : { height: last.finalized_height, hash: last.finalized_hash };
  return { previous, earlierTimes, earlierBest, earlierSpec, anchor };
}

export type HistoryState = "absent" | "empty" | "read" | "unreadable" | "broken" | "unchecked";

export interface History {
  state: HistoryState;
  /** What was found, in words. */
  detail: string;
  /** The day files read. None when the log was refused. */
  files: string[];
  /** Every earlier snapshot, oldest first. None when the log was refused. */
  snapshots: Snapshot[];
}

/** Whether a run may build on this history. */
export function usable(h: History): boolean {
  return h.state === "absent" || h.state === "empty" || h.state === "read";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The published log in the folder dir, and which case it is. */
export function readHistory(dir: string): History {
  const refused = (state: HistoryState, detail: string): History => ({ state, detail, files: [], snapshots: [] });
  let log;
  try {
    log = readDayLog(dir);
  } catch (e) {
    if (e instanceof LogRefused) return refused(e.kind, e.message);
    throw e;
  }
  if (log === null) return { state: "absent", detail: "the log folder does not exist, so this is a first run", files: [], snapshots: [] };
  for (const [i, s] of log.snapshots.entries()) {
    const broken = checkSnapshot(s);
    if (broken.length > 0) return refused("unchecked", `line ${i} of the log, counted across its day files, is no snapshot this code can check: it breaks ${broken.join(", ")}`);
  }
  if (log.snapshots.length === 0) return { state: "empty", detail: "the log folder holds no snapshot, so this snapshot starts the log", files: log.files, snapshots: [] };
  return {
    state: "read",
    detail: `read ${plural(log.snapshots.length, "snapshot")} from ${plural(log.files.length, "day file")}, and the chain verifies`,
    files: log.files,
    snapshots: log.snapshots,
  };
}
