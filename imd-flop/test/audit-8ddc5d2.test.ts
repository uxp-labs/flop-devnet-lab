/**
 * The swarm audit of commit 8ddc5d2 (IMD job 769d5aeb). Findings 1 to 4 and 8 to 11 are imd-flop's.
 * Each test asserts the safe outcome, so it fails on 8ddc5d2 and passes with its fix:
 *   1  receipt --refresh never settles from a receipt body that had to be redacted
 *   2  a later read never lowers a booked settlement, and a settlement is never charged below the
 *      cost the completion itself reported
 * Findings 5, 6 and 7 are the viewer's. Finding 12 is a documented residual. Finding 13 is a product
 * decision. Stub providers only; no network (test/setup.ts disables fetch).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
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
