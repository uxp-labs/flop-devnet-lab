// JSON feeds. The same objects feed the MCP tools, so both agree byte for byte.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_NESTING, nestingDepth } from "./strict.js";
import type { Snapshot } from "./types.js";

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v !== null && typeof v === "object") {
    // fromEntries defines each key as an own property. Plain assignment would treat a key named
    // __proto__ (an account, say) as the prototype and drop it from the written file. Keys sort by
    // UTF-16 unit, as Array.prototype.sort does by default.
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, sortDeep(x)]),
    );
  }
  return v;
}

/** Deterministic text: sorted keys, two-space indent, trailing newline. */
export function feedText(v: unknown): string {
  return JSON.stringify(sortDeep(v), null, 2) + "\n";
}

/**
 * The value a file's text holds when it is JSON in the written form (feedText), or the reason it
 * is not, naming the file. The written form has one spelling of each value: a repeated key,
 * padding or a rounded integer prints back differently.
 */
export function writtenValue(name: string, text: string): { value: unknown } | string {
  if (nestingDepth(text) > MAX_NESTING) return `${name} nests deeper than ${MAX_NESTING} levels`;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return `${name} is not JSON`;
  }
  return feedText(value) === text ? { value } : `${name} is not in the written form`;
}

export function statusFeed(s: Snapshot) {
  return { schema: "flop-observatory/feed-status@0", snapshot_hash: s.hash, observed_at: s.status.observed_at, trust: s.status.trust, status: s.status };
}

export function escrowsFeed(s: Snapshot) {
  return { schema: "flop-observatory/feed-escrows@0", snapshot_hash: s.hash, observed_at: s.observed_at, trust: s.trust, escrows: s.escrows };
}

/** census is null when it was not computed. Never an empty object with zeros. */
export function censusFeed(s: Snapshot) {
  return { schema: "flop-observatory/feed-census@0", snapshot_hash: s.hash, observed_at: s.census?.observed_at ?? s.observed_at, trust: s.census?.trust ?? s.trust, census: s.census ?? null };
}

export function driftFeed(s: Snapshot) {
  return { schema: "flop-observatory/feed-drift@0", snapshot_hash: s.hash, observed_at: s.drift?.observed_at ?? s.observed_at, trust: s.drift?.trust ?? s.trust, drift: s.drift ?? null };
}

export function snapshotMeta(s: Snapshot) {
  return { schema: "flop-observatory/feed-snapshot-meta@0", snapshot_hash: s.hash, seq: s.seq, prev_hash: s.prev_hash, observed_at: s.observed_at, trust: s.trust, pin: s.pin };
}

/** status.json, escrows.json, census.json, drift.json and snapshot.json, each a name and its text. */
export function feedFiles(s: Snapshot): [string, string][] {
  const files: [string, unknown][] = [
    ["status.json", statusFeed(s)],
    ["escrows.json", escrowsFeed(s)],
    ["census.json", censusFeed(s)],
    ["drift.json", driftFeed(s)],
    ["snapshot.json", s],
  ];
  return files.map(([name, obj]) => [name, feedText(obj)]);
}

/** Writes the feed files (feedFiles). Returns the file names. */
export function writeFeeds(dir: string, s: Snapshot): string[] {
  mkdirSync(dir, { recursive: true });
  const files = feedFiles(s);
  for (const [name, text] of files) writeFileSync(join(dir, name), text);
  return files.map(([n]) => n);
}
