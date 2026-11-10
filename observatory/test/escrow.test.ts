// Tests for src/escrow.ts against RULES.md section 2. Fixtures only, no network.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ESCROW_SCOPE, escrowState, escrowStates, isHash32 } from "../src/escrow.js";
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
  it("has all eight escrow scenarios", () => {
    expect(scenarios).toEqual([
      "escrows-conflicting",
      "escrows-duplicate",
      "escrows-gateway-report-only",
      "escrows-malformed",
      "escrows-opened-only",
      "escrows-other-genesis",
      "escrows-unfinalized-only",
      "escrows-verification",
    ]);
  });

  for (const name of scenarios) {
    it(`${name}: states match expected.json`, async () => {
      const { src, expected, pages, o } = await loadScenario(name);
      expect(src.data.loadErrors).toEqual([]);
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
    expect(checked).toBeGreaterThanOrEqual(12);
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
    const s = escrowState(A, [page([ev("EscrowReleased", A, 2, { block_number: 2000 })])], opts);
    expect(s.state).toBe("unverified");
    expect(s.notes.join(" ")).toContain("above the finalized height");
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
  it("genesis and id comparison ignore hex case", () => {
    const s = escrowState(A.toUpperCase().replace("0X", "0x"), [page([ev("EscrowOpened", A, 1)], G.toUpperCase().replace("0X", "0x"))], opts);
    expect(s.state).toBe("funded");
    expect(s.escrow_id).toBe(A);
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
    expect(s.notes.join(" ")).toContain("share one");
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
    ["finalized as a string", { ...ev("EscrowReleased", A, 2), finalized: "true" }],
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
  it("pages that are not event pages are ignored with a note", () => {
    const s = escrowState(A, [{ nope: true } as unknown as EventPage, page([ev("EscrowOpened", A, 1)])], opts);
    expect(s.state).toBe("funded");
    expect(s.notes.join(" ")).toContain("not an event page");
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
    const pages = [page([ev("EscrowOpened", A, 1)]), report as unknown as EventPage];
    const s = escrowState(A, pages, { ...opts, gatewayReport: report } as EscrowStateOptions);
    expect(s.state).toBe("funded");
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
