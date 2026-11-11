/**
 * The booking step (review of the audit 8ddc5d2 fixes). An independent review of those fixes found that
 * the rule "a booked settlement is never lowered by a later read" did not hold when two readers booked the
 * same request, and that a stored read below the booked amount printed as fine. The fix is:
 *   - one decision for every receipt read (settlement.ts decideBooking),
 *   - one booking step under the ledger lock for `run` and `receipt --refresh` (booking.ts bookRead),
 *     which also takes what `run` saw when its paid call failed (bookFailure, settlement.ts decideFailure),
 *   - one verdict for a stored receipt beside its ledger row (settlement.ts reconcile), shown by `run`,
 *     `receipt <id>` and `status`. Its cases are the shared vectors in contract/vectors/reconcile.json.
 * Each test asserts the safe outcome. The blocks named "fails on dbffac0" failed on that commit, the one the
 * review read, and pass with the booking step. The blocks named "fails on 9adfd17" failed on the first
 * build of the booking step, which covered receipt reads only. The blocks named "pin" passed on dbffac0 too:
 * they hold a behavior the booking step must keep.
 * Stub providers only; no network (test/setup.ts disables fetch). A second process is stood in for by a
 * stub whose readReceipt runs the other reader before it answers, or by a child process that holds the real
 * ledger lock.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FlopHTTPError } from "@flop-labs/client";
import { bookFailure, bookRead } from "../src/booking.js";
import { PreSendError } from "../src/gateway.js";
import { utcDay } from "../src/ledger.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { LEDGER_BUSY } from "../src/receipt-store.js";
import { CHARGE_RAISED, decideBooking, decideFailure, DISAGREE, type Failure } from "../src/settlement.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9001";
const QUOTE = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }; // pads to 0.186
type Read = { http: number; error: string | null; receipt: Record<string, unknown> | null };
type Reader = (id: string) => Read | Promise<Read>;
interface Opts {
  usage?: Record<string, unknown>;
  complete?: (req: CompleteReq) => Promise<CompleteRes>;
  read?: Reader;
}
/** A gateway receipt for the run's own request id. Pending unless fields say otherwise. */
const receiptFor = (id: string, fields: Record<string, unknown> = {}): Read => ({
  http: 200,
  error: null,
  receipt: { request_id: id, correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: null, state: "estimated", ...fields },
});
const settledAt = (spend: number) => (id: string) => receiptFor(id, { settled_spend: spend, state: "settled" });
const releasedAt = (spend: number) => (id: string) => receiptFor(id, { settled_spend: spend, state: "released" });
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
    if (this.o.complete) return this.o.complete(req);
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
/** A reader that first lets another reader refresh the same request, as a second process would, then answers. */
const after = (home: string, other: Reader, own: Reader): Reader => async (id) => {
  const r = await cli(home, refreshArgs(id), { provider: new P({ read: other }) });
  expect(r.code, r.err).toBe(0);
  return own(id);
};
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

  it("fails on a3d71d6: a trusted read that moves a released reservation (refused_local) holds the padded quote again", () => {
    const released = { state: "refused_local", spend: null, cap_charge: 0, quote_padded: 0.186 };
    expect(decideBooking(released, trusted("estimated", null), null)).toEqual({ booking: { state: "estimated", spend: null, cap_charge: 0.186 }, disagree: false });
    expect(decideBooking(released, trusted("released", null), null)).toEqual({ booking: { state: "released", spend: null, cap_charge: 0.186 }, disagree: false });
    // The restored hold is raised by a reported cost, as any hold is.
    expect(decideBooking(released, trusted("reserved", null), 0.3).booking).toEqual({ state: "reserved", spend: null, cap_charge: 0.3 });
    // A proven settlement is booked as usual.
    expect(decideBooking(released, trusted("settled", 0.05), null)).toEqual({ booking: { state: "settled", spend: 0.05, cap_charge: 0.05 }, disagree: false });
    // A read that does not move the row changes nothing: an untrusted read, and a trusted read with no state.
    for (const read of [{ ...trusted("estimated", null), fresh: false }, trusted(null, null)]) {
      expect(decideBooking(released, read, null)).toEqual({ booking: { state: "refused_local", spend: null, cap_charge: 0 }, disagree: false });
    }
    // A padded quote that is not a known amount: the charge is unknown, so nothing is guessed and the read disagrees.
    for (const quote of [null, undefined, -1, "0.186"]) {
      const noQuote = { ...released, quote_padded: quote };
      expect(decideBooking(noQuote, trusted("estimated", null), 0.3), String(quote)).toEqual({ booking: { state: "refused_local", spend: null, cap_charge: 0 }, disagree: true });
      expect(decideBooking(noQuote, trusted("settled", 0.05), null), String(quote)).toEqual({ booking: { state: "settled", spend: 0.05, cap_charge: 0.05 }, disagree: false });
    }
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

describe("decideFailure: the one decision for what run reports when its paid call fails", () => {
  const REPORTS: Failure[] = ["timeout_unknown", "error", "refused_local"];

  it("a failure report never replaces a booked settlement: a settling row stays, whatever is reported", () => {
    const settling = [
      { state: "settled", spend: 0.3, cap_charge: 0.3 },
      { state: "released", spend: 0, cap_charge: 0 },
      { state: "settled", spend: null, cap_charge: 0.186 },
      { state: "settled", spend: 0.05, cap_charge: 0.15 },
    ];
    for (const row of settling) for (const report of REPORTS) expect(decideFailure(row, report), `${row.state} ${report}`).toBeNull();
  });

  it("a timeout or a gateway error moves a row that does not settle: the spend stays and the charge stays", () => {
    for (const state of ["sent", "reserved", "estimated"]) {
      for (const charge of [0.186, 0.3]) {
        expect(decideFailure({ state, spend: null, cap_charge: charge }, "timeout_unknown")).toEqual({ state: "timeout_unknown", spend: null, cap_charge: charge });
        expect(decideFailure({ state, spend: null, cap_charge: charge }, "error")).toEqual({ state: "error", spend: null, cap_charge: charge });
      }
    }
  });

  it("\"nothing was sent\" releases the reservation only from a row still in state sent", () => {
    expect(decideFailure({ state: "sent", spend: null, cap_charge: 0.186 }, "refused_local")).toEqual({ state: "refused_local", spend: null, cap_charge: 0 });
    // Moved (review of the booking step): this expected a release from reserved and estimated too. Only a
    // trusted gateway read produces those states, and such a read beats a "nothing was sent" report.
    for (const state of ["reserved", "estimated", "timeout_unknown", "error"]) {
      expect(decideFailure({ state, spend: null, cap_charge: 0.186 }, "refused_local"), state).toBeNull();
    }
    expect(decideFailure({ state: "settled", spend: 0.3, cap_charge: 0.3 }, "refused_local")).toBeNull();
  });

  it("a charge that is not a known amount is never replaced by a guess: the row stays, also for \"nothing was sent\"", () => {
    for (const charge of [null, undefined, -1, Number.NaN, "0.186"]) {
      for (const report of REPORTS) expect(decideFailure({ state: "sent", spend: null, cap_charge: charge }, report), `${String(charge)} ${report}`).toBeNull();
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

describe("fails on dbffac0: run books its own read against the latest row, not the row from before the call", () => {
  // While run waits for its receipt, another reader refreshes the same request and books settled 0.07.
  // Per the gateway's OpenAPI (CredentialReceipt), read 2026-11-11, later reconciliation can change the
  // gateway's ledger observation, so two reads of one request can differ.
  it("(a) own read settled 0.05: 0.07 stays booked, and DISAGREE is on stderr and in the result", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ read: after(h, settledAt(0.07), settledAt(0.05)) }) });
    expect(run.code, run.err).toBe(0);
    const rows = ledger(h);
    // The third row is run's own: it records the HTTP status of its read. The booking in it is the other reader's.
    expect(rows.map((r) => r.state)).toEqual(["sent", "settled", "settled"]);
    expect(booked(rows.at(-1)!)).toEqual({ state: "settled", spend: 0.07, cap_charge: 0.07 });
    expect({ warned: run.err.includes(DISAGREE), status: run.json().receipt.status, cap_charge: run.json().cap_charge, settled_read: run.json().receipt.settled })
      .toEqual({ warned: true, status: DISAGREE, cap_charge: 0.07, settled_read: 0.05 });
    expect(await today(h)).toBe(0.07);
  });

  it("(b) own read released 0: 0.07 stays booked and charged, and DISAGREE is on stderr and in the result", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ read: after(h, settledAt(0.07), releasedAt(0)) }) });
    expect(run.code, run.err).toBe(0);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.07, cap_charge: 0.07 });
    expect({ warned: run.err.includes(DISAGREE), status: run.json().receipt.status, cap_charge: run.json().cap_charge }).toEqual({ warned: true, status: DISAGREE, cap_charge: 0.07 });
    expect(await today(h)).toBe(0.07);
  });

  it("(c) own read pending: the settling state does not go back, and the result says the stored files disagree", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ read: after(h, settledAt(0.07), pending) }) });
    expect(run.code, run.err).toBe(0);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.07, cap_charge: 0.07 });
    // A pending read refuses no settlement, so the booking step does not warn (as vector
    // refresh-settled-then-fresh-pending-keeps-booking pins for a refresh). The receipt file now holds the
    // pending read beside a settled row, and that is a disagreement of the stored files.
    expect({ warned: run.err.includes(DISAGREE), status: run.json().receipt.status, cap_charge: run.json().cap_charge }).toEqual({ warned: false, status: DISAGREE, cap_charge: 0.07 });
    expect(await today(h)).toBe(0.07);
    // The text output carries the status too, on its receipt line.
    const h2 = await ready();
    const text = await cli(h2, runArgs().filter((a) => a !== "--json"), { provider: new P({ read: after(h2, settledAt(0.07), pending) }) });
    expect(text.out.split("\n").find((l) => l.includes("receipt:"))).toContain(`status=${DISAGREE}`);
  });

  it("run records what only it knows even when its read is refused: the reported cost raises the other reader's charge", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ usage: usage(0.15), read: after(h, settledAt(0.07), settledAt(0.05)) }) });
    expect(run.code, run.err).toBe(0);
    const last = ledger(h).at(-1)!;
    expect({ ...booked(last), cost_reported: last.cost_reported, reason: last.reason, http: last.http })
      .toEqual({ state: "settled", spend: 0.07, cap_charge: 0.15, cost_reported: 0.15, reason: CHARGE_RAISED, http: 200 });
    expect(run.err).toContain(DISAGREE);
    expect(await today(h)).toBe(0.15);
  });

  it("control: an own read above the other reader's is booked, and nothing disagrees", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ read: after(h, settledAt(0.05), settledAt(0.07)) }) });
    expect(run.code, run.err).toBe(0);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.07, cap_charge: 0.07 });
    expect({ err: run.err, status: run.json().receipt.status }).toEqual({ err: "", status: undefined });
  });

  it("control: with no other reader, run books its read as before and reports nothing", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ read: settledAt(0.05) }) });
    expect(run.code, run.err).toBe(0);
    expect(ledger(h).map((r) => r.state)).toEqual(["sent", "settled"]);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05 });
    expect({ err: run.err, status: run.json().receipt.status }).toEqual({ err: "", status: undefined });
  });
});

describe("fails on 9adfd17: what run writes when its paid call fails goes through the booking step too", () => {
  // The call fails while another reader refreshes the same request and books a settlement. On 9adfd17 (and
  // on dbffac0) run wrote its timeout_unknown, error or refused_local row from the row it wrote before the
  // call, so the booked settlement was replaced by the 0.186 hold, or by 0, and an unresolved state.
  const hang = (req: CompleteReq) => new Promise<CompleteRes>((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true }));
  /** A completion that first lets another reader refresh the request and book this read, then fails. */
  const failsAfter = (home: string, other: Reader, fail: (req: CompleteReq) => Promise<CompleteRes>) => async (req: CompleteReq) => {
    const r = await cli(home, refreshArgs(req.requestId), { provider: new P({ read: other }) });
    expect(r.code, r.err).toBe(0);
    return fail(req);
  };
  const failures = {
    "the call times out": { fail: hang, code: 6, says: /^imd-flop: no answer within 50 ms/, state: "timeout_unknown", charge: 0.186 },
    "the gateway answers HTTP 500": { fail: async () => { throw new FlopHTTPError(500, {}, null); }, code: 1, says: /^imd-flop: gateway refused the call \(HTTP 500\)/, state: "error", charge: 0.186 },
    "nothing was sent (a pre send failure)": { fail: async () => { throw new PreSendError("child key mint failed"); }, code: 11, says: /^imd-flop: nothing sent: child key mint failed/, state: "refused_local", charge: 0 },
  };

  for (const [name, f] of Object.entries(failures)) {
    it(`${name} after another reader booked settled 0.3: the settlement stays, nothing is appended, run keeps its exit code and message`, async () => {
      const h = await ready();
      const run = await cli(h, runArgs(["--timeout-ms", "50"]), { provider: new P({ complete: failsAfter(h, settledAt(0.3), f.fail) }) });
      expect(run.code, run.err).toBe(f.code);
      expect(run.err).toMatch(f.says);
      // 0.3 is above the 0.186 hold: writing the failure row from the sent row lowered both spend and charge.
      expect(ledger(h).map(booked)).toEqual([{ state: "sent", spend: null, cap_charge: 0.186 }, { state: "settled", spend: 0.3, cap_charge: 0.3 }]);
      expect(await today(h)).toBe(0.3);
      const shown = (await cli(h, ["receipt", ledger(h)[0].request_id!, "--json"])).json();
      expect({ ledger_state: shown.ledger_state, ledger_spend: shown.ledger_spend, status: shown.status }).toEqual({ ledger_state: "settled", ledger_spend: 0.3, status: undefined });
    });

    it(`control: ${name} after another reader booked a pending read: the report is booked against that row, except "nothing was sent"`, async () => {
      const h = await ready();
      const run = await cli(h, runArgs(["--timeout-ms", "50"]), { provider: new P({ complete: failsAfter(h, pending, f.fail) }) });
      expect(run.code, run.err).toBe(f.code);
      const rows = ledger(h).map(booked);
      expect(rows.slice(0, 2)).toEqual([{ state: "sent", spend: null, cap_charge: 0.186 }, { state: "estimated", spend: null, cap_charge: 0.186 }]);
      if (f.state === "refused_local") {
        // Moved (review of the booking step): this expected refused_local, charge 0, today 0. A trusted
        // pending read shows the gateway holds the request, so "nothing was sent" does not release it.
        expect(rows.at(-1)).toEqual({ state: "estimated", spend: null, cap_charge: 0.186 });
        expect(await today(h)).toBe(0.186);
      } else {
        expect(rows.slice(2)).toEqual([{ state: f.state, spend: null, cap_charge: f.charge }]);
        expect(await today(h)).toBe(f.charge);
      }
    });

    it(`control: ${name} with no other reader: the row is written as before`, async () => {
      const h = await ready();
      const run = await cli(h, runArgs(["--timeout-ms", "50"]), { provider: new P({ complete: f.fail }) });
      expect(run.code, run.err).toBe(f.code);
      expect(ledger(h).map(booked)).toEqual([{ state: "sent", spend: null, cap_charge: 0.186 }, { state: f.state, spend: null, cap_charge: f.charge }]);
      const last = ledger(h).at(-1)!;
      expect({ http: last.http, reason: last.reason }).toEqual(
        f.state === "error" ? { http: 500, reason: "HTTP 500" } : f.state === "refused_local" ? { http: null, reason: "nothing sent: child key mint failed" } : { http: null, reason: "TimeoutError: no answer; spend unknown, not retried" },
      );
    });
  }
});

describe("fails on a3d71d6: a trusted read beats a \"nothing was sent\" report, in both orders", () => {
  const preSend = async () => {
    throw new PreSendError("child key mint failed");
  };

  it("read first: a refresh books a trusted pending read, then the call fails before send: the reservation stays held", async () => {
    // The reviewer's reproduction. The rows were sent 0.186, estimated 0.186, refused_local 0, and today was 0.
    const h = await ready();
    const complete = async (req: CompleteReq) => {
      const r = await cli(h, refreshArgs(req.requestId), { provider: new P({ read: pending }) });
      expect(r.code, r.err).toBe(0);
      return preSend();
    };
    const run = await cli(h, runArgs(), { provider: new P({ complete }) });
    expect(run.code, run.err).toBe(11);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "estimated", spend: null, cap_charge: 0.186 });
    expect(await today(h)).toBe(0.186);
  });

  it("report first: the call fails before send, then a refresh reads a trusted pending receipt: the padded quote is held again", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ complete: preSend }) });
    expect(run.code, run.err).toBe(11);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "refused_local", spend: null, cap_charge: 0 });
    const rid = ledger(h)[0].request_id!;
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: pending }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "estimated", spend: null, cap_charge: 0.186 });
    expect(await today(h)).toBe(0.186);
  });

  it("control: report first, then a refresh reads a proven settlement: it is booked as usual", async () => {
    const h = await ready();
    expect((await cli(h, runArgs(), { provider: new P({ complete: preSend }) })).code).toBe(11);
    const rid = ledger(h)[0].request_id!;
    expect((await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) })).code).toBe(0);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05 });
    expect(await today(h)).toBe(0.05);
  });
});

describe("a refresh racing a refresh", () => {
  /** A process that takes the real ledger lock, holds it, then books settled 0.07 for the request and lets go. */
  function holderThatBooks(home: string, rid: string, holdMs: number) {
    const root = join(import.meta.dirname, "..");
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: root });
    const script = join(home, "lock-holder.mjs");
    writeFileSync(script, `
import { appendLedger, latestAttempts, withLedgerLock } from ${JSON.stringify(join(root, "dist", "ledger.js"))};
const home = ${JSON.stringify(home)};
withLedgerLock(home, () => {
  process.stdout.write("HOLDING\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
  const prev = latestAttempts(home).find((e) => e.request_id === ${JSON.stringify(rid)});
  appendLedger(home, { ...prev, ts: new Date().toISOString(), state: "settled", spend: 0.07, cap_charge: 0.07 });
});
`);
    const child = spawn(process.execPath, [script], { env: { ...process.env, IMD_FLOP_HOME: home } });
    const exited = new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
    const holding = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d) => { if (String(d).includes("HOLDING")) resolve(); });
      child.on("exit", (c) => reject(new Error("holder exited before holding the lock: " + c)));
    });
    return { exited, holding };
  }

  it("fails on dbffac0: another process books settled 0.07 while this refresh waits for the lock: its lower read is refused", async () => {
    // On dbffac0 the refresh read the previous row before it took the lock, so it appended settled 0.05
    // over the 0.07 the other process booked in between.
    const h = await ready();
    const rid = await pendingRun(h);
    const holder = holderThatBooks(h, rid, 1000);
    await holder.holding;
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
    expect(await holder.exited).toBe(0);
    expect(refreshed.code, refreshed.err).toBe(0);
    const rows = ledger(h).filter((r) => r.request_id === rid);
    expect(rows.map(booked)).toEqual([
      { state: "sent", spend: null, cap_charge: 0.186 },
      { state: "estimated", spend: null, cap_charge: 0.186 },
      { state: "settled", spend: 0.07, cap_charge: 0.07 },
    ]);
    expect({ warned: refreshed.err.includes(DISAGREE), status: refreshed.json().status, ledger_spend: refreshed.json().ledger_spend }).toEqual({ warned: true, status: DISAGREE, ledger_spend: 0.07 });
    expect(await today(h)).toBe(0.07);
  }, 30_000);

  it("pin: the second refresh runs inside the first one's read: the first one's lower read is refused", async () => {
    // This form passed on dbffac0 too: refreshReceipt read the previous row after its own network read.
    const h = await ready();
    const rid = await pendingRun(h);
    const before = ledger(h).length;
    const first = await cli(h, refreshArgs(rid), { provider: new P({ read: after(h, settledAt(0.07), settledAt(0.05)) }) });
    expect(first.code, first.err).toBe(0);
    expect({ appended: ledger(h).length - before, last: booked(ledger(h).at(-1)!), warned: first.err.includes(DISAGREE), status: first.json().status, ledger_spend: first.json().ledger_spend })
      .toEqual({ appended: 1, last: { state: "settled", spend: 0.07, cap_charge: 0.07 }, warned: true, status: DISAGREE, ledger_spend: 0.07 });
  });

  it("pin: the two orders of two refreshes book the same spend and charge", async () => {
    const outcome = async (firstRead: Reader, secondRead: Reader) => {
      const h = await ready();
      const rid = await pendingRun(h);
      for (const read of [firstRead, secondRead]) expect((await cli(h, refreshArgs(rid), { provider: new P({ read }) })).code).toBe(0);
      const last = ledger(h).at(-1)!;
      return { spend: last.spend, cap_charge: last.cap_charge, today: await today(h) };
    };
    expect(await outcome(settledAt(0.05), settledAt(0.07))).toEqual({ spend: 0.07, cap_charge: 0.07, today: 0.07 });
    expect(await outcome(settledAt(0.07), settledAt(0.05))).toEqual({ spend: 0.07, cap_charge: 0.07, today: 0.07 });
  });
});

describe("fails on dbffac0: a stored read below the booked amount is shown as a disagreement", () => {
  /** Run settles 0.07, then a refresh reads settled 0.05: the receipt file holds 0.05, the ledger keeps 0.07. */
  async function lowerReadStored() {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ read: settledAt(0.07) }) });
    expect(run.code, run.err).toBe(0);
    const rid = run.json().request_id as string;
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
    expect({ code: refreshed.code, warned: refreshed.err.includes(DISAGREE), status: refreshed.json().status, last: booked(ledger(h).at(-1)!) })
      .toEqual({ code: 0, warned: true, status: DISAGREE, last: { state: "settled", spend: 0.07, cap_charge: 0.07 } });
    expect(JSON.parse(readFileSync(join(h, "receipts", `${rid}.json`), "utf8")).settled).toBe(0.05);
    return { h, rid };
  }

  it("receipt <id>: the status is DISAGREE, in --json and on the text line, and match stays the identity verdict", async () => {
    const { h, rid } = await lowerReadStored();
    const shown = (await cli(h, ["receipt", rid, "--json"])).json();
    expect({ settled: shown.settled, ledger_spend: shown.ledger_spend, status: shown.status, match: shown.match.match }).toEqual({ settled: 0.05, ledger_spend: 0.07, status: DISAGREE, match: "matches" });
    const text = await cli(h, ["receipt", rid]);
    expect(text.out.split("\n")[0]).toContain(`match=matches  status=${DISAGREE}`);
    expect(text.err).toBe(""); // nothing was refused just now: the status is read from the files
  });

  it("status: the receipt carries the same status, in --json and on its text line", async () => {
    const { h, rid } = await lowerReadStored();
    const st = (await cli(h, ["status", "--seat", SEAT, "--json"])).json();
    const shown = st.recent_receipts.find((r: { request_id: string }) => r.request_id === rid);
    expect({ settled: shown.settled, status: shown.status, match: shown.match.match }).toEqual({ settled: 0.05, status: DISAGREE, match: "matches" });
    const text = await cli(h, ["status", "--seat", SEAT]);
    expect(text.out.split("\n").find((l) => l.includes(rid))).toContain(`status=${DISAGREE}`);
  });

  it("the status is never stored: the receipt file has no status field, and a refresh that reads the booked amount again clears it", async () => {
    const { h, rid } = await lowerReadStored();
    expect("status" in JSON.parse(readFileSync(join(h, "receipts", `${rid}.json`), "utf8"))).toBe(false);
    const again = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.07) }) });
    expect({ code: again.code, err: again.err, status: again.json().status }).toEqual({ code: 0, err: "", status: undefined });
    expect((await cli(h, ["receipt", rid])).out).not.toContain(DISAGREE);
    expect((await cli(h, ["status", "--seat", SEAT])).out).not.toContain(DISAGREE);
  });

  it("control: files that agree show no status, for a settled run and for a pending run", async () => {
    for (const read of [settledAt(0.05), pending]) {
      const h = await ready();
      const run = await cli(h, runArgs(), { provider: new P({ read }) });
      const rid = run.json().request_id as string;
      expect({ run: run.json().receipt.status, receipt: (await cli(h, ["receipt", rid, "--json"])).json().status, text: (await cli(h, ["receipt", rid])).out.includes("status=") }).toEqual({ run: undefined, receipt: undefined, text: false });
      expect((await cli(h, ["status", "--seat", SEAT])).out).not.toContain(DISAGREE);
    }
  });

  it("a pending receipt beside a settled row is the same disagreement, without any refusal on stderr", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ read: settledAt(0.05) }) });
    const rid = run.json().request_id as string;
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: pending }) });
    expect({ code: refreshed.code, err: refreshed.err, status: refreshed.json().status, ledger_state: refreshed.json().ledger_state, last: booked(ledger(h).at(-1)!) })
      .toEqual({ code: 0, err: "", status: DISAGREE, ledger_state: "settled", last: { state: "settled", spend: 0.05, cap_charge: 0.05 } });
  });

  it("a timed out call disagrees with a receipt stored for it until a read is booked", async () => {
    const h = await ready();
    const hang = (req: CompleteReq) => new Promise<CompleteRes>((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true }));
    const timedOut = await cli(h, runArgs(["--timeout-ms", "50"]), { provider: new P({ complete: hang }) });
    expect(timedOut.code).toBe(6);
    const row = readLines(ledgerPath(h)).at(-1);
    expect(row.state).toBe("timeout_unknown");
    // The receipt file a refresh leaves when its booking could not be written: a pending read, stored.
    const file = { request_id: row.request_id, correlation_id: "imd-job-j1", job: row.job, provider: "mock", state: "estimated", reserved: 0.186, settled: null, settled_raw: null,
      stage: "gateway observed", chain_final: false, terminal_event: null, flag: null, http: 200, error: null, observed_at: new Date().toISOString(), mock: true, seat: row.seat, did: row.did };
    mkdirSync(join(h, "receipts"), { recursive: true });
    writeFileSync(join(h, "receipts", `${row.request_id}.json`), JSON.stringify(file));
    const shown = (await cli(h, ["receipt", row.request_id, "--json"])).json();
    expect({ status: shown.status, match: shown.match.match, ledger_state: shown.ledger_state }).toEqual({ status: DISAGREE, match: "matches", ledger_state: "timeout_unknown" });
    // Once a read is booked the row is no longer unresolved, and the files agree.
    const bookedNow = await cli(h, refreshArgs(row.request_id), { provider: new P({ read: pending }) });
    expect({ err: bookedNow.err, status: bookedNow.json().status, ledger_state: bookedNow.json().ledger_state }).toEqual({ err: "", status: undefined, ledger_state: "estimated" });
  });
});

describe("pin: a receipt shaped like the gateway's documented schema is stored whole and settles", () => {
  // Per the gateway's OpenAPI (CredentialReceipt), read 2026-11-11: settled_spend_raw is the exact amount as
  // a decimal digit string of base units (10^18 per FLOP), and terminal_event is a channel event id. Neither
  // is key shaped to the secret scan, so the stored copy needs no redaction. Not seen on a live receipt yet.
  it("settled_spend_raw as decimal digits and terminal_event as 0x and 64 hex: no redaction, the settlement is booked", async () => {
    const h = await ready();
    const event = "0x" + "ab".repeat(32);
    const run = await cli(h, runArgs(), { provider: new P({ read: (id) => receiptFor(id, { settled_spend: 0.05, settled_spend_raw: "50000000000000000", terminal_event: event, state: "settled" }) }) });
    expect(run.code, run.err).toBe(0);
    const file = JSON.parse(readFileSync(join(h, "receipts", `${run.json().request_id}.json`), "utf8"));
    expect({ settled: file.settled, settled_raw: file.settled_raw, terminal_event: file.terminal_event, chain_final: file.chain_final })
      .toEqual({ settled: 0.05, settled_raw: "50000000000000000", terminal_event: event, chain_final: false });
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05 });
    expect(run.json().receipt.status).toBeUndefined();
  });

  it("a released receipt with no amount moves the state and keeps the hold: null is never read as 0", async () => {
    const h = await ready();
    const run = await cli(h, runArgs(), { provider: new P({ read: (id) => receiptFor(id, { settled_spend: null, settled_spend_raw: null, state: "released" }) }) });
    expect(run.code, run.err).toBe(0);
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "released", spend: null, cap_charge: 0.186 });
    expect(await today(h)).toBe(0.186);
  });
});

describe("pin: after the paid call, when the booking step cannot run", () => {
  it("the ledger lock cannot be taken: exit 1, the sent row keeps the reservation, the answer is in the response file", async () => {
    const h = await ready();
    const lock = `${ledgerPath(h)}.lock`;
    // Another live process takes the lock while run waits for its receipt, and keeps it.
    const read: Reader = (id) => {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: "other" }));
      return settledAt(0.05)(id);
    };
    const p = new P({ read });
    const run = await cli(h, runArgs(), { provider: p });
    rmSync(lock);
    expect({ code: run.code, out: run.out, err: run.err, calls: p.calls }).toEqual({ code: 1, out: "", err: "imd-flop: ledger lock timeout", calls: 1 });
    const rows = ledger(h);
    expect(rows.map(booked)).toEqual([{ state: "sent", spend: null, cap_charge: 0.186 }]);
    const rid = rows[0].request_id!;
    expect(JSON.parse(readFileSync(join(h, "responses", `${rid}.json`), "utf8")).text).toBe("ok");
    expect(JSON.parse(readFileSync(join(h, "receipts", `${rid}.json`), "utf8")).settled).toBe(0.05);
    expect(await today(h)).toBe(0.186);
    // The read was stored and not booked. A later refresh books it.
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
    expect({ code: refreshed.code, last: booked(ledger(h).at(-1)!) }).toEqual({ code: 0, last: { state: "settled", spend: 0.05, cap_charge: 0.05 } });
  }, 30_000);

  it("the ledger append fails: exit 1, the sent row keeps the reservation, the answer is in the response file", async () => {
    const h = await ready();
    const read: Reader = (id) => {
      chmodSync(ledgerPath(h), 0o400);
      return settledAt(0.05)(id);
    };
    const run = await cli(h, runArgs(), { provider: new P({ read }) });
    chmodSync(ledgerPath(h), 0o644);
    expect({ code: run.code, out: run.out }).toEqual({ code: 1, out: "" });
    expect(run.err).toMatch(/^imd-flop: EACCES/);
    const rows = ledger(h);
    expect(rows.map(booked)).toEqual([{ state: "sent", spend: null, cap_charge: 0.186 }]);
    expect(JSON.parse(readFileSync(join(h, "responses", `${rows[0].request_id}.json`), "utf8")).text).toBe("ok");
    expect(await today(h)).toBe(0.186);
  });
});

describe("fails on a3d71d6: a reported cost survives a booking step that could not run", () => {
  // Review of the booking step, the must fix. When run's booking after the paid call could not run, the cost
  // its completion reported was on no row, and a later refresh took the cost from the row only. So it booked
  // the settlement below the reported cost. The booking step now takes the cost from the stored response
  // file when neither the caller nor the row has one.
  it("the ledger lock cannot be taken after the call: a later refresh charges the reported cost and records it", async () => {
    const h = await ready();
    const lock = `${ledgerPath(h)}.lock`;
    const read: Reader = (id) => {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: "other" }));
      return settledAt(0.05)(id);
    };
    const run = await cli(h, runArgs(), { provider: new P({ usage: usage(0.15), read }) });
    rmSync(lock);
    expect({ code: run.code, err: run.err }).toEqual({ code: 1, err: "imd-flop: ledger lock timeout" });
    expect(ledger(h).map(booked)).toEqual([{ state: "sent", spend: null, cap_charge: 0.186 }]);
    const rid = ledger(h)[0].request_id!;
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    const last = ledger(h).at(-1)!;
    expect({ ...booked(last), cost_reported: last.cost_reported, reason: last.reason }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.15, cost_reported: 0.15, reason: CHARGE_RAISED });
    expect(await today(h)).toBe(0.15);
  }, 30_000);

  it("the ledger append fails after the call: a later refresh charges the reported cost and records it", async () => {
    const h = await ready();
    const read: Reader = (id) => {
      chmodSync(ledgerPath(h), 0o400);
      return settledAt(0.05)(id);
    };
    const run = await cli(h, runArgs(), { provider: new P({ usage: usage(0.15), read }) });
    chmodSync(ledgerPath(h), 0o644);
    expect(run.code).toBe(1);
    const rid = ledger(h)[0].request_id!;
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    const last = ledger(h).at(-1)!;
    expect({ ...booked(last), cost_reported: last.cost_reported }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.15, cost_reported: 0.15 });
    expect(await today(h)).toBe(0.15);
  });
});

describe("fails on 9adfd17: a refresh that cannot take the ledger lock says the ledger was busy, not that receipt and ledger disagree", () => {
  // Booking step, review of the audit 8ddc5d2 fixes, decision 2. This was the pin "receipt --refresh, the
  // lock cannot be taken: the read is stored, nothing is booked, DISAGREE is printed, exit 0". Kept: the read
  // is stored, nothing is booked, exit 0. Changed: the stderr line. A busy ledger is not a disagreement, and
  // since the booking step takes the lock before it decides, the old line was also printed for a read that
  // had nothing to book. DISAGREE on stderr stays for a read that was refused, and for an append that failed
  // (test/audit-v3.test.ts).
  const BUSY = `${LEDGER_BUSY} (ledger lock timeout)`;

  it("a read with nothing to book: the busy line, no status, exit 0; then a read that settles: the busy line, and the files do disagree", async () => {
    const h = await ready();
    const rid = await pendingRun(h);
    const before = readFileSync(ledgerPath(h), "utf8");
    const lock = `${ledgerPath(h)}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: "other" }));
    const same = await cli(h, refreshArgs(rid), { provider: new P({ read: pending }) });
    expect({ code: same.code, err: same.err, status: same.json().status, ledger_state: same.json().ledger_state }).toEqual({ code: 0, err: BUSY, status: undefined, ledger_state: "estimated" });
    const settles = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
    rmSync(lock);
    // The status is read from the files: the stored read settles and the ledger row is still pending.
    expect({ code: settles.code, err: settles.err, status: settles.json().status, settled: settles.json().settled, ledger_state: settles.json().ledger_state })
      .toEqual({ code: 0, err: BUSY, status: DISAGREE, settled: 0.05, ledger_state: "estimated" });
    expect(readFileSync(ledgerPath(h), "utf8")).toBe(before);
    expect(BUSY).not.toContain("disagree");
    // With the lock free the same refresh books the read and says nothing.
    const again = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
    expect({ code: again.code, err: again.err, status: again.json().status, last: booked(ledger(h).at(-1)!) }).toEqual({ code: 0, err: "", status: undefined, last: { state: "settled", spend: 0.05, cap_charge: 0.05 } });
  }, 30_000);
});

describe("after the paid call, when the ledger no longer holds the request's row", () => {
  it("run writes the row again and books against it, so the paid call stays on the books", async () => {
    // On dbffac0 run appended one full row, built from the row it held in memory. The booking is the same.
    const h = await ready();
    const read: Reader = (id) => {
      rmSync(ledgerPath(h));
      return settledAt(0.05)(id);
    };
    const run = await cli(h, runArgs(), { provider: new P({ read }) });
    expect(run.code, run.err).toBe(0);
    expect(ledger(h).map(booked)).toEqual([{ state: "sent", spend: null, cap_charge: 0.186 }, { state: "settled", spend: 0.05, cap_charge: 0.05 }]);
    expect({ cap_charge: run.json().cap_charge, text: run.json().text }).toEqual({ cap_charge: 0.05, text: "ok" });
    expect(await today(h)).toBe(0.05);
  });
});

describe("after a failed call, when the ledger no longer holds the request's row", () => {
  it("run writes the row again and books the timeout against it, so the reservation is held", async () => {
    // On 9adfd17 run appended one full timeout row, built from the row it held in memory. The booking is the same.
    const h = await ready();
    const complete = (req: CompleteReq) => {
      rmSync(ledgerPath(h));
      return new Promise<CompleteRes>((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true }));
    };
    const run = await cli(h, runArgs(["--timeout-ms", "50"]), { provider: new P({ complete }) });
    expect(run.code, run.err).toBe(6);
    expect(ledger(h).map(booked)).toEqual([{ state: "sent", spend: null, cap_charge: 0.186 }, { state: "timeout_unknown", spend: null, cap_charge: 0.186 }]);
    expect(await today(h)).toBe(0.186);
  });
});

describe("bookRead: the one booking step", () => {
  const trusted = (state: string | null, settled: unknown) => ({ fresh: true, identityOk: true, redacted: false, state, settled });
  /** A ledger with one held row for request r1, as a run leaves it while its receipt is pending. */
  function held(fields: Record<string, unknown> = {}) {
    const h = tmpHome();
    const row = { ts: "2026-11-11T00:00:00.000Z", day: utcDay(), request_id: "r1", seat: SEAT, did: "did:key:zseed", job: "j1", provider: "mock", network: "devnet", payer: "holder", model: "m", max_tokens: 8,
      prompt_sha256: "ab".repeat(32), quote_raw: 0.066, quote_padded: 0.186, per_call_cap: 1, daily_cap: 1, job_budget: null, spent_before: 0, job_spent_before: null, state: "estimated", reason: null,
      spend: null, cost_reported: null, cap_charge: 0.186, http: 200, mock: true, ...fields };
    appendFileSync(ledgerPath(h), JSON.stringify(row) + "\n");
    return h;
  }
  const rowOf = (r: ReturnType<typeof bookRead>) => (r.outcome === "no_row" ? null : r.row);

  it("appends one row when the booking changes, and returns it as the latest row", () => {
    const h = held();
    const r = bookRead(h, "r1", trusted("settled", 0.05), { flag: null });
    expect(r.outcome).toBe("appended");
    expect(ledger(h).map(booked)).toEqual([{ state: "estimated", spend: null, cap_charge: 0.186 }, { state: "settled", spend: 0.05, cap_charge: 0.05 }]);
    expect(rowOf(r)).toEqual(readLines(ledgerPath(h)).at(-1));
    expect(rowOf(r)!.ts).not.toBe("2026-11-11T00:00:00.000Z");
  });

  it("appends nothing when no recorded field changes, and returns the row that stays", () => {
    const h = held();
    for (const read of [trusted("estimated", null), { ...trusted("settled", 0.05), fresh: false }, { ...trusted("settled", 0.05), redacted: true }, { ...trusted("settled", 0.05), identityOk: false }]) {
      const r = bookRead(h, "r1", read, { flag: null });
      expect(r.outcome).toBe("unchanged");
      expect(rowOf(r)).toEqual(readLines(ledgerPath(h))[0]);
    }
    expect(ledger(h)).toHaveLength(1);
  });

  it("a read below the booked settlement: disagree, nothing appended, the booked row returned", () => {
    const h = held({ state: "settled", spend: 0.07, cap_charge: 0.07 });
    for (const read of [trusted("settled", 0.05), trusted("released", 0)]) {
      const r = bookRead(h, "r1", read, { flag: null });
      expect(r.outcome).toBe("disagree");
      expect(booked(rowOf(r) as Row)).toEqual({ state: "settled", spend: 0.07, cap_charge: 0.07 });
    }
    expect(ledger(h)).toHaveLength(1);
  });

  it("a charge that is not a known amount and no proven settlement: disagree, the row stays as it is, never 0", () => {
    const h = held({ cap_charge: null });
    expect(bookRead(h, "r1", trusted("estimated", null), { flag: null }).outcome).toBe("disagree");
    expect(ledger(h).map(booked)).toEqual([{ state: "estimated", spend: null, cap_charge: null }]);
    // A proven settlement is a known charge, so it is booked.
    expect(bookRead(h, "r1", trusted("settled", 0.05), { flag: null }).outcome).toBe("appended");
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05 });
  });

  it("no ledger row for the request: nothing appended", () => {
    const h = held();
    expect(bookRead(h, "other", trusted("settled", 0.05), { flag: null })).toEqual({ outcome: "no_row" });
    expect(bookRead(tmpHome(), "r1", trusted("settled", 0.05), { flag: null })).toEqual({ outcome: "no_row" });
    expect(ledger(h)).toHaveLength(1);
  });

  it("what only run knows is recorded on the row: its reported cost and the HTTP status of its read", () => {
    const h = held({ state: "sent", http: null });
    const r = bookRead(h, "r1", { ...trusted("settled", 0.05), fresh: false }, { flag: null, cost_reported: 0.3, http: 503 });
    expect(r.outcome).toBe("appended");
    const last = ledger(h).at(-1)!;
    expect({ ...booked(last), cost_reported: last.cost_reported, http: last.http }).toEqual({ state: "sent", spend: null, cap_charge: 0.3, cost_reported: 0.3, http: 503 });
  });

  it("a refused read still records what only run knows, and the outcome stays disagree", () => {
    const h = held({ state: "settled", spend: 0.07, cap_charge: 0.07, http: null });
    const r = bookRead(h, "r1", trusted("settled", 0.05), { flag: null, cost_reported: 0.15, http: 200 });
    expect(r.outcome).toBe("disagree");
    expect(ledger(h)).toHaveLength(2);
    const last = ledger(h).at(-1)!;
    expect({ ...booked(last), cost_reported: last.cost_reported, http: last.http, reason: last.reason }).toEqual({ state: "settled", spend: 0.07, cap_charge: 0.15, cost_reported: 0.15, http: 200, reason: CHARGE_RAISED });
    expect(rowOf(r)).toEqual(readLines(ledgerPath(h)).at(-1));
  });

  it("a refresh uses the cost the row records, and ignores one that is not a finite number", () => {
    const withCost = held({ cost_reported: 0.15 });
    bookRead(withCost, "r1", trusted("settled", 0.05), { flag: null });
    expect({ ...booked(ledger(withCost).at(-1)!), reason: ledger(withCost).at(-1)!.reason }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.15, reason: CHARGE_RAISED });
    const notANumber = held({ cost_reported: "0.15" });
    bookRead(notANumber, "r1", trusted("settled", 0.05), { flag: null });
    expect(booked(ledger(notANumber).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05 });
  });

  describe("fails on a3d71d6: the reported cost is resolved in the booking step: the caller's, else the row's, else the stored response file's", () => {
    const writeResponse = (h: string, body: string) => {
      mkdirSync(join(h, "responses"), { recursive: true });
      writeFileSync(join(h, "responses", "r1.json"), body);
    };
    const response = (usageField: unknown) => JSON.stringify({ request_id: "r1", usage: usageField, text: "ok" });

    it("the response file's cost raises the charge, and the appended row records it", () => {
      const h = held();
      writeResponse(h, response({ cost_flop: 0.15 }));
      expect(bookRead(h, "r1", trusted("settled", 0.05), { flag: null }).outcome).toBe("appended");
      const last = ledger(h).at(-1)!;
      expect({ ...booked(last), cost_reported: last.cost_reported, reason: last.reason }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.15, cost_reported: 0.15, reason: CHARGE_RAISED });
    });

    it("the caller's cost comes first, then the row's: the response file is not asked", () => {
      const caller = held();
      writeResponse(caller, response({ cost_flop: 0.3 }));
      bookRead(caller, "r1", trusted("settled", 0.05), { flag: null, cost_reported: 0.15 });
      expect({ cap_charge: ledger(caller).at(-1)!.cap_charge, cost_reported: ledger(caller).at(-1)!.cost_reported }).toEqual({ cap_charge: 0.15, cost_reported: 0.15 });
      const row = held({ cost_reported: 0.15 });
      writeResponse(row, response({ cost_flop: 0.3 }));
      bookRead(row, "r1", trusted("settled", 0.05), { flag: null });
      expect({ cap_charge: ledger(row).at(-1)!.cap_charge, cost_reported: ledger(row).at(-1)!.cost_reported }).toEqual({ cap_charge: 0.15, cost_reported: 0.15 });
    });

    it("a response file that is missing, unreadable or has no usable cost gives no cost, never 0", () => {
      for (const body of [null, "{not json", response(null), response({ cost_flop: "0.15" }), response({ cost_flop: Number.NaN }), JSON.stringify(7)]) {
        const h = held({ cap_charge: 0.186 });
        if (body !== null) writeResponse(h, body);
        bookRead(h, "r1", trusted("estimated", null), { flag: null });
        expect(ledger(h), String(body)).toHaveLength(1);
        bookRead(h, "r1", trusted("settled", 0.05), { flag: null });
        const last = ledger(h).at(-1)!;
        expect({ ...booked(last), cost_reported: last.cost_reported }, String(body)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.05, cost_reported: null });
      }
    });
  });

  it("the receipt flag is the reason of an appended row, and a flag alone appends nothing", () => {
    const h = held();
    expect(bookRead(h, "r1", { ...trusted(null, null), fresh: false }, { flag: "key_expired" }).outcome).toBe("unchanged");
    expect(ledger(h)).toHaveLength(1);
    bookRead(h, "r1", trusted("reserved", null), { flag: "key_expired" });
    expect({ state: ledger(h).at(-1)!.state, reason: ledger(h).at(-1)!.reason }).toEqual({ state: "reserved", reason: "key_expired" });
  });
});

describe("bookFailure: a failed call goes through the same booking step", () => {
  /** A ledger with one row for request r1. */
  function ledgerWith(fields: Record<string, unknown> = {}) {
    const h = tmpHome();
    const row = { ts: "2026-11-11T00:00:00.000Z", day: utcDay(), request_id: "r1", seat: SEAT, did: "did:key:zseed", job: "j1", provider: "mock", network: "devnet", payer: "holder", model: "m", max_tokens: 8,
      prompt_sha256: "ab".repeat(32), quote_raw: 0.066, quote_padded: 0.186, per_call_cap: 1, daily_cap: 1, job_budget: null, spent_before: 0, job_spent_before: null, state: "sent", reason: null,
      spend: null, cost_reported: null, cap_charge: 0.186, http: null, mock: true, ...fields };
    appendFileSync(ledgerPath(h), JSON.stringify(row) + "\n");
    return h;
  }
  const timeout = { reason: "TimeoutError: no answer; spend unknown, not retried", http: null };

  it("a timeout or a gateway error on a row that does not settle: one row, the state moved, the hold kept, the reason and status recorded", () => {
    const h = ledgerWith();
    const r = bookFailure(h, "r1", "timeout_unknown", timeout);
    expect(r.outcome).toBe("appended");
    const last = ledger(h).at(-1)!;
    expect({ ...booked(last), reason: last.reason, http: last.http }).toEqual({ state: "timeout_unknown", spend: null, cap_charge: 0.186, ...timeout });
    expect(r.outcome !== "no_row" && r.row).toEqual(readLines(ledgerPath(h)).at(-1));
    const g = ledgerWith({ state: "estimated", http: 200, cap_charge: 0.3, cost_reported: 0.3 });
    bookFailure(g, "r1", "error", { reason: "HTTP 500", http: 500 });
    const row = ledger(g).at(-1)!;
    expect({ ...booked(row), reason: row.reason, http: row.http, cost_reported: row.cost_reported }).toEqual({ state: "error", spend: null, cap_charge: 0.3, reason: "HTTP 500", http: 500, cost_reported: 0.3 });
  });

  it("\"nothing was sent\" on a row that does not settle: refused_local, charge 0", () => {
    const h = ledgerWith();
    expect(bookFailure(h, "r1", "refused_local", { reason: "nothing sent: mint failed", http: null }).outcome).toBe("appended");
    const last = ledger(h).at(-1)!;
    expect({ ...booked(last), reason: last.reason }).toEqual({ state: "refused_local", spend: null, cap_charge: 0, reason: "nothing sent: mint failed" });
  });

  it("a settling row stays, whatever is reported: nothing is appended, not even the report's reason or HTTP status", () => {
    const h = ledgerWith({ state: "settled", spend: 0.3, cap_charge: 0.3 });
    const before = readFileSync(ledgerPath(h), "utf8");
    for (const [report, info] of [["timeout_unknown", timeout], ["error", { reason: "HTTP 500", http: 500 }], ["refused_local", { reason: "nothing sent: mint failed", http: null }]] as const) {
      const r = bookFailure(h, "r1", report, info);
      expect(r.outcome, report).toBe("unchanged");
      expect(r.outcome !== "no_row" && booked(r.row as Row), report).toEqual({ state: "settled", spend: 0.3, cap_charge: 0.3 });
    }
    expect(readFileSync(ledgerPath(h), "utf8")).toBe(before);
  });

  it("a charge that is not a known amount: the row stays as it is, also for \"nothing was sent\"", () => {
    const h = ledgerWith({ cap_charge: null });
    const before = readFileSync(ledgerPath(h), "utf8");
    for (const report of ["timeout_unknown", "error", "refused_local"] as const) expect(bookFailure(h, "r1", report, timeout).outcome, report).toBe("unchanged");
    expect(readFileSync(ledgerPath(h), "utf8")).toBe(before);
  });

  it("no ledger row for the request: nothing appended", () => {
    const h = ledgerWith();
    expect(bookFailure(h, "other", "timeout_unknown", timeout)).toEqual({ outcome: "no_row" });
    expect(ledger(h)).toHaveLength(1);
  });

  it("a later trusted read books over a booked failure report as over any hold", () => {
    const h = ledgerWith();
    bookFailure(h, "r1", "timeout_unknown", timeout);
    expect(bookRead(h, "r1", { fresh: true, identityOk: true, redacted: false, state: "settled", settled: 0.05 }, { flag: null }).outcome).toBe("appended");
    expect(ledger(h).map(booked)).toEqual([{ state: "sent", spend: null, cap_charge: 0.186 }, { state: "timeout_unknown", spend: null, cap_charge: 0.186 }, { state: "settled", spend: 0.05, cap_charge: 0.05 }]);
  });
});
