import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLine, handleMcp } from "../src/mcp.js";
import { writeFeeds } from "../src/feed.js";
import { hashSnapshot } from "../src/store.js";
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

const ctx = { snapshot: build() };
let n = 0;
const call = (name: string, args?: unknown) => handleMcp({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }, ctx);
const text = (r: ReturnType<typeof handleMcp>) => ((r?.result as { content: { text: string }[] }).content[0] as { text: string }).text;

describe("mcp protocol", () => {
  it("initialize, ping, tools/list", () => {
    const i = handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, ctx);
    expect((i?.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
    expect(handleMcp({ jsonrpc: "2.0", id: 2, method: "ping" }, ctx)?.result).toEqual({});
    const l = handleMcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx);
    const tools = (l?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["get_status", "get_escrow_state", "list_escrows", "get_census", "get_drift", "get_upgrade", "get_snapshot_meta"]);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });
  it("notifications get no response", () => {
    expect(handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
    expect(handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', ctx)).toBeNull();
    expect(handleLine("", ctx)).toBeNull();
  });
  it("errors: unknown method, unknown tool, bad params, bad request, parse error", () => {
    expect(handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/nope" }, ctx)?.error?.code).toBe(-32601);
    expect(call("write_everything")?.error?.code).toBe(-32602);
    expect(handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }, ctx)?.error?.code).toBe(-32602);
    expect(call("get_escrow_state", {})?.error?.code).toBe(-32602);
    expect(call("get_escrow_state", { escrow_id: "0x12" })?.error?.code).toBe(-32602);
    expect(handleMcp([], ctx)?.error?.code).toBe(-32600);
    expect(handleMcp({ id: 1, method: "ping" }, ctx)?.error?.code).toBe(-32600);
    expect(JSON.parse(handleLine("{nope", ctx) as string).error.code).toBe(-32700);
  });
  it("answers a call it cannot serve with an internal error instead of throwing", () => {
    // A snapshot with no status makes get_status throw inside the handler.
    const broken = { snapshot: { ...build(), status: undefined } as unknown as Snapshot };
    const req = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_status", arguments: {} } });
    expect(JSON.parse(handleLine(req, broken) as string)).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "internal error" } });
    // The same server still answers what it can.
    expect(JSON.parse(handleLine('{"jsonrpc":"2.0","id":8,"method":"ping"}', broken) as string)).toEqual({ jsonrpc: "2.0", id: 8, result: {} });
  });
});

describe("mcp tools", () => {
  it("match the feed files byte for byte and carry trust, observed_at and hash", () => {
    const d = mkdtempSync(join(tmpdir(), "obs-mcp-"));
    made.push(d);
    writeFeeds(d, ctx.snapshot);
    const pairs: [string, string][] = [["get_status", "status.json"], ["list_escrows", "escrows.json"], ["get_census", "census.json"], ["get_drift", "drift.json"], ["get_upgrade", "upgrade.json"]];
    for (const [tool, file] of pairs) {
      const t = text(call(tool));
      expect(t).toBe(readFileSync(join(d, file), "utf8"));
      const o = JSON.parse(t);
      expect(o.trust).toBe("fixture");
      expect(o.observed_at).toBe(T);
      expect(o.snapshot_hash).toBe(ctx.snapshot.hash);
    }
  });
  it("get_escrow_state returns the same object as the feed", () => {
    for (const e of ctx.snapshot.escrows) {
      expect(JSON.parse(text(call("get_escrow_state", { escrow_id: e.escrow_id })))).toEqual(JSON.parse(JSON.stringify(e)));
    }
  });
  it("an unseen escrow id asked for in upper case is answered in lower case, as every escrow id is (third IMD audit J10)", () => {
    const o = JSON.parse(text(call("get_escrow_state", { escrow_id: "0x" + "AB".repeat(32) })));
    expect([o.escrow_id, o.state]).toEqual(["0x" + "ab".repeat(32), "unverified"]);
  });
  it("an unseen escrow id is unverified with a note and the scope line", () => {
    const o = JSON.parse(text(call("get_escrow_state", { escrow_id: "0x" + "99".repeat(32) })));
    expect(o.state).toBe("unverified");
    expect(o.evidence).toEqual([]);
    expect(o.notes.length).toBeGreaterThan(0);
    expect(o.scope).toBe("settlement only; says nothing about output quality");
    expect(o.trust).toBe("fixture");
  });
  it("null census and drift are null, not empty objects", () => {
    const c2 = { snapshot: build({ census: null, drift: null }) };
    const r = handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_census" } }, c2);
    expect(JSON.parse(text(r)).census).toBeNull();
    const r2 = handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_drift" } }, c2);
    expect(JSON.parse(text(r2)).drift).toBeNull();
  });
  it("snapshot meta and status nulls", () => {
    const m = JSON.parse(text(call("get_snapshot_meta")));
    expect(m.snapshot_hash).toBe(ctx.snapshot.hash);
    expect(m.prev_hash).toBeNull();
    const s = JSON.parse(text(call("get_status"))).status;
    expect(s.reset_detected).toBeNull();
    expect(s.gateway.health).toBe("unknown");
  });
  it("never mutates the snapshot", () => {
    const before = JSON.stringify(ctx.snapshot);
    for (const t of ["get_status", "list_escrows", "get_census", "get_drift", "get_snapshot_meta"]) call(t);
    expect(JSON.stringify(ctx.snapshot)).toBe(before);
    expect(hashSnapshot(ctx.snapshot)).toBe(ctx.snapshot.hash);
  });
});

describe("mcp on a reset snapshot", () => {
  it("returns reset_detected true, conflicts, stale and the faucet genesis as the snapshot has them", () => {
    const s = buildReset();
    const r = handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_status" } }, { snapshot: s });
    const o = JSON.parse(text(r)).status;
    expect(o).toEqual(JSON.parse(JSON.stringify(s.status)));
    expect(o.reset_detected).toBe(true);
    expect(o.rpc.stale).toBe(true);
    expect(o.conflicts).toEqual(s.status.conflicts);
    expect(o.genesis.faucet).not.toBe(o.genesis.pinned);
  });
});

describe("mcp fallback for an unseen escrow", () => {
  it("has finalized_height null even when the snapshot status has a finalized height", () => {
    const s = buildReset();
    expect(s.status.finalized_height).toBe(10);
    const r = handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_escrow_state", arguments: { escrow_id: "0x" + "77".repeat(32) } } }, { snapshot: s });
    const o = JSON.parse(text(r));
    expect(o.state).toBe("unverified");
    expect(o.finalized_height).toBeNull();
  });
});
