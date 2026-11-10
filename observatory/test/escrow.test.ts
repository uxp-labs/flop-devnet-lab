// Tests for src/escrow.ts against RULES.md section 2. Fixtures only, no network.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ESCROW_SCOPE, escrowState, escrowStates, isHash32, pageProblem } from "../src/escrow.js";
import { FixtureSource } from "../src/source.js";
import type { EscrowState, EscrowStateOptions, EventPage, RawEvent } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "..", "fixtures");
const schemaPath = resolve(here, "..", "..", "interfaces", "escrow-state.v0.schema.json");

const G = "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631";
const OTHER = "0x" + "0f".repeat(32);
const A = "0x" + "a1".repeat(32);
const B = "0x" + "b2".repeat(32);
const bh = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32);

const opts: EscrowStateOptions = {
  pinnedGenesis: G,
  finalizedHeight: 1000,
  observedAt: "2026-11-10T00:00:00Z",
  trust: "fixture",
};

function ev(method: string, id: unknown, block: number, over: Partial<RawEvent> = {}): RawEvent {
  return {
    block_number: 100 + block,
    block_hash: bh(block),
    finalized: true,
    index: 0,
    section: "hasStation",
    method,
    data: { "0": id },
    ...over,
  };
}
function page(events: unknown[], genesis = G): EventPage {
  return { genesis, from_block: 100, to_block: 199, page: 0, next_page: null, events: events as RawEvent[] };
}

interface Expected {
  pinned_genesis: string;
  finalized_height: number | null;
  escrows: { id: string; state: string }[];
}
async function loadScenario(name: string) {
  const dir = join(fixturesDir, name);
  const src = FixtureSource.fromDir(dir);
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
  const pages = await src.eventPages();
  const o: EscrowStateOptions = {
    pinnedGenesis: expected.pinned_genesis,
    finalizedHeight: expected.finalized_height,
    observedAt: src.data.meta.now,
    trust: src.trust,
    unreadablePages: await src.eventPageErrors(),
  };
  return { dir, src, expected, pages, o };
}
const scenarios = readdirSync(fixturesDir).filter((n) => n.startsWith("escrows-")).sort();

// ---- tiny JSON Schema check (only the keywords the escrow schema uses) ----
type Schema = Record<string, unknown>;
function typeOk(t: string, v: unknown): boolean {
  if (t === "null") return v === null;
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number";
  if (t === "array") return Array.isArray(v);
  if (t === "object") return typeof v === "object" && v !== null && !Array.isArray(v);
  return typeof v === t;
}
function validate(schema: Schema, v: unknown, path = "$"): string[] {
  const errs: string[] = [];
  if ("const" in schema && v !== schema["const"]) errs.push(`${path}: not the const value`);
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(v)) errs.push(`${path}: not in enum`);
  if (schema["type"] !== undefined) {
    const types = Array.isArray(schema["type"]) ? (schema["type"] as string[]) : [schema["type"] as string];
    if (!types.some((t) => typeOk(t, v))) errs.push(`${path}: wrong type`);
  }
  if (typeof schema["pattern"] === "string" && typeof v === "string" && !new RegExp(schema["pattern"]).test(v)) {
    errs.push(`${path}: pattern`);
  }
  if (typeof schema["minimum"] === "number" && typeof v === "number" && v < schema["minimum"]) {
    errs.push(`${path}: below minimum`);
  }
  if (Array.isArray(v) && schema["items"]) {
    v.forEach((item, i) => errs.push(...validate(schema["items"] as Schema, item, `${path}[${i}]`)));
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    const props = (schema["properties"] ?? {}) as Record<string, Schema>;
    for (const r of (schema["required"] ?? []) as string[]) if (!(r in obj)) errs.push(`${path}: missing ${r}`);
    for (const [k, val] of Object.entries(obj)) {
      if (props[k]) errs.push(...validate(props[k], val, `${path}.${k}`));
      else if (schema["additionalProperties"] === false) errs.push(`${path}: extra property ${k}`);
    }
  }
  return errs;
}

describe("fixture scenarios", () => {
  it("has all twenty-eight escrow scenarios", () => {
    expect(scenarios).toEqual([
      "escrows-block-number-disagrees",
      "escrows-broken-chain",
      "escrows-conflicting",
      "escrows-duplicate",
      "escrows-finality-disagrees",
      "escrows-gateway-report-only",
      "escrows-genesis-case",
      "escrows-invalid-page",
      "escrows-malformed",
      "escrows-negative-block-number",
      "escrows-no-block-number",
      "escrows-off-chain-release",
      "escrows-one-event-two-escrows",
      "escrows-opened-only",
      "escrows-other-genesis",
      "escrows-outside-page-range",
      "escrows-outside-range-copy-disagrees",
      "escrows-outside-range-refund-vs-claim",
      "escrows-outside-range-unparsable",
      "escrows-release-above-height",
      "escrows-two-opens-and-release",
      "escrows-unfinalized-only",
      "escrows-unparsable-copies-disagree",
      "escrows-unparsable-copy-disagrees",
      "escrows-unreadable-page",
      "escrows-unsafe-index",
      "escrows-unsafe-page-range",
      "escrows-verification",
    ]);
  });

  for (const name of scenarios) {
    it(`${name}: states match expected.json`, async () => {
      const { src, expected, pages, o } = await loadScenario(name);
      // Only the unreadable-page scenario may have files that do not parse.
      const unreadable = await src.eventPageErrors();
      expect(src.data.loadErrors).toEqual(unreadable);
      expect(unreadable.length).toBe(name === "escrows-unreadable-page" ? 1 : 0);
      // meta.json lists the same ids and the pinned genesis, for check.sh and the CLI.
      const meta = src.data.meta as unknown as { escrow_ids?: string[]; pinned_genesis?: string };
      expect(meta.escrow_ids).toEqual(expected.escrows.map((e) => e.id));
      expect(meta.pinned_genesis).toBe(expected.pinned_genesis);
      expect(expected.escrows.length).toBeGreaterThan(0);
      const got = escrowStates(expected.escrows.map((e) => e.id), pages, o);
      expect(got.map((g) => [g.escrow_id, g.state])).toEqual(expected.escrows.map((e) => [e.id, e.state]));
    });
  }

  it("every fixture output is valid against interfaces/escrow-state.v0.schema.json", async () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Schema;
    let checked = 0;
    for (const name of scenarios) {
      const { expected, pages, o } = await loadScenario(name);
      for (const s of escrowStates(expected.escrows.map((e) => e.id), pages, o)) {
        expect(validate(schema, s), `${name} ${s.escrow_id}`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(46);
  });

  it("the schema check itself rejects bad objects", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Schema;
    const good = escrowState(A, [page([ev("EscrowOpened", A, 1)])], opts);
    expect(validate(schema, good)).toEqual([]);
    expect(validate(schema, { ...good, state: "settled" })).not.toEqual([]);
    expect(validate(schema, { ...good, scope: "all good" })).not.toEqual([]);
    expect(validate(schema, { ...good, extra: 1 })).not.toEqual([]);
    expect(validate(schema, { ...good, finalized_height: "1000" })).not.toEqual([]);
    const { trust: _t, ...noTrust } = good;
    expect(validate(schema, noTrust)).not.toEqual([]);
    const badEvidence = { ...good, evidence: [{ ...good.evidence[0], block_hash: "0x12" }] };
    expect(validate(schema, badEvidence)).not.toEqual([]);
  });
});

describe("verification fixture (ids and block hashes from tclk/flop/VERIFICATION.md)", () => {
  it("reports the claim as claimed and the refund as refunded, with the recorded blocks", async () => {
    const { expected, pages, o, src } = await loadScenario("escrows-verification");
    const [claim, refund, none] = escrowStates(expected.escrows.map((e) => e.id), pages, o) as [EscrowState, EscrowState, EscrowState];
    expect(none.state).toBe("unverified");
    expect(none.evidence).toEqual([]);
    expect(claim.escrow_id).toBe("0x6fca0e2333da351600475a298ff0bd15acc42933b1ea6873ced2c15910e2cac5");
    expect(claim.state).toBe("claimed");
    expect(claim.evidence).toEqual([
      {
        event: "hasStation.EscrowReleased",
        block_hash: "0xeafcbbc66e68895b686dd3ab5ac647db41dba785cabd740e53a2727256b5794a",
        block_number: null,
        event_index: 0,
        genesis: G,
      },
    ]);
    expect(refund.escrow_id).toBe("0x222eb1c4dc1aee313d4e89e29ce89299cf0fb8ea16739872da21f68e78a5f851");
    expect(refund.state).toBe("refunded");
    expect(refund.evidence[0]?.event).toBe("hasStation.EscrowRefunded");
    expect(refund.evidence[0]?.block_hash).toBe("0xfefa385a2438805f23e260cfb9bf66efcecdb463e065b1de896f402f666dd538");
    // Unknown stays null, and fixture data is never labeled as a live read.
    expect(claim.finalized_height).toBeNull();
    expect(claim.trust).toBe("fixture");
    expect(src.data.meta.synthetic).toBe(true);
    expect(src.data.meta.description).toContain("synthetic");
  });
});

describe("finalized only", () => {
  it("an unfinalized open and release leave the escrow unverified", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1, { finalized: false }), ev("EscrowReleased", A, 2, { finalized: false })])], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes.join(" ")).toContain("not finalized");
  });
  it("a finalized open with an unfinalized release is funded, not claimed", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2, { finalized: false })])], opts);
    expect(s.state).toBe("funded");
    expect(s.evidence.map((e) => e.event)).toEqual(["hasStation.EscrowOpened"]);
  });
  it("an event above the finalized height does not count", () => {
    // Inside the page's range (100 to 199) but above the finalized height.
    const low = { ...opts, finalizedHeight: 150 };
    const s = escrowState(A, [page([ev("EscrowReleased", A, 2, { block_number: 160 })])], low);
    expect(s.state).toBe("unverified");
    expect(s.notes.join(" ")).toContain("above the finalized height");
    expect(escrowState(A, [page([ev("EscrowReleased", A, 2, { block_number: 150 })])], low).state).toBe("claimed");
  });
});

describe("pinned genesis only", () => {
  it("events on another genesis are excluded and noted", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2)], OTHER)], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes.join(" ")).toContain("another genesis");
  });
  it("another genesis cannot upgrade a funded escrow", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1)]), page([ev("EscrowReleased", A, 2)], OTHER)], opts);
    expect(s.state).toBe("funded");
    expect(s.evidence.every((e) => e.genesis === G)).toBe(true);
  });
  const upper = (h: string) => "0x" + h.slice(2).toUpperCase();
  it("escrow ids are matched without regard to case", () => {
    const s = escrowState(upper(A), [page([ev("EscrowOpened", upper(A), 1)])], opts);
    expect(s.state).toBe("funded");
    expect(s.escrow_id).toBe(A);
  });
  it("genesis is compared exactly: the pinned genesis in upper case is another genesis", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2)], upper(G))], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes.join(" ")).toContain("another genesis");
  });
  it("a pinned genesis that is not lower case hex verifies nothing", () => {
    const s = escrowState(A, [page([ev("EscrowReleased", A, 2)], upper(G))], { ...opts, pinnedGenesis: upper(G) });
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
  });
  it("block hashes are compared exactly: an upper case block hash is malformed, never evidence", () => {
    const s = escrowState(A, [page([{ ...ev("EscrowReleased", A, 2), block_hash: upper(bh(171)) }])], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes.some((n) => n.startsWith("malformed event ignored"))).toBe(true);
  });
  it("fixture: the pinned genesis in upper case does not count", async () => {
    const { expected, pages, o } = await loadScenario("escrows-genesis-case");
    const [a] = escrowStates(expected.escrows.map((e) => e.id), pages, o) as [EscrowState];
    expect(a.state).toBe("unverified");
    expect(a.notes.join(" ")).toContain("another genesis");
  });
  it("a pinned genesis that does not parse verifies nothing", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1)], "devnet")], { ...opts, pinnedGenesis: "devnet" });
    expect(s.state).toBe("unverified");
  });
});

describe("dedupe by (genesis, block_hash, index)", () => {
  it("the same release seen three times counts once", () => {
    const rel = ev("EscrowReleased", A, 2);
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), rel, rel]), page([rel])], opts);
    expect(s.state).toBe("claimed");
    expect(s.evidence.map((e) => e.event)).toEqual(["hasStation.EscrowOpened", "hasStation.EscrowReleased"]);
    expect(s.notes).toContain("2 duplicate events counted once");
  });
  it("two distinct releases for one escrow are a conflict", () => {
    const s = escrowState(A, [page([ev("EscrowReleased", A, 2), ev("EscrowReleased", A, 3)])], opts);
    expect(s.state).toBe("unverified");
  });
  it("two different events with one identity are a conflict", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 1)])], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes.join(" ")).toContain("copies of one event disagree");
  });
});

describe("state rules", () => {
  it("funded needs a finalized open and no terminal event", () => {
    expect(escrowState(A, [page([ev("EscrowOpened", A, 1)])], opts).state).toBe("funded");
  });
  it("claimed needs a finalized release", () => {
    expect(escrowState(A, [page([ev("EscrowReleased", A, 2)])], opts).state).toBe("claimed");
  });
  it("refunded needs a finalized refund", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowRefunded", A, 3)])], opts);
    expect(s.state).toBe("refunded");
    expect(s.evidence.map((e) => e.event)).toEqual(["hasStation.EscrowOpened", "hasStation.EscrowRefunded"]);
  });
  it("no events at all is unverified with a note", () => {
    const s = escrowState(A, [], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toEqual(["no finalized hasStation event for this escrow on the pinned genesis"]);
  });
  it("events for another escrow do not count", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", B, 1), ev("EscrowReleased", B, 2)])], opts);
    expect(s.state).toBe("unverified");
  });
  it("both a release and a refund leave it unverified with a note and no evidence", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2), ev("EscrowRefunded", A, 3)])], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes.join(" ")).toContain("both a finalized release and a finalized refund");
  });
  it("only hasStation events count, whatever the method is called", () => {
    const s = escrowState(A, [page([ev("EscrowReleased", A, 2, { section: "gateway" })])], opts);
    expect(s.state).toBe("unverified");
  });
});

describe("malformed events", () => {
  const bad: [string, unknown][] = [
    ["short escrow id", ev("EscrowReleased", "0x1234", 2)],
    ["id of the wrong type", ev("EscrowReleased", 12345, 2)],
    ["missing data", { ...ev("EscrowReleased", A, 2), data: undefined }],
    ["index as a string", { ...ev("EscrowReleased", A, 2), index: "0" }],
    ["short block hash", { ...ev("EscrowReleased", A, 2), block_hash: "0x12" }],
    ["block number as a string", { ...ev("EscrowReleased", A, 2), block_number: "120" }],
    ["id fields that disagree", { ...ev("EscrowReleased", A, 2), data: { "0": A, escrow_id: B } }],
  ];
  for (const [label, event] of bad) {
    it(`${label}: never makes an escrow claimed`, () => {
      const s = escrowState(A, [page([event])], opts);
      expect(s.state).toBe("unverified");
      expect(s.evidence).toEqual([]);
      expect(s.notes.some((n) => n.startsWith("malformed event ignored"))).toBe(true);
    });
  }
  it("a malformed open never makes an escrow funded", () => {
    const s = escrowState(A, [page([{ ...ev("EscrowOpened", A, 1), index: null }])], opts);
    expect(s.state).toBe("unverified");
  });
  it("a malformed open is ignored with a note and does not disturb clean evidence", () => {
    const s = escrowState(A, [page([ev("EscrowReleased", A, 2), ev("EscrowOpened", "0x12", 5)])], opts);
    expect(s.state).toBe("claimed");
    expect(s.notes.some((n) => n.startsWith("malformed event ignored"))).toBe(true);
  });
  it("a finalized release whose id does not parse conflicts with funded", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", "0x1234", 2)])], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes.join(" ")).toContain("conflicting evidence");
  });
  it("a finalized refund whose id does not parse conflicts with claimed", () => {
    const s = escrowState(A, [page([ev("EscrowReleased", A, 2), ev("EscrowRefunded", "nope", 3)])], opts);
    expect(s.state).toBe("unverified");
  });
  it("an unfinalized malformed release does not conflict", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", "0x1234", 2, { finalized: false })])], opts);
    expect(s.state).toBe("funded");
  });
  it("a malformed event naming another valid escrow is not about this one", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), { ...ev("EscrowReleased", B, 2), index: "x" }])], opts);
    expect(s.state).toBe("funded");
    expect(s.notes).toEqual([]);
  });
  it("an escrow id that does not parse is never looked up", () => {
    const s = escrowState("0x1234", [page([ev("EscrowReleased", "0x1234", 2)])], opts);
    expect(s.state).toBe("unverified");
    expect(s.escrow_id).toBe("0x1234");
  });
  it("a missing or non boolean finalized flag means not finalized", () => {
    for (const flag of ["true", 1, null, undefined]) {
      const s = escrowState(A, [page([{ ...ev("EscrowReleased", A, 2), finalized: flag }])], opts);
      expect(s.state).toBe("unverified");
      expect(s.evidence).toEqual([]);
      expect(s.notes.join(" ")).toContain("not finalized");
    }
  });
  it("isHash32 accepts only 0x plus 64 hex", () => {
    expect(isHash32(A)).toBe(true);
    expect(isHash32(A + "00")).toBe(false);
    expect(isHash32(A.slice(2))).toBe(false);
    expect(isHash32("0x" + "zz".repeat(32))).toBe(false);
    expect(isHash32(null)).toBe(false);
  });
});

describe("gateway reports are not chain proof", () => {
  it("a gateway settled report passed alongside the pages changes nothing", async () => {
    const { dir, expected, pages, o } = await loadScenario("escrows-gateway-report-only");
    const reportPath = join(dir, "gateway-report.json");
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    expect(report["state"]).toBe("settled");
    const id = expected.escrows[0]!.id;
    expect(report["escrow_id"]).toBe(id);

    const without = escrowState(id, pages, o);
    // Smuggle the report in every way a caller could: as an extra option, as an extra
    // page, and as an extra property on a real page.
    const smuggledOpts = { ...o, gatewayReport: report, receipts: [report] } as EscrowStateOptions;
    const smuggledPages = [
      ...pages.map((p) => ({ ...p, gateway_report: report })),
      report as unknown as EventPage,
    ];
    const withReport = escrowState(id, smuggledPages, smuggledOpts);
    expect(without.state).toBe("unverified");
    expect(withReport.state).toBe("unverified");
    expect(withReport.evidence).toEqual([]);
    expect({ ...withReport, notes: [] }).toEqual({ ...without, notes: [] });
  });
  it("a gateway report cannot upgrade funded to claimed either", () => {
    const report = { state: "settled", escrow_id: A, chain_final: true };
    const pages = [{ ...page([ev("EscrowOpened", A, 1)]), gateway_report: report }];
    const s = escrowState(A, pages, { ...opts, gatewayReport: report } as EscrowStateOptions);
    expect(s.state).toBe("funded");
    // Passed as a page of its own it is an invalid page: nothing is verified, and never claimed.
    const asPage = escrowState(A, [...pages, report as unknown as EventPage], opts);
    expect(asPage.state).toBe("unverified");
    expect(asPage.evidence).toEqual([]);
  });
  it("escrowState takes exactly three parameters", () => {
    expect(escrowState.length).toBe(3);
  });
});

describe("every result", () => {
  it("carries the fixed scope, schema, observed_at, trust and finalized height", () => {
    const all = [
      escrowState(A, [], opts),
      escrowState(A, [page([ev("EscrowOpened", A, 1)])], opts),
      escrowState(A, [page([ev("EscrowReleased", A, 2)])], opts),
      escrowState(A, [page([ev("EscrowRefunded", A, 3)])], opts),
      escrowState("bad", [], opts),
    ];
    for (const s of all) {
      expect(s.scope).toBe("settlement only; says nothing about output quality");
      expect(s.scope).toBe(ESCROW_SCOPE);
      expect(s.schema).toBe("flop-observatory/escrow-state@0");
      expect(s.observed_at).toBe(opts.observedAt);
      expect(s.trust).toBe("fixture");
      expect(s.finalized_height).toBe(1000);
    }
  });
  it("an unknown finalized height stays null, never 0", () => {
    expect(escrowState(A, [], { ...opts, finalizedHeight: null }).finalized_height).toBeNull();
  });
  it("is deterministic and does not change its inputs", () => {
    const pages = [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2)])];
    const before = JSON.stringify(pages);
    const one = escrowState(A, pages, opts);
    const two = escrowState(A, pages, opts);
    expect(one).toEqual(two);
    expect(JSON.stringify(pages)).toBe(before);
  });
  it("escrowStates keeps the order of the ids", () => {
    const pages = [page([ev("EscrowOpened", A, 1), ev("EscrowRefunded", B, 2)])];
    expect(escrowStates([B, A], pages, opts).map((s) => [s.escrow_id, s.state])).toEqual([
      [B, "refunded"],
      [A, "funded"],
    ]);
  });
});

describe("one event is never evidence for two escrows", () => {
  it("the same identity naming two escrows leaves both unverified and names the event", () => {
    const pages = [page([ev("EscrowReleased", A, 9), ev("EscrowReleased", B, 9)])];
    const [a, b] = escrowStates([A, B], pages, opts) as [EscrowState, EscrowState];
    for (const s of [a, b]) {
      expect(s.state).toBe("unverified");
      expect(s.evidence).toEqual([]);
      expect(s.notes.join(" ")).toContain("copies of one event disagree");
      expect(s.notes.join(" ")).toContain(`block ${bh(9)}, index 0`);
    }
  });
  it("the order of the copies does not matter, also across pages", () => {
    const one = escrowStates([A, B], [page([ev("EscrowReleased", B, 9)]), page([ev("EscrowReleased", A, 9)])], opts);
    expect(one.map((s) => s.state)).toEqual(["unverified", "unverified"]);
  });
  it("a split event overrides clean evidence for the escrows it names", () => {
    const pages = [page([ev("EscrowOpened", A, 1), ev("EscrowRefunded", A, 9), ev("EscrowRefunded", B, 9)])];
    expect(escrowState(A, pages, opts).state).toBe("unverified");
  });
  it("an escrow the split event does not name is not affected", () => {
    const C = "0x" + "c3".repeat(32);
    const pages = [page([ev("EscrowReleased", A, 9), ev("EscrowReleased", B, 9), ev("EscrowReleased", C, 10)])];
    const s = escrowState(C, pages, opts);
    expect(s.state).toBe("claimed");
    expect(s.notes).toEqual([]);
  });
  it("copies that disagree on method are a conflict", () => {
    const s = escrowState(A, [page([ev("EscrowReleased", A, 9), ev("EscrowRefunded", A, 9)])], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes.join(" ")).toContain("copies of one event disagree");
  });
  it("copies that disagree on section are a conflict", () => {
    const s = escrowState(A, [page([ev("EscrowReleased", A, 9), ev("EscrowReleased", A, 9, { section: "gateway" })])], opts);
    expect(s.state).toBe("unverified");
  });
  it("fixture: a1 and b2 unverified, c3 claimed", async () => {
    const { expected, pages, o } = await loadScenario("escrows-one-event-two-escrows");
    const got = escrowStates(expected.escrows.map((e) => e.id), pages, o);
    expect(got.map((g) => g.state)).toEqual(["unverified", "unverified", "claimed"]);
    expect(got[0]?.evidence).toEqual([]);
    expect(got[1]?.evidence).toEqual([]);
  });
});

describe("any unfinalized copy makes the event pending", () => {
  it("a release read finalized once and unfinalized once is not proof", () => {
    const pages = [page([ev("EscrowReleased", A, 2)]), page([ev("EscrowReleased", A, 2, { finalized: false })])];
    const s = escrowState(A, pages, opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes.join(" ")).toContain("not finalized: pending, not proof");
  });
  it("with a finalized open it is funded with a pending note, in either order", () => {
    const fin = ev("EscrowReleased", A, 2);
    const unfin = ev("EscrowReleased", A, 2, { finalized: false });
    for (const copies of [[fin, unfin], [unfin, fin]]) {
      const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ...copies])], opts);
      expect(s.state).toBe("funded");
      expect(s.evidence.map((e) => e.event)).toEqual(["hasStation.EscrowOpened"]);
      expect(s.notes).toContain("1 event for this escrow not finalized: pending, not proof");
    }
  });
  it("fixture: a1 funded with a pending note, b2 unverified", async () => {
    const { expected, pages, o } = await loadScenario("escrows-finality-disagrees");
    const [a, b] = escrowStates(expected.escrows.map((e) => e.id), pages, o) as [EscrowState, EscrowState];
    expect(a.state).toBe("funded");
    expect(a.notes.join(" ")).toContain("pending, not proof");
    expect(b.state).toBe("unverified");
  });
});

describe("unreadable or invalid pages verify nothing", () => {
  const good = [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2)])];
  it("control: the readable page alone would say claimed", () => {
    expect(escrowState(A, good, opts).state).toBe("claimed");
  });
  it("an unreadable page makes every escrow unverified and names the file", () => {
    const o = { ...opts, unreadablePages: ["event-pages/001.json: Unexpected end of JSON input"] };
    const got = escrowStates([A, B], good, o);
    for (const s of got) {
      expect(s.state).toBe("unverified");
      expect(s.evidence).toEqual([]);
      expect(s.notes.join(" ")).toContain("event-pages/001.json");
    }
  });
  it("an empty unreadablePages list changes nothing", () => {
    expect(escrowState(A, good, { ...opts, unreadablePages: [] }).state).toBe("claimed");
  });
  it("fixture: the loader reports the bad file and every escrow is unverified", async () => {
    const { src, expected, pages, o } = await loadScenario("escrows-unreadable-page");
    const errors = await src.eventPageErrors();
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("001.json");
    // The readable page alone, as a complete chain, would say claimed. That is the bug this rule
    // closes. With its own next_page 1 the chain is broken without the missing page as well.
    expect(escrowState(A, pages.map((p) => ({ ...p, next_page: null })), { ...o, unreadablePages: [] }).state).toBe("claimed");
    const blind = escrowState(A, pages, { ...o, unreadablePages: [] });
    expect(blind.state).toBe("unverified");
    expect(blind.notes.join(" ")).toContain("next_page 1 on page 0 names a page that does not exist");
    const got = escrowStates(expected.escrows.map((e) => e.id), pages, o);
    for (const s of got) {
      expect(s.state).toBe("unverified");
      expect(s.notes.join(" ")).toContain("001.json");
    }
  });
  const invalidPages: [string, unknown][] = [
    ["not an object", "junk"],
    ["genesis not a string", { ...page([]), genesis: 5 }],
    ["from_block missing", { ...page([]), from_block: undefined }],
    ["to_block of the wrong type", { ...page([]), to_block: "199" }],
    ["page missing", { ...page([]), page: undefined }],
    ["next_page of the wrong type", { ...page([]), next_page: "1" }],
    ["negative page", { ...page([]), page: -1 }],
    ["events not a list", { ...page([]), events: {} }],
    ["inverted range", { ...page([]), from_block: 200, to_block: 100 }],
  ];
  for (const [label, bad] of invalidPages) {
    it(`invalid page (${label}) makes every escrow unverified and names the page`, () => {
      expect(pageProblem(bad)).not.toBeNull();
      const s = escrowState(A, [...good, bad as EventPage], opts);
      expect(s.state).toBe("unverified");
      expect(s.evidence).toEqual([]);
      expect(s.notes.join(" ")).toContain("page at position 1");
    });
  }
  it("a page with no next_page key at all is invalid, null is valid", () => {
    const { next_page: _n, ...noNext } = page([]);
    expect(pageProblem(noNext)).not.toBeNull();
    expect(pageProblem(page([]))).toBeNull();
  });
  it("the note names the page by position and range", () => {
    const s = escrowState(A, [...good, { ...page([]), from_block: 200, to_block: 100, page: 3 } as EventPage], opts);
    expect(s.notes).toEqual([
      "event page is invalid, so nothing is verified: page at position 1 (blocks 200 to 100, page 3): block range is inverted",
    ]);
  });
  it("fixture: a page without to_block makes every escrow unverified", async () => {
    const { expected, pages, o } = await loadScenario("escrows-invalid-page");
    expect(pages.length).toBe(2);
    expect(escrowState(A, [{ ...pages[0]!, next_page: null }], o).state).toBe("claimed");
    expect(escrowState(A, pages.slice(0, 1), o).state).toBe("unverified");
    const got = escrowStates(expected.escrows.map((e) => e.id), pages, o);
    for (const s of got) {
      expect(s.state).toBe("unverified");
      expect(s.notes.join(" ")).toContain("page at position 1");
    }
  });
});

describe("copies of one event must agree on block_number", () => {
  it("two different numbers are a conflict, with a note naming the event", () => {
    const pages = [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2, { block_number: 120 }), ev("EscrowReleased", A, 2, { block_number: 121 })])];
    const s = escrowState(A, pages, opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes.join(" ")).toContain("copies of one event disagree on section, method, escrow id, block number or account");
    expect(s.notes.join(" ")).toContain(`block ${bh(2)}, index 0`);
  });
  it("null against a number is a conflict, in either order", () => {
    const withNumber = ev("EscrowReleased", A, 2, { block_number: 120 });
    const withNull = ev("EscrowReleased", A, 2, { block_number: null });
    for (const copies of [[withNumber, withNull], [withNull, withNumber]]) {
      expect(escrowState(A, [page(copies)], opts).state).toBe("unverified");
    }
  });
  it("a copy above the finalized height cannot hide behind a lower number", () => {
    const pages = [page([ev("EscrowReleased", A, 2, { block_number: 120 }), ev("EscrowReleased", A, 2, { block_number: 160 })])];
    expect(escrowState(A, pages, { ...opts, finalizedHeight: 150 }).state).toBe("unverified");
  });
  it("control: copies that agree, both null or both the same number, still count once", () => {
    const same = ev("EscrowReleased", A, 2, { block_number: 120 });
    expect(escrowState(A, [page([same, same])], opts).state).toBe("claimed");
    const nulls = ev("EscrowReleased", A, 2, { block_number: null });
    expect(escrowState(A, [page([nulls, nulls])], opts).state).toBe("claimed");
  });
  it("fixture: a1 and b2 unverified, c3 claimed", async () => {
    const { expected, pages, o } = await loadScenario("escrows-block-number-disagrees");
    const got = escrowStates(expected.escrows.map((e) => e.id), pages, o);
    expect(got.map((g) => g.state)).toEqual(["unverified", "unverified", "claimed"]);
    expect(got[0]?.notes.join(" ")).toContain("block number");
    expect(got[1]?.notes.join(" ")).toContain("block number");
  });
});

describe("an unparsable terminal copy counts whatever the other copies say", () => {
  const badRelease = ev("EscrowReleased", "0x12", 9);
  it("control: alone it leaves a funded escrow unverified", () => {
    const s = escrowState(B, [page([ev("EscrowOpened", B, 1), badRelease])], opts);
    expect(s.state).toBe("unverified");
  });
  it("with a well formed copy naming another escrow, both are unverified", () => {
    const pages = [page([ev("EscrowOpened", B, 1), badRelease, ev("EscrowReleased", A, 9)])];
    const [a, b] = escrowStates([A, B], pages, opts) as [EscrowState, EscrowState];
    expect(a.state).toBe("unverified");
    expect(b.state).toBe("unverified");
    expect(b.evidence).toEqual([]);
    expect(b.notes.join(" ")).toContain("a malformed finalized terminal event could be about this escrow");
  });
  it("copy order does not matter", () => {
    const pages = [page([ev("EscrowReleased", A, 9), badRelease, ev("EscrowOpened", B, 1)])];
    expect(escrowState(B, pages, opts).state).toBe("unverified");
  });
  it("two unparsable copies that disagree on method both count", () => {
    const pages = [page([ev("EscrowOpened", B, 1), badRelease, ev("EscrowRefunded", "0x34", 9)])];
    const s = escrowState(B, pages, opts);
    expect(s.state).toBe("unverified");
    expect(s.notes.join(" ")).toContain("conflicting evidence");
  });
  it("an unparsable refund copy in a disagreeing group contradicts a claimed escrow", () => {
    const pages = [page([ev("EscrowReleased", B, 2), ev("EscrowRefunded", "0x34", 9), ev("EscrowRefunded", A, 9)])];
    expect(escrowState(B, pages, opts).state).toBe("unverified");
  });
  it("fixtures: every escrow is unverified", async () => {
    for (const name of ["escrows-unparsable-copy-disagrees", "escrows-unparsable-copies-disagree"]) {
      const { expected, pages, o } = await loadScenario(name);
      for (const s of escrowStates(expected.escrows.map((e) => e.id), pages, o)) {
        expect(s.state, name).toBe("unverified");
        expect(s.evidence).toEqual([]);
      }
    }
  });
});

describe("conflict rules for distinct events", () => {
  it("an open plus two distinct finalized refunds is unverified", () => {
    const pages = [page([ev("EscrowOpened", A, 1), ev("EscrowRefunded", A, 2), ev("EscrowRefunded", A, 3)])];
    const s = escrowState(A, pages, opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes).toContain("conflicting evidence: more than one distinct finalized refund for this escrow");
  });
  it("an open plus two distinct finalized releases is unverified", () => {
    const pages = [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2), ev("EscrowReleased", A, 3)])];
    const s = escrowState(A, pages, opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain("conflicting evidence: more than one distinct finalized release for this escrow");
  });
  it("two distinct finalized opens are unverified, with a note that says so", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowOpened", A, 2)])], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes).toEqual(["conflicting evidence: more than one distinct finalized open for this escrow"]);
  });
  it("a refund plus a malformed finalized release is unverified", () => {
    const pages = [page([ev("EscrowRefunded", A, 3), { ...ev("EscrowReleased", A, 2), index: "0" }])];
    const s = escrowState(A, pages, opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes).toContain("conflicting evidence: a malformed finalized release could be about this escrow");
  });
  it("a release plus a malformed finalized refund is unverified", () => {
    const pages = [page([ev("EscrowReleased", A, 2), { ...ev("EscrowRefunded", A, 3), index: "0" }])];
    const s = escrowState(A, pages, opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain("conflicting evidence: a malformed finalized refund could be about this escrow");
  });
  it("a refund plus a malformed finalized refund is unverified: the malformed one could be a second refund", () => {
    const pages = [page([ev("EscrowRefunded", A, 3), { ...ev("EscrowRefunded", A, 4), index: "0" }])];
    const s = escrowState(A, pages, opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain("conflicting evidence: a malformed finalized refund could be about this escrow");
  });
  it("an open and a release plus a finalized release whose id does not parse is unverified, as two distinct releases are (IMD follow-up audit)", () => {
    const bad = { ...ev("EscrowReleased", A, 5), data: { "0": "not-an-id" } };
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2), bad])], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain("conflicting evidence: a malformed finalized release could be about this escrow");
    const two = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2), ev("EscrowReleased", A, 5)])], opts);
    expect(two.state).toBe("unverified");
    const refundBad = { ...ev("EscrowRefunded", A, 6), data: { "0": "not-an-id" } };
    expect(escrowState(A, [page([ev("EscrowRefunded", A, 3), refundBad])], opts).state).toBe("unverified");
  });
});

describe("an event outside its page's block range is never evidence, and it is suspect", () => {
  const C = "0x" + "c3".repeat(32);
  const noted = "1 event outside its page's block range: never evidence";
  it("a finalized release above the page range does not claim, and leaves the escrow unverified", () => {
    const pages = [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2, { block_number: 500 })])];
    const s = escrowState(A, pages, opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes).toContain(noted);
    expect(s.notes.join(" ")).toContain("a finalized release outside its page's block range names this escrow");
  });
  it("a finalized release below the page range does not claim either", () => {
    const s = escrowState(A, [page([ev("EscrowReleased", A, 2, { block_number: 99 })])], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain(noted);
  });
  it("a finalized refund out of range overrides a clean claim, but only for the escrow it names", () => {
    const pages = [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2), ev("EscrowRefunded", A, 3, { block_number: 500 }), ev("EscrowReleased", C, 4)])];
    const a = escrowState(A, pages, opts);
    expect(a.state).toBe("unverified");
    expect(a.evidence).toEqual([]);
    expect(a.notes.join(" ")).toContain("a finalized refund outside its page's block range names this escrow");
    const c = escrowState(C, pages, opts);
    expect(c.state).toBe("claimed");
    expect(c.notes).toEqual([]);
  });
  it("control: without the out of range refund the escrow is claimed", () => {
    expect(escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2)])], opts).state).toBe("claimed");
  });
  it("an out of range open is ignored with a note and funds nothing", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1, { block_number: 500 })])], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain(noted);
    expect(s.notes.join(" ")).not.toContain("conflicting evidence");
  });
  it("an out of range unfinalized release does not conflict with funded", () => {
    const pages = [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2, { block_number: 500, finalized: false })])];
    expect(escrowState(A, pages, opts).state).toBe("funded");
  });
  it("an out of range copy still counts for the copy agreement rule (x10)", () => {
    const pages = [page([ev("EscrowReleased", A, 9, { block_number: 150 })]), page([ev("EscrowReleased", B, 9, { block_number: 250 })])];
    const [a, b] = escrowStates([A, B], pages, opts) as [EscrowState, EscrowState];
    expect(a.state).toBe("unverified");
    expect(a.evidence).toEqual([]);
    expect(a.notes.join(" ")).toContain("copies of one event disagree");
    expect(b.state).toBe("unverified");
  });
  it("an out of range unparsable finalized release still contradicts funded (x11)", () => {
    const pages = [page([ev("EscrowOpened", B, 1), ev("EscrowReleased", "0x12", 9, { block_number: 500 })])];
    const s = escrowState(B, pages, opts);
    expect(s.state).toBe("unverified");
    expect(s.notes.join(" ")).toContain("a malformed finalized terminal event could be about this escrow");
  });
  it("the edges of the range are inside", () => {
    expect(escrowState(A, [page([ev("EscrowReleased", A, 2, { block_number: 100 })])], opts).state).toBe("claimed");
    expect(escrowState(A, [page([ev("EscrowReleased", A, 2, { block_number: 199 })])], opts).state).toBe("claimed");
  });
  it("a null block number is kept", () => {
    expect(escrowState(A, [page([ev("EscrowReleased", A, 2, { block_number: null })])], opts).state).toBe("claimed");
  });
  it("fixtures: out of range events never give funded, claimed or refunded to the escrows they touch", async () => {
    const want: Record<string, string[]> = {
      "escrows-outside-page-range": ["unverified", "unverified", "unverified"],
      "escrows-outside-range-copy-disagrees": ["unverified", "unverified"],
      "escrows-outside-range-unparsable": ["unverified"],
      "escrows-outside-range-refund-vs-claim": ["unverified", "claimed"],
    };
    for (const [name, states] of Object.entries(want)) {
      const { expected, pages, o } = await loadScenario(name);
      const got = escrowStates(expected.escrows.map((e) => e.id), pages, o);
      expect(got.map((g) => g.state), name).toEqual(states);
    }
  });
});

describe("evidence without a finalized height says so", () => {
  const unbounded = "evidence is not bounded by a finalized height: no finalized height from an RPC head on the pinned genesis";
  it("a result with evidence and a null height carries the note", () => {
    const s = escrowState(A, [page([ev("EscrowReleased", A, 2)])], { ...opts, finalizedHeight: null });
    expect(s.state).toBe("claimed");
    expect(s.finalized_height).toBeNull();
    expect(s.notes).toContain(unbounded);
  });
  it("with a height there is no such note", () => {
    expect(escrowState(A, [page([ev("EscrowReleased", A, 2)])], opts).notes).toEqual([]);
  });
  it("an unverified result has no evidence, so no such note", () => {
    expect(escrowState(A, [], { ...opts, finalizedHeight: null }).notes).not.toContain(unbounded);
  });
  it("fixture: the verification escrows have no height and say so", async () => {
    const { expected, pages, o } = await loadScenario("escrows-verification");
    expect(o.finalizedHeight).toBeNull();
    const got = escrowStates(expected.escrows.map((e) => e.id), pages, o);
    expect(got[0]?.notes).toContain(unbounded);
    expect(got[1]?.notes).toContain(unbounded);
    expect(got[2]?.notes).not.toContain(unbounded);
  });
});

describe("unsafe integers (census clause 14)", () => {
  const UNSAFE = 9007199254740992; // 2^53, what JSON.parse makes of 9007199254740993
  it("the fixture files really hold the literal 9007199254740993, and parsing rounds it", () => {
    for (const name of ["escrows-unsafe-index", "escrows-unsafe-page-range"]) {
      const text = readFileSync(join(fixturesDir, name, "event-pages", "000.json"), "utf8");
      expect(text, name).toContain("9007199254740993");
      expect(text, name).not.toContain("9007199254740992");
      expect(JSON.stringify(JSON.parse(text)), name).toContain("9007199254740992");
    }
    const idx = readFileSync(join(fixturesDir, "escrows-unsafe-index", "event-pages", "000.json"), "utf8");
    expect(idx).toMatch(/"index": 9007199254740993,/);
    const rng = readFileSync(join(fixturesDir, "escrows-unsafe-page-range", "event-pages", "000.json"), "utf8");
    expect(rng).toMatch(/"to_block": 9007199254740993,/);
  });
  it("an event with an unsafe index is malformed, never evidence", () => {
    const s = escrowState(A, [page([{ ...ev("EscrowOpened", A, 1), index: UNSAFE }])], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes).toContain("malformed event ignored: hasStation.EscrowOpened (index is not a safe whole number)");
  });
  it("the largest safe index is fine", () => {
    const s = escrowState(A, [page([{ ...ev("EscrowOpened", A, 1), index: Number.MAX_SAFE_INTEGER }])], opts);
    expect(s.state).toBe("funded");
  });
  it("an event with an unsafe block_number is malformed, never evidence", () => {
    const wide = { ...page([{ ...ev("EscrowReleased", A, 2), block_number: UNSAFE }]), to_block: Number.MAX_SAFE_INTEGER };
    const s = escrowState(A, [wide], { ...opts, finalizedHeight: null });
    expect(s.state).toBe("unverified");
    expect(s.notes.some((n) => n.includes("block_number is not a safe integer or null"))).toBe(true);
  });
  it("fixture: the unsafe index leaves a1 unverified and b2 funded", async () => {
    const { expected, pages, o } = await loadScenario("escrows-unsafe-index");
    const [a, b] = escrowStates(expected.escrows.map((e) => e.id), pages, o) as [EscrowState, EscrowState];
    expect(a.state).toBe("unverified");
    expect(a.notes.join(" ")).toContain("index is not a safe whole number");
    expect(b.state).toBe("funded");
  });
  const unsafePages: [string, unknown][] = [
    ["from_block", { ...page([]), from_block: -UNSAFE }],
    ["to_block", { ...page([]), to_block: UNSAFE }],
    ["page", { ...page([]), page: UNSAFE }],
    ["next_page", { ...page([]), next_page: UNSAFE }],
  ];
  for (const [field, bad] of unsafePages) {
    it(`a page with an unsafe ${field} is invalid and verifies nothing`, () => {
      expect(pageProblem(bad)).not.toBeNull();
      const good = page([ev("EscrowReleased", A, 2)]);
      expect(escrowState(A, [good], opts).state).toBe("claimed");
      const s = escrowState(A, [good, bad as EventPage], opts);
      expect(s.state).toBe("unverified");
      expect(s.evidence).toEqual([]);
    });
  }
  it("fixture: the unsafe to_block makes every escrow unverified", async () => {
    const { expected, pages, o } = await loadScenario("escrows-unsafe-page-range");
    expect(pageProblem(pages[0])).toBe("to_block is missing or not a safe whole number");
    for (const s of escrowStates(expected.escrows.map((e) => e.id), pages, o)) {
      expect(s.state).toBe("unverified");
      expect(s.notes.join(" ")).toContain("event page is invalid");
    }
  });
});

describe("two distinct finalized opens conflict whatever else exists", () => {
  const twoOpens = [ev("EscrowOpened", A, 1), ev("EscrowOpened", A, 2)];
  const note = "conflicting evidence: more than one distinct finalized open for this escrow";
  it("with a release the escrow is unverified, not claimed", () => {
    const s = escrowState(A, [page([...twoOpens, ev("EscrowReleased", A, 3)])], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes).toContain(note);
  });
  it("with a refund the escrow is unverified, not refunded", () => {
    const s = escrowState(A, [page([...twoOpens, ev("EscrowRefunded", A, 3)])], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain(note);
  });
  it("control: one open, seen twice, plus a release is claimed", () => {
    const open = ev("EscrowOpened", A, 1);
    expect(escrowState(A, [page([open, open, ev("EscrowReleased", A, 3)])], opts).state).toBe("claimed");
  });
  it("fixture: both escrows are unverified", async () => {
    const { expected, pages, o } = await loadScenario("escrows-two-opens-and-release");
    for (const s of escrowStates(expected.escrows.map((e) => e.id), pages, o)) {
      expect(s.state).toBe("unverified");
      expect(s.notes).toContain(note);
    }
  });
});

describe("a finalized release or refund above the finalized height", () => {
  const low = { ...opts, finalizedHeight: 150 };
  it("leaves a funded escrow unverified, with a note", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2, { block_number: 160 })])], low);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes).toContain("1 event above the finalized height: not evidence");
    expect(s.notes.join(" ")).toContain("a finalized release above the finalized height names this escrow");
  });
  it("a refund above the height overrides a clean claim", () => {
    const pages = [page([ev("EscrowReleased", A, 2), ev("EscrowRefunded", A, 3, { block_number: 160 })])];
    const s = escrowState(A, pages, low);
    expect(s.state).toBe("unverified");
    expect(s.notes.join(" ")).toContain("a finalized refund above the finalized height names this escrow");
  });
  it("an open above the height is ignored with a note and is not a conflict", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1, { block_number: 160 })])], low);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain("1 event above the finalized height: not evidence");
    expect(s.notes.join(" ")).not.toContain("conflicting evidence");
  });
  it("an event exactly at the height counts", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowRefunded", A, 3, { block_number: 150 })])], low);
    expect(s.state).toBe("refunded");
  });
  it("fixture: a1 unverified, b2 refunded, c3 unverified", async () => {
    const { expected, pages, o } = await loadScenario("escrows-release-above-height");
    expect(o.finalizedHeight).toBe(150);
    const got = escrowStates(expected.escrows.map((e) => e.id), pages, o);
    expect(got.map((g) => g.state)).toEqual(["unverified", "refunded", "unverified"]);
    expect(got[0]?.notes.join(" ")).toContain("above the finalized height names this escrow");
  });
});

describe("a negative block_number is an integer, handled by the page range rule", () => {
  it("a finalized release at block -5 is out of range, not malformed, and leaves the escrow unverified", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 9, { block_number: -5 })])], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes).toContain("1 event outside its page's block range: never evidence");
    expect(s.notes.join(" ")).toContain("a finalized release outside its page's block range names this escrow");
    expect(s.notes.some((n) => n.startsWith("malformed event ignored"))).toBe(false);
  });
  it("a page whose range starts below block 0 is invalid, so a release at block -5 inside it is never evidence", () => {
    const wide = { ...page([ev("EscrowOpened", A, 1, { block_number: 2 }), ev("EscrowReleased", A, 9, { block_number: -5 })]), from_block: -10, to_block: 10 };
    expect(pageProblem(wide)).toBe("from_block is negative");
    const s = escrowState(A, [wide], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(pageProblem({ ...wide, from_block: 0 })).toBeNull();
  });
  it("fixture: a1 is unverified with a range note", async () => {
    const { expected, pages, o } = await loadScenario("escrows-negative-block-number");
    const [a] = escrowStates(expected.escrows.map((e) => e.id), pages, o) as [EscrowState];
    expect(a.state).toBe("unverified");
    expect(a.notes.join(" ")).toContain("outside its page's block range");
    expect(a.notes.some((n) => n.startsWith("malformed event ignored"))).toBe(false);
  });
});

describe("IMD follow-up audit: an event with no block_number key is malformed (census clause 7)", () => {
  const noNumber = (method: string, n: number) => {
    const { block_number: _b, ...rest } = ev(method, A, n);
    return rest;
  };
  it("an open and a release with no block_number key are ignored with a note, never claimed", () => {
    const s = escrowState(A, [page([noNumber("EscrowOpened", 1), noNumber("EscrowReleased", 2)])], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes).toContain("malformed event ignored: hasStation.EscrowReleased (block_number is missing)");
  });
  it("a finalized release with no block_number key leaves a funded escrow unverified, as any malformed terminal does", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), noNumber("EscrowReleased", 2)])], { ...opts, finalizedHeight: 1000 });
    expect(s.state).toBe("unverified");
    expect(s.notes.join(" ")).toContain("a malformed finalized terminal event could be about this escrow");
  });
  it("an explicit null block_number is kept, and the result says the finalized height cannot bound it", () => {
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1, { block_number: null })])], { ...opts, finalizedHeight: 1000 });
    expect(s.state).toBe("funded");
    expect(s.notes).toContain("1 evidence event with no block number, so the finalized height cannot bound it");
    expect(escrowState(A, [page([ev("EscrowOpened", A, 1)])], { ...opts, finalizedHeight: 1000 }).notes.join(" ")).not.toContain("no block number");
  });
  it("fixture: a1 unverified, b2 funded with the note", async () => {
    const { expected, pages, o } = await loadScenario("escrows-no-block-number");
    const [a, b] = escrowStates(expected.escrows.map((e) => e.id), pages, o) as [EscrowState, EscrowState];
    expect([a.state, b.state]).toEqual(["unverified", "funded"]);
    expect(a.notes.join(" ")).toContain("block_number is missing");
    expect(b.notes.join(" ")).toContain("finalized height cannot bound it");
  });
});

describe("IMD follow-up audit: escrow pages follow census clause 2", () => {
  const p = (events: unknown[], n: number, next: number | null, over: Partial<EventPage> = {}) => ({ ...page(events), page: n, next_page: next, ...over });
  it("a complete two page chain counts both pages", () => {
    expect(escrowState(A, [p([ev("EscrowOpened", A, 1)], 0, 1), p([ev("EscrowReleased", A, 2)], 1, null)], opts).state).toBe("claimed");
  });
  it.each([
    ["a next_page that names a missing page", [p([ev("EscrowOpened", A, 1)], 0, 1)], "next_page 1 on page 0 names a page that does not exist"],
    ["no page 0", [p([ev("EscrowOpened", A, 1)], 1, null)], "there is no page 0"],
    ["a cycle", [p([ev("EscrowOpened", A, 1)], 0, 1), p([], 1, 0)], "makes a cycle"],
    ["copies of one page that disagree on next_page", [p([ev("EscrowOpened", A, 1)], 0, null), p([], 0, 2), p([], 2, null)], "copies of page 0 disagree on next_page"],
  ])("%s on the pinned genesis verifies nothing, with a note naming the chain", (_name, pages, why) => {
    const s = escrowState(A, pages as EventPage[], opts);
    expect(s.state).toBe("unverified");
    expect(s.evidence).toEqual([]);
    expect(s.notes.join(" ")).toContain("the page chain for blocks 100 to 199 is broken");
    expect(s.notes.join(" ")).toContain(why);
  });
  it("a broken chain on another genesis does not matter: those pages never count", () => {
    const other = "0x" + "cd".repeat(32);
    expect(escrowState(A, [p([ev("EscrowOpened", A, 1)], 0, null), p([], 0, 1, { genesis: other })], opts).state).toBe("funded");
  });
  it("an event on a page not reachable from page 0 is never evidence, and a finalized release there leaves the escrow unverified", () => {
    const s = escrowState(A, [p([ev("EscrowOpened", A, 1)], 0, null), p([ev("EscrowReleased", A, 2)], 3, null)], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain("1 event on a page not reachable from page 0: never evidence");
    expect(s.notes.join(" ")).toContain("a finalized release on a page not reachable from page 0 names this escrow");
    const openOnly = escrowState(A, [p([ev("EscrowOpened", A, 1)], 0, null), p([ev("EscrowOpened", A, 2)], 3, null)], opts);
    expect(openOnly.state).toBe("funded");
    expect(openOnly.evidence.map((e) => e.block_hash)).toEqual([bh(1)]);
  });
  it("fixtures: the broken chain verifies nothing, the off chain release leaves a1 unverified and b2 funded", async () => {
    for (const [name, want] of [["escrows-broken-chain", ["unverified", "unverified"]], ["escrows-off-chain-release", ["unverified", "funded"]]] as const) {
      const { expected, pages, o } = await loadScenario(name);
      expect(escrowStates(expected.escrows.map((e) => e.id), pages, o).map((s) => s.state)).toEqual(want);
    }
  });
});

describe("Fable review: copies of one event must agree on the account, as census clause 9 says", () => {
  it.each([
    ["a release", "EscrowReleased"],
    ["an open", "EscrowOpened"],
  ])("two copies of %s that name different accounts are a conflict, never evidence", (_name, method) => {
    const a = ev(method, A, 2, { data: { "0": A, who: "alice" } });
    const b = ev(method, A, 2, { data: { "0": A, who: "bob" } });
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), a, b].filter((e, i) => method === "EscrowReleased" || i > 0))], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes.join(" ")).toContain("copies of one event disagree on section, method, escrow id, block number or account");
  });
  it("copies that agree on the account, or that both have none, still count once", () => {
    const same = ev("EscrowReleased", A, 2, { data: { "0": A, who: "alice" } });
    expect(escrowState(A, [page([ev("EscrowOpened", A, 1), same, same])], opts).state).toBe("claimed");
    expect(escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2), ev("EscrowReleased", A, 2)])], opts).state).toBe("claimed");
  });
});

describe("Fable review: a finalized event that names this escrow but lost its section or method is suspect", () => {
  it.each([
    ["no section key", (e: Record<string, unknown>) => { const { section: _s, ...rest } = e; return rest; }],
    ["a section that is a list", (e: Record<string, unknown>) => ({ ...e, section: ["hasStation"] })],
    ["an empty method", (e: Record<string, unknown>) => ({ ...e, method: "" })],
    ["a null method", (e: Record<string, unknown>) => ({ ...e, method: null })],
  ])("%s: a funded escrow is unverified, with a note", (_name, damage) => {
    const broken = damage(ev("EscrowReleased", A, 2) as unknown as Record<string, unknown>);
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), broken])], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain("malformed event ignored: an event that names this escrow has no valid section or method");
    expect(s.notes.join(" ")).toContain("a malformed finalized terminal event could be about this escrow");
  });
  it("the same damage on an event that names another escrow changes nothing here", () => {
    const B = "0x" + "b2".repeat(32);
    const { section: _s, ...other } = ev("EscrowReleased", B, 2) as unknown as Record<string, unknown>;
    expect(escrowState(A, [page([ev("EscrowOpened", A, 1), other])], opts).state).toBe("funded");
  });
  it("a well formed event of another kind that happens to carry this id is not an escrow event", () => {
    const transfer = ev("Transfer", A, 2, { section: "balances" });
    expect(escrowState(A, [page([ev("EscrowOpened", A, 1), transfer])], opts).state).toBe("funded");
  });
  it("with a clean release too, a damaged event naming the escrow leaves it unverified", () => {
    const { method: _m, ...noMethod } = ev("EscrowRefunded", A, 3) as unknown as Record<string, unknown>;
    const s = escrowState(A, [page([ev("EscrowOpened", A, 1), ev("EscrowReleased", A, 2), noMethod])], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes).toContain("conflicting evidence: a malformed finalized event of unknown kind could be about this escrow");
  });
});

