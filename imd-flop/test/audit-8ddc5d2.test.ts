/**
 * The swarm audit of commit 8ddc5d2 (IMD job 769d5aeb). Findings 1 to 4 and 8 to 11 are imd-flop's.
 * Each test asserts the safe outcome, so it fails on 8ddc5d2 and passes with its fix:
 *   1  receipt --refresh never settles from a receipt body that had to be redacted
 *   2  a later read never lowers a booked settlement, and a settlement is never charged below the
 *      cost the completion itself reported
 *   3  the cap is checked against a total rounded up and room rounded down, never to nearest
 *   4  a refusal that needs no quote happens before the estimate, so the prompt is not posted for nothing
 *   8  status keeps working when a receipt file is unreadable, and names the file
 *   9  "nothing was sent" has its own exit code (11), apart from "sent, spend unknown" (1)
 *  10  reserved_spend is held to the one amount rule: finite and >= 0, else unknown and shown blank
 *  11  padQuote refuses a negative token count instead of letting it inflate the pad
 * Findings 5, 6 and 7 are the viewer's. Finding 12 is a documented residual. Finding 13 is a product
 * decision. Stub providers only; no network (test/setup.ts disables fetch).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlopHTTPError } from "@flop-labs/client";
import { EXIT } from "../src/errors.js";
import { mintChildKey, PaidGateError, PreSendError } from "../src/gateway.js";
import { jobSpent, spentToday, utcDay } from "../src/ledger.js";
import { network } from "../src/networks.js";
import { checkBudget, noRoom, padQuote } from "../src/policy.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { classifyReceipt, knownAmount, receiptLine, type GatewayReceipt } from "../src/receipts.js";
import { ceil6, floor6 } from "../src/rounding.js";
import { CHARGE_RAISED, DISAGREE, nextBooking, refreshBooking, settledSpend } from "../src/settlement.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9001";
const QUOTE = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }; // pads to 0.186
type Read = { http: number; error: string | null; receipt: Record<string, unknown> | null };
interface Opts {
  estimate?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  complete?: (req: CompleteReq) => Promise<CompleteRes>;
  read?: (id: string) => Read;
}
/** A gateway receipt for the run's own request id. */
const receiptFor = (id: string, fields: Record<string, unknown> = {}): Read => ({
  http: 200,
  error: null,
  receipt: { request_id: id, correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: null, state: "estimated", ...fields },
});
class P implements Provider {
  readonly name = "mock" as const;
  estimates = 0;
  calls = 0;
  constructor(private readonly o: Opts = {}) {}
  async estimate() {
    this.estimates += 1;
    return (this.o.estimate ?? QUOTE) as never;
  }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    if (this.o.complete) return this.o.complete(req);
    return { request_id: req.requestId, text: "ok", usage: (this.o.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) as CompleteRes["usage"] };
  }
  async readReceipt(id: string) {
    return (this.o.read ?? receiptFor)(id) as never;
  }
}
const runArgs = (job = "j1", extra: string[] = []) => ["run", "--seat", SEAT, "--job", job, "--prompt", "Say hi", "--provider", "mock", "--max-tokens", "8", "--json", ...extra];
const refreshArgs = (rid: string) => ["receipt", rid, "--refresh", "--json", "--seat", SEAT];
type Row = { request_id: string | null; state: string; spend: number | null; cap_charge: number | null; cost_reported: number | null; reason: string | null; quote_raw: number | null; quote_padded: number | null; spent_before: number | null };
const ledger = (home: string) => (existsSync(join(home, "ledger.jsonl")) ? (readLines(join(home, "ledger.jsonl")) as Row[]) : []);
const booked = (r: Row) => ({ state: r.state, spend: r.spend, cap_charge: r.cap_charge });
async function ready(cap = "1") {
  const h = tmpHome();
  await readySeat(h, SEAT, cap);
  return h;
}
/** Append a settled ledger row with this cap charge, as an earlier call today would have left it. */
function seedCharge(home: string, id: string, capCharge: number, payer: "holder" | "requester" = "holder", job = "seed") {
  const row = { ts: new Date().toISOString(), day: utcDay(), request_id: id, seat: SEAT, did: "did:key:zseed", job, provider: "mock", network: "devnet", payer, model: "m", max_tokens: 8,
    prompt_sha256: "ab".repeat(32), quote_raw: 0.066, quote_padded: 0.186, per_call_cap: 1, daily_cap: 1, job_budget: payer === "requester" ? 1 : null, spent_before: 0, state: "settled", reason: null,
    spend: capCharge, cost_reported: null, cap_charge: capCharge, http: 200, mock: true };
  appendFileSync(join(home, "ledger.jsonl"), JSON.stringify(row) + "\n");
}

describe("finding 1: receipt --refresh never settles from a receipt body that had to be redacted", () => {
  // 64 hex characters: the secret scan nulls settled_raw, so the stored receipt is a redacted copy.
  const KEY_SHAPED = "ab".repeat(32);
  const settledRedacted = (id: string) => receiptFor(id, { settled_spend: 0.05, settled_spend_raw: KEY_SHAPED, state: "settled" });

  it("run holds the reservation, and a refresh with the identical read appends nothing and still holds 0.186", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ read: settledRedacted }) });
    expect(run.code, run.err).toBe(0);
    const rid = run.json().request_id as string;
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "sent", spend: null, cap_charge: 0.186 });
    const before = ledger(h).length;
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledRedacted }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    expect(refreshed.err).not.toContain(DISAGREE);
    expect({ appended: ledger(h).length - before, last: booked(ledger(h).at(-1)!) }).toEqual({ appended: 0, last: { state: "sent", spend: null, cap_charge: 0.186 } });
    expect((await cli(h, ["status", "--seat", SEAT, "--json"])).json().today_utc.mock).toBe(0.186);
  });

  it("control: the same settlement without the key-shaped field is booked by the refresh", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P() });
    const rid = run.json().request_id as string;
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: (id) => receiptFor(id, { settled_spend: 0.05, state: "settled" }) }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05 });
  });

  it("the rule lives in settlement.ts: a redacted read proves no settlement and moves no state", () => {
    const read = { fresh: true, identityOk: true, state: "settled", settled: 0.05 };
    expect(settledSpend({ ...read, redacted: true })).toBeNull();
    expect(nextBooking({ state: "estimated", spend: null }, { ...read, redacted: true }, 0.186, null)).toEqual({ state: "estimated", spend: null, cap_charge: 0.186 });
    expect(refreshBooking({ state: "estimated", spend: null, cap_charge: 0.186, cost_reported: null }, { ...read, redacted: true })).toEqual({ kind: "unchanged" });
    expect(settledSpend({ ...read, redacted: false })).toBe(0.05);
  });
});

describe("finding 2: a later read never lowers a booked settlement, and a reported cost never lowers the charge", () => {
  const read = (state: string, settled: unknown) => ({ fresh: true, identityOk: true, redacted: false, state, settled });
  const settledAt = (spend: number) => (id: string) => receiptFor(id, { settled_spend: spend, state: "settled" });
  const releasedAt = (spend: number) => (id: string) => receiptFor(id, { settled_spend: spend, state: "released" });
  const usage = (cost: number) => ({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: cost });

  describe("(a) a booked known settlement is never lowered", () => {
    it("nextBooking: settled 0.05, then a fresh released 0 changes nothing", () => {
      expect(nextBooking({ state: "settled", spend: 0.05 }, read("released", 0), 0.05, null)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05 });
    });

    it("refreshBooking: the same read is a disagreement, not a new row", () => {
      expect(refreshBooking({ state: "settled", spend: 0.05, cap_charge: 0.05, cost_reported: null }, read("released", 0))).toEqual({ kind: "disagree" });
      expect(refreshBooking({ state: "settled", spend: 0.05, cap_charge: 0.05, cost_reported: null }, read("settled", 0.049999))).toEqual({ kind: "disagree" });
    });

    it("an equal amount may still move the state, and a higher amount is booked", () => {
      expect(nextBooking({ state: "settled", spend: 0.05 }, read("released", 0.05), 0.05, null)).toEqual({ state: "released", spend: 0.05, cap_charge: 0.05 });
      expect(refreshBooking({ state: "settled", spend: 0.05, cap_charge: 0.05, cost_reported: null }, read("released", 0.05))).toEqual({ kind: "append", booking: { state: "released", spend: 0.05, cap_charge: 0.05 } });
      expect(nextBooking({ state: "settled", spend: 0.05 }, read("settled", 0.07), 0.05, null)).toEqual({ state: "settled", spend: 0.07, cap_charge: 0.07 });
      expect(refreshBooking({ state: "settled", spend: 0.05, cap_charge: 0.05, cost_reported: null }, read("settled", 0.07))).toEqual({ kind: "append", booking: { state: "settled", spend: 0.07, cap_charge: 0.07 } });
    });

    it("control: a settling state with no known spend still learns its settlement, whatever the amount", () => {
      expect(nextBooking({ state: "settled", spend: null }, read("settled", 0.01), 0.186, null)).toEqual({ state: "settled", spend: 0.01, cap_charge: 0.01 });
      expect(nextBooking({ state: "estimated", spend: null }, read("released", 0), 0.186, null)).toEqual({ state: "released", spend: 0, cap_charge: 0 });
    });

    for (const [name, later] of [["released 0", releasedAt(0)], ["settled 0.01", settledAt(0.01)]] as const) {
      it(`run settles 0.05, then a refresh reads ${name}: nothing appended, DISAGREE, 0.05 still booked`, async () => {
        const h = await ready();
        const run = await cli(h, runArgs(), { provider: new P({ read: settledAt(0.05) }) });
        expect(run.code, run.err).toBe(0);
        const rid = run.json().request_id as string;
        expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05 });
        const before = ledger(h).length;
        const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: later }) });
        expect(refreshed.code, refreshed.err).toBe(0);
        expect({ appended: ledger(h).length - before, last: booked(ledger(h).at(-1)!), warned: refreshed.err.includes(DISAGREE), status: refreshed.json().status, ledger_spend: refreshed.json().ledger_spend })
          .toEqual({ appended: 0, last: { state: "settled", spend: 0.05, cap_charge: 0.05 }, warned: true, status: DISAGREE, ledger_spend: 0.05 });
      });
    }
  });

  describe("(b) the charge of a proven settlement is max(settled, reported cost); spend stays the settled figure", () => {
    it("nextBooking: a reported cost raises the settled charge and never lowers it", () => {
      expect(nextBooking({ state: "sent", spend: null }, read("released", 0), 0.186, 0.15)).toEqual({ state: "released", spend: 0, cap_charge: 0.15 });
      expect(nextBooking({ state: "sent", spend: null }, read("settled", 0.05), 0.186, 0.15)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.15 });
      expect(nextBooking({ state: "sent", spend: null }, read("settled", 0.05), 0.186, 0.01)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05 });
      expect(nextBooking({ state: "sent", spend: null }, read("settled", 0.05), 0.186, null)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05 });
    });

    it("refreshBooking takes the reported cost from the ledger row, and ignores one that is not a finite number", () => {
      const prev = { state: "estimated", spend: null, cap_charge: 0.186 };
      expect(refreshBooking({ ...prev, cost_reported: 0.15 }, read("settled", 0.05))).toEqual({ kind: "append", booking: { state: "settled", spend: 0.05, cap_charge: 0.15 } });
      for (const bad of [null, undefined, "0.15", Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(refreshBooking({ ...prev, cost_reported: bad }, read("settled", 0.05)), String(bad)).toEqual({ kind: "append", booking: { state: "settled", spend: 0.05, cap_charge: 0.05 } });
      }
    });

    it("run: usage.cost_flop 0.15 and a released / 0 receipt books spend 0 with cap_charge 0.15, and says why", async () => {
      const h = await ready();
      const run = await cli(h, runArgs(), { provider: new P({ usage: usage(0.15), read: releasedAt(0) }) });
      expect(run.code, run.err).toBe(0);
      const last = ledger(h).at(-1)!;
      expect({ ...booked(last), cost_reported: last.cost_reported, reason: last.reason }).toEqual({ state: "released", spend: 0, cap_charge: 0.15, cost_reported: 0.15, reason: CHARGE_RAISED });
      expect(run.json().cap_charge).toBe(0.15);
      expect((await cli(h, ["status", "--seat", SEAT, "--json"])).json().today_utc.mock).toBe(0.15);
    });

    it("control: a reported cost below the settlement leaves the settled charge and no reason", async () => {
      const h = await ready();
      const run = await cli(h, runArgs(), { provider: new P({ usage: usage(0.01), read: settledAt(0.05) }) });
      expect(run.code, run.err).toBe(0);
      const last = ledger(h).at(-1)!;
      expect({ ...booked(last), reason: last.reason }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05, reason: null });
    });

    it("run then refresh: the settlement learned later is charged at the reported cost, once", async () => {
      const h = await ready();
      const run = await cli(h, runArgs(), { provider: new P({ usage: usage(0.15) }) });
      expect(run.code, run.err).toBe(0);
      const rid = run.json().request_id as string;
      expect(booked(ledger(h).at(-1)!)).toEqual({ state: "estimated", spend: null, cap_charge: 0.186 });
      const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
      expect(refreshed.code, refreshed.err).toBe(0);
      const last = ledger(h).at(-1)!;
      expect({ ...booked(last), cost_reported: last.cost_reported, reason: last.reason }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.15, cost_reported: 0.15, reason: CHARGE_RAISED });
      expect(refreshed.json().ledger_spend).toBe(0.05);
      const before = ledger(h).length;
      const again = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
      expect(again.code, again.err).toBe(0);
      expect(again.err).not.toContain(DISAGREE);
      expect(ledger(h).length - before).toBe(0);
    });
  });
});

describe("finding 3: money already spent rounds up and room left rounds down, so the exact sum never passes the cap", () => {
  const TINY = { estimated_cost_flop: 1e-8, estimated_input_tokens: 3, estimated_output_tokens: 8 }; // pads to 0.000001
  const settles = (spend: number) => (id: string) => receiptFor(id, { settled_spend: spend, state: "settled" });

  it("holder: two calls settle 0.4999996 each under cap 1, and a third call quoted 0.000001 is refused (exit 3)", async () => {
    const h = await ready("1");
    for (const job of ["a", "b"]) expect((await cli(h, runArgs(job), { provider: new P({ read: settles(0.4999996) }) })).code).toBe(0);
    const third = new P({ estimate: TINY });
    const r = await cli(h, runArgs("c"), { provider: third });
    expect({ code: r.code, calls: third.calls }).toEqual({ code: 3, calls: 0 });
    expect(r.err).toMatch(/daily cap reached \(1\/1 FLOP today, UTC\)/);
    expect((await cli(h, ["status", "--seat", SEAT, "--json"])).json().today_utc.mock).toBe(1);
  });

  it("requester: the same two settlements use up a job budget of 1, and the third call is refused (exit 3)", async () => {
    const h = await ready("5");
    await cli(h, ["config", "set", "payer", "requester"]);
    const budget = ["--job-budget", "1"];
    for (let i = 0; i < 2; i++) expect((await cli(h, runArgs("j1", budget), { provider: new P({ read: settles(0.4999996) }) })).code).toBe(0);
    const third = new P({ estimate: TINY });
    const r = await cli(h, runArgs("j1", budget), { provider: third });
    expect({ code: r.code, calls: third.calls }).toEqual({ code: 3, calls: 0 });
    expect(r.err).toMatch(/requester budget/);
  });

  it("the ledger total rounds up to 6 decimals, for the daily total and the job total", () => {
    const h = tmpHome();
    seedCharge(h, "s1", 0.4999996);
    seedCharge(h, "s2", 0.4999996);
    expect(spentToday(h, SEAT, "mock")).toBe(1);
    seedCharge(h, "q1", 0.0000004, "requester", "jq");
    expect(jobSpent(h, "jq", "mock")).toBe(0.000001);
  });

  it("control: float noise does not move a total or the room off a 6 decimal boundary", () => {
    const h = tmpHome();
    seedCharge(h, "s1", 0.1);
    seedCharge(h, "s2", 0.2); // 0.1 + 0.2 is 0.30000000000000004
    expect(spentToday(h, SEAT, "mock")).toBe(0.3);
    // 1 - 0.9 is 0.09999999999999998: still 0.1 of room, so a 0.1 quote fits and a 0.100001 quote does not.
    const cap = { daily: 1, perCall: 1 };
    expect(checkBudget({ padded: 0.1, cap, payer: "holder", spentBefore: 0.9 })).toBeNull();
    expect(checkBudget({ padded: 0.100001, cap, payer: "holder", spentBefore: 0.9 })).toMatchObject({ code: 3, reason: "padded quote 0.100001 FLOP is over the remaining daily cap 0.1" });
  });

  it("ceil6 and floor6 round away from and toward zero room, and both keep a value that is on a boundary", () => {
    expect([ceil6(0.9999992), floor6(0.0000008), ceil6(0.0000001), floor6(0.9999999)]).toEqual([1, 0, 0.000001, 0.999999]);
    expect([ceil6(0.186), floor6(0.186), ceil6(0), floor6(0), ceil6(1), floor6(1)]).toEqual([0.186, 0.186, 0, 0, 1, 1]);
    expect([ceil6(0.1 + 0.2), floor6(0.1 + 0.2), ceil6(1 - 0.9), floor6(1 - 0.9)]).toEqual([0.3, 0.3, 0.1, 0.1]);
    // A value 1e-12 from a boundary stays on it. One 1e-9 away does not.
    expect([ceil6(0.5 + 1e-12), floor6(0.5 - 1e-12), ceil6(0.5 + 1e-9), floor6(0.5 - 1e-9)]).toEqual([0.5, 0.5, 0.500001, 0.499999]);
  });

  it("checkBudget: room left rounds down, for the daily cap and for the job budget", () => {
    const cap = { daily: 1, perCall: 1 };
    // 1 - 0.9999992 is 0.0000008 of room: less than the smallest quote, so nothing fits.
    expect(checkBudget({ padded: 0.000001, cap, payer: "holder", spentBefore: 0.9999992 })).toMatchObject({ code: 3, reason: expect.stringMatching(/daily cap reached/) });
    expect(checkBudget({ padded: 0.000001, cap: { daily: 5, perCall: 5 }, payer: "requester", spentBefore: 0.9999992, jobBudget: 1 })).toMatchObject({ code: 3, reason: expect.stringMatching(/requester budget/) });
    // 1 - 0.4999996 is 0.5000004: the room is 0.5, not 0.500001.
    expect(checkBudget({ padded: 0.500001, cap, payer: "holder", spentBefore: 0.4999996 })).toMatchObject({ code: 3, reason: "padded quote 0.500001 FLOP is over the remaining daily cap 0.5" });
    expect(checkBudget({ padded: 0.5, cap, payer: "holder", spentBefore: 0.4999996 })).toBeNull();
  });
});

describe("finding 4: a refusal that needs no quote happens before the estimate", () => {
  const lastRow = (h: string) => {
    const r = ledger(h).at(-1)!;
    return { request_id: r.request_id, state: r.state, reason: r.reason, quote_raw: r.quote_raw, quote_padded: r.quote_padded, spent_before: r.spent_before, cap_charge: r.cap_charge };
  };

  it("holder: with the daily cap used up, run refuses (exit 3) without calling estimate, and books the usual refused_local row", async () => {
    const h = await ready("0.186");
    expect((await cli(h, runArgs("a"), { provider: new P() })).code).toBe(0);
    const p = new P();
    const r = await cli(h, runArgs("b"), { provider: p });
    expect({ code: r.code, estimates: p.estimates, calls: p.calls }).toEqual({ code: 3, estimates: 0, calls: 0 });
    expect(r.err).toBe("imd-flop: refused locally, nothing sent: daily cap reached (0.186/0.186 FLOP today, UTC)");
    expect(lastRow(h)).toEqual({ request_id: null, state: "refused_local", reason: "daily cap reached (0.186/0.186 FLOP today, UTC)", quote_raw: null, quote_padded: null, spent_before: 0.186, cap_charge: 0 });
  });

  it("requester: with the job budget used up, run refuses (exit 3) without calling estimate", async () => {
    const h = await ready("5");
    await cli(h, ["config", "set", "payer", "requester"]);
    const budget = ["--job-budget", "0.186"];
    expect((await cli(h, runArgs("j1", budget), { provider: new P() })).code).toBe(0);
    const p = new P();
    const r = await cli(h, runArgs("j1", budget), { provider: p });
    expect({ code: r.code, estimates: p.estimates, calls: p.calls }).toEqual({ code: 3, estimates: 0, calls: 0 });
    expect(lastRow(h)).toEqual({ request_id: null, state: "refused_local", reason: "requester budget reached (0.186/0.186 FLOP on this job)", quote_raw: null, quote_padded: null, spent_before: 0.186, cap_charge: 0 });
    // Another job has its own budget, so it still gets a quote and runs.
    const other = new P();
    expect((await cli(h, runArgs("j2", budget), { provider: other })).code).toBe(0);
    expect(other.estimates).toBe(1);
  });

  it("an unusable ledger charge refuses as before (exit 3), now without calling estimate", async () => {
    const h = await ready("5");
    appendFileSync(join(h, "ledger.jsonl"), JSON.stringify({ day: utcDay(), request_id: "seed-bad", seat: SEAT, job: "seed", provider: "mock", payer: "holder", state: "sent", cap_charge: null }) + "\n");
    const p = new P();
    const r = await cli(h, runArgs("a"), { provider: p });
    expect({ code: r.code, estimates: p.estimates, calls: p.calls }).toEqual({ code: 3, estimates: 0, calls: 0 });
    expect(r.err).toMatch(/ledger cap_charge unusable; next call refused/);
    expect(lastRow(h)).toMatchObject({ request_id: null, state: "refused_local", quote_raw: null, quote_padded: null, spent_before: null, cap_charge: 0 });
  });

  it("control: with room left but not enough for this quote, the estimate is asked and the refusal names the quote", async () => {
    const h = await ready("0.2");
    expect((await cli(h, runArgs("a"), { provider: new P() })).code).toBe(0);
    const p = new P();
    const r = await cli(h, runArgs("b"), { provider: p });
    expect({ code: r.code, estimates: p.estimates, calls: p.calls }).toEqual({ code: 3, estimates: 1, calls: 0 });
    expect(lastRow(h)).toEqual({ request_id: null, state: "refused_local", reason: "padded quote 0.186 FLOP is over the remaining daily cap 0.014", quote_raw: 0.066, quote_padded: 0.186, spent_before: 0.186, cap_charge: 0 });
  });

  it("control: the check under the ledger lock stays the authority when the room goes during the estimate", async () => {
    const h = await ready("0.186");
    const p = new P();
    // Another process books 0.186 while this run waits for its quote.
    p.estimate = async () => {
      p.estimates += 1;
      seedCharge(h, "other-process", 0.186);
      return QUOTE as never;
    };
    const r = await cli(h, runArgs("a"), { provider: p });
    expect({ code: r.code, estimates: p.estimates, calls: p.calls }).toEqual({ code: 3, estimates: 1, calls: 0 });
    expect(lastRow(h)).toEqual({ request_id: null, state: "refused_local", reason: "daily cap reached (0.186/0.186 FLOP today, UTC)", quote_raw: 0.066, quote_padded: 0.186, spent_before: 0.186, cap_charge: 0 });
  });

  it("noRoom is the one rule: checkBudget gives the same refusal, whatever the quote", () => {
    const cap = { daily: 1, perCall: 0.5 };
    const holder = { cap, payer: "holder" as const, spentBefore: 1 };
    expect(noRoom(holder)).toEqual({ reason: "daily cap reached (1/1 FLOP today, UTC)", code: 3 });
    const requester = { cap, payer: "requester" as const, spentBefore: 0.3, jobBudget: 0.3 };
    expect(noRoom(requester)).toEqual({ reason: "requester budget reached (0.3/0.3 FLOP on this job)", code: 3 });
    for (const state of [holder, requester]) {
      for (const padded of [0.000001, 0.186, 0.9]) expect(checkBudget({ ...state, padded })).toEqual(noRoom(state));
    }
    expect(noRoom({ cap, payer: "requester", spentBefore: 0, jobBudget: Number.POSITIVE_INFINITY })).toEqual({ reason: 'no usable requester budget for payer "requester"', code: 3 });
    expect(noRoom({ ...holder, spentBefore: 0.999999 })).toBeNull();
    expect(noRoom({ ...requester, spentBefore: 0.299999 })).toBeNull();
    // 0.0000008 of room is no room: the smallest quote is 0.000001.
    expect(noRoom({ ...holder, spentBefore: 0.9999992 })).toMatchObject({ code: 3 });
  });
});

describe("finding 8: status keeps working when a receipt file is unreadable", () => {
  const BAD = "mock-9001-deadbeef.json";
  async function oneRun() {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P() });
    expect(run.code, run.err).toBe(0);
    return { h, rid: run.json().request_id as string };
  }

  for (const [what, body] of [["not JSON", "{not json"], ["JSON that is not an object", "null"]] as const) {
    it(`a receipt file holding ${what}: status --json exits 0, lists the readable receipt and names the unreadable file`, async () => {
      const { h, rid } = await oneRun();
      writeFileSync(join(h, "receipts", BAD), body);
      const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
      expect(st.code, st.err).toBe(0);
      const o = st.json();
      expect(o.unreadable_receipts).toEqual([BAD]);
      expect(o.recent_receipts.map((r: { request_id: string }) => r.request_id)).toEqual([rid]);
      expect(o.today_utc.mock).toBe(0.186);
    });
  }

  it("text output: the overview is printed, with one line naming the unreadable files", async () => {
    const { h, rid } = await oneRun();
    writeFileSync(join(h, "receipts", BAD), "{not json");
    writeFileSync(join(h, "receipts", "mock-9001-0badf00d.json"), "[]");
    const st = await cli(h, ["status", "--seat", SEAT]);
    expect(st.code, st.err).toBe(0);
    expect(st.out).toContain(`seat ${SEAT}`);
    expect(st.out).toContain(rid);
    const lines = st.out.split("\n").filter((l) => l.includes("unreadable"));
    expect(lines).toEqual(["  unreadable receipt files (not shown): mock-9001-0badf00d.json, mock-9001-deadbeef.json"]);
  });

  it("control: with every receipt readable, the field is an empty list and the text has no such line", async () => {
    const { h } = await oneRun();
    expect((await cli(h, ["status", "--seat", SEAT, "--json"])).json().unreadable_receipts).toEqual([]);
    expect((await cli(h, ["status", "--seat", SEAT])).out).not.toContain("unreadable");
  });
});

describe("finding 9: a provider failure before anything was sent exits 11 (NOT_SENT), not 1", () => {
  const net = network("devnet");
  const mint = (f: unknown) => async (req: CompleteReq): Promise<CompleteRes> => {
    await mintChildKey(net, "parent", { model: req.model, maxSpend: req.maxCostFlop }, f as never);
    throw new Error("unreachable: the mint must fail");
  };
  // Each case fails the way the flop provider does before the paid request. None of them is a PaidGateError.
  const notSent: Record<string, (req: CompleteReq) => Promise<CompleteRes>> = {
    "child key mint transport error": mint(async () => { throw new TypeError("fetch failed"); }),
    "child key mint HTTP 401": mint(async () => new Response("{}", { status: 401 })),
    "child key mint HTTP 503": mint(async () => new Response("{}", { status: 503 })),
    "unparsable child key mint body": mint(async () => new Response("not json", { status: 201 })),
    "abort between the gate and the mint": async () => { throw new PreSendError("aborted before send (after the network check): no answer within 50 ms"); },
    "a key-shaped provider message (withheld)": async () => { throw new PreSendError("rpc error: Bearer SYNTHETICNOTAKEY0123456789"); },
  };
  for (const [name, complete] of Object.entries(notSent)) {
    it(`${name}: exit 11, "nothing sent", the reservation is released and the next run is not capped`, async () => {
      const h = await ready("0.186");
      const r = await cli(h, runArgs("n1"), { provider: new P({ complete }) });
      expect(r.code, r.err).toBe(11);
      expect(r.err).toMatch(/nothing sent/);
      expect(booked(ledger(h).at(-1)!)).toEqual({ state: "refused_local", spend: null, cap_charge: 0 });
      const next = new P();
      expect((await cli(h, runArgs("n2"), { provider: next })).code).toBe(0);
      expect(next.calls).toBe(1);
    });
  }

  it("control: a refusal at the pre-mint gate (PaidGateError) stays exit 5", async () => {
    const h = await ready("0.186");
    const r = await cli(h, runArgs("g1"), { provider: new P({ complete: async () => { throw new PaidGateError("FLOP genesis check failed: genesis mismatch"); } }) });
    expect(r.code, r.err).toBe(5);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "refused_local", spend: null, cap_charge: 0 });
  });

  it("control: a gateway HTTP error on the paid call itself stays exit 1 and holds the reservation", async () => {
    const h = await ready("0.186");
    const r = await cli(h, runArgs("e1"), { provider: new P({ complete: async () => { throw new FlopHTTPError(500, {}, null); } }) });
    expect(r.code, r.err).toBe(1);
    expect(r.err).not.toMatch(/nothing sent/);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "error", spend: null, cap_charge: 0.186 });
    expect((await cli(h, runArgs("e2"), { provider: new P() })).code).toBe(3);
  });

  it("EXIT.NOT_SENT is 11 and shares its value with no other code", () => {
    const values = Object.values(EXIT) as number[];
    expect((EXIT as Record<string, number>).NOT_SENT).toBe(11);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("finding 10: reserved_spend is held to the amount rule (finite and >= 0, else unknown)", () => {
  const classify = (reserved: unknown) => classifyReceipt({ request_id: "r", reserved_spend: reserved, state: "estimated" } as GatewayReceipt, { job: "j", provider: "mock" });
  const notAmounts: [string, unknown][] = [["-0.5", -0.5], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["-Infinity", Number.NEGATIVE_INFINITY], ["the string 0.186", "0.186"], ["true", true]];

  for (const [name, value] of notAmounts) {
    it(`reserved_spend ${name} is unknown: reserved null, and the receipt line shows it blank`, () => {
      const c = classify(value);
      expect(c.reserved).toBeNull();
      expect(receiptLine(c)).toContain("reserved=  settled=");
    });
  }

  it("control: 0 and 0.186 are amounts and are kept", () => {
    expect([classify(0).reserved, classify(0.186).reserved, classify(null).reserved]).toEqual([0, 0.186, null]);
    expect(receiptLine(classify(0.186))).toContain("reserved=0.186  settled=");
  });

  it("knownAmount is the one rule, for reserved and for settled", () => {
    for (const [name, value] of notAmounts) expect(knownAmount(value), name).toBeNull();
    expect([knownAmount(0), knownAmount(0.05), knownAmount(null), knownAmount(undefined)]).toEqual([0, 0.05, null, null]);
    const c = classifyReceipt({ request_id: "r", reserved_spend: -1, settled_spend: -1, state: "settled" } as GatewayReceipt, { job: "j", provider: "mock" });
    expect({ reserved: c.reserved, settled: c.settled }).toEqual({ reserved: null, settled: null });
  });

  for (const [name, value] of notAmounts.slice(0, 3)) {
    it(`run with reserved_spend ${name}: stdout, the receipt file and receipt <id> never show it`, async () => {
      const h = await ready();
      const read = (id: string) => receiptFor(id, { reserved_spend: value });
      const run = await cli(h, runArgs(), { provider: new P({ read }) });
      expect(run.code, run.err).toBe(0);
      const rid = run.json().request_id as string;
      expect(run.json().receipt.reserved).toBeNull();
      expect(JSON.parse(readFileSync(join(h, "receipts", `${rid}.json`), "utf8")).reserved).toBeNull();
      const text = await cli(h, ["run", "--seat", SEAT, "--job", "j1", "--prompt", "Say hi", "--provider", "mock", "--max-tokens", "8"], { provider: new P({ read }) });
      const shown = await cli(h, ["receipt", rid, "--seat", SEAT]);
      for (const out of [text.out, shown.out]) {
        expect(out).toContain("reserved=  settled=");
        expect(out).not.toContain(`reserved=${name}`);
      }
    });
  }
});

describe("finding 11: a negative token count is not a usable count", () => {
  const est = (tin: unknown, tout: unknown) => ({ estimated_cost_flop: 0.066, estimated_input_tokens: tin, estimated_output_tokens: tout }) as never;

  it("padQuote returns null for a negative input or output count", () => {
    expect(padQuote(est(3, -2))).toBeNull(); // was padded 1.386: the divisor shrank to 1
    expect(padQuote(est(-1, 8))).toBeNull(); // was padded 0.254572
    expect(padQuote(est(-3, 8))).toBeNull(); // was padded 0.33, the audit report's example
    expect(padQuote(est(-3, -8))).toBeNull();
    expect(padQuote(est(-0.5, 8))).toBeNull();
  });

  it("control: zero, missing and positive counts pad as before", () => {
    expect(padQuote(est(3, 8))).toEqual({ raw: 0.066, padded: 0.186 });
    expect(padQuote(est(0, 8))).toEqual({ raw: 0.066, padded: 0.231 });
    expect(padQuote({ estimated_cost_flop: 0.066, estimated_output_tokens: 8 })).toEqual({ raw: 0.066, padded: 0.231 });
  });

  it("run with a negative count in the estimate refuses with exit 7, nothing sent", async () => {
    const h = await ready("5");
    const p = new P({ estimate: { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: -2 } });
    const r = await cli(h, runArgs(), { provider: p });
    expect({ code: r.code, calls: p.calls }).toEqual({ code: 7, calls: 0 });
    expect(r.err).toMatch(/estimate returned no usable cost/);
    const last = ledger(h).at(-1)!;
    expect({ state: last.state, quote_padded: last.quote_padded, cap_charge: last.cap_charge }).toEqual({ state: "refused_local", quote_padded: null, cap_charge: 0 });
  });
});
