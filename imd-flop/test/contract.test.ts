/**
 * imd-flop against the shared contract (../contract/rules.json, ../contract/vectors/*.json).
 * Current behavior at 3ae1cdf, not intent. Mock providers only; test/setup.ts disables fetch.
 * Every vector names all three parts; a part is either checked here or tagged not_applicable with a reason.
 * Vectors with status "known_defect" assert `expect` (today's output); `target` is recorded, not asserted.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlopHTTPError } from "@flop-labs/client";
import { EXIT } from "../src/errors.js";
import { PreSendError } from "../src/gateway.js";
import { usableCapCharge } from "../src/ledger.js";
import { matchReceipt, RECEIPT_IDENTITY_STATUS } from "../src/match.js";
import { ledgerFile, receiptsDir } from "../src/paths.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { classifyReceipt, knownSettledSpend, RECEIPT_STATES, STAGE_GATEWAY, type GatewayReceipt } from "../src/receipts.js";
import { padQuote, TEMPLATE_PAD } from "../src/run.js";
import { DISAGREE, SETTLES } from "../src/settlement.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";
import { decode, forPart, rules, unreferencedLabelRules, unreferencedQuirks, vectors, type Json } from "./lib/contract-vectors.js";

const PART = "imd-flop";
const applicable = forPart(PART);

// ---- adapters: one per rule; each returns the part's observed outcome in the vector's vocabulary ----
const SEAT = "9001";
const QUOTE = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 };
type Read = { http: Json; error: string | null; receipt: Json };
interface POpts { estimate?: Json; complete?: string; presendMessage?: string; costFlop?: number; read?: Read }
const withRid = (r: Json, id: string): Json => (r && typeof r === "object" ? { ...r, ...(r.request_id === "$rid" ? { request_id: id } : {}) } : r);
class P implements Provider {
  readonly name = "mock" as const;
  calls = 0;
  constructor(private readonly o: POpts = {}) {}
  async estimate() { return this.o.estimate ?? QUOTE; }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    if (this.o.complete === "presend") throw new PreSendError(this.o.presendMessage ?? "provider refused before mint");
    if (this.o.complete === "http500") throw new FlopHTTPError(500, {}, null);
    if (this.o.complete === "timeout") await new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true }));
    return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, ...(this.o.costFlop !== undefined ? { cost_flop: this.o.costFlop } : {}) } };
  }
  async readReceipt(id: string) {
    const r = this.o.read ?? { http: 200, error: null, receipt: { request_id: "$rid", correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: null, state: "estimated" } };
    return { http: r.http, error: r.error, receipt: withRid(r.receipt, id) } as never;
  }
}
type Row = { request_id: string | null; state: string; spend: number | null; cap_charge: number | null; reason: string | null };
const ledger = (h: string): Row[] => (existsSync(ledgerFile(h)) ? (readLines(ledgerFile(h)) as Row[]) : []);
const runArgs = (extra: string[] = []) => ["run", "--seat", SEAT, "--job", "j1", "--prompt", "Say hi", "--provider", "mock", "--timeout-ms", "50", "--json", ...extra];
async function ready(cap = "1") {
  const h = tmpHome();
  await readySeat(h, SEAT, cap);
  return h;
}
const pick = (got: Json, want: Json) => Object.fromEntries(Object.keys(want).map((k) => [k, got[k]]));
const lastOf = (rows: Row[]) => { const r = rows[rows.length - 1]; return { state: r.state, spend: r.spend, cap_charge: r.cap_charge }; };
const ridOf = (h: string) => ledger(h).find((r) => r.request_id)!.request_id!;
const receiptPath = (h: string, rid: string) => join(receiptsDir(h), `${rid}.json`);

const adapters: Record<string, (i: Json, want: Json) => Promise<Json> | Json> = {
  "quote.pad": (i) => ({ padded: padQuote(i.estimate)?.padded ?? null }),
  "cap.compare": async (i) => {
    const h = await ready(i.cap);
    const r = await cli(h, runArgs(["--max-tokens", String(i.max_tokens)]), { provider: new P({ estimate: i.estimate }) });
    return { exit: r.code };
  },
  "amount.text": async (i) => {
    const h = tmpHome();
    await cli(h, ["init", "--seat", SEAT]);
    const r = await cli(h, ["cap", "set", i.text]);
    if (r.code !== EXIT.OK) return { accepted: false, exit: r.code };
    return { accepted: true, value: (await cli(h, ["cap", "show", "--json"])).json().cap.daily };
  },
  "amount.json": (i) => ({ known_settled: knownSettledSpend(i.value), usable_cap_charge: usableCapCharge(i.value) }),
  max_tokens: async (i) => {
    const h = await ready();
    const r = await cli(h, runArgs([`--max-tokens=${i.text}`]), { provider: new P() });
    return r.code === EXIT.OK ? { accepted: true } : { accepted: false, exit: r.code };
  },
  "max_tokens.quote": async (i) => {
    const h = tmpHome();
    return { exit: (await cli(h, ["quote", "--prompt", "hi", `--max-tokens=${i.text}`])).code };
  },
  "receipt.state": (i) => ({ state: classifyReceipt({ request_id: "r", state: i.state } as GatewayReceipt, { job: "j", provider: "mock" }).state }),
  "read.failed": async (i) => {
    const h = await ready();
    await cli(h, runArgs(["--max-tokens", "8"]), { provider: new P() });
    const rid = ridOf(h);
    const receipt = i.body === "object" ? { request_id: "$rid", correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: null, state: "estimated" } : null;
    const r = await cli(h, ["receipt", rid, "--refresh", "--json"], { provider: new P({ read: { http: i.http, error: i.error, receipt } }) });
    expect(r.code, r.err).toBe(EXIT.OK);
    return { failed: "last_known_at" in JSON.parse(readFileSync(receiptPath(h, rid), "utf8")) };
  },
  identity: async (i) => {
    const ids = new Set(["job", "seat", "did", RECEIPT_IDENTITY_STATUS, "ledger_row_missing", "job(correlation_id)"]);
    let m;
    try {
      m = await matchReceipt(tmpHome(), i.receipt, i.ledger);
    } catch (e) {
      return { throws: (e as Error).name };
    }
    return { fields: m.fields.filter((f) => ids.has(f)).map((f) => (f === RECEIPT_IDENTITY_STATUS ? "IDENTITY" : f)) };
  },
  "settlement.run": async (i, want) => {
    const h = await ready(i.cap ?? "1");
    const r = await cli(h, runArgs(["--max-tokens", "8"]), { provider: new P({ complete: i.complete, presendMessage: i.presend_message, costFlop: i.cost_flop, read: i.read }) });
    const rows = ledger(h);
    const got: Json = { exit: r.code, states: rows.map((x) => x.state), last: lastOf(rows), reason: rows[rows.length - 1].reason };
    if ("stderr_contains" in want) got.stderr_contains = (want.stderr_contains as string[]).filter((s) => r.err.includes(s));
    return pick(got, want);
  },
  "settlement.refresh": async (i, want) => {
    const h = await ready();
    await cli(h, runArgs(["--max-tokens", "8"]), { provider: new P(i.run_complete ? { complete: i.run_complete } : { costFlop: i.run_cost_flop, read: { http: 200, error: null, receipt: i.run_read } }) });
    const rid = ridOf(h);
    if ("prev_cap_charge" in i) {
      const rows = ledger(h);
      appendFileSync(ledgerFile(h), JSON.stringify({ ...rows[rows.length - 1], cap_charge: i.prev_cap_charge }) + "\n");
    }
    if (i.strip_receipt_fields) {
      const body = JSON.parse(readFileSync(receiptPath(h, rid), "utf8"));
      for (const k of i.strip_receipt_fields) delete body[k];
      writeFileSync(receiptPath(h, rid), JSON.stringify(body));
    }
    const before = ledger(h).length;
    const r = await cli(h, ["receipt", rid, "--refresh", "--json"], { provider: new P({ read: i.refresh_read }) });
    const rows = ledger(h);
    const file = existsSync(receiptPath(h, rid)) ? JSON.parse(readFileSync(receiptPath(h, rid), "utf8")) : {};
    const got: Json = {
      exit: r.code,
      appended: rows.length - before,
      last: lastOf(rows),
      stderr_disagree: r.err.includes(rules.constants.DISAGREE.value),
      file_absent: (want.file_absent ?? []).filter((k: string) => !(k in file)),
      file_present: (want.file_present ?? []).filter((k: string) => k in file),
    };
    return pick(got, want);
  },
};

describe("contract files", () => {
  it("are well formed: unique ids, all three parts named, reasons for not_applicable, known quirks", () => {
    // lib/contract-vectors.ts throws on load for any malformed vector; here every quirk must also be pinned.
    expect(vectors.length).toBeGreaterThan(0);
    expect(unreferencedQuirks()).toEqual([]);
  });
  it("every FIXER viewer label rule id is referenced by a vector's label_rules", () => {
    expect(unreferencedLabelRules()).toEqual([]);
  });
  it("constants match imd-flop's source", () => {
    const c = rules.constants;
    expect(TEMPLATE_PAD).toBe(c.TEMPLATE_PAD.value);
    expect([...RECEIPT_STATES]).toEqual(c.RECEIPT_STATES.value);
    expect(RECEIPT_IDENTITY_STATUS).toBe(c.IDENTITY.value);
    expect(STAGE_GATEWAY).toBe(c.STAGE_GATEWAY.value);
    expect(EXIT).toEqual(c.EXIT[PART]);
  });
  it("settlement.ts SETTLES and DISAGREE match rules.json", () => {
    expect([...SETTLES]).toEqual(rules.constants.SETTLES.value);
    expect(DISAGREE).toBe(rules.constants.DISAGREE.value);
  });
  it("every vector is checked here or tagged not_applicable for imd-flop", () => {
    expect(applicable.length).toBeGreaterThan(0);
    for (const v of applicable) expect(Object.keys(adapters), `${v.id}: no adapter for ${v.rule}`).toContain(v.rule);
  });
});

describe("contract vectors (imd-flop)", () => {
  for (const v of applicable) {
    it(`${v.file} ${v.id}${v.status === "known_defect" ? " [known defect: asserts today's output]" : v.status === "fixed" ? ` [fixed ${v.defect}]` : ""}`, async () => {
      const want = decode(v.expect[PART]);
      const got = await adapters[v.rule](decode(v.input), want);
      expect(got, `${v.file}:${v.id}`).toEqual(want);
    });
  }
});
