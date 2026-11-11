/**
 * Independent review of the hold floor branch (b839bf3..bf9087c), fixed by review fixes 3. The reviewer wrote
 * each finding as a test that asserted the wrong behavior of bf9087c; each is now rewritten under a plain name
 * to assert the decided behavior, and was seen failing before its fix. Items 1 to 10 are the reviewer's
 * findings, A to D the smaller ones from the same report. Stub providers only; test/setup.ts disables fetch.
 * Item 2 uses a real child process (dist/cli.js, built by `npm test`) against one ledger.
 * The stress block is the review's own multi process run: the two gateway modes of review-fixes.test.ts with a
 * worker that tolerates a line in flight, plus three modes of its own.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PreSendError } from "../src/gateway.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { LEDGER_BUSY } from "../src/receipt-store.js";
import { decideBooking, PAST_ADMITTED } from "../src/settlement.js";
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
type Row = Record<string, unknown> & { request_id: string | null; state: string; spend: number | null; cap_charge: number | null; reason?: string | null };
const ledgerPath = (home: string) => join(home, "ledger.jsonl");
const ledger = (home: string) => (existsSync(ledgerPath(home)) ? (readLines(ledgerPath(home)) as Row[]) : []);
const status = async (home: string) => (await cli(home, ["status", "--seat", SEAT, "--json"])).json();
const anyPastAdmitted = (home: string) => ledger(home).some((r) => typeof r.reason === "string" && r.reason.includes(PAST_ADMITTED));
async function ready(cap = "1") {
  const h = tmpHome();
  await readySeat(h, SEAT, cap);
  return h;
}
const settledAt = (spend: number) => (id: string) => receiptFor(id, { state: "settled", settled_spend: spend });

describe("1 (high): a row an older version booked below its hold is raised back, and says so", () => {
  // The README and KD-12 say rows an older version booked below their hold are not migrated: they keep their
  // charge, "and a later read only raises it". pastAdmitted (settlement.ts) takes what the cap admitted for a
  // sent row to be its padded quote. For such an older row the cap admitted every later call against the
  // lower booked charge, so a later read that raises it back toward the padded quote puts the day over the
  // cap, and pastAdmitted says nothing: the charge never passes the padded quote. No refusal, no
  // PAST_ADMITTED line, no row carries it. R-f ("the daily cap can be passed only when ...") is false here.
  // Decided (review fixes 3): a booking is past what the cap admitted whenever it raises a request's known
  // booked charge, since that charge is what every later admission counted. So this booking prints
  // PAST_ADMITTED and records it in the row's reason.
  it("a refresh that raises a row an older version charged below its hold, taking the day to 0.372 of 0.3, prints PAST_ADMITTED and records it in the row's reason", async () => {
    const h = await ready("0.3");
    const a = await cli(h, runArgs("jA"), { provider: new P({ read: settledAt(0.01) }) });
    expect(a.code, a.err).toBe(0);
    const rid = a.json().request_id as string;
    // The row as the version before the hold floor (b839bf3) booked it: charge = settled spend, no receipt_seen.
    const latest = ledger(h).at(-1)!;
    appendFileSync(ledgerPath(h), JSON.stringify({ ...latest, ts: new Date().toISOString(), cap_charge: 0.01 }) + "\n");
    expect((await cli(h, runArgs("jB"), { provider: new P() })).code).toBe(0);
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.186) }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    const s = await status(h);
    expect({ total: s.today_utc.mock, over: s.over_cap_today_utc.mock }).toEqual({ total: 0.372, over: true });
    expect(refreshed.err).toContain(PAST_ADMITTED);
    expect(ledger(h).at(-1)!.reason).toContain(PAST_ADMITTED);
  });

  it("job budget: a refresh that takes a requester job over its budget by raising an older row's charge prints PAST_ADMITTED", async () => {
    const h = await ready("5");
    await cli(h, ["config", "set", "payer", "requester"]);
    const req = (job: string) => [...runArgs(job), "--job-budget", "0.3"];
    const a = await cli(h, req("jA"), { provider: new P({ read: settledAt(0.01) }) });
    expect(a.code, a.err).toBe(0);
    const latest = ledger(h).at(-1)!;
    appendFileSync(ledgerPath(h), JSON.stringify({ ...latest, ts: new Date().toISOString(), cap_charge: 0.01 }) + "\n");
    expect((await cli(h, req("jA"), { provider: new P() })).code).toBe(0);
    const refreshed = await cli(h, refreshArgs(a.json().request_id), { provider: new P({ read: settledAt(0.186) }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    const latestPerRequest = [...new Map(ledger(h).map((r) => [r.request_id, r])).values()];
    const jobTotal = latestPerRequest.filter((r) => r.job === "jA").reduce((t, r) => t + (r.cap_charge as number), 0);
    expect(Math.round(jobTotal * 1e6) / 1e6).toBe(0.372);
    expect(refreshed.err).toContain(PAST_ADMITTED);
    expect(anyPastAdmitted(h)).toBe(true);
  });
});

describe("A (review fixes 3): a read whose state is not one of the four gateway states moves no state", () => {
  // A trusted read in a state the gateway does not document ("refused_local", "sent", anything) counts as a
  // read with no state. A gateway answer must never set a local state.
  const sent = { state: "sent", spend: null, cap_charge: 0.186, quote_padded: 0.186 };
  const estimated = { state: "estimated", spend: null, cap_charge: 0.186, quote_padded: 0.186 };
  const read = (state: string) => ({ fresh: true, identityOk: true, redacted: false, state, settled: null });

  it("refused_local or sent on a sent row: the row stays sent, holds its hold and is marked receipt_seen", () => {
    for (const state of ["refused_local", "sent", "bogus"]) {
      const { booking } = decideBooking(sent, read(state), null);
      expect({ state: booking.state, cap_charge: booking.cap_charge, receipt_seen: booking.receipt_seen }, state).toEqual({ state: "sent", cap_charge: 0.186, receipt_seen: true });
    }
  });

  it("refused_local or sent on an estimated row: the state stays estimated", () => {
    for (const state of ["refused_local", "sent"]) expect(decideBooking(estimated, read(state), null).booking.state, state).toBe("estimated");
  });
});

describe("B (review fixes 3): a matching 200 read stored redacted keeps or brings back the hold, and never settles", () => {
  // A 200 read whose request id matches shows the gateway knows the request, even when its stored copy had
  // to be redacted (here settled_spend_raw of 64 digits). It never proves a settlement. Both orders.
  const redacted = (state: string) => (id: string) => receiptFor(id, { state, settled_spend: 0.05, settled_spend_raw: "0".repeat(47) + "50000000000000000" });
  const preSend = async (): Promise<CompleteRes> => {
    throw new PreSendError("child key mint failed");
  };

  it("read first: a refresh stores a redacted matching read, then the call fails before send: the hold stays", async () => {
    const h = await ready();
    const complete = async (req: CompleteReq) => {
      const r = await cli(h, refreshArgs(req.requestId), { provider: new P({ read: redacted("settled") }) });
      expect(r.code, r.err).toBe(0);
      return preSend();
    };
    expect((await cli(h, runArgs(), { provider: new P({ complete }) })).code).toBe(11);
    const last = ledger(h).at(-1)!;
    expect({ state: last.state, spend: last.spend, cap_charge: last.cap_charge, receipt_seen: last.receipt_seen }).toEqual({ state: "sent", spend: null, cap_charge: 0.186, receipt_seen: true });
    expect((await status(h)).today_utc.mock).toBe(0.186);
  });

  it("report first: the call fails before send, then a redacted matching read brings the hold back, says so, and settles nothing", async () => {
    const h = await ready();
    expect((await cli(h, runArgs(), { provider: new P({ complete: preSend }) })).code).toBe(11);
    const rid = ledger(h)[0].request_id!;
    const r = await cli(h, refreshArgs(rid), { provider: new P({ read: redacted("settled") }) });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain(PAST_ADMITTED);
    const last = ledger(h).at(-1)!;
    expect({ state: last.state, spend: last.spend, cap_charge: last.cap_charge }).toEqual({ state: "sent", spend: null, cap_charge: 0.186 });
  });
});

describe("2 (medium): a ledger line another process is still writing is not named as damaged", () => {
  // run's early check (run.ts spentEarly), status, cap show and receipt <id> read ledger.jsonl without the
  // ledger lock. A line another process is appending under the lock can be seen half written. ledgerLines
  // then throws UnusableLedgerRow: run refuses with exit 3 and appends a refused_local row, status exits 1,
  // and each tells the holder "ledger line N cannot be read ... Repair or remove that line." The line is
  // good once its writer finishes. A holder (or an agent) that follows the message removes a good row, and
  // when that row is the request's latest booking its charge leaves the day's total.
  // Seen in the wild: the erratic stress mode of review-fixes.test.ts at 6 x 60 x 20 fails on this very
  // thing in its own worker, and the review's stress block below counts the CLI's own false reports.
  // Decided (review fixes 3): a read outside the lock that meets a line it cannot parse takes the ledger lock
  // and reads again before it names any line. Only a line still unreadable under the lock is named. If the
  // lock cannot be taken, the command says the ledger is busy, as a busy ledger does for it.
  it("a line another process is still writing under the lock is not named as damaged, and the run is not refused for it", async () => {
    const h = await ready("1");
    const rid = (await cli(h, runArgs("jA"), { provider: new P() })).json().request_id as string;
    const lines = readFileSync(ledgerPath(h), "utf8");
    const nLines = lines.split("\n").filter(Boolean).length;
    // Another process holds the lock and is appending the next booking of request A.
    const lock = `${ledgerPath(h)}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: "writer" }));
    const next = JSON.stringify({ ...ledger(h).at(-1)!, ts: new Date().toISOString(), state: "settled", spend: 0.05 }) + "\n";
    appendFileSync(ledgerPath(h), next.slice(0, 200));
    const root = join(import.meta.dirname, "..");
    const script = join(h, "child.mjs");
    writeFileSync(script, `
import { main } from ${JSON.stringify(join(root, "dist", "cli.js"))};
class P { name = "mock"; calls = 0;
  async estimate() { return ${JSON.stringify(QUOTE)}; }
  async complete(req) { this.calls++; return { request_id: req.requestId, text: "ok", usage: null }; }
  async readReceipt(id) { return { http: 503, error: "HTTP 503", receipt: null }; } }
const err = []; const p = new P();
const code = await main(${JSON.stringify(runArgs("jB"))}, { out: () => {}, err: (s) => err.push(s), env: { IMD_FLOP_HOME: ${JSON.stringify(h)} }, provider: p });
process.stdout.write(JSON.stringify({ code, err: err.join("\\n"), sent: p.calls }));
`);
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, IMD_FLOP_HOME: h } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const done = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    // The writer finishes its line and releases the lock while the child waits for it.
    await new Promise((r) => setTimeout(r, 3000));
    appendFileSync(ledgerPath(h), next.slice(200));
    writeFileSync(lock, "");
    const { unlinkSync } = await import("node:fs");
    unlinkSync(lock);
    await done;
    const r = JSON.parse(out) as { code: number; err: string; sent: number };
    // The ledger is whole: every line parses, and request A's latest row is the settlement that was in flight.
    const rows = ledger(h);
    expect(rows.filter((x) => x.request_id === rid).at(-1)!.state).toBe("settled");
    expect({ code: r.code, sent: r.sent }, r.err).toEqual({ code: 0, sent: 1 });
    expect(r.err).not.toContain("cannot be read");
  }, 20_000);
});

describe("2 (medium), busy: a line in flight while the lock cannot be taken is a busy ledger, never a damaged one", () => {
  // Another process holds the lock for longer than the lock timeout (5 s) while a line is half written. Each
  // command says the ledger is busy, with the words it uses for a busy ledger, and names no line.
  it("status and receipt exit 1 with the lock timeout, run exits 10 with nothing sent, a refresh stores its read and prints the busy line", async () => {
    const h = await ready("1");
    const rid = (await cli(h, runArgs("jA"), { provider: new P() })).json().request_id as string;
    // Another live process: the test runner. Our own pid with a token we do not hold is a dead owner (lock reclaim, audit 33f3b9f finding 7).
    writeFileSync(`${ledgerPath(h)}.lock`, JSON.stringify({ pid: process.ppid, host: hostname(), token: "writer" }));
    appendFileSync(ledgerPath(h), JSON.stringify({ ...ledger(h).at(-1)!, state: "settled" }).slice(0, 100));
    const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
    const receipt = await cli(h, ["receipt", rid, "--json", "--seat", SEAT]);
    const p = new P();
    const run = await cli(h, runArgs("jB"), { provider: p });
    const refresh = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
    const named = (r: { err: string }) => r.err.includes("cannot be read");
    expect([st, receipt, run, refresh].map((r) => ({ code: r.code, named: named(r) }))).toEqual([
      { code: 1, named: false },
      { code: 1, named: false },
      { code: 10, named: false },
      { code: 0, named: false },
    ]);
    expect([st.err, receipt.err, run.err].every((e) => e.includes("ledger lock timeout"))).toBe(true);
    expect(refresh.err).toContain(LEDGER_BUSY);
    expect(p.calls).toBe(0);
    expect(JSON.parse(readFileSync(join(h, "receipts", `${rid}.json`), "utf8")).state).toBe("settled");
  }, 60_000);
});

describe("3 (medium): a latest row with no usable request_id cannot be placed", () => {
  // ledger.ts latestLines omitted every line whose request_id was falsy before placed() looked at it, so a
  // line with this seat's day, seat, provider and a charge but no usable request_id counted nowhere and
  // refused nothing; when it was a request's latest row, the older row (a released hold, charge 0) stood in.
  // Decided (review fixes 3): a line with no usable request_id cannot be placed, unless it is a
  // refused_local row charged 0 (a refusal written before a request id exists). It refuses the next call and
  // names the line, like any other row that cannot be placed.
  const preSend = async (): Promise<CompleteRes> => {
    throw new PreSendError("child key mint failed");
  };
  async function refusedNaming(h: string, line: number) {
    const p = new P();
    const b = await cli(h, runArgs("jB"), { provider: p });
    expect({ code: b.code, sent: p.calls, named: b.err.includes(`ledger line ${line} cannot be placed`) && b.err.includes("request_id") }, b.err).toEqual({ code: 3, sent: 0, named: true });
  }

  it("a latest row that lost its request_id (A revived to 0.186, cap 0.3) cannot be placed: B is refused and the line is named", async () => {
    const h = await ready("0.3");
    expect((await cli(h, runArgs("jA"), { provider: new P({ complete: preSend }) })).code).toBe(11);
    const a = ledger(h)[0].request_id!;
    const revived = await cli(h, refreshArgs(a), { provider: new P() });
    expect(revived.code, revived.err).toBe(0);
    expect((await status(h)).today_utc.mock).toBe(0.186);
    const lines = readFileSync(ledgerPath(h), "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines.at(-1)!);
    expect(last.cap_charge).toBe(0.186);
    lines[lines.length - 1] = JSON.stringify({ ...last, request_id: null });
    writeFileSync(ledgerPath(h), lines.join("\n") + "\n");
    await refusedNaming(h, lines.length);
  });

  it("no history: a held call whose lines all lost their request_id refuses the next call", async () => {
    const h = await ready("0.3");
    await cli(h, runArgs("jA"), { provider: new P() });
    const lines = readLines(ledgerPath(h)).map((r: Record<string, unknown>) => ({ ...r, request_id: "" }));
    writeFileSync(ledgerPath(h), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await refusedNaming(h, 1);
  });

  it("control: a refusal written before a request id exists (refused_local, request_id null, charge 0) is not a damaged row", async () => {
    const h = await ready("0.3");
    const refusal = await cli(h, runArgs("jA"), { provider: new P({ complete: preSend }) });
    expect(refusal.code).toBe(11);
    // The refusal before the estimate writes such a row: a run refused at the cap.
    await cli(h, ["cap", "set", "0.1", "--seat", SEAT]);
    expect((await cli(h, runArgs("jZ"), { provider: new P() })).code).toBe(3);
    expect(ledger(h).at(-1)!).toMatchObject({ request_id: null, state: "refused_local", cap_charge: 0 });
    await cli(h, ["cap", "set", "0.3", "--seat", SEAT]);
    expect((await cli(h, runArgs("jB"), { provider: new P() })).code).toBe(0);
  });
});

describe("C (review fixes 3): the day 0000-01-01 is not a usable day", () => {
  // imd-flop read 0000-01-01 as a calendar date and the viewer did not (Python dates start at year 1).
  // Decided: both refuse it.
  it("a held row whose day is 0000-01-01 refuses the next call and names the line", async () => {
    const h = await ready();
    await cli(h, runArgs("jA"), { provider: new P() });
    appendFileSync(ledgerPath(h), JSON.stringify({ ...ledger(h).at(-1)!, ts: new Date().toISOString(), day: "0000-01-01" }) + "\n");
    const p = new P();
    const b = await cli(h, runArgs("jB"), { provider: p });
    expect({ code: b.code, sent: p.calls, named: b.err.includes(`ledger line ${ledger(h).length - 1} cannot be placed`) }, b.err).toEqual({ code: 3, sent: 0, named: true });
  });
});

describe("4 (low): a reported cost is a known amount or it is unknown", () => {
  // settlement.ts reportedCost took any finite number, so a completion that reported cost_flop 1e16 raised
  // the charge to 1e16, above AMOUNT_MAX, and every later call was refused on an unusable charge this tool
  // wrote itself. Decided (review fixes 3): a reported cost follows knownAmount; an unknown cost raises nothing.
  const reporting = (cost: number) => async (req: CompleteReq): Promise<CompleteRes> => ({ request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: cost } });

  it("a reported cost above AMOUNT_MAX (1e16) is unknown: it raises nothing, the row stays readable and the next call is admitted", async () => {
    const h = await ready("1");
    const a = await cli(h, runArgs("jA"), { provider: new P({ complete: reporting(1e16) }) });
    expect(a.code, a.err).toBe(0);
    const last = ledger(h).at(-1)!;
    expect({ cap_charge: last.cap_charge, cost_reported: last.cost_reported }).toEqual({ cap_charge: 0.186, cost_reported: null });
    const p = new P();
    expect((await cli(h, runArgs("jB"), { provider: p })).code).toBe(0);
    expect(p.calls).toBe(1);
    expect((await cli(h, ["status", "--seat", SEAT, "--json"])).code).toBe(0);
  });

  it("a negative reported cost is unknown too and is not recorded", async () => {
    const h = await ready("1");
    expect((await cli(h, runArgs("jA"), { provider: new P({ complete: reporting(-0.5) }) })).code).toBe(0);
    expect(ledger(h).at(-1)!.cost_reported).toBe(null);
  });
});

describe("D (review fixes 3): status marks today over its cap, in text and --json", () => {
  // Two direct cases: today's latest rows total 0.372 against a cap of 0.3 (over), and 0.186 (not over).
  async function dayOf(charges: number[]) {
    const h = await ready("0.3");
    const day = new Date().toISOString().slice(0, 10);
    const row = (i: number, c: number) => ({ ts: new Date().toISOString(), day, request_id: `mock-${SEAT}-${i}`, seat: SEAT, did: "did:key:z", job: `j${i}`, provider: "mock", network: "devnet", payer: "holder", model: "m", max_tokens: 8, quote_raw: 0.066, quote_padded: 0.186, per_call_cap: 0.3, daily_cap: 0.3, job_budget: null, spent_before: 0, job_spent_before: null, state: "estimated", reason: null, spend: null, cost_reported: null, cap_charge: c, http: 200, mock: true });
    writeFileSync(ledgerPath(h), charges.map((c, i) => JSON.stringify(row(i, c))).join("\n") + "\n");
    return { json: await status(h), text: (await cli(h, ["status", "--seat", SEAT])).out };
  }
  it("0.372 of 0.3 is over: over_cap_today_utc.mock is true and the text says OVER CAP", async () => {
    const { json, text } = await dayOf([0.186, 0.186]);
    expect({ total: json.today_utc.mock, over: json.over_cap_today_utc }).toEqual({ total: 0.372, over: { flop: false, mock: true } });
    expect(text).toContain("mock 0.372 / 0.3 OVER CAP");
  });
  it("0.186 of 0.3 is not over: false, and no OVER CAP", async () => {
    const { json, text } = await dayOf([0.186]);
    expect({ total: json.today_utc.mock, over: json.over_cap_today_utc }).toEqual({ total: 0.186, over: { flop: false, mock: false } });
    expect(text).toContain("mock 0.186 / 0.3");
    expect(text).not.toContain("OVER CAP");
  });
});

describe("7 (review fixes 3): a ledger line with NaN, Infinity or -Infinity is unreadable, in both parts", () => {
  // JSON.parse refuses those constants, so imd-flop names the line; the viewer now reads with the same grammar
  // (viewer/test_review_hold.py, item 7). Both read the same lines: contract/fixtures/ledger-text/json-constants.jsonl.
  const FIXTURE = join(import.meta.dirname, "..", "..", "contract", "fixtures", "ledger-text", "json-constants.jsonl");
  it("each fixture line: status exits 1 and run refuses with exit 3, both naming ledger line 1", async () => {
    const lines = readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const h = await ready("1");
      writeFileSync(ledgerPath(h), line + "\n");
      const message = "ledger line 1 cannot be read: not valid JSON";
      const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
      const p = new P();
      const run = await cli(h, runArgs("jB"), { provider: p });
      expect({ status: st.code, statusNamed: st.err.includes(message), run: run.code, runNamed: run.err.includes(message), sent: p.calls }, line).toEqual({ status: 1, statusNamed: true, run: 3, runNamed: true, sent: 0 });
    }
  });
});

describe("5 (words): status marks today only, and the README says so", () => {
  // README: a booking past what the cap admitted prints the line, and "`status` then marks the day OVER CAP"
  // (also R-f). status computes over_cap_today_utc for today only. A released hold of an earlier UTC day that
  // a trusted read brings back puts that day over its cap; status never marks it, in text or in --json.
  // Right: the words say status marks today's total only, or status marks every day over its cap.
  // Decided (review fixes 3): the words say status marks today only, and that a hold that comes back on an
  // earlier day is shown by its PAST_ADMITTED row and by the viewer.
  it("a hold revived on yesterday's row is not marked by status; its row carries PAST_ADMITTED; the README says status marks today only", async () => {
    const h = await ready("0.3");
    const preSend = async (): Promise<CompleteRes> => {
      throw new PreSendError("child key mint failed");
    };
    expect((await cli(h, runArgs("jA"), { provider: new P({ complete: preSend }) })).code).toBe(11);
    expect((await cli(h, runArgs("jB"), { provider: new P() })).code).toBe(0);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const moved = readLines(ledgerPath(h)).map((r: Record<string, unknown>) => ({ ...r, day: yesterday }));
    writeFileSync(ledgerPath(h), moved.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const a = moved[0].request_id as string;
    const refreshed = await cli(h, refreshArgs(a), { provider: new P() });
    expect(refreshed.err).toContain(PAST_ADMITTED);
    const s = await status(h);
    expect(s.over_cap_today_utc).toEqual({ flop: false, mock: false });
    expect(JSON.stringify(s)).not.toContain(yesterday);
    expect((await cli(h, ["status", "--seat", SEAT])).out).not.toContain("OVER CAP");
    expect(ledger(h).at(-1)!.reason).toContain(PAST_ADMITTED);
    const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    expect(readme).toContain("`status` marks today's total only");
    expect(readme).not.toContain("`status` then marks the day `OVER CAP`");
  });
});

/**
 * The review's multi process stress: real child processes against one IMD_FLOP_HOME, each running `run`,
 * `receipt --refresh` and `status` (dist/cli.js main with a stub provider). Size: STRESS_PROCS processes x
 * STRESS_OPS operations x STRESS_ROUNDS rounds per mode (defaults 3 x 15 x 1 here; the review ran 6 x 60 x 20
 * by env). STRESS_REPORT, when set, is a path prefix: each mode writes its numbers to <prefix>.<mode>.json.
 * Modes:
 *  - consistent, erratic: the gateways of review-fixes.test.ts, with one change to the worker: it picks a
 *    request id from the ledger lines it can parse, so a line in flight (item 2) does not kill it.
 *  - requester: as erratic, and each run is a requester call with a job budget of 0.6 or a holder call, by
 *    each process's own config writes; the job totals are checked beside the daily cap.
 *  - revive: as erratic, and a request that failed before send is later answered by trusted reads (pending
 *    or with no state) so released holds come back, and completions report costs up to 0.3, above the hold.
 *    The check: every line that takes the replayed day above the cap carries PAST_ADMITTED.
 *  - midnight: as erratic, with every process's clock 5 s before the next UTC midnight until its middle
 *    operation and 5 s after it from then on, so the processes cross the day change at different moments. Each day's total is checked on its own, and every sent row against its own day.
 * Every mode counts the CLI's own reports of a damaged ledger line ("cannot be read") and checks afterwards
 * that every ledger line parses, so each such report named a line that was good.
 * History: written by the independent review of the hold floor branch at bf9087c, which ran all five modes
 * at 6 x 60 x 20 and counted false damaged line reports there (item 2). Kept as a permanent test by review
 * fixes 3 at the small default size (3 x 15 x 1), and since the fix of item 2 a false report fails it. Review
 * fixes 3 ran it again at 6 x 60 x 20 (numbers in that report).
 */
describe("review stress: the hold floor under real concurrent processes", () => {
  const PROCS = Number(process.env.STRESS_PROCS ?? 3);
  const OPS = Number(process.env.STRESS_OPS ?? 15);
  const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 1);
  const CAP = 2;
  const BUDGET = 0.6;
  const root = join(import.meta.dirname, "..");
  type Mode = "consistent" | "erratic" | "requester" | "revive" | "midnight";

  function worker(home: string, seed: number, mode: Mode, midnight: number): Promise<{ code: number; out: string; err: string }> {
    const script = join(home, `worker-${seed}.mjs`);
    writeFileSync(script, `
const MIDNIGHT = ${midnight};
const Real = Date;
let OFFSET = MIDNIGHT ? MIDNIGHT - 5000 - Real.now() : 0;
if (MIDNIGHT) globalThis.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + OFFSET); } static now() { return Real.now() + OFFSET; } };
const { main } = await import(${JSON.stringify(join(root, "dist", "cli.js"))});
const { readFileSync, existsSync, appendFileSync, writeFileSync } = await import("node:fs");
let s = ${seed} * 2654435761 % 4294967296 || 1;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = ${JSON.stringify(home)};
const MODE = ${JSON.stringify(mode)};
const HOLD = 0.186;
const AMOUNTS = [0, 0.01, 0.05, 0.07, HOLD];
const rawOf = (amt) => amt === null ? null : String(Math.round(amt * 1e6)) + "000000000000";
function outcome(id) {
  let x = 0; for (const ch of id) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  const amt = AMOUNTS[x % 5];
  return { final: ["settled", "settled", "released", "released-unknown"][(x >>> 3) % 4], amt, cost: (x >>> 5) % 2 ? amt : undefined };
}
function read(id) {
  if (existsSync(home + "/presend.txt") && readFileSync(home + "/presend.txt", "utf8").includes(id)) {
    if (MODE !== "revive" || rnd() < 0.5) return { http: 404, error: "not found", receipt: null };
    return { http: 200, error: null, receipt: { request_id: id, correlation_id: "c", state: pick([null, "reserved", "estimated"]), settled_spend: null, settled_spend_raw: null, reserved_spend: HOLD } };
  }
  const k = rnd();
  if (k < 0.15) return { http: 503, error: "HTTP 503", receipt: null };
  if (k < 0.25) return { http: 200, error: null, receipt: { request_id: "other", state: "settled", settled_spend: 0.001 } };
  if (MODE !== "consistent") {
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
    if (k < (MODE === "revive" ? 0.25 : 0.1)) { appendFileSync(home + "/presend.txt", req.requestId + "\\n"); const { PreSendError } = await import(${JSON.stringify(join(root, "dist", "gateway.js"))}); throw new PreSendError("mint failed"); }
    if (k < 0.3 && k >= 0.2) { const { FlopHTTPError } = await import(${JSON.stringify(join(root, "node_modules", "@flop-labs", "client", "dist", "index.js"))}); throw new FlopHTTPError(500, {}, null); }
    if (k < 0.4 && k >= 0.3) { await new Promise((_, rej) => { if (req.signal.aborted) rej(req.signal.reason); else req.signal.addEventListener("abort", () => rej(req.signal.reason), { once: true }); }); }
    let cost;
    if (MODE === "consistent") { const o = outcome(req.requestId); cost = o.final === "settled" ? o.cost : undefined; }
    else { await sleep(rnd() * 25); cost = pick([undefined, ...AMOUNTS, ...(MODE === "revive" ? [0.25, 0.3] : [])]); }
    return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, ...(cost === undefined ? {} : { cost_flop: cost }) } };
  }
  async readReceipt(id) { await sleep(rnd() * 20); return read(id); }
}
const tally = { codes: {}, damaged: 0, damagedByCode: {}, placed: 0, exit1: [], lockLost: 0, exit10: [] };
for (let i = 0; i < ${OPS}; i++) {
  if (MIDNIGHT && i === Math.floor(${OPS} / 2)) OFFSET = MIDNIGHT + 5000 - Real.now();
  const errs = [];
  const io = (p) => ({ out: () => {}, err: (m) => errs.push(m), env: { IMD_FLOP_HOME: home }, provider: p });
  let code;
  const k = rnd();
  if (k < 0.5) {
    const args = ["run", "--seat", "${SEAT}", "--job", "j" + Math.floor(rnd() * 3), "--prompt", "hi", "--provider", "mock", "--max-tokens", "8", "--timeout-ms", "60"];
    if (MODE === "requester") {
      const requester = rnd() < 0.6;
      await main(["config", "set", "payer", requester ? "requester" : "holder"], io(new P()));
      if (requester) args.push("--job-budget", "${BUDGET}");
    }
    code = await main(args, io(new P()));
  } else if (k < 0.9) {
    let ids = [];
    if (existsSync(home + "/ledger.jsonl")) for (const l of readFileSync(home + "/ledger.jsonl", "utf8").split("\\n")) { try { const id = JSON.parse(l).request_id; if (id) ids.push(id); } catch {} }
    if (ids.length === 0) continue;
    code = await main(["receipt", pick(ids), "--refresh", "--seat", "${SEAT}"], io(new P()));
  } else code = await main(["status", "--seat", "${SEAT}", "--json"], io(new P()));
  tally.codes[code] = (tally.codes[code] ?? 0) + 1;
  if (errs.some((m) => m.includes("cannot be read"))) { tally.damaged++; tally.damagedByCode[code] = (tally.damagedByCode[code] ?? 0) + 1; }
  if (errs.some((m) => m.includes("cannot be placed"))) tally.placed++;
  if (errs.some((m) => m.includes("ledger lock lost"))) tally.lockLost++;
  if (code === 10 && tally.exit10.length < 3) tally.exit10.push(errs.join(" | ").slice(0, 200));
  if (code === 1 && tally.exit1.length < 3) tally.exit1.push(errs.join(" | ").slice(0, 200));
}
process.stdout.write(JSON.stringify(tally));
`);
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, IMD_FLOP_HOME: home } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    return new Promise((resolve) => child.on("exit", (c) => resolve({ code: c ?? 1, out, err })));
  }

  /** Replay the ledger line by line and check every rule the review attacks. */
  function check(home: string, mode: Mode) {
    const text = readFileSync(ledgerPath(home), "utf8").split("\n").filter(Boolean);
    const problems: string[] = [];
    const lines = text.map((l, i) => {
      try {
        return JSON.parse(l) as Row;
      } catch {
        problems.push(`line ${i + 1} does not parse after the round`);
        return null;
      }
    }).filter((x): x is Row => x !== null);
    const latest = new Map<string, Row>();
    const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
    const dayTotal = (day: string) => r6([...latest.values()].filter((r) => r.day === day).reduce((t, r) => t + (r.cap_charge as number), 0));
    const jobTotal = (job: string) => r6([...latest.values()].filter((r) => r.job === job && r.payer === "requester").reduce((t, r) => t + (r.cap_charge as number), 0));
    let sent = 0;
    let past = 0;
    let revived = 0;
    let overDays = 0;
    for (const [i, e] of lines.entries()) {
      const prev = e.request_id ? latest.get(e.request_id) : undefined;
      const day = e.day as string;
      const before = dayTotal(day);
      const jobBefore = jobTotal(e.job as string);
      if (e.state === "sent" && !prev) {
        sent += 1;
        if (Math.abs(before - (e.spent_before as number)) > 1e-9) problems.push(`line ${i + 1}: spent_before ${e.spent_before} but replayed total of ${day} is ${before}`);
        if ((e.spent_before as number) + (e.quote_padded as number) > CAP + 1e-9) problems.push(`line ${i + 1}: admitted over the cap`);
        if (e.payer === "requester" && (jobBefore + (e.quote_padded as number) > BUDGET + 1e-9 || Math.abs(jobBefore - (e.job_spent_before as number)) > 1e-9)) problems.push(`line ${i + 1}: requester call admitted against job total ${jobBefore} (recorded ${e.job_spent_before})`);
      }
      const isPast = typeof e.reason === "string" && e.reason.includes(PAST_ADMITTED);
      if (isPast) past += 1;
      if (prev) {
        const settles = (st: string) => st === "settled" || st === "released";
        if (settles(prev.state) && !settles(e.state)) problems.push(`line ${i + 1}: left a settling state`);
        if (settles(prev.state) && typeof prev.spend === "number" && !(typeof e.spend === "number" && e.spend >= prev.spend)) problems.push(`line ${i + 1}: booked settlement lowered`);
        if ((e.cap_charge as number) < (prev.cap_charge as number)) {
          if (!(e.state === "refused_local" && prev.state === "sent" && prev.receipt_seen !== true)) problems.push(`line ${i + 1}: charge lowered from ${prev.cap_charge} to ${e.cap_charge} (${prev.state} -> ${e.state})`);
        }
        if (prev.state === "refused_local" && e.state !== "refused_local") revived += 1;
        if (e.day !== prev.day) problems.push(`line ${i + 1}: the booking moved the request from ${prev.day} to ${e.day}`);
      }
      if (e.state !== "refused_local" && (e.cap_charge as number) < (e.quote_padded as number) - 1e-12) problems.push(`line ${i + 1}: charge below its hold`);
      if (e.request_id) latest.set(e.request_id, e);
      const after = dayTotal(day);
      // Never silent: a line that takes its day above the cap, other than an admission, says so.
      if (after > CAP + 1e-9 && after > before + 1e-12 && !isPast) problems.push(`line ${i + 1}: took ${day} from ${before} to ${after} over the cap ${CAP} without PAST_ADMITTED`);
      if (mode === "requester" && e.payer === "requester") {
        const jobAfter = jobTotal(e.job as string);
        if (jobAfter > BUDGET + 1e-9 && jobAfter > jobBefore + 1e-12 && !isPast) problems.push(`line ${i + 1}: took job ${e.job} to ${jobAfter} over its budget without PAST_ADMITTED`);
      }
    }
    const days = [...new Set([...latest.values()].map((r) => r.day as string))];
    for (const d of days) if (dayTotal(d) > CAP + 1e-9) overDays += 1;
    return { lines: lines.length, sent, past, revived, days: days.length, overDays, problems };
  }

  for (const mode of ["consistent", "erratic", "requester", "revive", "midnight"] as const) {
    it(`${mode}: ${PROCS} processes x ${OPS} operations x ${ROUNDS} rounds: no line breaks a rule; damaged line reports are counted`, async () => {
      const summary: ReturnType<typeof check>[] = [];
      const tally = { codes: {} as Record<string, number>, damaged: 0, damagedByCode: {} as Record<string, number>, placed: 0, exit1: [] as string[], lockLost: 0, exit10: [] as string[] };
      const lockFiles: string[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const h = await ready(String(CAP));
        // midnight: each worker's clock reads 5 s before the next UTC midnight, and 5 s after it from its
        // middle operation on, so the processes cross the day change at different moments.
        const nextMidnight = Math.ceil((Date.now() + 1) / 86_400_000) * 86_400_000;
        const offset = mode === "midnight" ? nextMidnight : 0;
        const results = await Promise.all(Array.from({ length: PROCS }, (_, p) => worker(h, round * 1000 + p + 1 + 7000, mode, offset)));
        for (const r of results) {
          expect(r.code, r.err).toBe(0);
          const t = JSON.parse(r.out) as typeof tally;
          for (const [k, n] of Object.entries(t.codes)) tally.codes[k] = (tally.codes[k] ?? 0) + n;
          for (const [k, n] of Object.entries(t.damagedByCode)) tally.damagedByCode[k] = (tally.damagedByCode[k] ?? 0) + n;
          tally.damaged += t.damaged;
          tally.placed += t.placed;
          tally.lockLost += t.lockLost;
          tally.exit10.push(...t.exit10.slice(0, Math.max(0, 3 - tally.exit10.length)));
          tally.exit1.push(...t.exit1.slice(0, Math.max(0, 6 - tally.exit1.length)));
        }
        const c = check(h, mode);
        summary.push(c);
        expect(c.problems).toEqual([]);
        lockFiles.push(...readdirSync(h).filter((f) => f.startsWith("ledger.jsonl.lock")));
      }
      expect({ damaged: tally.damaged, byCode: tally.damagedByCode }).toEqual({ damaged: 0, byCode: {} });
      // Moved (lock reclaim, audit 33f3b9f finding 1): this counted "ledger lock contested", which only a
      // reclaim that moved a live holder's lock aside could print. Nothing moves the lock now, so that message
      // is gone. In its place: no append ever finds the lock no longer ours ("ledger lock lost", lock.ts), and
      // after every round no lock, right file or temporary file of the lock is left. A lock timeout (exit 10)
      // under load is a busy ledger, not a broken rule: its messages are recorded in the report.
      expect({ lockLost: tally.lockLost, lockFiles }).toEqual({ lockLost: 0, lockFiles: [] });
      if (process.env.STRESS_REPORT) writeFileSync(`${process.env.STRESS_REPORT}.${mode}.json`, JSON.stringify({ mode, procs: PROCS, ops: OPS, rounds: ROUNDS, tally, summary: summary.map(({ problems: _p, ...s }) => s) }));
    }, 3_600_000);
  }
});

describe("8 (words): the exit code table says only status and cap show stop on a row that cannot be placed", () => {
  // README exit 1: "a ledger line that cannot be read or placed when status, cap show, receipt or receipt
  // --refresh reads it (the message names the line)". receipt and receipt --refresh never place a row in a
  // total (they read latestAttempts, which only parses), so a row that cannot be placed leaves them at exit 0
  // and they name nothing. status and cap show do exit 1.
  // Right: the words say that only status and cap show stop on a row that cannot be placed.
  it("the exit code table says that only status and cap show (not receipt or receipt --refresh) stop on a row that cannot be placed", async () => {
    const h = await ready("1");
    const rid = (await cli(h, runArgs("jA"), { provider: new P() })).json().request_id as string;
    appendFileSync(ledgerPath(h), JSON.stringify({ ...ledger(h).at(-1)!, ts: new Date().toISOString(), day: null }) + "\n");
    const receipt = await cli(h, ["receipt", rid, "--json", "--seat", SEAT]);
    const refresh = await cli(h, refreshArgs(rid), { provider: new P() });
    const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
    const capShow = await cli(h, ["cap", "show", "--seat", SEAT]);
    expect([receipt, refresh, st, capShow].map((r) => ({ code: r.code, named: r.err.includes("ledger line 3 cannot be placed") }))).toEqual([
      { code: 0, named: false },
      { code: 0, named: false },
      { code: 1, named: true },
      { code: 1, named: true },
    ]);
    const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    expect(readme).not.toContain("a ledger line that cannot be read or placed when `status`, `cap show`, `receipt` or `receipt --refresh` reads it");
    expect(readme).toContain("a row that cannot be placed in a total when `status` or `cap show` reads it (`receipt` and `receipt --refresh` never place a row)");
  });
});

describe("9 (words): decideBooking's comment says the exact pair is order independent with no exception", () => {
  // settlement.ts decideBooking: "They book the same pair of spend and exact spend in either order too,
  // except for the shapes that test counts." test/decision-properties.test.ts no longer counts any shape: it
  // asserts failed: 0 over 436 x 50 x 50 pairs, and the README and KD-14 say "no counted exception".
  // Right: the comment says the pair is the same in either order, with no exception.
  it("decideBooking's comment says two trusted reads book the same exact pair in either order, with no exception", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "settlement.ts"), "utf8");
    const props = readFileSync(join(import.meta.dirname, "decision-properties.test.ts"), "utf8");
    expect(src).not.toContain("except for the shapes that test counts");
    expect(src).toContain("They book the same pair of spend and exact spend in either order too, with no exception");
    expect(props).toContain("Both\n    // are gone, and any pair that differs now fails here.");
  });
});

describe("10 (low): a limit above AMOUNT_MAX is refused", () => {
  // `cap set`, --per-call and --job-budget took any finite number of at least MIN_CAP, so `cap set 1e16` was
  // a usable cap and every row recorded daily_cap 1e16, which the viewer reads as not an amount.
  // Decided (review fixes 3): a limit is a known amount at or above MIN_CAP. Above AMOUNT_MAX it is refused
  // when it is set (exit 2), and a config that holds one is no usable cap (exit 3).
  it("cap set 1e16, --per-call 1e16 and --job-budget 1e16 are refused with exit 2; a config holding a cap of 1e16 refuses the run with exit 3", async () => {
    const h = await ready("1");
    expect((await cli(h, ["cap", "set", "1e16", "--seat", SEAT])).code).toBe(2);
    expect((await cli(h, ["cap", "set", "1", "--per-call", "1e16", "--seat", SEAT])).code).toBe(2);
    await cli(h, ["config", "set", "payer", "requester"]);
    const p = new P();
    expect((await cli(h, [...runArgs("jB"), "--job-budget", "1e16"], { provider: p })).code).toBe(2);
    await cli(h, ["config", "set", "payer", "holder"]);
    const cfgPath = join(h, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.caps[SEAT] = { daily: 1e16, perCall: 1 };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const r = await cli(h, runArgs("jA"), { provider: p });
    expect({ code: r.code, sent: p.calls }, r.err).toEqual({ code: 3, sent: 0 });
  });
});
