import { describe, expect, it } from "vitest";
import { PAGE_CSS, renderPage } from "../src/page.js";
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
    expect(html).toContain("partial totals escrows opened");
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

/** The rule for a key's label, written out again here on purpose (RULES section 5). */
function labelFor(key: string, partial: boolean): string {
  let rest = key;
  const m = /^(status\.|census\.|drift\.|escrow\.0x[0-9a-f]{64}\.)/.exec(key);
  if (m) rest = key.slice(m[1]!.length);
  const base = rest.replace(/[._]/g, " ");
  return key.startsWith("census.totals.") && partial ? "partial " + base : base;
}

describe("page rows and cards", () => {
  for (const [name, snap] of [["default", build()], ["reset", buildReset()], ["no census or drift", build({ census: null, drift: null })]] as const) {
    const h = renderPage(snap);
    const partial = snap.census !== null && snap.census.status !== "complete";
    it(`${name}: every labeled row is one th and one td, data-for equals the td key, label follows the rule`, () => {
      const rows = [...h.matchAll(/<tr><th scope="row" data-for="([^"]*)">([^<]*)<\/th><td data-k="([^"]*)"/g)];
      expect(rows.length).toBeGreaterThan(10);
      // every row with a th in a row position is accounted for
      expect((h.match(/<th scope="row"/g) ?? []).length).toBe(rows.length);
      for (const r of rows) {
        expect(r[3], r[2]).toBe(r[1]);
        expect(r[2], r[1]).toBe(labelFor(r[1]!, partial));
      }
    });
    it(`${name}: every td carries data-k`, () => {
      expect((h.match(/<td\b/g) ?? []).length).toBe((h.match(/<td data-k="/g) ?? []).length);
    });
    it(`${name}: each escrow card holds only its own cells`, () => {
      const cards = [...h.matchAll(/<div class="card" data-escrow="([^"]*)">(.*?)<\/table><\/div>/gs)];
      expect(cards.map((c) => c[1])).toEqual(snap.escrows.map((e) => e.escrow_id));
      for (const c of cards) {
        const keys = [...(c[2] as string).matchAll(/data-k="([^"]*)"/g)].map((k) => k[1] as string);
        expect(keys.length).toBeGreaterThan(5);
        for (const k of keys) expect(k.startsWith(`escrow.${c[1]}.`), `${k} in card ${c[1]}`).toBe(true);
        expect(keys).toContain(`escrow.${c[1]}.state`);
      }
    });
    it(`${name}: each drift row holds only its own cells`, () => {
      const rows = [...h.matchAll(/<tr data-row="([^"]*)">(.*?)<\/tr>/gs)];
      expect(rows.map((r) => r[1])).toEqual((snap.drift?.items ?? []).map((_, i) => `drift.${i}`));
      for (const r of rows) {
        const keys = [...(r[2] as string).matchAll(/data-k="([^"]*)"/g)].map((k) => k[1] as string);
        expect(keys.length).toBeGreaterThan(5);
        for (const k of keys) expect(k.startsWith(`${r[1]}.`), `${k} in ${r[1]}`).toBe(true);
      }
    });
  }
  it("the drift header row stays plain th cells", () => {
    expect(renderPage(buildReset())).toContain('<tr><th data-col="param">param</th><th data-col="spec">spec</th>');
  });
  it("a card's state cell is the card's own escrow state", () => {
    const h = renderPage(buildReset());
    for (const e of buildReset().escrows) {
      const card = new RegExp(`data-escrow="${e.escrow_id}">(.*?)</table></div>`, "s").exec(h)![1]!;
      expect(card).toContain(`data-k="escrow.${e.escrow_id}.state" data-v="${e.state}"`);
    }
  });
});

describe("page sections, columns and hidden content", () => {
  const sectionOf = (k: string) => (k.startsWith("status.") ? "status" : k.startsWith("escrow.") ? "escrow" : k.startsWith("census") ? "census" : k.startsWith("drift") ? "drift" : k.startsWith("snapshot.") ? "snapshot" : "?");
  for (const [name, snap] of [["default", build()], ["reset", buildReset()], ["null parts", build({ census: null, drift: null })]] as const) {
    const h = renderPage(snap);
    it(`${name}: every table has a data-section and holds only that section's keys`, () => {
      const tables = [...h.matchAll(/<table( [^>]*)?>(.*?)<\/table>/gs)];
      expect(tables.length).toBeGreaterThan(3);
      for (const t of tables) {
        const sec = /data-section="([^"]*)"/.exec(t[1] ?? "")?.[1];
        expect(["status", "escrow", "census", "drift"], String(sec)).toContain(sec);
        const keys = [...(t[2] as string).matchAll(/data-k="([^"]*)"/g)].map((k) => k[1] as string);
        expect(keys.length).toBeGreaterThan(0);
        for (const k of keys) expect(sectionOf(k), `${k} in ${sec} table`).toBe(sec);
      }
    });
    it(`${name}: no comments or hidden markup`, () => {
      expect(h).not.toMatch(/<!--|\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden/i);
    });
  }
  it("the drift header data-col order matches the cells of every row", () => {
    const h = renderPage(buildReset());
    const head = [...h.matchAll(/<th data-col="([^"]*)"/g)].map((m) => m[1]);
    expect(head).toEqual(["param", "spec", "runtime", "status", "note", "mapping", "unit", "expected", "runtime_path"]);
    const rows = [...h.matchAll(/<tr data-row="(drift\.\d+)">(.*?)<\/tr>/gs)];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      const keys = [...(r[2] as string).matchAll(/data-k="([^"]*)"/g)].map((k) => k[1]);
      expect(keys).toEqual(head.map((c) => `${r[1]}.${c}`));
    }
  });
  it("the status table holds the status reset row and the census table the census one", () => {
    const h = renderPage(buildReset());
    const st = /<table data-section="status">(.*?)<\/table>/s.exec(h)![1]!;
    const ce = /<table data-section="census">(.*?)<\/table>/s.exec(h)![1]!;
    expect(st).toMatch(/data-for="status.reset_detected">reset detected<\/th><td data-k="status.reset_detected" data-v="true"/);
    expect(ce).toMatch(/data-for="census.reset_detected">reset detected<\/th><td data-k="census.reset_detected" data-v="true"/);
  });
});

describe("the stylesheet hides nothing (IMD audit finding 12)", () => {
  // Every property the page's one stylesheet sets, each reviewed: none of them can hide a value,
  // shrink it to nothing or paint it invisible. A new property must be added here on purpose.
  const REVIEWED = new Set([
    "background", "border", "border-bottom", "border-collapse", "border-left", "border-radius", "box-sizing", "color",
    "font", "font-size", "font-weight", "margin", "margin-inline", "max-width", "overflow-x", "padding", "text-align",
    "vertical-align", "width", "word-break",
  ]);
  const declarations = [...PAGE_CSS.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)].map((m) => [m[1]!, m[2]!.trim()] as const);

  it("sets only reviewed properties, besides its own color variables", () => {
    const props = declarations.map(([p]) => p).filter((p) => !p.startsWith("--") && p !== "prefers-color-scheme");
    expect(props.length).toBeGreaterThan(20);
    expect(props.filter((p) => !REVIEWED.has(p))).toEqual([]);
  });

  it("never shrinks text or a box to nothing, paints it transparent or clips it", () => {
    for (const [p, v] of declarations) {
      if (["font", "font-size", "width", "max-width"].includes(p)) expect(`${p}: ${v}`).not.toMatch(/(?:^|[\s:])0(?:px|em|rem|%)?(?=[\s/]|$)/);
      expect(`${p}: ${v}`).not.toMatch(/transparent|hidden|clip/);
    }
  });

  it("is the one stylesheet on a rendered page", () => {
    const html = renderPage(build());
    expect(html.split("<style>")).toHaveLength(2);
    expect(html).toContain(`<style>${PAGE_CSS}</style>`);
  });
});
