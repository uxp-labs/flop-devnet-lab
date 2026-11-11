/**
 * The booking step (review of the audit 8ddc5d2 fixes). An independent review of those fixes found that
 * the rule "a booked settlement is never lowered by a later read" did not hold when two readers booked the
 * same request, and that a stored read below the booked amount printed as fine. The fix starts with:
 *   - one decision for every receipt read (settlement.ts decideBooking).
 * Each test asserts the safe outcome. The blocks named "fails on dbffac0" failed on that commit, the one the
 * review read, and pass with the booking step.
 * Stub providers only; no network (test/setup.ts disables fetch).
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { CHARGE_RAISED, decideBooking, DISAGREE } from "../src/settlement.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9001";
const QUOTE = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }; // pads to 0.186
type Read = { http: number; error: string | null; receipt: Record<string, unknown> | null };
type Reader = (id: string) => Read | Promise<Read>;
interface Opts {
  usage?: Record<string, unknown>;
  read?: Reader;
}
/** A gateway receipt for the run's own request id. Pending unless fields say otherwise. */
const receiptFor = (id: string, fields: Record<string, unknown> = {}): Read => ({
  http: 200,
  error: null,
  receipt: { request_id: id, correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: null, state: "estimated", ...fields },
});
const settledAt = (spend: number) => (id: string) => receiptFor(id, { settled_spend: spend, state: "settled" });
const pending = (id: string) => receiptFor(id);
const failed: Reader = () => ({ http: 503, error: "HTTP 503", receipt: null });
class P implements Provider {
  readonly name = "mock" as const;
  calls = 0;
  constructor(private readonly o: Opts = {}) {}
  async estimate() {
    return QUOTE as never;
  }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    return { request_id: req.requestId, text: "ok", usage: (this.o.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) as CompleteRes["usage"] };
  }
  async readReceipt(id: string) {
    return (await (this.o.read ?? receiptFor)(id)) as never;
  }
}
const usage = (cost: number) => ({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: cost });
const runArgs = (extra: string[] = []) => ["run", "--seat", SEAT, "--job", "j1", "--prompt", "Say hi", "--provider", "mock", "--max-tokens", "8", "--json", ...extra];
const refreshArgs = (rid: string) => ["receipt", rid, "--refresh", "--json", "--seat", SEAT];
type Row = { request_id: string | null; state: string; spend: number | null; cap_charge: number | null; cost_reported: number | null; reason: string | null; http: number | null };
const ledgerPath = (home: string) => join(home, "ledger.jsonl");
const ledger = (home: string) => (existsSync(ledgerPath(home)) ? (readLines(ledgerPath(home)) as Row[]) : []);
const booked = (r: Row) => ({ state: r.state, spend: r.spend, cap_charge: r.cap_charge });
const today = async (home: string) => (await cli(home, ["status", "--seat", SEAT, "--json"])).json().today_utc.mock as number;
async function ready(cap = "1") {
  const h = tmpHome();
  await readySeat(h, SEAT, cap);
  return h;
}
/** A run whose own receipt read is pending: the row holds the padded quote, 0.186. */
async function pendingRun(home: string, opts: Opts = {}): Promise<string> {
  const run = await cli(home, runArgs(), { provider: new P(opts) });
  expect(run.code, run.err).toBe(0);
  expect(booked(ledger(home).at(-1)!)).toEqual({ state: "estimated", spend: null, cap_charge: 0.186 });
  return run.json().request_id as string;
}

describe("decideBooking: the one decision for every receipt read", () => {
  const trusted = (state: string | null, settled: unknown) => ({ fresh: true, identityOk: true, redacted: false, state, settled });
  const held = { state: "estimated", spend: null, cap_charge: 0.186 };
  const settled007 = { state: "settled", spend: 0.07, cap_charge: 0.07 };

  it("only a trusted read changes state or spend: a failed, a redacted and a wrong identity read change nothing", () => {
    for (const untrusted of [{ fresh: false }, { redacted: true }, { identityOk: false }]) {
      const read = { ...trusted("settled", 0.05), ...untrusted };
      expect(decideBooking(held, read, null), JSON.stringify(untrusted)).toEqual({ booking: held, disagree: false });
      expect(decideBooking(settled007, read, null), JSON.stringify(untrusted)).toEqual({ booking: settled007, disagree: false });
    }
  });

  it("a read below a booked settlement disagrees: state and spend stay", () => {
    for (const read of [trusted("settled", 0.05), trusted("released", 0)]) {
      expect(decideBooking(settled007, read, null)).toEqual({ booking: settled007, disagree: true });
    }
  });

  it("a proven settlement replaces the booked spend, and its charge replaces the hold", () => {
    expect(decideBooking(held, trusted("settled", 0.05), null)).toEqual({ booking: { state: "settled", spend: 0.05, cap_charge: 0.05 }, disagree: false });
    expect(decideBooking(settled007, trusted("released", 0.09), null)).toEqual({ booking: { state: "released", spend: 0.09, cap_charge: 0.09 }, disagree: false });
  });

  it("the state moves only forward: a trusted pending read never takes a settling state back", () => {
    for (const state of ["reserved", "estimated"]) {
      expect(decideBooking(settled007, trusted(state, null), null)).toEqual({ booking: settled007, disagree: false });
      expect(decideBooking({ state: "sent", spend: null, cap_charge: 0.186 }, trusted(state, null), null).booking.state).toBe(state);
    }
    // A settling state with no amount moves the state and books no spend: the hold stays charged.
    expect(decideBooking(held, trusted("released", null), null)).toEqual({ booking: { state: "released", spend: null, cap_charge: 0.186 }, disagree: false });
  });

  it("a reported cost raises a charge and never lowers it, on a hold and on a settlement alike", () => {
    expect(decideBooking(held, trusted("estimated", null), 0.3).booking.cap_charge).toBe(0.3);
    expect(decideBooking(held, trusted("estimated", null), 0.1).booking.cap_charge).toBe(0.186);
    expect(decideBooking(held, { ...trusted("settled", 0.05), fresh: false }, 0.3).booking).toEqual({ state: "estimated", spend: null, cap_charge: 0.3 });
    expect(decideBooking(held, trusted("settled", 0.05), 0.15).booking.cap_charge).toBe(0.15);
    // Also when the read itself is refused: the booked settlement stays, and its charge is raised.
    expect(decideBooking(settled007, trusted("settled", 0.05), 0.15)).toEqual({ booking: { state: "settled", spend: 0.07, cap_charge: 0.15 }, disagree: true });
    expect(decideBooking(settled007, { ...trusted("settled", 0.05), fresh: false }, 0.15).booking).toEqual({ state: "settled", spend: 0.07, cap_charge: 0.15 });
  });

  it("a charge that is not a known amount is never replaced by a guess: disagree, nothing changes, never 0", () => {
    for (const charge of [null, undefined, -1, Number.NaN, "0.186"]) {
      const unknown = { state: "estimated", spend: null, cap_charge: charge };
      for (const read of [trusted("estimated", null), trusted("settled", null), { ...trusted("settled", 0.05), fresh: false }]) {
        expect(decideBooking(unknown, read, 0.3), String(charge)).toEqual({ booking: unknown, disagree: true });
      }
      // A proven settlement is a known charge, so it is booked.
      expect(decideBooking(unknown, trusted("settled", 0.05), null), String(charge)).toEqual({ booking: { state: "settled", spend: 0.05, cap_charge: 0.05 }, disagree: false });
      // A read below the booked settlement stays refused, and the unknown charge stays as it is.
      const settledUnknown = { state: "settled", spend: 0.07, cap_charge: charge };
      expect(decideBooking(settledUnknown, trusted("settled", 0.05), null), String(charge)).toEqual({ booking: settledUnknown, disagree: true });
    }
  });
});

describe("fails on dbffac0: a reported cost raises a charge on a hold and on a settlement alike", () => {
  it("a settled row booked below its recorded cost is raised by the next refresh, whatever that refresh reads", async () => {
    // Such a row was booked before a reported cost could raise a settled charge. On dbffac0 only a refresh
    // that read a trusted settlement raised it.
    for (const read of [failed, pending, settledAt(0.05)]) {
      const h = await ready();
      const rid = await pendingRun(h, { usage: usage(0.15) });
      const hold = ledger(h).at(-1)!;
      expect(hold.cost_reported).toBe(0.15);
      appendFileSync(ledgerPath(h), JSON.stringify({ ...hold, state: "settled", spend: 0.05, cap_charge: 0.05, reason: null }) + "\n");
      const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read }) });
      expect(refreshed.code, refreshed.err).toBe(0);
      const last = ledger(h).at(-1)!;
      expect({ ...booked(last), reason: last.reason, warned: refreshed.err.includes(DISAGREE) }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.15, reason: CHARGE_RAISED, warned: false });
      expect(await today(h)).toBe(0.15);
    }
  });

  it("a refresh that reads below such a row's settlement is refused, and the charge is still raised", async () => {
    const h = await ready();
    const rid = await pendingRun(h, { usage: usage(0.15) });
    appendFileSync(ledgerPath(h), JSON.stringify({ ...ledger(h).at(-1)!, state: "settled", spend: 0.05, cap_charge: 0.05, reason: null }) + "\n");
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.01) }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    expect({ ...booked(ledger(h).at(-1)!), warned: refreshed.err.includes(DISAGREE) }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.15, warned: true });
  });
});
