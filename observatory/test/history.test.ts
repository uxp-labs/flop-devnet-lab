// The earlier snapshots a run builds on: the published log read as one chain, and each case it can be in.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { earlierOf, readHistory, usable } from "../src/history.js";
import { logLine, sealSnapshot } from "../src/store.js";
import type { Snapshot } from "../src/types.js";

const G = "0x" + "ab".repeat(32);
const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");

let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "obs-history-"));
});
afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

/** A snapshot as a run writes it, with the head values the history reads. */
function reading(at: string, head: { genesis: string | null; finalized: number | null; best: number | null; headAt?: string | null }): Omit<Snapshot, "hash" | "seq" | "prev_hash"> {
  return {
    schema: "flop-observatory/snapshot@0",
    observed_at: at,
    trust: "fixture",
    pin: { source_sha: null, source: "fixture:test", genesis: head.genesis, finalized_height: head.finalized, finalized_hash: head.finalized === null ? null : H(head.finalized), node: "none" },
    status: {
      schema: "flop-observatory/network-status@0",
      observed_at: at,
      trust: "fixture",
      genesis: { pinned: G, faucet: null, rpc: head.genesis },
      reset_detected: null,
      conflicts: [],
      finalized_height: head.finalized,
      finalized_hash: head.finalized === null ? null : H(head.finalized),
      best_height: head.best,
      finality_lag: head.finalized !== null && head.best !== null && head.best >= head.finalized ? head.best - head.finalized : null,
      runtime_version: null,
      rpc: { health: "unknown", http: null, detail: null, observed_at: head.headAt === undefined ? at : head.headAt, stale: null },
      gateway: { health: "unknown", http: null, detail: null, observed_at: null },
      faucet: { health: "unknown", http: null, detail: null, observed_at: null, ready: null, limits: null },
    },
    escrows: [],
    census: null,
    drift: null,
  };
}

function chainOf(...parts: ReturnType<typeof reading>[]): Snapshot[] {
  const out: Snapshot[] = [];
  for (const p of parts) out.push(sealSnapshot(p, out.at(-1)));
  return out;
}

function logDir(files: Record<string, Snapshot[] | string>): string {
  const dir = join(box, "log");
  mkdirSync(dir, { recursive: true });
  for (const [n, ss] of Object.entries(files)) writeFileSync(join(dir, n), typeof ss === "string" ? ss : ss.map(logLine).join(""));
  return dir;
}

describe("earlierOf", () => {
  it("passes every earlier snapshot's time, every best height on a genesis, and every finalized head, oldest first", () => {
    const ss = chainOf(
      reading("2026-01-01T00:00:00.000Z", { genesis: G, finalized: 10, best: 12 }),
      reading("2026-01-01T00:30:00.000Z", { genesis: null, finalized: null, best: null }),
      reading("2026-01-01T01:00:00.000Z", { genesis: G, finalized: null, best: 20 }),
      reading("2026-01-01T01:30:00.000Z", { genesis: G, finalized: 30, best: 31, headAt: null }),
    );
    expect(earlierOf(ss)).toEqual({
      previous: [
        { genesis: G, finalized_height: 10, finalized_hash: H(10), observed_at: "2026-01-01T00:00:00.000Z" },
        { genesis: G, finalized_height: 30, finalized_hash: H(30), observed_at: null },
      ],
      earlierTimes: ["2026-01-01T00:00:00.000Z", "2026-01-01T00:30:00.000Z", "2026-01-01T01:00:00.000Z", "2026-01-01T01:30:00.000Z"],
      earlierBest: [
        { genesis: G, best_height: 12 },
        { genesis: G, best_height: 20 },
        { genesis: G, best_height: 31 },
      ],
    });
    expect(earlierOf([])).toEqual({ previous: [], earlierTimes: [], earlierBest: [] });
  });
});

describe("readHistory", () => {
  const a = reading("2026-01-01T00:00:00.000Z", { genesis: G, finalized: 10, best: 12 });
  const b = reading("2026-01-02T00:00:00.000Z", { genesis: G, finalized: 20, best: 22 });

  it("absent: the folder does not exist, so this is a first run", () => {
    const h = readHistory(join(box, "log"));
    expect(h).toEqual({ state: "absent", detail: "the log folder does not exist, so this is a first run", files: [], snapshots: [] });
    expect(usable(h)).toBe(true);
  });

  it("empty: the folder holds no day file; a day file with no line is refused, never read as empty", () => {
    const h = readHistory(logDir({}));
    expect(h).toEqual({ state: "empty", detail: "the log folder holds no snapshot, so this snapshot starts the log", files: [], snapshots: [] });
    expect(usable(h)).toBe(true);
    rmSync(join(box, "log"), { recursive: true });
    const blank = readHistory(logDir({ "2026-01-01.jsonl": "" }));
    expect(blank).toEqual({ state: "unreadable", detail: "2026-01-01.jsonl holds no line", files: [], snapshots: [] });
    expect(usable(blank)).toBe(false);
  });

  it("read: every line, across day files, in one chain", () => {
    const [x, y] = chainOf(a, b) as [Snapshot, Snapshot];
    const h = readHistory(logDir({ "2026-01-01.jsonl": [x], "2026-01-02.jsonl": [y] }));
    expect(h).toEqual({ state: "read", detail: "read 2 snapshots from 2 day files, and the chain verifies", files: ["2026-01-01.jsonl", "2026-01-02.jsonl"], snapshots: [x, y] });
    expect(usable(h)).toBe(true);
  });

  it("unreadable, broken: refused, with nothing to build on, and the reason", () => {
    const [x, y] = chainOf(a, b) as [Snapshot, Snapshot];
    const unreadable = readHistory(logDir({ "2026-01-01.jsonl": logLine(x) + '{"a": 1}\n' }));
    expect(unreadable).toEqual({ state: "unreadable", detail: "2026-01-01.jsonl line 1 is not in canonical form", files: [], snapshots: [] });
    expect(usable(unreadable)).toBe(false);
    rmSync(join(box, "log"), { recursive: true });
    const broken = readHistory(logDir({ "2026-01-02.jsonl": [y] }));
    expect(broken).toEqual({ state: "broken", detail: "2026-01-02.jsonl line 0 has seq 1, not 0", files: [], snapshots: [] });
    expect(usable(broken)).toBe(false);
  });

  it("unchecked: a line in the chain that is no snapshot this code can check is refused, never skipped", () => {
    const later = { ...b, schema: "flop-observatory/snapshot@1" } as unknown as typeof b;
    const ss = chainOf(a, later);
    const h = readHistory(logDir({ "2026-01-01.jsonl": ss }));
    expect(h.state).toBe("unchecked");
    expect(h.detail).toMatch(/^line 1 of the log, counted across its day files, is no snapshot this code can check: it breaks /);
    expect([h.files, h.snapshots, usable(h)]).toEqual([[], [], false]);
  });
});
