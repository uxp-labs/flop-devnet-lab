// JSON feeds. The same objects feed the MCP tools, so both agree byte for byte.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** Writes status.json, escrows.json, census.json, drift.json and snapshot.json. Returns the file names. */
export function writeFeeds(dir: string, s: Snapshot): string[] {
  mkdirSync(dir, { recursive: true });
  const files: [string, unknown][] = [
    ["status.json", statusFeed(s)],
    ["escrows.json", escrowsFeed(s)],
    ["census.json", censusFeed(s)],
    ["drift.json", driftFeed(s)],
    ["snapshot.json", s],
  ];
  for (const [name, obj] of files) writeFileSync(join(dir, name), feedText(obj));
  return files.map(([n]) => n);
}
