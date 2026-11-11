/**
 * Independent review of the ten review fixes on claude/review-fixes (e52d7f4 .. f762a4d, merged at 7f57b4b).
 * Each finding block asserted the safe or stated outcome and failed at 7f57b4b; it carried a marker for an
 * expected failure so the suite stayed green, and the fix that made it pass removed the marker. No block
 * carries one now: the hold floor fixed R2, R3, R5 and R9, and review fixes 2 fixed R1, R6, R8 and R10,
 * pinned R7 as residual R-g, and added the blocks A to E. R4's two blocks hold a rule the existing tests did
 * not pin (it says which mutant they kill), and the stress block is the multi process run.
 * Stub providers only; test/setup.ts disables fetch. A second process is stood in for by a stub whose
 * readReceipt or complete runs `receipt <id> --refresh` first, as booking.test.ts does, or by real child
 * processes in the stress block.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PreSendError } from "../src/gateway.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { checkBudget } from "../src/policy.js";
import { ceil6 } from "../src/rounding.js";
import { CHARGE_RAISED, decideBooking, DISAGREE, PAST_ADMITTED, reconcile } from "../src/settlement.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9001";
const QUOTE = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }; // pads to 0.186
type Read = { http: number; error: string | null; receipt: Record<string, unknown> | null };
type Reader = (id: string) => Read | Promise<Read>;
interface Opts {
  complete?: (req: CompleteReq) => Promise<CompleteRes>;
  read?: Reader;
}
const receiptFor = (id: string, fields: Record<string, unknown> = {}): Read => ({
  http: 200,
  error: null,
  receipt: { request_id: id, correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: null, state: "estimated", ...fields },
});
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
    return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }
  async readReceipt(id: string) {
    return (await (this.o.read ?? receiptFor)(id)) as never;
  }
}
const runArgs = (job = "j1") => ["run", "--seat", SEAT, "--job", job, "--prompt", "Say hi", "--provider", "mock", "--max-tokens", "8", "--json"];
const refreshArgs = (rid: string) => ["receipt", rid, "--refresh", "--json", "--seat", SEAT];
type Row = Record<string, unknown> & { request_id: string | null; state: string; spend: number | null; cap_charge: number | null };
const ledgerPath = (home: string) => join(home, "ledger.jsonl");
const ledger = (home: string) => (existsSync(ledgerPath(home)) ? (readLines(ledgerPath(home)) as Row[]) : []);
const booked = (r: Row) => ({ state: r.state, spend: r.spend, cap_charge: r.cap_charge });
const today = async (home: string) => (await cli(home, ["status", "--seat", SEAT, "--json"])).json().today_utc.mock as number;
async function ready(cap = "1") {
  const h = tmpHome();
  await readySeat(h, SEAT, cap);
  return h;
}
/** A run whose own read is pending: the row holds the padded quote, 0.186. */
async function pendingRun(home: string, job = "j1"): Promise<string> {
  const run = await cli(home, runArgs(job), { provider: new P() });
  expect(run.code, run.err).toBe(0);
  return run.json().request_id as string;
}
/** Another call on the seat: admitted (0) or refused at the cap (3); either is fine for the cap tests. */
async function anotherRun(home: string, job: string): Promise<number> {
  const r = await cli(home, runArgs(job), { provider: new P() });
  expect([0, 3], r.err).toContain(r.code);
  return r.code;
}
const preSend = async (): Promise<CompleteRes> => {
  throw new PreSendError("child key mint failed");
};

describe("R1 (medium): run's own failed receipt read drops the gateway fields another process stored", () => {
  // 379261d made a failed read keep every gateway field the stored receipt holds, but only in
  // receipt --refresh (receipt-store.ts refreshedBody). run.ts writes its own read with writeReceipt and
  // no merge, so a failed own read overwrites the file a concurrent refresh wrote: channel_id,
  // settled_raw, state and settled become null. The ledger keeps the settlement; the receipt file loses
  // the channel id that ties it to the chain, and the viewer shows "last seen unknown".
  it("a refresh stores settled 0.05 on channel chan-1 while run waits; run's own read then fails: the file keeps chan-1", async () => {
    const h = await ready();
    const settledOnChannel = (id: string) => receiptFor(id, { state: "settled", settled_spend: 0.05, settled_spend_raw: "50000000000000000", channel_id: "chan-1", terminal_event: "evt-1" });
    const read: Reader = async (id) => {
      const r = await cli(h, refreshArgs(id), { provider: new P({ read: settledOnChannel }) });
      expect(r.code, r.err).toBe(0);
      return failed(id);
    };
    const run = await cli(h, runArgs(), { provider: new P({ read }) });
    expect(run.code, run.err).toBe(0);
    // Moved (hold floor): the charge keeps the padded quote, 0.186, after a settlement below it.
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.186 });
    const stored = JSON.parse(readFileSync(join(h, "receipts", `${run.json().request_id}.json`), "utf8"));
    expect({ channel_id: stored.channel_id, settled_raw: stored.settled_raw, terminal_event: stored.terminal_event, state: stored.state, settled: stored.settled })
      .toEqual({ channel_id: "chan-1", settled_raw: "50000000000000000", terminal_event: "evt-1", state: "settled", settled: 0.05 });
  });
});

describe("C (review fixes 2): last_known_at after failed reads in a row", () => {
  // A failed read stores last_known_at: when the gateway fields the file keeps were last read. After two
  // failed reads in a row it must still point at the last good read, not at the first failed one.
  const stored = (h: string, rid: string) => JSON.parse(readFileSync(join(h, "receipts", `${rid}.json`), "utf8"));
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("a good read, then two failed refreshes: last_known_at is the good read's observed_at", async () => {
    const h = await ready();
    const rid = await pendingRun(h);
    const good = stored(h, rid).observed_at as string;
    for (let i = 0; i < 2; i++) {
      await tick();
      expect((await cli(h, refreshArgs(rid), { provider: new P({ read: failed }) })).code).toBe(0);
    }
    const file = stored(h, rid);
    expect({ last_known_at: file.last_known_at, state: file.state }).toEqual({ last_known_at: good, state: "estimated" });
  });

  it("a failed read, then a good one: the file no longer carries last_known_at", async () => {
    const h = await ready();
    const rid = await pendingRun(h);
    await tick();
    await cli(h, refreshArgs(rid), { provider: new P({ read: failed }) });
    await tick();
    expect((await cli(h, refreshArgs(rid), { provider: new P({ read: pending }) })).code).toBe(0);
    expect("last_known_at" in stored(h, rid)).toBe(false);
  });
});

describe("D (review fixes 2): the \"raised to reported cost\" note only when the charge was raised", () => {
  // bookingReason wrote "cap charge raised to reported cost" when the charge equalled the recorded cost and
  // was above the spend. With the hold floor a cost equal to the padded quote leaves the charge at the hold,
  // and the note said it was raised. Decided: the note appears only when the reported cost is above the
  // padded quote, so the charge really was raised.
  const settled005 = (id: string) => receiptFor(id, { state: "settled", settled_spend: 0.05 });
  const withCost = (cost: number) => async (req: CompleteReq): Promise<CompleteRes> => ({ request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: cost } });

  it("cost 0.186, the padded quote, and a settlement of 0.05: the charge stays at the hold and the reason says nothing", async () => {
    const h = await ready();
    expect((await cli(h, runArgs(), { provider: new P({ complete: withCost(0.186), read: settled005 }) })).code).toBe(0);
    const last = ledger(h).at(-1)!;
    expect({ ...booked(last), reason: last.reason }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.186, reason: null });
  });

  it("cost 0.3, above the padded quote: the charge is raised, and the reason says so beside PAST_ADMITTED", async () => {
    const h = await ready();
    expect((await cli(h, runArgs(), { provider: new P({ complete: withCost(0.3), read: settled005 }) })).code).toBe(0);
    const last = ledger(h).at(-1)!;
    expect({ ...booked(last), reason: last.reason }).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.3, reason: `${PAST_ADMITTED}; ${CHARGE_RAISED}` });
  });
});

describe("A (review fixes 2): a settled_spend_raw of 64 or more digits is redacted, and the hold stays", () => {
  // settled_spend_raw is decimal digits with no length limit in the gateway's schema, so 64 or more of them
  // match the secret scan's 64 hex rule. The receipt is then stored redacted, a redacted read never proves a
  // settlement, and the call stays charged at its hold: the safe direction.
  const settledRaw = (raw: string) => (id: string) => receiptFor(id, { state: "settled", settled_spend: 0.05, settled_spend_raw: raw });
  const file = (h: string, rid: string) => JSON.parse(readFileSync(join(h, "receipts", `${rid}.json`), "utf8"));

  it("64 digits (0.05 with 47 leading zeros): settled_raw is redacted, nothing is booked, the hold stays and the receipt shows it disagrees", async () => {
    const h = await ready();
    const rid = await pendingRun(h);
    const r = await cli(h, refreshArgs(rid), { provider: new P({ read: settledRaw("0".repeat(47) + "50000000000000000") }) });
    expect(r.code, r.err).toBe(0);
    expect({ settled_raw: file(h, rid).settled_raw, state: file(h, rid).state }).toEqual({ settled_raw: null, state: "settled" });
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "estimated", spend: null, cap_charge: 0.186 });
    expect(r.json().status).toBe(DISAGREE);
  });

  it("control: 63 digits are stored whole and the read settles", async () => {
    const h = await ready();
    const rid = await pendingRun(h);
    expect((await cli(h, refreshArgs(rid), { provider: new P({ read: settledRaw("9".repeat(63)) }) })).code).toBe(0);
    expect(file(h, rid).settled_raw).toBe("9".repeat(63));
    expect(booked(ledger(h).at(-1)!)).toEqual({ state: "settled", spend: 0.05, cap_charge: 0.186 });
  });
});

describe("R2 (medium): a trusted receipt with no state does not beat \"nothing was sent\"", () => {
  // b0835bb: a trusted read beats a "nothing was sent" report in both orders. The gateway's schema allows
  // state null (receipts.ts GatewayReceipt). A trusted 200 receipt for this request id with state null
  // shows the gateway holds the request just as a reserved one does, but stateAfter keeps the row's
  // state, so the row stays sent (read first) or refused_local (report first) and the hold is released.
  const noState = (id: string) => receiptFor(id, { state: null, reserved_spend: 0.186 });

  it("read first: a refresh books a trusted receipt with no state, then the call fails before send: the hold stays", async () => {
    const h = await ready();
    const complete = async (req: CompleteReq) => {
      const r = await cli(h, refreshArgs(req.requestId), { provider: new P({ read: noState }) });
      expect(r.code, r.err).toBe(0);
      return preSend();
    };
    expect((await cli(h, runArgs(), { provider: new P({ complete }) })).code).toBe(11);
    expect(await today(h)).toBe(0.186);
  });

  it("report first: the call fails before send, then a refresh reads a trusted receipt with no state: the hold comes back", async () => {
    const h = await ready();
    expect((await cli(h, runArgs(), { provider: new P({ complete: preSend }) })).code).toBe(11);
    const rid = ledger(h)[0].request_id!;
    expect((await cli(h, refreshArgs(rid), { provider: new P({ read: noState }) })).code).toBe(0);
    expect(await today(h)).toBe(0.186);
  });
});

describe("R3 (medium): a hold taken back after \"nothing was sent\" puts the day over the cap, silently", () => {
  // b0835bb lets a trusted read take a released reservation back to its padded quote. Between the release
  // and that read another call may be admitted against the freed room. The day then ends above the cap,
  // with no refusal and no DISAGREE: the trusted read proves the gateway held the first call all along.
  // Decided (hold floor): this stays possible, because the hold coming back is the safe direction, and it is
  // never silent. The booking prints PAST_ADMITTED on stderr and records it in the row's reason, and status
  // marks the day whose total is above its cap, in text and in --json.
  it("cap 0.3: A fails before send (released), B is admitted at 0.186, a refresh of A reads estimated: the hold is back, the line is printed, status marks the day", async () => {
    const h = await ready("0.3");
    expect((await cli(h, runArgs("jA"), { provider: new P({ complete: preSend }) })).code).toBe(11);
    const a = ledger(h)[0].request_id!;
    expect(await anotherRun(h, "jB")).toBe(0);
    const refreshed = await cli(h, refreshArgs(a), { provider: new P({ read: pending }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    expect(refreshed.err).toContain(PAST_ADMITTED);
    const rowA = ledger(h).filter((r) => r.request_id === a).at(-1)!;
    expect({ ...booked(rowA), reason: rowA.reason }).toEqual({ state: "estimated", spend: null, cap_charge: 0.186, reason: PAST_ADMITTED });
    const status = await cli(h, ["status", "--seat", SEAT, "--json"]);
    expect(status.json().today_utc.mock).toBe(0.372);
    expect(status.json().over_cap_today_utc).toEqual({ flop: false, mock: true });
    expect((await cli(h, ["status", "--seat", SEAT])).out).toContain("mock 0.372 / 0.3 OVER CAP");
  });
});

describe("R9 (high): a gateway settlement below the hold frees room that a later, higher read takes back", () => {
  // The booking step treats two different reads of one request as normal (the gateway's later
  // reconciliation can change its observation) and books the higher one, and a reported cost raises a
  // settled charge. But the first, lower settlement already replaced the hold (0.186) in the cap total, so
  // calls admitted against the freed room push the day over the cap once the higher figure is booked. No
  // refusal, no DISAGREE. Found by the stress block with a gateway stub that answered differently per read.
  const settledAt = (spend: number) => (id: string) => receiptFor(id, { state: "settled", settled_spend: spend });

  it("cap 0.3: A settles at 0.01, B is admitted at 0.186, a refresh of A reads settled 0.186: the day stays within 0.3", async () => {
    const h = await ready("0.3");
    const a = await cli(h, runArgs("jA"), { provider: new P({ read: settledAt(0.01) }) });
    expect(a.code, a.err).toBe(0);
    await anotherRun(h, "jB");
    const refreshed = await cli(h, refreshArgs(a.json().request_id), { provider: new P({ read: settledAt(0.186) }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    expect(await today(h)).toBeLessThanOrEqual(0.3);
  });

  it("cap 0.3: while A waits, a refresh books A settled 0.01 and B is admitted; A's completion reports cost 0.186: the day stays within 0.3", async () => {
    const h = await ready("0.3");
    const complete = async (req: CompleteReq): Promise<CompleteRes> => {
      expect((await cli(h, refreshArgs(req.requestId), { provider: new P({ read: settledAt(0.01) }) })).code).toBe(0);
      await anotherRun(h, "jB");
      return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: 0.186 } };
    };
    const a = await cli(h, runArgs("jA"), { provider: new P({ complete, read: settledAt(0.01) }) });
    expect(a.code, a.err).toBe(0);
    expect(await today(h)).toBeLessThanOrEqual(0.3);
  });
});

describe("R5 (medium): the exact spend stays beside a float spend it does not describe", () => {
  // f762a4d: "the exact spend moves with the float spend it describes" when a read changes the float
  // spend from one known amount to a different one. Its near neighbour is a float that moves from unknown
  // to known: a released read with settled_spend null (documented: unknown) and an exact amount fills
  // spend_raw; a later trusted settled read books float 0.05 with its own exact amount 0.05, and the row
  // keeps the released read's 0.06 beside 0.05. In the other order 0.06 rises over 0.05 the same way.
  const trusted = (state: string, settled: number | null, settledRaw: string) => ({ fresh: true, identityOk: true, redacted: false, state, settled, settledRaw });
  const hold = { state: "estimated", spend: null, cap_charge: 0.186, quote_padded: 0.186, spend_raw: null };
  const releasedNoFloat = trusted("released", null, "60000000000000000");
  const settled005 = trusted("settled", 0.05, "50000000000000000");
  const after = (prev: typeof hold, read: ReturnType<typeof trusted>) => ({ ...prev, ...decideBooking(prev, read, null).booking }) as typeof hold;

  it("released (float unknown, exact 0.06) then settled 0.05 (exact 0.05): the row's exact spend is 0.05's own", () => {
    const row = after(after(hold, releasedNoFloat), settled005);
    expect({ spend: row.spend, spend_raw: row.spend_raw }).toEqual({ spend: 0.05, spend_raw: "50000000000000000" });
  });

  it("settled 0.05 (exact 0.05) then released (float unknown, exact 0.06): the exact spend still describes 0.05", () => {
    const row = after(after(hold, settled005), releasedNoFloat);
    expect({ spend: row.spend, spend_raw: row.spend_raw }).toEqual({ spend: 0.05, spend_raw: "50000000000000000" });
  });
});

describe("R6 (medium): a ledger row with an unusable day drops its charge from the daily total", () => {
  // An unusable cap_charge refuses the next call (ledger.ts sumCharges), but spentToday filters rows by
  // e.day === day before it sums, so a row whose day is damaged (null here) is counted nowhere and its
  // charge is read as 0 for today. The same holds for a damaged seat or provider.
  // Decided (review fixes 2): fail closed. A row that would count toward a total if its day, seat or
  // provider (for the job total: job, provider or payer) were readable, and whose value there is not
  // usable, refuses the next call with exit 3, nothing sent, and the refusal names the ledger line.
  /** Append a copy of the latest row with these fields changed: line `n` of the ledger. */
  const damage = (h: string, fields: Record<string, unknown>) => {
    appendFileSync(ledgerPath(h), JSON.stringify({ ...ledger(h).at(-1)!, ts: new Date().toISOString(), ...fields }) + "\n");
    return ledger(h).length;
  };
  async function refused(h: string, args: string[], line: number) {
    const p = new P();
    const r = await cli(h, args, { provider: p });
    expect({ code: r.code, sent: p.calls, line: r.err.includes(`ledger line ${line}`) }, r.err).toEqual({ code: 3, sent: 0, line: true });
  }
  const requesterArgs = (job: string) => [...runArgs(job), "--job-budget", "1"];

  it("cap 0.3, one held call of 0.186 whose latest row lost its day: a second 0.186 call is refused", async () => {
    const h = await ready("0.3");
    await pendingRun(h, "jA");
    const latest = ledger(h).at(-1)!;
    appendFileSync(ledgerPath(h), JSON.stringify({ ...latest, ts: new Date().toISOString(), day: null }) + "\n");
    const second = await cli(h, runArgs("jB"), { provider: new P() });
    expect(second.code, second.err).toBe(3);
  });

  it("cap 1: a day that is not a calendar date (2026-13-40) refuses the next call and names the line", async () => {
    const h = await ready();
    await pendingRun(h, "jA");
    await refused(h, runArgs("jB"), damage(h, { day: "2026-13-40" }));
  });

  it("cap 1: a damaged seat refuses the next call and names the line", async () => {
    const h = await ready();
    await pendingRun(h, "jA");
    await refused(h, runArgs("jB"), damage(h, { seat: "nine thousand one" }));
  });

  it("cap 1: a damaged provider refuses the next call and names the line", async () => {
    const h = await ready();
    await pendingRun(h, "jA");
    await refused(h, runArgs("jB"), damage(h, { provider: "MOCK" }));
  });

  it("control: a row of another seat whose day is damaged would never count toward this seat: the call is admitted", async () => {
    const h = await ready();
    await pendingRun(h, "jA");
    damage(h, { seat: "9002", day: null });
    expect((await cli(h, runArgs("jB"), { provider: new P() })).code).toBe(0);
  });

  it("requester: a damaged job on a requester row refuses the next requester call; a holder call does not check the job total", async () => {
    const h = await ready();
    await cli(h, ["config", "set", "payer", "requester"]);
    expect((await cli(h, requesterArgs("jA"), { provider: new P() })).code).toBe(0);
    const line = damage(h, { job: null });
    await refused(h, requesterArgs("jB"), line);
    await cli(h, ["config", "set", "payer", "holder"]);
    expect((await cli(h, runArgs("jC"), { provider: new P() })).code).toBe(0);
  });

  it("requester: a damaged payer on a row of this job refuses the next requester call for the job", async () => {
    const h = await ready();
    await cli(h, ["config", "set", "payer", "requester"]);
    expect((await cli(h, requesterArgs("jA"), { provider: new P() })).code).toBe(0);
    await refused(h, requesterArgs("jA"), damage(h, { payer: "requestor" }));
  });

  it("a damaged row that is not the latest row of its request is history: it is not placed, and the call is admitted", async () => {
    // The latest row of a request is its booking and the only row any total counts. An older row of the
    // same request is superseded whatever it holds, so damage there loses no charge.
    const h = await ready();
    await pendingRun(h, "jA");
    const lines = readFileSync(ledgerPath(h), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(1);
    lines[0] = { ...lines[0], day: null, seat: null, provider: null };
    writeFileSync(ledgerPath(h), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect((await cli(h, runArgs("jB"), { provider: new P() })).code).toBe(0);
    expect(await today(h)).toBe(0.372);
  });
});

describe("R7 (low), now residual R-g: the rounding tolerance", () => {
  // README: "the total already charged is rounded up ... so rounding never admits a call". ceil6 snaps a
  // total within 1e-12 FLOP above a 1e-6 boundary down onto it. A known spend of 0.8140000000005 (any
  // finite amount is a known settled spend) is charged as 0.814, the room is 0.186, and a 0.186 call fits:
  // the day ends at 1.0000000000005 against a cap of 1 (500000 base units over).
  // Decided (review fixes 2): words, not code. contract/rules.json R-g says what is true: a charge on the 6
  // decimal grid is never understated by rounding; a charge off it within 1e-12 FLOP above a step can be
  // admitted over the cap by at most 1e-12 FLOP. It closes when money moves to exact base units (stage 2).
  it("R-g: cap 1, a settled row charged 0.8140000000005 (off the grid): the charge rounds up to 0.814001, so a 0.186 call is refused and the day stays within its cap", async () => {
    // Moved (review of the audit 33f3b9f fixes, defect 1): there is no 1e-12 tolerance. An amount off the grid
    // rounds up when charged, so this residual is closed. Before, the call was admitted and the day ended over its
    // cap by at most 1e-12 FLOP.
    const h = await ready("1");
    await pendingRun(h, "jA");
    const latest = ledger(h).at(-1)!;
    appendFileSync(ledgerPath(h), JSON.stringify({ ...latest, ts: new Date().toISOString(), state: "settled", spend: 0.8140000000005, cap_charge: 0.8140000000005 }) + "\n");
    const second = await cli(h, runArgs("jB"), { provider: new P() });
    expect(second.code, second.err).toBe(3);
    expect(await today(h)).toBe(0.814001);
  });

  it("charges on the 6 decimal grid: rounding never admits a call over the cap (20000 random sums)", () => {
    // Each case: up to 40 charges on the grid (whole base units of 1e-6 FLOP), summed as floats in order as
    // ledger.ts sumCharges does and rounded up with ceil6, a cap and a padded quote on the grid, and
    // policy.ts checkBudget. Whenever the call is admitted, the exact total in 1e-6 units plus the quote is
    // within the cap. And the rounded total is never below the exact one.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const micro = (max: number) => Math.floor(rnd() * max);
    let admitted = 0;
    for (let c = 0; c < 20000; c++) {
      const scale = [10, 1e3, 1e6, 1e8, 1e10][c % 5]; // charges from 1e-5 FLOP to 1e4 FLOP
      const charges = Array.from({ length: 1 + micro(40) }, () => micro(scale));
      const exact = charges.reduce((a, b) => a + b, 0);
      let float = 0;
      for (const k of charges) float += k / 1e6;
      const spent = ceil6(float);
      expect(Math.round(spent * 1e6), `charges ${charges}`).toBeGreaterThanOrEqual(exact);
      const capMicro = exact + micro(scale * 2) - micro(scale);
      if (capMicro < 1) continue;
      const padMicro = 1 + micro(scale);
      const cap = { daily: capMicro / 1e6, perCall: capMicro / 1e6 };
      if (checkBudget({ padded: padMicro / 1e6, cap, payer: "holder", spentBefore: spent }) === null) {
        admitted += 1;
        expect(exact + padMicro, `charges ${charges}, cap ${capMicro}, quote ${padMicro}`).toBeLessThanOrEqual(capMicro);
      }
    }
    expect(admitted).toBeGreaterThan(1000);
  });
});

describe("R8 (words): a refresh against a ledger with a damaged line exits 1, not 0 with DISAGREE", () => {
  // README, lock-timeout rule: "For receipt --refresh a booking that cannot be written is not an error
  // exit: it stores the read, books nothing and exits 0 ... When the step failed for any other reason ...
  // it prints receipt and ledger disagree". With an unparsable ledger line the booking step throws a
  // SyntaxError, and the catch block in refreshReceipt calls latestAttempts again, which throws the same
  // error out of the catch: exit 1, no DISAGREE. Failing closed is fine; the words say otherwise.
  // Decided (review fixes 2): a damaged ledger is not a disagreement. The refresh stores the read, books
  // nothing, exits 1 and names the damaged line. status, receipt and run name the same line.
  const settled = (id: string) => receiptFor(id, { state: "settled", settled_spend: 0.05 });
  async function damaged(text: string) {
    const h = await ready();
    const rid = await pendingRun(h);
    appendFileSync(ledgerPath(h), text + "\n");
    const lines = readFileSync(ledgerPath(h), "utf8").split("\n").filter(Boolean);
    return { h, rid, line: lines.length, rows: lines.length - 1 };
  }
  const rowsOf = (h: string) => readFileSync(ledgerPath(h), "utf8").split("\n").filter(Boolean).length;

  it("one unparsable ledger line: the refresh stores the read, books nothing, names the line, prints no DISAGREE and exits 1", async () => {
    const { h, rid, line } = await damaged('{"request_id": ');
    const before = rowsOf(h);
    const r = await cli(h, refreshArgs(rid), { provider: new P({ read: settled }) });
    expect({ code: r.code, warned: r.err.includes(DISAGREE), named: r.err.includes(`ledger line ${line} cannot be read: not valid JSON`) }, r.err).toEqual({ code: 1, warned: false, named: true });
    expect(JSON.parse(readFileSync(join(h, "receipts", `${rid}.json`), "utf8")).state).toBe("settled");
    expect(rowsOf(h)).toBe(before);
  });

  it("a line that is JSON but not an object (null) is damaged the same way", async () => {
    const { h, rid, line } = await damaged("null");
    const r = await cli(h, refreshArgs(rid), { provider: new P({ read: settled }) });
    expect({ code: r.code, named: r.err.includes(`ledger line ${line} cannot be read: not a JSON object`) }, r.err).toEqual({ code: 1, named: true });
  });

  it("status, receipt and cap show exit 1 and run refuses with exit 3, nothing sent; each names the same line", async () => {
    const { h, rid, line } = await damaged('{"request_id": ');
    const message = `ledger line ${line} cannot be read: not valid JSON`;
    const status = await cli(h, ["status", "--seat", SEAT, "--json"]);
    const receipt = await cli(h, ["receipt", rid, "--json", "--seat", SEAT]);
    const capShow = await cli(h, ["cap", "show", "--seat", SEAT]);
    const p = new P();
    const run = await cli(h, runArgs("jB"), { provider: p });
    expect([status, receipt, capShow, run].map((r) => ({ code: r.code, named: r.err.includes(message) }))).toEqual([
      { code: 1, named: true },
      { code: 1, named: true },
      { code: 1, named: true },
      { code: 3, named: true },
    ]);
    expect(p.calls).toBe(0);
  });
});

describe("R4 (low, test gap): reconcile's seat and did checks are pinned by no test", () => {
  // e3f2456 added vectors reconcile-not-compared-identity-seat-* and -did-*, but every one of them also has
  // job null on both sides, so the job check alone decides them. Dropping "seat" and "did" from
  // settlement.ts sameAttempt passes all 605 tests at 7f57b4b (run in a scratch copy). These two blocks pass
  // at 7f57b4b and fail on that mutant. They never carried a failure marker: the code is right, the tests were not.
  // Review fixes 2: those 8 vectors now hold job j1 on both sides, so each varies exactly one field, and
  // reconcile.json gains -job-differs, -seat-differs and -did-differs. Dropping the seat or the did check
  // from sameAttempt now fails 5 contract vectors each, in imd-flop and in the viewer alike.
  const row = { request_id: "req-1", job: "j1", seat: "9001", did: "did:key:zA", state: "settled", spend: 0.07 };
  const receipt = { request_id: "req-1", job: "j1", seat: "9001", did: "did:key:zA", state: "settled", settled: 0.05, http: 200, error: null, flag: null, chain_final: false };
  it("a receipt for another seat is not compared", () => {
    expect(reconcile(row, receipt)).toBe("disagree");
    expect(reconcile(row, { ...receipt, seat: "9002" })).toBe("not_compared");
  });
  it("a receipt under another DID is not compared", () => {
    expect(reconcile(row, { ...receipt, did: "did:key:zB" })).toBe("not_compared");
  });
});

/**
 * Multi process stress: real child processes against one IMD_FLOP_HOME, each running `run` (dist/cli.js
 * main with a stub provider) and `receipt --refresh` on random requests of the shared ledger, with random
 * reads, failures and small delays so the lock is contested. Two gateway stubs:
 *  - consistent: each request has one final outcome (settled at an amount at or below the padded quote, as
 *    max_cost_flop requires, with that amount as its reported cost or none; released at 0; or released with
 *    no amount), and before it a read may be pending, failed or for another request id.
 *  - erratic (review fixes 2): every read of the same request answers anew: any of the four states in any
 *    order, a settled amount at or below the padded quote or none, an exact amount or none, and failed or
 *    foreign reads as before. The completion is slow and reports its cost late, at or below the padded quote
 *    or not at all, so other processes often book the request first. This is the shape of stub that found
 *    the high finding (R9). With the hold floor the day must never pass the cap.
 * In both, a request that failed before send is answered 404 only, so no read takes a released hold back
 * (R3 covers that), and a gateway that reports more than the padded quote is outside the stub (R9's own
 * tests pin it). Then the whole ledger is replayed and checked. Size: STRESS_PROCS processes x STRESS_OPS
 * operations x STRESS_ROUNDS rounds per mode (defaults 4 x 25 x 2 here; the review ran 6 x 60 x 20 by env).
 * STRESS_REPORT, when set, is a path prefix: each mode writes its numbers to <prefix>.<mode>.json.
 */
describe("stress: the cap, the booking step and the lock under real concurrent processes", () => {
  const PROCS = Number(process.env.STRESS_PROCS ?? 4);
  const OPS = Number(process.env.STRESS_OPS ?? 25);
  const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 2);
  const CAP = 2;
  const root = join(import.meta.dirname, "..");
  type Mode = "consistent" | "erratic";

  function worker(home: string, seed: number, mode: Mode): Promise<{ code: number; out: string; err: string }> {
    const script = join(home, `worker-${seed}.mjs`);
    writeFileSync(script, `
import { main } from ${JSON.stringify(join(root, "dist", "cli.js"))};
import { readFileSync, existsSync } from "node:fs";
let s = ${seed} * 2654435761 % 4294967296 || 1;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = ${JSON.stringify(home)};
const MODE = ${JSON.stringify(mode)};
const HOLD = 0.186;
const AMOUNTS = [0, 0.01, 0.05, 0.07, HOLD];
const rawOf = (amt) => amt === null ? null : String(Math.round(amt * 1e6)) + "000000000000";
/** The consistent gateway: each request has one final outcome, chosen from its id. */
function outcome(id) {
  let x = 0; for (const ch of id) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  const amt = AMOUNTS[x % 5];
  return { final: ["settled", "settled", "released", "released-unknown"][(x >>> 3) % 4], amt, cost: (x >>> 5) % 2 ? amt : undefined };
}
function read(id) {
  if (existsSync(home + "/presend.txt") && readFileSync(home + "/presend.txt", "utf8").includes(id)) return { http: 404, error: "not found", receipt: null };
  const k = rnd();
  if (k < 0.15) return { http: 503, error: "HTTP 503", receipt: null };
  if (k < 0.25) return { http: 200, error: null, receipt: { request_id: "other", state: "settled", settled_spend: 0.001 } };
  if (MODE === "erratic") {
    // Every read answers anew: any state in any order, an amount at or below the hold or none.
    const state = pick(["reserved", "estimated", "settled", "released", null]);
    const settled = pick([null, ...AMOUNTS]);
    return { http: 200, error: null, receipt: { request_id: id, correlation_id: "c", state, settled_spend: settled, settled_spend_raw: pick([null, rawOf(settled)]), reserved_spend: HOLD } };
  }
  const o = outcome(id);
  if (k < 0.5) return { http: 200, error: null, receipt: { request_id: id, correlation_id: "c", state: pick(["reserved", "estimated"]), settled_spend: null, settled_spend_raw: null, reserved_spend: HOLD } };
  const settled = o.final === "settled" ? o.amt : o.final === "released" ? 0 : null;
  return { http: 200, error: null, receipt: { request_id: id, correlation_id: "c", state: o.final === "settled" ? "settled" : "released", settled_spend: settled, settled_spend_raw: pick([null, rawOf(settled)]), reserved_spend: HOLD } };
}
class P {
  name = "mock"; calls = 0;
  async estimate() { return { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }; }
  async complete(req) {
    this.calls++; await sleep(rnd() * 20);
    const k = rnd();
    if (k < 0.1) { const { appendFileSync } = await import("node:fs"); appendFileSync(home + "/presend.txt", req.requestId + "\\n"); const { PreSendError } = await import(${JSON.stringify(join(root, "dist", "gateway.js"))}); throw new PreSendError("mint failed"); }
    if (k < 0.2) { const { FlopHTTPError } = await import(${JSON.stringify(join(root, "node_modules", "@flop-labs", "client", "dist", "index.js"))}); throw new FlopHTTPError(500, {}, null); }
    if (k < 0.3) { await new Promise((_, rej) => { if (req.signal.aborted) rej(req.signal.reason); else req.signal.addEventListener("abort", () => rej(req.signal.reason), { once: true }); }); }
    let cost;
    if (MODE === "erratic") {
      // The cost comes late: other processes have time to refresh and book the request first.
      await sleep(rnd() * 25);
      cost = pick([undefined, ...AMOUNTS]);
    } else {
      const o = outcome(req.requestId);
      cost = o.final === "settled" ? o.cost : undefined;
    }
    return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, ...(cost === undefined ? {} : { cost_flop: cost }) } };
  }
  async readReceipt(id) { await sleep(rnd() * 20); return read(id); }
}
let errs = [];
const io = (p) => ({ out: () => {}, err: (m) => errs.push(m), env: { IMD_FLOP_HOME: home }, provider: p });
const codes = {};
let damaged = 0;
for (let i = 0; i < ${OPS}; i++) {
  let code;
  errs = [];
  if (rnd() < 0.55) code = await main(["run", "--seat", "${SEAT}", "--job", "j" + Math.floor(rnd() * 3), "--prompt", "hi", "--provider", "mock", "--max-tokens", "8", "--timeout-ms", "${mode === "erratic" ? 60 : 30}"], io(new P()));
  else {
    // A line another process is appending may be seen half written: skip what does not parse.
    const ids = [];
    if (existsSync(home + "/ledger.jsonl")) for (const l of readFileSync(home + "/ledger.jsonl", "utf8").split("\\n")) { try { const id = JSON.parse(l).request_id; if (id) ids.push(id); } catch {} }
    if (ids.length === 0) continue;
    code = await main(["receipt", pick(ids), "--refresh", "--seat", "${SEAT}"], io(new P()));
  }
  codes[code] = (codes[code] ?? 0) + 1;
  if (errs.some((m) => m.includes("cannot be read"))) damaged += 1;
}
process.stdout.write(JSON.stringify({ codes, damaged }));
`);
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, IMD_FLOP_HOME: home } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    return new Promise((resolve) => child.on("exit", (c) => resolve({ code: c ?? 1, out, err })));
  }

  /** Replay the ledger: every check the review cares about, on every line. */
  function check(home: string) {
    const lines = readLines(ledgerPath(home)) as Row[];
    const latest = new Map<string, Row>();
    const problems: string[] = [];
    const ceil6 = (n: number) => Math.ceil(Math.round(n * 1e6 * 1e6) / 1e6) / 1e6;
    let sent = 0;
    for (const [i, e] of lines.entries()) {
      const prev = e.request_id ? latest.get(e.request_id) : undefined;
      if (e.state === "sent" && !prev) {
        sent += 1;
        let total = 0;
        for (const r of latest.values()) total += r.cap_charge as number;
        // The lock serialises the cap check and its sent row: the recorded total is the true total.
        if (Math.abs(ceil6(total) - (e.spent_before as number)) > 1e-9) problems.push(`line ${i}: spent_before ${e.spent_before} but replayed total ${ceil6(total)}`);
        if ((e.spent_before as number) + (e.quote_padded as number) > CAP + 1e-9) problems.push(`line ${i}: admitted over the cap`);
      }
      if (prev) {
        const settles = (st: string) => st === "settled" || st === "released";
        if (settles(prev.state) && !settles(e.state)) problems.push(`line ${i}: left a settling state`);
        if (settles(prev.state) && typeof prev.spend === "number" && !(typeof e.spend === "number" && e.spend >= prev.spend)) problems.push(`line ${i}: booked settlement lowered`);
        if (e.state === "refused_local" && prev.state !== "sent") problems.push(`line ${i}: released a row in state ${prev.state}`);
        if (typeof e.spend === "number" && (e.cap_charge as number) < Math.max(e.spend, (e.cost_reported as number | null) ?? 0) - 1e-12) problems.push(`line ${i}: charge below max(spend, cost)`);
        if (e.spend === null && e.state !== "refused_local" && (e.cap_charge as number) < (e.quote_padded as number) - 1e-12) problems.push(`line ${i}: hold released with spend unknown`);
      }
      // The hold floor: a row the call was sent for is never charged below its padded quote.
      if (e.state !== "refused_local" && (e.cap_charge as number) < (e.quote_padded as number) - 1e-12) problems.push(`line ${i}: charge ${e.cap_charge} below its hold ${e.quote_padded}`);
      if (e.request_id) latest.set(e.request_id, e);
    }
    let total = 0;
    for (const r of latest.values()) total += r.cap_charge as number;
    return { lines: lines.length, sent, total, problems };
  }

  for (const mode of ["consistent", "erratic"] as const) {
    it(`${mode} gateway, ${PROCS} processes x ${OPS} operations x ${ROUNDS} rounds: no line breaks a rule and the day stays within the cap`, async () => {
      execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: root });
      const summary: { lines: number; sent: number; total: number }[] = [];
      const codes: Record<string, number> = {};
      let damaged = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const h = await ready(String(CAP));
        const results = await Promise.all(Array.from({ length: PROCS }, (_, p) => worker(h, round * 1000 + p + 1 + (mode === "erratic" ? 500 : 0), mode)));
        for (const r of results) {
          expect(r.code, r.err).toBe(0);
          const out = JSON.parse(r.out) as { codes: Record<string, number>; damaged: number };
          for (const [k, n] of Object.entries(out.codes)) codes[k] = (codes[k] ?? 0) + n;
          damaged += out.damaged;
        }
        const c = check(h);
        expect(c.problems).toEqual([]);
        expect(c.total).toBeLessThanOrEqual(CAP + 1e-9);
        summary.push({ lines: c.lines, sent: c.sent, total: c.total });
      }
      // Review fixes 3, item 2: a line in flight is read again under the lock, so the CLI never reports a
      // damaged line here (the ledger is checked whole above).
      expect(damaged).toBe(0);
      if (process.env.STRESS_REPORT) writeFileSync(`${process.env.STRESS_REPORT}.${mode}.json`, JSON.stringify({ mode, procs: PROCS, ops: OPS, rounds: ROUNDS, codes, damaged, summary }));
    }, 1_800_000);
  }
});
