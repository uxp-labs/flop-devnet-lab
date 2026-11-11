/**
 * The swarm audit of commit 8ddc5d2 (IMD job 769d5aeb). Findings 1 to 4, 8 to 11 and 13 are imd-flop's.
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
 *  13  the seat's daily cap bounds every call the seat's key pays for, whoever the call is for. A requester
 *      call must fit the per-call cap, the seat's daily cap and its job budget (the owner's decision)
 * Findings 5, 6 and 7 are the viewer's. Finding 12 is a documented residual: R-e in contract/rules.json.
 * The blocks named "review" are the review of the audit 8ddc5d2 fixes. They fail on 36b23fe, the commit the
 * review read, and pass with their fix:
 *   item 3  status keeps working when a receipt file cannot be matched, and names the file
 * Booking step, review of the audit 8ddc5d2 fixes: nextBooking and refreshBooking became the one decision
 * decideBooking(prev, read, costReported). The assertions that called them call it now, with the same
 * expectations: a booking that equals the previous row is what refreshBooking called "unchanged", a
 * different one is what it called "append", and `disagree` is its "disagree".
 * Stub providers only; no network (test/setup.ts disables fetch).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlopHTTPError } from "@flop-labs/client";
import { knownAmount } from "../src/amount.js";
import { EXIT } from "../src/errors.js";
import { mintChildKey, PaidGateError, PreSendError } from "../src/gateway.js";
import { jobSpent, spentToday, utcDay } from "../src/ledger.js";
import { matchable } from "../src/match.js";
import { network } from "../src/networks.js";
import { checkBudget, noRoom, padQuote } from "../src/policy.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { classifyReceipt, receiptLine, type GatewayReceipt } from "../src/receipts.js";
import { ceil6, floor6 } from "../src/rounding.js";
import { CHARGE_RAISED, decideBooking, DISAGREE, PAST_ADMITTED, reportedCost, settledSpend } from "../src/settlement.js";
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
    // Moved (hold floor): charged 0.05 before. The charge keeps the 0.186 hold.
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.186 });
  });

  it("the rule lives in settlement.ts: a redacted read proves no settlement and moves no state", () => {
    const read = { fresh: true, identityOk: true, state: "settled", settled: 0.05 };
    expect(settledSpend({ ...read, redacted: true })).toBeNull();
    expect(decideBooking({ state: "estimated", spend: null, cap_charge: 0.186 }, { ...read, redacted: true }, null)).toEqual({ booking: { state: "estimated", spend: null, cap_charge: 0.186 }, disagree: false, pastAdmitted: false });
    expect(settledSpend({ ...read, redacted: false })).toBe(0.05);
  });
});

describe("finding 2: a later read never lowers a booked settlement, and a reported cost never lowers the charge", () => {
  const read = (state: string, settled: unknown) => ({ fresh: true, identityOk: true, redacted: false, state, settled });
  const settledAt = (spend: number) => (id: string) => receiptFor(id, { settled_spend: spend, state: "settled" });
  const releasedAt = (spend: number) => (id: string) => receiptFor(id, { settled_spend: spend, state: "released" });
  const usage = (cost: number) => ({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: cost });

  describe("(a) a booked known settlement is never lowered", () => {
    const settled005 = { state: "settled", spend: 0.05, cap_charge: 0.05 };

    it("decideBooking: settled 0.05, then a fresh released 0 changes nothing", () => {
      expect(decideBooking(settled005, read("released", 0), null).booking).toEqual(settled005);
    });

    it("decideBooking: the same read is a disagreement, not a new row", () => {
      expect(decideBooking(settled005, read("released", 0), null)).toEqual({ booking: settled005, disagree: true, pastAdmitted: false });
      expect(decideBooking(settled005, read("settled", 0.049999), null)).toEqual({ booking: settled005, disagree: true, pastAdmitted: false });
    });

    it("an equal amount may still move the state, and a higher amount is booked", () => {
      expect(decideBooking(settled005, read("released", 0.05), null)).toEqual({ booking: { state: "released", spend: 0.05, cap_charge: 0.05 }, disagree: false, pastAdmitted: false });
      // Moved (money stage 1, decision 1): a read that books a different known spend brings its own exact
      // spend, here unknown (null). The state, spend and charge are as before. settled005 is a row an older
      // version booked below its hold: it is not migrated, and a higher settlement raises its charge.
      expect(decideBooking(settled005, read("settled", 0.07), null)).toEqual({ booking: { state: "settled", spend: 0.07, cap_charge: 0.07, spend_raw: null }, disagree: false, pastAdmitted: false });
    });

    it("control: a settling state with no known spend still learns its settlement, whatever the amount", () => {
      // Moved (hold floor): the charge followed the settlement down to 0.01 and 0. It keeps the hold, and the
      // read sets the pair of float and exact spend (no exact amount here).
      expect(decideBooking({ state: "settled", spend: null, cap_charge: 0.186 }, read("settled", 0.01), null).booking).toEqual({ state: "settled", spend: 0.01, cap_charge: 0.186, spend_raw: null });
      expect(decideBooking({ state: "estimated", spend: null, cap_charge: 0.186 }, read("released", 0), null).booking).toEqual({ state: "released", spend: 0, cap_charge: 0.186, spend_raw: null });
    });

    for (const [name, later] of [["released 0", releasedAt(0)], ["settled 0.01", settledAt(0.01)]] as const) {
      it(`run settles 0.05, then a refresh reads ${name}: nothing appended, DISAGREE, 0.05 still booked`, async () => {
        const h = await ready();
        const run = await cli(h, runArgs(), { provider: new P({ read: settledAt(0.05) }) });
        expect(run.code, run.err).toBe(0);
        const rid = run.json().request_id as string;
        // Moved (hold floor): charged 0.05 before, the hold now.
        expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.186 });
        const before = ledger(h).length;
        const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: later }) });
        expect(refreshed.code, refreshed.err).toBe(0);
        expect({ appended: ledger(h).length - before, last: booked(ledger(h).at(-1)!), warned: refreshed.err.includes(DISAGREE), status: refreshed.json().status, ledger_spend: refreshed.json().ledger_spend })
          .toEqual({ appended: 0, last: { state: "settled", spend: 0.05, cap_charge: 0.186 }, warned: true, status: DISAGREE, ledger_spend: 0.05 });
      });
    }
  });

  // Moved (hold floor): this section was "the charge of a proven settlement is max(settled, reported cost)",
  // with a cost of 0.15 raising a settled charge of 0.05. The charge now keeps the 0.186 hold, so it is
  // max(hold, settled, reported cost), and the costs that raise it here are above the hold.
  describe("(b) the charge of a proven settlement is max(hold, settled, reported cost); spend stays the settled figure", () => {
    it("decideBooking: a reported cost raises the settled charge and never lowers it", () => {
      const sent = { state: "sent", spend: null, cap_charge: 0.186 };
      expect(decideBooking(sent, read("released", 0), 0.3).booking).toEqual({ state: "released", spend: 0, cap_charge: 0.3, spend_raw: null });
      expect(decideBooking(sent, read("settled", 0.05), 0.3).booking).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.3, spend_raw: null });
      expect(decideBooking(sent, read("settled", 0.05), 0.15).booking).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.186, spend_raw: null });
      expect(decideBooking(sent, read("settled", 0.05), null).booking).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.186, spend_raw: null });
    });

    it("a reported cost counts only when reportedCost reads a finite number: 0.3 raises the settled charge, and anything else leaves it", () => {
      const prev = { state: "estimated", spend: null, cap_charge: 0.186 };
      expect(decideBooking(prev, read("settled", 0.05), reportedCost(0.3))).toEqual({ booking: { state: "settled", spend: 0.05, cap_charge: 0.3, spend_raw: null }, disagree: false, pastAdmitted: false });
      for (const bad of [null, undefined, "0.3", Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(decideBooking(prev, read("settled", 0.05), reportedCost(bad)), String(bad)).toEqual({ booking: { state: "settled", spend: 0.05, cap_charge: 0.186, spend_raw: null }, disagree: false, pastAdmitted: false });
      }
    });

    it("run: usage.cost_flop 0.3 and a released / 0 receipt books spend 0 with cap_charge 0.3, and says why", async () => {
      // The cost is above the 0.186 padded quote, so the booking also says it passed what the cap admitted.
      const h = await ready();
      const run = await cli(h, runArgs(), { provider: new P({ usage: usage(0.3), read: releasedAt(0) }) });
      expect(run.code, run.err).toBe(0);
      const last = ledger(h).at(-1)!;
      expect({ ...booked(last), cost_reported: last.cost_reported, reason: last.reason }).toEqual({ state: "released", spend: 0, cap_charge: 0.3, cost_reported: 0.3, reason: `${PAST_ADMITTED}; ${CHARGE_RAISED}` });
      expect(run.err).toBe(PAST_ADMITTED);
      expect(run.json().cap_charge).toBe(0.3);
      expect((await cli(h, ["status", "--seat", SEAT, "--json"])).json().today_utc.mock).toBe(0.3);
    });

    it("control: a reported cost below the hold leaves the charge at the hold and no reason", async () => {
      const h = await ready();
      const run = await cli(h, runArgs(), { provider: new P({ usage: usage(0.01), read: settledAt(0.05) }) });
      expect(run.code, run.err).toBe(0);
      const last = ledger(h).at(-1)!;
      expect({ ...booked(last), reason: last.reason }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.186, reason: null });
    });

    it("run then refresh: the settlement learned later is charged at the reported cost, once", async () => {
      const h = await ready();
      const run = await cli(h, runArgs(), { provider: new P({ usage: usage(0.3) }) });
      expect(run.code, run.err).toBe(0);
      const rid = run.json().request_id as string;
      // The cost is above the hold, so it raises the held charge already, and run says it passed what the cap admitted.
      expect({ ...booked(ledger(h).at(-1)!), warned: run.err }).toEqual({ state: "estimated", spend: null, cap_charge: 0.3, warned: PAST_ADMITTED });
      const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
      expect({ code: refreshed.code, err: refreshed.err }).toEqual({ code: 0, err: "" });
      const last = ledger(h).at(-1)!;
      expect({ ...booked(last), cost_reported: last.cost_reported, reason: last.reason }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.3, cost_reported: 0.3, reason: CHARGE_RAISED });
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
    // Since finding 13 a requester state carries two totals. The job's spend is jobSpentBefore, so it is named here.
    expect(checkBudget({ padded: 0.000001, cap: { daily: 5, perCall: 5 }, payer: "requester", spentBefore: 0.9999992, jobSpentBefore: 0.9999992, jobBudget: 1 })).toMatchObject({ code: 3, reason: expect.stringMatching(/requester budget/) });
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
    // Since finding 13 a requester state carries two totals: the seat's spend today and the job's spend.
    const requester = { cap, payer: "requester" as const, spentBefore: 0.3, jobSpentBefore: 0.3, jobBudget: 0.3 };
    expect(noRoom(requester)).toEqual({ reason: "requester budget reached (0.3/0.3 FLOP on this job)", code: 3 });
    for (const state of [holder, requester]) {
      for (const padded of [0.000001, 0.186, 0.9]) expect(checkBudget({ ...state, padded })).toEqual(noRoom(state));
    }
    expect(noRoom({ cap, payer: "requester", spentBefore: 0, jobSpentBefore: 0, jobBudget: Number.POSITIVE_INFINITY })).toEqual({ reason: 'no usable requester budget for payer "requester"', code: 3 });
    expect(noRoom({ ...holder, spentBefore: 0.999999 })).toBeNull();
    expect(noRoom({ ...requester, spentBefore: 0.299999, jobSpentBefore: 0.299999 })).toBeNull();
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

describe("finding 13: the seat's daily cap bounds every call the seat's key pays for, whoever the call is for", () => {
  const budget = (flop: string) => ["--job-budget", flop];
  type PayerRow = Row & { payer: string; job: string; job_spent_before?: number | null };
  const rows = (h: string) => ledger(h) as PayerRow[];
  /** What a row says about the two limits: the seat's spend today and the job's spend, both before the call. */
  const totals = (r: PayerRow) => ({ payer: r.payer, state: r.state, spent_before: r.spent_before, job_spent_before: r.job_spent_before });
  const settles = (spend: number) => (id: string) => receiptFor(id, { settled_spend: spend, state: "settled" });
  async function readyRequester(cap: string) {
    const h = await ready(cap);
    expect((await cli(h, ["config", "set", "payer", "requester"])).code).toBe(0);
    return h;
  }

  // The repro's own commands. The report's figures (padded quote 0.186 each, 0.93 FLOP reserved) are those of
  // this file's stub provider. The built-in mock quotes 0.18 for the same prompt. Both were five exits of 0
  // against a 0.2 FLOP/day cap, with spent_today_mock 0.
  const repro: [string, (() => Provider) | null, number, number][] = [["this file's stub provider", () => new P(), 0.186, 0.014], ["the built-in mock", null, 0.18, 0.02]];
  for (const [name, provider, quote, left] of repro) {
    it(`the audit's repro with ${name}: cap 0.2, payer requester, five jobs with --job-budget 1: the second run is refused (exit 3) and cap show reports ${quote}`, async () => {
      const h = tmpHome();
      await cli(h, ["init", "--seat", "9001"]);
      await cli(h, ["link", "--token", "9001", "--agent", "7"]);
      await cli(h, ["cap", "set", "0.2"]);
      await cli(h, ["config", "set", "payer", "requester"]);
      const runs = [];
      for (let i = 1; i <= 5; i++) runs.push(await cli(h, ["run", "--job", `job-${i}`, "--prompt", "Say hi", "--max-tokens", "8", "--job-budget", "1", "--provider", "mock"], provider ? { provider: provider() } : {}));
      expect(runs.map((r) => r.code)).toEqual([0, 3, 3, 3, 3]);
      expect(runs[1].err).toBe(`imd-flop: refused locally, nothing sent: padded quote ${quote} FLOP is over the remaining daily cap ${left}`);
      const shown = (await cli(h, ["cap", "show", "--json"])).json();
      expect({ daily: shown.cap.daily, spent_today_mock: shown.spent_today_mock }).toEqual({ daily: 0.2, spent_today_mock: quote });
      expect((await cli(h, ["cap", "show"])).out).toBe(`seat 9001: cap 0.2 FLOP/day (UTC), 0.2 per call. Today: flop 0, mock ${quote}`);
      expect((await cli(h, ["status", "--json"])).json().today_utc.mock).toBe(quote);
      expect(rows(h).filter((r) => r.state === "refused_local")).toHaveLength(4);
    });
  }

  it("a requester call inside the daily cap but over its job budget is refused (exit 3), and the row records both totals", async () => {
    const h = await readyRequester("5");
    // Another job runs first, so the seat's spend today (0.372) and this job's spend (0.186) differ.
    expect((await cli(h, runArgs("other", budget("1")), { provider: new P() })).code).toBe(0);
    expect((await cli(h, runArgs("j1", budget("0.3")), { provider: new P() })).code).toBe(0);
    const p = new P();
    const r = await cli(h, runArgs("j1", budget("0.3")), { provider: p });
    expect({ code: r.code, estimates: p.estimates, calls: p.calls }).toEqual({ code: 3, estimates: 1, calls: 0 });
    expect(r.err).toBe("imd-flop: refused locally, nothing sent: padded quote 0.186 FLOP is over this job's remaining requester budget 0.114");
    expect(totals(rows(h).at(-1)!)).toEqual({ payer: "requester", state: "refused_local", spent_before: 0.372, job_spent_before: 0.186 });
  });

  it("a holder call after requester calls sees their charges", async () => {
    const h = await readyRequester("0.2");
    expect((await cli(h, runArgs("j1", budget("1")), { provider: new P() })).code).toBe(0);
    expect((await cli(h, ["config", "set", "payer", "holder"])).code).toBe(0);
    const p = new P();
    const r = await cli(h, runArgs("j2"), { provider: p });
    expect({ code: r.code, calls: p.calls }).toEqual({ code: 3, calls: 0 });
    expect(r.err).toBe("imd-flop: refused locally, nothing sent: padded quote 0.186 FLOP is over the remaining daily cap 0.014");
    expect(totals(rows(h).at(-1)!)).toEqual({ payer: "holder", state: "refused_local", spent_before: 0.186, job_spent_before: null });
  });

  it("the refusal before the estimate fires for a requester when the day is used up", async () => {
    const h = await readyRequester("0.186");
    expect((await cli(h, runArgs("a", budget("1")), { provider: new P() })).code).toBe(0);
    const p = new P();
    const r = await cli(h, runArgs("b", budget("1")), { provider: p });
    expect({ code: r.code, estimates: p.estimates, calls: p.calls }).toEqual({ code: 3, estimates: 0, calls: 0 });
    expect(r.err).toBe("imd-flop: refused locally, nothing sent: daily cap reached (0.186/0.186 FLOP today, UTC)");
    const last = rows(h).at(-1)!;
    expect({ ...totals(last), request_id: last.request_id, quote_padded: last.quote_padded, cap_charge: last.cap_charge })
      .toEqual({ payer: "requester", state: "refused_local", spent_before: 0.186, job_spent_before: 0, request_id: null, quote_padded: null, cap_charge: 0 });
  });

  it("the check under the ledger lock reads the seat's spend for a requester too: room that goes during the estimate refuses the call", async () => {
    const h = await readyRequester("0.186");
    const p = new P();
    // Another process books a holder paid 0.186 while this requester run waits for its quote.
    p.estimate = async () => {
      p.estimates += 1;
      seedCharge(h, "other-process", 0.186);
      return QUOTE as never;
    };
    const r = await cli(h, runArgs("a", budget("1")), { provider: p });
    expect({ code: r.code, estimates: p.estimates, calls: p.calls }).toEqual({ code: 3, estimates: 1, calls: 0 });
    const last = rows(h).at(-1)!;
    expect({ ...totals(last), reason: last.reason, quote_padded: last.quote_padded })
      .toEqual({ payer: "requester", state: "refused_local", spent_before: 0.186, job_spent_before: 0, reason: "daily cap reached (0.186/0.186 FLOP today, UTC)", quote_padded: 0.186 });
  });

  it("every row a run writes carries both totals: spent_before is the seat's spend today, job_spent_before the job's (null on a holder row)", async () => {
    const h = await ready("5");
    expect((await cli(h, runArgs("h1"), { provider: new P() })).code).toBe(0);
    expect((await cli(h, ["config", "set", "payer", "requester"])).code).toBe(0);
    expect((await cli(h, runArgs("j1", budget("1")), { provider: new P() })).code).toBe(0);
    expect((await cli(h, runArgs("j1", budget("1")), { provider: new P({ read: settles(0.05) }) })).code).toBe(0);
    const last = await cli(h, runArgs("j2", budget("1")), { provider: new P() });
    expect(last.code, last.err).toBe(0);
    // A refresh appends a copy of the attempt's row with the new booking: both totals stay as they were.
    expect((await cli(h, refreshArgs(last.json().request_id as string), { provider: new P({ read: settles(0.1) }) })).code).toBe(0);
    const all = rows(h);
    expect(all.every((r) => "job_spent_before" in r)).toBe(true);
    expect(all.map(totals)).toEqual([
      { payer: "holder", state: "sent", spent_before: 0, job_spent_before: null },
      { payer: "holder", state: "estimated", spent_before: 0, job_spent_before: null },
      { payer: "requester", state: "sent", spent_before: 0.186, job_spent_before: 0 },
      { payer: "requester", state: "estimated", spent_before: 0.186, job_spent_before: 0 },
      { payer: "requester", state: "sent", spent_before: 0.372, job_spent_before: 0.186 },
      { payer: "requester", state: "settled", spent_before: 0.372, job_spent_before: 0.186 },
      { payer: "requester", state: "sent", spent_before: 0.558, job_spent_before: 0 },
      { payer: "requester", state: "estimated", spent_before: 0.558, job_spent_before: 0 },
      { payer: "requester", state: "settled", spent_before: 0.558, job_spent_before: 0 },
    ]);
    // status reports the seat's total for the day, all payers. Moved (hold floor): this was 0.186 + 0.186 +
    // 0.05 + 0.1 = 0.522. Every call keeps its 0.186 hold, so it is 4 x 0.186; the gateway reported 0.15.
    const st = (await cli(h, ["status", "--seat", SEAT, "--json"])).json();
    expect({ charged: st.today_utc.mock, reported: st.gateway_spent_today_utc.mock }).toEqual({ charged: 0.744, reported: 0.15 });
  });

  it("an unusable ledger charge on any of the seat's rows today refuses the next call, whoever either call is for (exit 3, no estimate)", async () => {
    const bad = (payer: string) => JSON.stringify({ day: utcDay(), request_id: "seed-bad", seat: SEAT, job: "seed", provider: "mock", payer, state: "sent", cap_charge: null }) + "\n";
    for (const [seeded, next] of [["requester", "holder"], ["holder", "requester"]] as const) {
      const h = await ready("5");
      appendFileSync(join(h, "ledger.jsonl"), bad(seeded));
      await cli(h, ["config", "set", "payer", next]);
      const p = new P();
      const r = await cli(h, runArgs("a", next === "requester" ? budget("1") : []), { provider: p });
      expect({ code: r.code, estimates: p.estimates, calls: p.calls }, `${seeded} row, ${next} call`).toEqual({ code: 3, estimates: 0, calls: 0 });
      expect(r.err).toMatch(/ledger cap_charge unusable; next call refused/);
      expect(totals(rows(h).at(-1)!)).toEqual({ payer: next, state: "refused_local", spent_before: null, job_spent_before: null });
    }
  });

  it("spentToday counts every row of the seat for that provider and UTC day; jobSpent stays the requester rows of one job", () => {
    const h = tmpHome();
    seedCharge(h, "h1", 0.1);
    seedCharge(h, "r1", 0.2, "requester", "ja");
    seedCharge(h, "r2", 0.05, "requester", "jb");
    expect(spentToday(h, SEAT, "mock")).toBe(0.35);
    expect([jobSpent(h, "ja", "mock"), jobSpent(h, "jb", "mock"), jobSpent(h, "seed", "mock")]).toEqual([0.2, 0.05, 0]);
    // Control: another seat, another provider and another day are not this seat's spend today.
    expect([spentToday(h, "9002", "mock"), spentToday(h, SEAT, "flop"), spentToday(h, SEAT, "mock", "2000-01-01")]).toEqual([0, 0, 0]);
  });

  describe("policy.ts: the limits that apply to a payer, in order", () => {
    const cap = { daily: 1, perCall: 0.5 };
    const DAY_USED = { reason: "daily cap reached (1/1 FLOP today, UTC)", code: 3 };
    /** A requester state: the seat's spend today, this job's spend, and the job budget. */
    const req = (spentBefore: number, jobSpentBefore: number, jobBudget = 0.3) => ({ cap, payer: "requester" as const, spentBefore, jobBudget, jobSpentBefore });

    it("noRoom refuses on the first limit with nothing left: the daily cap for every payer, then the job budget for a requester", () => {
      expect(noRoom(req(1, 0))).toEqual(DAY_USED); // the job budget has 0.3 left, the day has nothing
      expect(noRoom(req(1, 0.3))).toEqual(DAY_USED); // both used up: the daily cap is first
      expect(noRoom(req(0.5, 0.3))).toEqual({ reason: "requester budget reached (0.3/0.3 FLOP on this job)", code: 3 });
      expect(noRoom(req(0.5, 0.1))).toBeNull();
      expect(noRoom({ cap, payer: "holder", spentBefore: 1 })).toEqual(DAY_USED);
    });

    it("checkBudget: noRoom, then the per-call cap, then the first limit the padded quote does not fit", () => {
      const overDay = { reason: "padded quote 0.186 FLOP is over the remaining daily cap 0.1", code: 3 };
      expect(checkBudget({ ...req(0.9, 0), padded: 0.186 })).toEqual(overDay); // fits the job budget, not the day
      expect(checkBudget({ ...req(0.9, 0.2), padded: 0.186 })).toEqual(overDay); // fits neither: the daily cap is first
      expect(checkBudget({ ...req(0.5, 0.2), padded: 0.186 })).toEqual({ reason: "padded quote 0.186 FLOP is over this job's remaining requester budget 0.1", code: 3 });
      expect(checkBudget({ ...req(0.9, 0.2), padded: 0.6 })).toEqual({ reason: "padded quote 0.6 FLOP is over the per-call cap 0.5", code: 3 });
      expect(checkBudget({ ...req(1, 0.2), padded: 0.6 })).toEqual(DAY_USED); // nothing left comes before the per-call cap
      expect(checkBudget({ ...req(0.5, 0.1), padded: 0.186 })).toBeNull();
      expect(checkBudget({ ...req(0.5, 0.1), padded: 0.2 })).toBeNull(); // exactly what the job budget has left
    });

    it("fails closed: a requester state without a usable job budget or job spend is refused, never read as 0", () => {
      const unusable = { reason: 'no usable requester budget for payer "requester"', code: 3 };
      expect(noRoom({ cap, payer: "requester", spentBefore: 0, jobBudget: 0.3 })).toEqual(unusable); // no job spend
      expect(noRoom({ cap, payer: "requester", spentBefore: 0, jobSpentBefore: 0 })).toEqual(unusable); // no job budget
      // A null from a file or another writer is not 0 either.
      expect(noRoom({ ...req(0, 0), jobSpentBefore: null as never })).toEqual(unusable);
      expect(noRoom({ ...req(0, 0), jobBudget: null as never })).toEqual(unusable);
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(noRoom({ ...req(0, 0), jobBudget: bad }), `budget ${bad}`).toEqual(unusable);
        expect(noRoom({ ...req(0, 0), jobSpentBefore: bad }), `job spend ${bad}`).toEqual(unusable);
        expect(checkBudget({ ...req(0, 0), jobBudget: bad, padded: 0.186 }), `budget ${bad}`).toEqual(unusable);
      }
    });

    it("fails closed: a daily cap room that is not a finite number is refused, for every payer", () => {
      const unusable = { reason: "no usable daily cap (NaN/1 FLOP today, UTC)", code: 3 };
      expect(noRoom({ cap, payer: "holder", spentBefore: Number.NaN })).toEqual(unusable);
      expect(noRoom(req(Number.NaN, 0))).toEqual(unusable);
      expect(checkBudget({ cap, payer: "holder", spentBefore: Number.NaN, padded: 0.186 })).toEqual(unusable);
    });

    it("control: a payer that is neither is refused as before, and a holder is bounded by the daily cap alone", () => {
      expect(noRoom({ cap, payer: "sponsor" as never, spentBefore: 0 })).toEqual({ reason: 'no usable requester budget for payer "sponsor"', code: 3 });
      expect(checkBudget({ cap, payer: "sponsor" as never, spentBefore: 0, jobBudget: 1, jobSpentBefore: 0, padded: 0.186 })).toEqual({ reason: 'no usable requester budget for payer "sponsor"', code: 3 });
      // Job figures on a holder state are not read: the job budget is the requester's limit.
      expect(checkBudget({ cap, payer: "holder", spentBefore: 0.5, jobBudget: 0.01, jobSpentBefore: 5, padded: 0.186 })).toBeNull();
    });
  });

  it("config set payer requester says the seat's daily cap still applies", async () => {
    const h = await ready();
    const r = await cli(h, ["config", "set", "payer", "requester"]);
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: "payer = requester (run needs --job-budget; the seat's daily cap still applies)" });
  });
});

describe("review: status survives a receipt it cannot match", () => {
  // matchReceipt builds the link path from the receipt's seat. A seat that is not a string made it throw
  // (quirk Q-IDENTITY-FIELDS), so one such file aborted status and hid every other receipt.
  const BAD = "x.json";
  const withSeat = (seat: unknown) => JSON.stringify({ request_id: "x", seat, did: "d", job: "j" });
  async function oneRun() {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P() });
    expect(run.code, run.err).toBe(0);
    return { h, rid: run.json().request_id as string };
  }

  for (const [what, seat] of [["a number", 5], ["an object", {}]] as const) {
    it(`a receipt file whose seat is ${what}: status --json exits 0, lists the other receipt and names the file`, async () => {
      const { h, rid } = await oneRun();
      writeFileSync(join(h, "receipts", BAD), withSeat(seat));
      const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
      expect({ code: st.code, err: st.err }).toEqual({ code: 0, err: "" });
      const o = st.json();
      expect(o.unreadable_receipts).toEqual([BAD]);
      expect(o.recent_receipts.map((r: { request_id: string }) => r.request_id)).toEqual([rid]);
      expect(o.today_utc.mock).toBe(0.186);
    });
  }

  it("text output: the overview is printed, and the one line names the file beside an unreadable one", async () => {
    const { h, rid } = await oneRun();
    writeFileSync(join(h, "receipts", BAD), withSeat(5));
    writeFileSync(join(h, "receipts", "mock-9001-deadbeef.json"), "{not json");
    const st = await cli(h, ["status", "--seat", SEAT]);
    expect({ code: st.code, err: st.err }).toEqual({ code: 0, err: "" });
    expect(st.out).toContain(`seat ${SEAT}`);
    expect(st.out).toContain(rid);
    expect(st.out.split("\n").filter((l) => l.includes("unreadable"))).toEqual(["  unreadable receipt files (not shown): mock-9001-deadbeef.json, x.json"]);
  });

  it("matchable: a receipt can be matched when its seat is a string or absent, and not otherwise", () => {
    for (const seat of ["9001", "", null, undefined]) expect(matchable({ seat }), JSON.stringify(seat)).toBe(true);
    expect(matchable({})).toBe(true);
    for (const seat of [5, 0, {}, [], ["9001"], true, false]) expect(matchable({ seat }), JSON.stringify(seat)).toBe(false);
  });

  it("control: a receipt whose other identity fields are malformed can be matched, and is shown as a mismatch", async () => {
    const { h, rid } = await oneRun();
    writeFileSync(join(h, "receipts", "y.json"), JSON.stringify({ request_id: "y", seat: SEAT, did: 5, job: {}, observed_at: "2000-01-01T00:00:00.000Z" }));
    const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
    expect(st.code, st.err).toBe(0);
    const o = st.json();
    expect(o.unreadable_receipts).toEqual([]);
    expect(o.recent_receipts.map((r: { request_id: string; match: { match: string } }) => [r.request_id, r.match.match])).toEqual([[rid, "matches"], ["y", "mismatch"]]);
  });

  it("control: receipt <id> on that file is unchanged, it still fails with exit 1", async () => {
    const { h } = await oneRun();
    writeFileSync(join(h, "receipts", BAD), withSeat(5));
    const r = await cli(h, ["receipt", "x"]);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('The "path" argument must be of type string');
    expect(r.out).toBe("");
  });
});
