// One snapshot, three outputs (page, JSON feeds, MCP). They must agree.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPage } from "../src/page.js";
import { writeFeeds } from "../src/feed.js";
import { handleMcp } from "../src/mcp.js";
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

function pageCells(html: string): Map<string, string | undefined> {
  const m = new Map<string, string | undefined>();
  for (const x of html.matchAll(/<(?:td|p|span) data-k="([^"]*)"([^>]*)>/g)) {
    const v = /data-v="([^"]*)"/.exec(x[2] as string);
    m.set(x[1] as string, v ? v[1] : undefined);
  }
  return m;
}

function setup(s: Snapshot) {
  const d = mkdtempSync(join(tmpdir(), "obs-cons-"));
  writeFeeds(d, s);
  const feed = (n: string) => JSON.parse(readFileSync(join(d, n), "utf8"));
  let i = 0;
  const mcp = (name: string, args?: unknown) => {
    const r = handleMcp({ jsonrpc: "2.0", id: ++i, method: "tools/call", params: { name, arguments: args } }, { snapshot: s });
    return JSON.parse(((r?.result as { content: { text: string }[] }).content[0] as { text: string }).text);
  };
  return { cells: pageCells(renderPage(s)), feed, mcp };
}

describe("page, feeds and MCP agree", () => {
  const s = build();
  const { cells, feed, mcp } = setup(s);

  it("on every escrow state, observed_at and trust", () => {
    const fe = feed("escrows.json").escrows as EscrowState[];
    const me = mcp("list_escrows").escrows as EscrowState[];
    expect(fe.map((e) => e.state)).toEqual(["claimed", "refunded", "unverified"]);
    for (const e of s.escrows) {
      const f = fe.find((x) => x.escrow_id === e.escrow_id)!;
      const m = me.find((x) => x.escrow_id === e.escrow_id)!;
      const one = mcp("get_escrow_state", { escrow_id: e.escrow_id }) as EscrowState;
      for (const o of [f, m, one]) {
        expect(o.state).toBe(e.state);
        expect(o.observed_at).toBe(e.observed_at);
        expect(o.trust).toBe(e.trust);
      }
      expect(cells.get(`escrow.${e.escrow_id}.state`)).toBe(e.state);
      expect(cells.get(`escrow.${e.escrow_id}.observed_at`)).toBe(e.observed_at);
      expect(cells.get(`escrow.${e.escrow_id}.trust`)).toBe(e.trust);
    }
  });

  it("on status health values, observed_at and trust", () => {
    const fs = feed("status.json");
    const ms = mcp("get_status");
    for (const o of [fs, ms]) {
      expect(o.observed_at).toBe(s.status.observed_at);
      expect(o.trust).toBe(s.status.trust);
      expect(o.status.rpc.health).toBe("ok");
      expect(o.status.gateway.health).toBe("unknown");
      expect(o.status.faucet.health).toBe("unknown");
    }
    expect(cells.get("status.rpc.health")).toBe("ok");
    expect(cells.get("status.gateway.health")).toBe("unknown");
    expect(cells.get("status.faucet.health")).toBe("unknown");
    expect(cells.get("status.observed_at")).toBe(s.status.observed_at);
    expect(cells.get("status.trust")).toBe(s.status.trust);
  });

  it("on nulls: blank on the page, null in JSON and MCP", () => {
    const keys: [string, (st: any) => unknown][] = [
      ["status.reset_detected", (x) => x.reset_detected],
      ["status.genesis.faucet", (x) => x.genesis.faucet],
      ["status.finalized_hash", (x) => x.finalized_hash],
      ["status.best_height", (x) => x.best_height],
      ["status.finality_lag", (x) => x.finality_lag],
      ["status.runtime_version", (x) => x.runtime_version],
      ["status.gateway.observed_at", (x) => x.gateway.observed_at],
      ["status.rpc.stale", (x) => x.rpc.stale],
      ["status.faucet.ready", (x) => x.faucet.ready],
    ];
    for (const [k, get] of keys) {
      expect(cells.has(k), k).toBe(true);
      expect(cells.get(k), k).toBeUndefined();
      expect(get(feed("status.json").status), k).toBeNull();
      expect(get(mcp("get_status").status), k).toBeNull();
    }
    expect(cells.get("status.finalized_height")).toBe("10");
    expect(feed("status.json").status.finalized_height).toBe(10);
  });

  it("on the partial census and its totals", () => {
    const fc = feed("census.json").census;
    const mc = mcp("get_census").census;
    for (const c of [fc, mc]) {
      expect(c.status).toBe("partial");
      expect(c.complete).toBe(false);
      expect(c.totals.escrows_opened).toBe(3);
    }
    expect(cells.get("census.status")).toBe("partial");
    expect(cells.get("census.totals.escrows_opened")).toBe("3");
  });

  it("on a null census and drift", () => {
    const n = setup(build({ census: null, drift: null }));
    expect(n.feed("census.json").census).toBeNull();
    expect(n.mcp("get_census").census).toBeNull();
    expect(n.feed("drift.json").drift).toBeNull();
    expect(n.mcp("get_drift").drift).toBeNull();
    expect(n.cells.get("census")).toBeUndefined();
    expect(n.cells.has("census")).toBe(true);
    expect(n.cells.has("census.totals.escrows_opened")).toBe(false);
  });

  it("on the snapshot hash", () => {
    expect(feed("snapshot.json").hash).toBe(s.hash);
    expect(mcp("get_snapshot_meta").snapshot_hash).toBe(s.hash);
    expect(renderPage(s)).toContain(s.hash);
    expect(hashSnapshot(s)).toBe(s.hash);
  });

  it("with a malicious string in data: escaped on the page, verbatim in JSON and MCP", () => {
    const evil = `<script>alert("x")</script>`;
    const b = build();
    const e: EscrowState = { ...esc1(ID_UNVERIFIED, "unverified", null), notes: [evil] };
    const base: Omit<Snapshot, "hash"> = { ...b, escrows: [e] };
    const sn: Snapshot = { ...base, hash: hashSnapshot(base) };
    const o = setup(sn);
    expect(renderPage(sn)).not.toContain("<script");
    expect(o.feed("escrows.json").escrows[0].notes[0]).toBe(evil);
    expect(o.mcp("list_escrows").escrows[0].notes[0]).toBe(evil);
  });
});
