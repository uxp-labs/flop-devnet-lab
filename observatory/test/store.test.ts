import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSnapshot, canonicalJson, hashSnapshot, readSnapshots, verifyChain } from "../src/store.js";
import { writeFeeds } from "../src/feed.js";
import type { EscrowState, Snapshot } from "../src/types.js";

const G = "0x" + "ab".repeat(32);
const ID_CLAIMED = "0x" + "01".repeat(32);
const ID_REFUNDED = "0x" + "02".repeat(32);
const ID_UNVERIFIED = "0x" + "03".repeat(32);
const T = "2026-01-01T00:00:00.000Z";
const SCOPE = "settlement only; says nothing about output quality" as const;

function esc1(id: string, state: EscrowState["state"], evEvent: string | null): EscrowState {
  return {
    schema: "flop-observatory/escrow-state@0",
    escrow_id: id,
    state,
    evidence: evEvent ? [{ event: evEvent, block_hash: "0x" + "cd".repeat(32), block_number: 7, event_index: 1, genesis: G }] : [],
    notes: state === "unverified" ? ["no finalized evidence"] : [],
    finalized_height: 10,
    observed_at: T,
    trust: "fixture",
    scope: SCOPE,
  };
}

function build(over: Partial<Snapshot> = {}): Snapshot {
  const base: Omit<Snapshot, "hash"> = {
    schema: "flop-observatory/snapshot@0",
    seq: 0,
    prev_hash: null,
    observed_at: T,
    trust: "fixture",
    pin: { source_sha: null, source: "fixture:test", genesis: G, finalized_height: 10, finalized_hash: null, node: "none" },
    status: {
      schema: "flop-observatory/network-status@0",
      observed_at: T,
      trust: "fixture",
      genesis: { pinned: G, faucet: null, rpc: G },
      reset_detected: null,
      conflicts: [],
      finalized_height: 10,
      finalized_hash: null,
      best_height: null,
      finality_lag: null,
      runtime_version: null,
      rpc: { health: "ok", http: null, detail: null, observed_at: T, stale: null },
      gateway: { health: "unknown", http: null, detail: null, observed_at: null },
      faucet: { health: "unknown", http: null, detail: null, observed_at: null, ready: null, limits: null },
    },
    escrows: [
      esc1(ID_CLAIMED, "claimed", "hasStation.EscrowReleased"),
      esc1(ID_REFUNDED, "refunded", "hasStation.EscrowRefunded"),
      esc1(ID_UNVERIFIED, "unverified", null),
    ],
    census: {
      schema: "flop-observatory/census@0",
      observed_at: T,
      trust: "fixture",
      genesis: G,
      requested: { from_block: 0, to_block: 100 },
      covered: [{ from_block: 0, to_block: 49 }],
      gaps: [{ from_block: 50, to_block: 100 }],
      complete: false,
      status: "partial",
      totals: { escrows_opened: 3, escrows_released: 1, escrows_refunded: 1, channels_opened: 0, channels_settled: 0 },
      by_account: {},
      totals_label: "partial",
      requested_blocks: 101,
      covered_blocks: 50,
      reset_detected: null,
      notes: [],
      pending_unfinalized: 0,
      duplicates_dropped: 0,
      excluded_other_genesis: 0,
      malformed_dropped: 0,
      event_names: {
        escrows_opened: { event: "hasStation.EscrowOpened", confirmed: true },
        escrows_released: { event: "hasStation.EscrowReleased", confirmed: true },
        escrows_refunded: { event: "hasStation.EscrowRefunded", confirmed: true },
        channels_opened: { event: "computeChannel.ChannelOpened", confirmed: false },
        channels_settled: { event: "computeChannel.ChannelSettled", confirmed: false },
      },
    },
    drift: null,
    ...over,
  };
  return { ...base, hash: hashSnapshot(base) };
}

const FAUCET_G = "0x" + "ef".repeat(32);
const FIN_HASH = "0x" + "aa".repeat(32);

/** A reset scenario: reset true, stale true, conflicts, finalized height and hash, a differing faucet genesis,
 *  an escrow with empty notes, a complete census with empty gaps, and a drift report with an unknown item. */
function buildReset(): Snapshot {
  const b = build();
  const st = b.status;
  const census = { ...b.census!, complete: true, status: "complete" as const, totals_label: "complete" as const, covered: [{ from_block: 0, to_block: 100 }], gaps: [], covered_blocks: 101, reset_detected: true, notes: ["page on another genesis ignored"] };
  const drift = {
    schema: "flop-observatory/drift@0" as const, observed_at: T, trust: "fixture" as const, genesis: G, finalized_height: 10, runtime_version: 5, spec_source: "spec.yaml", runtime_observed_at: null,
    items: [
      { param: "a", runtime_path: "api.consts.a", spec: 5, runtime: 5, status: "match" as const, note: null, mapping: "constant" as const, unit: null, expected: "5" },
      { param: "b", runtime_path: null, spec: "", runtime: null, status: "unknown" as const, note: "", mapping: "none" as const, unit: null, expected: null },
    ],
    matches: 1, mismatches: 0, unknown: 1,
  };
  return build({
    status: {
      ...st,
      genesis: { pinned: G, faucet: FAUCET_G, rpc: G },
      reset_detected: true,
      conflicts: ["faucet genesis differs from pinned", "second conflict"],
      finalized_height: 10,
      finalized_hash: FIN_HASH,
      best_height: 12,
      finality_lag: 2,
      runtime_version: 5,
      rpc: { ...st.rpc, health: "degraded", http: 200, detail: "stale head", stale: true },
    },
    census,
    drift,
  });
}

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "obs-store-"));
  made.push(d);
  return d;
}
function fresh() {
  const { hash: _h, seq: _s, prev_hash: _p, ...rest } = build();
  return rest;
}

describe("canonical json and hash", () => {
  it("sorts keys, no whitespace, numbers as JS prints them", () => {
    expect(canonicalJson({ b: 1, a: { d: 1.5, c: [2, { z: null, y: 1e21 }] } })).toBe('{"a":{"c":[2,{"y":1e+21,"z":null}],"d":1.5},"b":1}');
  });
  it("hash ignores the hash field and key order, and changes with content", () => {
    const s = build();
    expect(hashSnapshot(s)).toBe(s.hash);
    expect(hashSnapshot({ ...s, hash: "junk" })).toBe(s.hash);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(s).reverse()))) as Snapshot;
    expect(hashSnapshot(reordered)).toBe(s.hash);
    expect(hashSnapshot({ ...s, observed_at: "2026-01-02T00:00:00.000Z" })).not.toBe(s.hash);
  });
});

describe("snapshot log chain", () => {
  it("appends with seq and prev_hash from the last line and verifies", () => {
    const p = join(tmp(), "log", "snapshots.jsonl");
    const a = appendSnapshot(p, fresh());
    const b = appendSnapshot(p, fresh());
    const c = appendSnapshot(p, fresh());
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
    expect(a.prev_hash).toBeNull();
    expect(b.prev_hash).toBe(a.hash);
    expect(c.prev_hash).toBe(b.hash);
    expect(readSnapshots(p).map((s) => s.hash)).toEqual([a.hash, b.hash, c.hash]);
    expect(verifyChain(p)).toBeNull();
  });
  it("an empty or missing log verifies", () => {
    expect(verifyChain(join(tmp(), "none.jsonl"))).toBeNull();
  });
  it("detects an edited line at its seq", () => {
    const p = join(tmp(), "s.jsonl");
    appendSnapshot(p, fresh());
    appendSnapshot(p, fresh());
    appendSnapshot(p, fresh());
    const ls = readFileSync(p, "utf8").trim().split("\n");
    const mid = JSON.parse(ls[1] as string);
    mid.observed_at = "2030-01-01T00:00:00.000Z";
    ls[1] = JSON.stringify(mid);
    writeFileSync(p, ls.join("\n") + "\n");
    expect(verifyChain(p)).toBe(1);
  });
  it("detects a wrong prev_hash even when the line's own hash is valid", () => {
    const p = join(tmp(), "s.jsonl");
    const a = appendSnapshot(p, fresh());
    const forged = { ...fresh(), seq: 1, prev_hash: "0".repeat(64) } as Omit<Snapshot, "hash">;
    appendFileSync(p, JSON.stringify({ ...forged, hash: hashSnapshot(forged) }) + "\n");
    expect(a.seq).toBe(0);
    expect(verifyChain(p)).toBe(1);
  });
  it("detects a deleted first line and a non-JSON line", () => {
    const p = join(tmp(), "s.jsonl");
    appendSnapshot(p, fresh());
    appendSnapshot(p, fresh());
    const ls = readFileSync(p, "utf8").trim().split("\n");
    writeFileSync(p, (ls[1] as string) + "\n");
    expect(verifyChain(p)).toBe(0);
    writeFileSync(p, (ls[0] as string) + "\nnot json\n");
    expect(verifyChain(p)).toBe(1);
  });
});

describe("feeds", () => {
  it("are deterministic, sorted, indented, newline terminated, and carry observed_at, trust and hash", () => {
    const s = build();
    const d1 = tmp();
    const d2 = tmp();
    const names = writeFeeds(d1, s);
    writeFeeds(d2, s);
    expect(names).toEqual(["status.json", "escrows.json", "census.json", "drift.json", "snapshot.json"]);
    for (const n of names) {
      const t = readFileSync(join(d1, n), "utf8");
      expect(t).toBe(readFileSync(join(d2, n), "utf8"));
      expect(t.endsWith("}\n")).toBe(true);
      expect(t.startsWith('{\n  "')).toBe(true);
      const o = JSON.parse(t);
      expect(Object.keys(o)).toEqual([...Object.keys(o)].sort());
      expect(typeof o.observed_at).toBe("string");
      expect(o.trust).toBe("fixture");
      expect(o.snapshot_hash ?? o.hash).toBe(s.hash);
    }
  });
  it("writes a null census and drift as null, never an empty object with zeros", () => {
    const s = build({ census: null, drift: null });
    const d = tmp();
    writeFeeds(d, s);
    const c = JSON.parse(readFileSync(join(d, "census.json"), "utf8"));
    const dr = JSON.parse(readFileSync(join(d, "drift.json"), "utf8"));
    expect(c.census).toBeNull();
    expect(dr.drift).toBeNull();
    expect(readFileSync(join(d, "census.json"), "utf8")).not.toContain("escrows_opened");
  });
  it("keeps null status values null, not 0", () => {
    const d = tmp();
    writeFeeds(d, build());
    const st = JSON.parse(readFileSync(join(d, "status.json"), "utf8")).status;
    expect(st.finalized_hash).toBeNull();
    expect(st.best_height).toBeNull();
    expect(st.finality_lag).toBeNull();
    expect(st.reset_detected).toBeNull();
    expect(st.gateway.health).toBe("unknown");
  });
});
