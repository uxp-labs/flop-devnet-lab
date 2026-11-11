// The reader contract for the data branch (RULES.md section 7, README "Published readings").
//
// The publish job in .github/workflows/observatory-live.yml puts each live run's output folder on
// the branch observatory-data, under latest/. A consumer fetches each file there by its raw URL
// and hands their text to judgeLatest, which says whether the reading may be used. It is pure: it
// reads no file, no clock and no network, so the consumer passes the time it trusts as now.
//
// A reading is usable only when, in this order:
//   1. the files are exactly PUBLISHED_FILES and SHA256SUMS,
//   2. each file matches its line in SHA256SUMS, and SHA256SUMS is in the form the live run
//      writes (src/sums.ts),
//   3. snapshot.json is JSON in the written form (src/feed.ts), passes every snapshot check the
//      MCP binary holds a snapshot to (src/snapshot-check.ts) and its hash check (src/store.ts),
//      and its trust is "trusted RPC",
//   4. every feed and snapshots.jsonl is the one that snapshot gives, and run.json names that
//      snapshot and the exit it gives (src/live-run.ts),
//   5. neither the snapshot's observed_at nor its status's is after now, and neither is older
//      than the limit the consumer passes.
// The first step that fails gives the reasons, and nothing after it is read. The tape is checked
// against its sum only: no rule here reads what it says. The sums show the files are the ones the
// publish job checked, not that the reading is true: its trust is one RPC endpoint.
import { feedFiles, feedText } from "./feed.js";
import { EXIT, RUN_SCHEMA, resetSignal } from "./live-run.js";
import { own } from "./own.js";
import { checkSnapshot } from "./snapshot-check.js";
import { canonicalJson, hashSnapshot } from "./store.js";
import { MAX_NESTING, nestingDepth, parseZoned } from "./strict.js";
import { sumsOf } from "./sums.js";
import type { Snapshot } from "./types.js";

/** Every file latest/ holds but SHA256SUMS, in the order SHA256SUMS lists them. */
export const PUBLISHED_FILES = ["census.json", "drift.json", "escrows.json", "run.json", "snapshot.json", "snapshots.jsonl", "status.json", "tape.jsonl"] as const;

export type Judgement = { usable: true; snapshot: Snapshot; reset: string | null } | { usable: false; refused: string[] };

export interface JudgeOptions {
  /** The time the consumer trusts, with a zone. */
  now: string;
  /** The oldest reading the consumer will use, in whole seconds. */
  maxAgeSeconds: number;
}

const refuse = (...refused: string[]): Judgement => ({ usable: false, refused });

/** The value a text holds when it is JSON in the written form (feedText), or the reason it is not. */
function written(name: string, text: string): { value: unknown } | string {
  if (nestingDepth(text) > MAX_NESTING) return `${name} nests deeper than ${MAX_NESTING} levels`;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return `${name} is not JSON`;
  }
  // The written form has one spelling of each value: a repeated key, padding or a rounded integer
  // prints back differently.
  return feedText(value) === text ? { value } : `${name} is not in the written form`;
}

/** Whether the files of latest/ hold a reading the consumer may use, and the reset signal it holds. */
export function judgeLatest(files: Readonly<Record<string, string>>, o: JudgeOptions): Judgement {
  const now = parseZoned(o.now);
  if (now === null) throw new TypeError("judgeLatest: now must be a time with a zone");
  if (!Number.isSafeInteger(o.maxAgeSeconds) || o.maxAgeSeconds < 0) throw new TypeError("judgeLatest: maxAgeSeconds must be a whole number of seconds from 0");

  // 1. Exactly the published files.
  const known: readonly string[] = [...PUBLISHED_FILES, "SHA256SUMS"];
  const text = (name: string): string => own(files, name) as string;
  const missing = known.filter((n) => typeof own(files, n) !== "string").map((n) => `missing ${n}`);
  const unexpected = Object.keys(files)
    .filter((n) => !known.includes(n))
    .sort()
    .map((n) => `unexpected ${n}`);
  if (missing.length + unexpected.length > 0) return refuse(...missing, ...unexpected);

  // 2. Each file against its sum, then the sums file's own form.
  const sums = text("SHA256SUMS");
  const lines = sums.split("\n");
  const differ = PUBLISHED_FILES.filter((n) => !lines.includes(sumsOf([[n, text(n)]]).slice(0, -1))).map((n) => `${n} differs from SHA256SUMS`);
  if (differ.length > 0) return refuse(...differ);
  if (sumsOf(PUBLISHED_FILES.map((n) => [n, text(n)] as const)) !== sums) return refuse("SHA256SUMS is not in the written form");

  // 3. The snapshot.
  const read = written("snapshot.json", text("snapshot.json"));
  if (typeof read === "string") return refuse(read);
  const broken = checkSnapshot(read.value);
  if (broken.length > 0) return refuse(...broken.map((c) => `snapshot.json breaks ${c}`));
  const s = read.value as Snapshot;
  if (s.hash !== hashSnapshot(s)) return refuse("snapshot.json fails its hash check");
  if (s.trust !== "trusted RPC") return refuse(`snapshot.json has trust ${JSON.stringify(s.trust)}, not "trusted RPC"`);

  // 4. Every other file is the one the snapshot gives.
  const given: [string, string][] = [...feedFiles(s).filter(([n]) => n !== "snapshot.json"), ["snapshots.jsonl", canonicalJson(s) + "\n"]];
  const notGiven = given.filter(([n, t]) => text(n) !== t).map(([n]) => `${n} is not the one the snapshot gives`);
  if (notGiven.length > 0) return refuse(...notGiven);
  const run = written("run.json", text("run.json"));
  if (typeof run === "string") return refuse(run);
  if (run.value === null || typeof run.value !== "object" || Array.isArray(run.value)) return refuse("run.json is not an object");
  const reset = resetSignal(s);
  const exit = reset === null ? EXIT.ok : EXIT.reset;
  if (own(run.value as object, "schema") !== RUN_SCHEMA) return refuse(`run.json is not a ${RUN_SCHEMA}`);
  if (own(run.value as object, "snapshot_hash") !== s.hash) return refuse("run.json names another snapshot");
  const said = own(run.value as object, "exit_code");
  if (said !== exit) return refuse(`run.json says exit ${JSON.stringify(said)}, the snapshot says ${exit}`);

  // 5. Fresh: the snapshot's time and its status's, the time every feed carries.
  const stale: string[] = [];
  for (const [name, t] of [
    ["snapshot.json", s.observed_at],
    ["status.json", s.status.observed_at],
  ] as const) {
    const at = parseZoned(t) as number;
    if (at > now) stale.push(`${name} observed_at ${t} is in the future`);
    else if (now - at > o.maxAgeSeconds * 1000) stale.push(`${name} observed_at ${t} is older than ${o.maxAgeSeconds} s`);
  }
  if (stale.length > 0) return refuse(...stale);
  return { usable: true, snapshot: s, reset };
}
