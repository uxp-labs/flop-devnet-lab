import { describe, expect, it } from "vitest";
import { renderPage } from "../src/page.js";
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

/** Reads one data-k cell: returns {present, value (data-v or undefined), text}. */
function cellOf(html: string, k: string) {
  const m = new RegExp(`<td data-k="${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"([^>]*)>([^<]*)</td>`).exec(html);
  if (!m) return null;
  const v = /data-v="([^"]*)"/.exec(m[1] as string);
  return { value: v ? v[1] : undefined, text: m[2] as string };
}

describe("page", () => {
  const html = renderPage(build());

  it("is self contained with light and dark", () => {
    expect(html).not.toMatch(/<script|<link|src=|href=|url\(|@import|https?:\/\//i);
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain("<style>");
  });
  it("says escrow state is settlement only", () => {
    expect(html).toContain("Escrow state is settlement only. It says nothing about output quality.");
  });
  it("renders unknown values as empty cells, never ok, 0 or complete", () => {
    for (const k of ["status.genesis.faucet", "status.reset_detected", "status.finalized_hash", "status.best_height", "status.finality_lag", "status.runtime_version", "status.gateway.http", "status.rpc.stale", "status.faucet.ready"]) {
      const c = cellOf(html, k);
      expect(c, k).not.toBeNull();
      expect(c?.text, k).toBe("");
      expect(c?.value, k).toBeUndefined();
    }
    const g = cellOf(html, "status.gateway.health");
    expect(g?.text).toBe("");
    expect(g?.value).toBe("unknown");
    expect(html).not.toMatch(/data-k="status\.gateway\.health"[^>]*>ok/);
    expect(cellOf(html, "status.rpc.health")?.text).toBe("ok");
  });
  it("labels partial census totals as partial, never complete", () => {
    expect(html).toContain("PARTIAL");
    expect(html).toContain("partial escrows_opened");
    expect(html).not.toContain("Complete: the whole");
    expect(html).toMatch(/data-k="census.status" data-v="partial"/);
  });
  it("labels a complete census complete", () => {
    const base = build();
    const c = { ...base.census!, complete: true, status: "complete" as const, gaps: [], covered: [base.census!.requested] };
    const h = renderPage(build({ census: c }));
    expect(h).toContain("Complete: the whole");
    expect(h).not.toContain("PARTIAL");
  });
  it("shows null census and drift as blank, not zero totals", () => {
    const h = renderPage(build({ census: null, drift: null }));
    expect(cellOf(h, "census")?.text).toBe("");
    expect(cellOf(h, "drift")?.text).toBe("");
    expect(h).not.toContain("escrows_opened");
  });
  it("shows trust and observed_at for the status and every escrow", () => {
    expect(cellOf(html, "status.trust")?.text).toBe("fixture");
    expect(cellOf(html, "status.observed_at")?.text).toBe(T);
    for (const id of [ID_CLAIMED, ID_REFUNDED, ID_UNVERIFIED]) {
      expect(cellOf(html, `escrow.${id}.trust`)?.text).toBe("fixture");
      expect(cellOf(html, `escrow.${id}.observed_at`)?.text).toBe(T);
    }
  });
  it("escapes every string from data (XSS)", () => {
    const evil = `<img src=x onerror=alert(1)>"'&<script>alert(2)</script>`;
    const s = build();
    const e: EscrowState = { ...esc1(ID_UNVERIFIED, "unverified", null), notes: [evil], escrow_id: ID_UNVERIFIED };
    const base: Omit<Snapshot, "hash"> = {
      ...s,
      escrows: [e],
      status: { ...s.status, conflicts: [evil], rpc: { ...s.status.rpc, detail: evil }, gateway: { ...s.status.gateway, detail: evil, health: evil as never } },
      pin: { ...s.pin, source: evil },
    };
    const h = renderPage({ ...base, hash: hashSnapshot(base) });
    expect(h).not.toContain("<img");
    expect(h).not.toContain("<script");
    expect(h).not.toContain(`onerror=alert(1)>`);
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;&lt;script&gt;");
  });
  it("escapes a malicious escrow id and drift strings", () => {
    const evil = `"><script>x</script>`;
    const s = build();
    const base: Omit<Snapshot, "hash"> = {
      ...s,
      escrows: [{ ...esc1(ID_CLAIMED, "claimed", null), escrow_id: evil }],
      drift: { schema: "flop-observatory/drift@0", observed_at: T, trust: "fixture", genesis: null, finalized_height: null, runtime_version: null, spec_source: evil, items: [{ param: evil, runtime_path: null, spec: evil, runtime: null, status: "unknown", note: evil }], mismatches: 0, unknown: 1 },
    };
    const h = renderPage({ ...base, hash: hashSnapshot(base) });
    expect(h).not.toContain("<script");
    expect(h).not.toContain("x</script>");
  });
});

describe("page cell rules", () => {
  const html = renderPage(build());
  const rh = renderPage(buildReset());
  const n = (h: string, k: string) => new RegExp(`data-k="${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*data-n="(\\d+)"`).exec(h)?.[1];
  const nOnly = (h: string, k: string) => new RegExp(`data-k="${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*data-n="\\d+">none</td>`).test(h);

  it("empty lists read none with data-n 0, never blank", () => {
    expect(nOnly(html, "status.conflicts")).toBe(true);
    expect(cellOf(html, "status.conflicts")?.text).toBe("none");
    expect(html).not.toContain("none seen");
    expect(nOnly(html, `escrow.${ID_CLAIMED}.notes`)).toBe(true);
    expect(nOnly(html, `escrow.${ID_UNVERIFIED}.evidence`)).toBe(true);
    expect(nOnly(rh, "census.gaps")).toBe(true);
    expect(nOnly(rh, "census.notes")).toBe(false);
  });
  it("non-empty lists carry data-n equal to their length and join with the right separators", () => {
    expect(n(rh, "status.conflicts")).toBe("2");
    expect(cellOf(rh, "status.conflicts")?.text).toBe("faucet genesis differs from pinned; second conflict");
    expect(n(html, "census.gaps")).toBe("1");
    expect(n(html, "census.covered")).toBe("1");
    expect(n(rh, `escrow.${ID_CLAIMED}.evidence`)).toBe("1");
    expect(cellOf(rh, `escrow.${ID_CLAIMED}.evidence`)?.text).toBe(`hasStation.EscrowReleased @ 7 0x${"cd".repeat(32)} #1`);
    const two = build();
    const c = { ...two.census!, gaps: [{ from_block: 1, to_block: 2 }, { from_block: 5, to_block: 9 }] };
    const h2 = renderPage(build({ census: c }));
    expect(n(h2, "census.gaps")).toBe("2");
    expect(cellOf(h2, "census.gaps")?.text).toBe("1-2, 5-9");
  });
  it("an empty string reads (empty) and keeps data-v empty", () => {
    expect(cellOf(rh, "drift.1.spec")).toEqual({ value: "", text: "(empty)" });
    expect(cellOf(rh, "drift.1.note")).toEqual({ value: "", text: "(empty)" });
  });
  it("booleans read as words, null stays blank", () => {
    expect(cellOf(rh, "status.reset_detected")).toEqual({ value: "true", text: "true" });
    expect(cellOf(rh, "status.rpc.stale")).toEqual({ value: "true", text: "true" });
    expect(cellOf(html, "status.reset_detected")).toEqual({ value: undefined, text: "" });
    expect(cellOf(html, "status.rpc.stale")).toEqual({ value: undefined, text: "" });
  });
  it("emits the full key set", () => {
    const keys = new Set([...rh.matchAll(/data-k="([^"]*)"/g)].map((m) => m[1]));
    for (const k of [
      "snapshot.hash", "snapshot.observed_at", "snapshot.trust", "status.reset_detected", "status.conflicts", "status.rpc.stale", "status.genesis.faucet",
      `escrow.${ID_CLAIMED}.escrow_id`, `escrow.${ID_CLAIMED}.state`, `escrow.${ID_CLAIMED}.notes`, `escrow.${ID_CLAIMED}.evidence`, `escrow.${ID_CLAIMED}.scope`,
      "census.status", "census.requested", "census.covered", "census.gaps", "census.totals.escrows_opened", "census.reset_detected", "census.notes",
      "drift.matches", "drift.mismatches", "drift.unknown", "drift.0.param", "drift.0.status", "drift.1.status",
    ]) expect(keys.has(k), k).toBe(true);
    expect(keys.has(`escrow.${ID_CLAIMED}.id`)).toBe(false);
  });
  it("shows the census request as from to to", () => {
    expect(cellOf(html, "census.requested")?.text).toBe("0 to 100");
  });
});
