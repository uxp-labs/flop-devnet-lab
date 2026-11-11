/**
 * Independent review of the hold floor branch (b839bf3..bf9087c, HEAD bf9087c). Each DEFECT test is named
 * for what should happen, and its body asserts what the code does today, which is wrong, so it passes at
 * bf9087c and fails once the defect is fixed. The comment of each block says what goes wrong and what the
 * right behavior is. Stub providers only; test/setup.ts disables fetch.
 * DEFECT 2 uses a real child process (dist/cli.js, built by `npm test`) against one ledger.
 * The stress block at the end is the review's own multi process run: the two gateway modes of
 * review-fixes.test.ts with a worker that tolerates a line in flight, plus two modes of its own.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PreSendError } from "../src/gateway.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { PAST_ADMITTED } from "../src/settlement.js";
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

describe("DEFECT 1 (high): a row an older version booked below its hold is raised back silently", () => {
  // The README and KD-12 say rows an older version booked below their hold are not migrated: they keep their
  // charge, "and a later read only raises it". pastAdmitted (settlement.ts) takes what the cap admitted for a
  // sent row to be its padded quote. For such an older row the cap admitted every later call against the
  // lower booked charge, so a later read that raises it back toward the padded quote puts the day over the
  // cap, and pastAdmitted says nothing: the charge never passes the padded quote. No refusal, no
  // PAST_ADMITTED line, no row carries it. R-f ("the daily cap can be passed only when ...") is false here.
  // Right: what the cap admitted for a row is the lower of its padded quote and its booked charge, so this
  // booking prints PAST_ADMITTED and records it in the row's reason.
  it("DEFECT 1: a refresh that raises a row an older version charged below its hold, taking the day to 0.372 of 0.3, prints PAST_ADMITTED and records it in the row's reason", async () => {
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
    // Wrong today: the booking that took the day over the cap printed nothing and no row says so.
    expect(refreshed.err).not.toContain(PAST_ADMITTED);
    expect(anyPastAdmitted(h)).toBe(false);
  });

  it("DEFECT 1 (job budget): a refresh that takes a requester job over its budget by raising an older row's charge prints PAST_ADMITTED", async () => {
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
    expect(refreshed.err).not.toContain(PAST_ADMITTED);
    expect(anyPastAdmitted(h)).toBe(false);
  });
});

describe("DEFECT 2 (medium): a ledger line another process is still writing is named as damaged", () => {
  // run's early check (run.ts spentEarly), status, cap show and receipt <id> read ledger.jsonl without the
  // ledger lock. A line another process is appending under the lock can be seen half written. ledgerLines
  // then throws UnusableLedgerRow: run refuses with exit 3 and appends a refused_local row, status exits 1,
  // and each tells the holder "ledger line N cannot be read ... Repair or remove that line." The line is
  // good once its writer finishes. A holder (or an agent) that follows the message removes a good row, and
  // when that row is the request's latest booking its charge leaves the day's total.
  // Seen in the wild: the erratic stress mode of review-fixes.test.ts at 6 x 60 x 20 fails on this very
  // thing in its own worker, and the review's stress block below counts the CLI's own false reports.
  // Right: a read outside the lock that meets a damaged last line (no newline at its end) takes the lock and
  // reads again before it names the line; only a line still damaged under the lock is named.
  it("DEFECT 2: a line another process is still writing under the lock is not named as damaged, and the run is not refused for it", async () => {
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
    // Wrong today: the child named the good line as damaged and told the holder to repair or remove it.
    expect({ code: r.code, sent: r.sent }).toEqual({ code: 3, sent: 0 });
    expect(r.err).toContain(`ledger line ${nLines + 1} cannot be read: not valid JSON; next call refused. Repair or remove that line.`);
  }, 20_000);
});

describe("DEFECT 3 (medium): a latest row with no request_id drops its charge from every total", () => {
  // ledger.ts latestLines omits every line whose request_id is falsy, before placed() looks at day, seat or
  // provider, so a line that is valid JSON and carries this seat's day, seat, provider and a charge but no
  // usable request_id is counted nowhere and refuses nothing. imd-flop itself writes request_id null only on
  // refused_local rows with charge 0. The README says "Only the latest row of a request is placed: an older
  // row of the same request is superseded, so damage there loses no charge": when the damage is to the
  // latest row's request_id, the older row (here the released hold, charge 0) becomes the latest, and the
  // revived hold is lost.
  // Right: a line with no usable request_id that is not a refused_local row charged 0 cannot be placed: it
  // refuses the next call (exit 3) and names the line.
  it("DEFECT 3: a latest row that lost its request_id (A revived to 0.186, cap 0.3) cannot be placed: B is refused and the line is named", async () => {
    const h = await ready("0.3");
    const preSend = async (): Promise<CompleteRes> => {
      throw new PreSendError("child key mint failed");
    };
    expect((await cli(h, runArgs("jA"), { provider: new P({ complete: preSend }) })).code).toBe(11);
    const a = ledger(h)[0].request_id!;
    const revived = await cli(h, refreshArgs(a), { provider: new P() });
    expect(revived.code, revived.err).toBe(0);
    expect((await status(h)).today_utc.mock).toBe(0.186);
    // Damage: the latest row of A, valid JSON, loses its request_id.
    const lines = readFileSync(ledgerPath(h), "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines.at(-1)!);
    expect(last.cap_charge).toBe(0.186);
    lines[lines.length - 1] = JSON.stringify({ ...last, request_id: null });
    writeFileSync(ledgerPath(h), lines.join("\n") + "\n");
    // Wrong today: the charge is gone from the total, no line is named, and B is admitted.
    expect((await status(h)).today_utc.mock).toBe(0);
    const b = await cli(h, runArgs("jB"), { provider: new P() });
    expect(b.code, b.err).toBe(0);
    const rows = ledger(h);
    const heldCharges = rows.filter((r) => r.state !== "refused_local").map((r) => r.cap_charge);
    expect(heldCharges).toContain(0.186);
    expect((await status(h)).today_utc.mock).toBe(0.186);
  });

  it("DEFECT 3 (no history): a held call whose lines all lost their request_id refuses the next call", async () => {
    const h = await ready("0.3");
    await cli(h, runArgs("jA"), { provider: new P() });
    const lines = readLines(ledgerPath(h)).map((r: Record<string, unknown>) => ({ ...r, request_id: "" }));
    writeFileSync(ledgerPath(h), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const b = await cli(h, runArgs("jB"), { provider: new P() });
    expect(b.code, b.err).toBe(0);
    expect((await status(h)).today_utc.mock).toBe(0.186);
  });
});

describe("DEFECT 4 (low): a reported cost above AMOUNT_MAX is a known amount to the booking step", () => {
  // Rule 8: an amount above 9007199254740991 is unknown. settlement.ts reportedCost takes any finite number,
  // so a completion that reports cost_flop 1e16 raises the charge to 1e16 and the row records it. The next
  // call then reads that charge through knownAmount, finds it unknown, and refuses: every call of the seat
  // is refused (exit 3, "ledger cap_charge unusable") until the holder edits a line this tool wrote itself.
  // Right: reportedCost applies the amount rule (knownAmount); a cost above AMOUNT_MAX is unknown, raises
  // nothing, and the row stays readable.
  it("DEFECT 4: a reported cost above AMOUNT_MAX (1e16) is unknown: it raises nothing, the row stays readable and the next call is admitted", async () => {
    const h = await ready("1");
    const complete = async (req: CompleteReq): Promise<CompleteRes> => ({ request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: 1e16 } });
    const a = await cli(h, runArgs("jA"), { provider: new P({ complete }) });
    expect(a.code, a.err).toBe(0);
    expect(ledger(h).at(-1)!.cap_charge).toBe(1e16);
    const p = new P();
    const b = await cli(h, runArgs("jB"), { provider: p });
    expect({ code: b.code, sent: p.calls, unusable: b.err.includes("ledger cap_charge unusable") }).toEqual({ code: 3, sent: 0, unusable: true });
    expect((await cli(h, ["status", "--seat", SEAT, "--json"])).code).toBe(1);
  });
});

describe("DEFECT 5 (low, words): status marks only today, so a past day put over its cap is never marked", () => {
  // README: a booking past what the cap admitted prints the line, and "`status` then marks the day OVER CAP"
  // (also R-f). status computes over_cap_today_utc for today only. A released hold of an earlier UTC day that
  // a trusted read brings back puts that day over its cap; status never marks it, in text or in --json.
  // Right: the words say status marks today's total only, or status marks every day over its cap.
  it("DEFECT 5: status marks the past UTC day a revived hold put over its cap, or the README says status marks today only", async () => {
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
  });
});

/**
 * The review's multi process stress: real child processes against one IMD_FLOP_HOME, each running `run`,
 * `receipt --refresh` and `status` (dist/cli.js main with a stub provider). Size: STRESS_PROCS processes x
 * STRESS_OPS operations x STRESS_ROUNDS rounds per mode (defaults 3 x 15 x 1 here; the review ran 6 x 60 x 20
 * by env). STRESS_REPORT, when set, is a path prefix: each mode writes its numbers to <prefix>.<mode>.json.
 * Modes:
 *  - consistent, erratic: the gateways of review-fixes.test.ts, with one change to the worker: it picks a
 *    request id from the ledger lines it can parse, so a line in flight (DEFECT 2) no longer kills it.
 *  - requester: as erratic, and each run is a requester call with a job budget of 0.6 or a holder call, by
 *    each process's own config writes; the job totals are checked beside the daily cap.
 *  - revive: as erratic, and a request that failed before send is later answered by trusted reads (pending
 *    or with no state) so released holds come back, and completions report costs up to 0.3, above the hold.
 *    The check: every line that takes the replayed day above the cap carries PAST_ADMITTED.
 *  - midnight: as erratic, with every process's clock 5 s before the next UTC midnight until its middle
 *    operation and 5 s after it from then on, so the processes cross the day change at different moments. Each day's total is checked on its own, and every sent row against its own day.
 * Every mode counts the CLI's own reports of a damaged ledger line ("cannot be read") and checks afterwards
 * that every ledger line parses, so each such report named a line that was good (DEFECT 2). The test fails
 * only on a broken rule; it does not fail on those reports.
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
const tally = { codes: {}, damaged: 0, damagedByCode: {}, placed: 0, exit1: [] };
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
      const tally = { codes: {} as Record<string, number>, damaged: 0, damagedByCode: {} as Record<string, number>, placed: 0, exit1: [] as string[] };
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
          tally.exit1.push(...t.exit1.slice(0, Math.max(0, 6 - tally.exit1.length)));
        }
        const c = check(h, mode);
        summary.push(c);
        expect(c.problems).toEqual([]);
      }
      if (process.env.STRESS_REPORT) writeFileSync(`${process.env.STRESS_REPORT}.${mode}.json`, JSON.stringify({ mode, procs: PROCS, ops: OPS, rounds: ROUNDS, tally, summary: summary.map(({ problems: _p, ...s }) => s) }));
    }, 3_600_000);
  }
});

describe("DEFECT 8 (low, words): the exit code table says receipt and receipt --refresh exit 1 on a ledger line that cannot be placed", () => {
  // README exit 1: "a ledger line that cannot be read or placed when status, cap show, receipt or receipt
  // --refresh reads it (the message names the line)". receipt and receipt --refresh never place a row in a
  // total (they read latestAttempts, which only parses), so a row that cannot be placed leaves them at exit 0
  // and they name nothing. status and cap show do exit 1.
  // Right: the words say that only status and cap show stop on a row that cannot be placed.
  it("DEFECT 8: the exit code table says that only status and cap show (not receipt or receipt --refresh) stop on a row that cannot be placed", async () => {
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
    expect(readme).toContain("a ledger line that cannot be read or placed when `status`, `cap show`, `receipt` or `receipt --refresh` reads it");
  });
});

describe("DEFECT 9 (low, words): decideBooking's comment still counts exceptions to order independence of the exact pair", () => {
  // settlement.ts decideBooking: "They book the same pair of spend and exact spend in either order too,
  // except for the shapes that test counts." test/decision-properties.test.ts no longer counts any shape: it
  // asserts failed: 0 over 436 x 50 x 50 pairs, and the README and KD-14 say "no counted exception".
  // Right: the comment says the pair is the same in either order, with no exception.
  it("DEFECT 9: decideBooking's comment says two trusted reads book the same exact pair in either order, with no exception", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "settlement.ts"), "utf8");
    const props = readFileSync(join(import.meta.dirname, "decision-properties.test.ts"), "utf8");
    expect(src).toContain("except for the shapes that test counts");
    expect(props).toContain("Both\n    // are gone, and any pair that differs now fails here.");
  });
});

describe("DEFECT 10 (low): a daily cap or job budget above AMOUNT_MAX is a usable limit to imd-flop and an unreadable row to the viewer", () => {
  // Rule 8: an amount above 9007199254740991 is unknown. `cap set` and --job-budget take any finite number of
  // at least MIN_CAP (policy.ts parseAmount, requireCap, validatePayer), so `cap set 1e16` (a holder's
  // "no limit") is a known cap: calls are admitted, and every row records daily_cap 1e16. The viewer reads
  // daily_cap 1e16 as not an amount and shows every such row as a red unreadable row
  // (viewer/test_review_hold.py DEFECT 10). The two parts give different verdicts on every row of the seat.
  // Right: a limit above AMOUNT_MAX is refused when it is set (exit 2), as a limit below MIN_CAP is, and a
  // config that holds one is no usable cap (exit 3), so no row ever records one.
  it("DEFECT 10: a cap of 1e16 is refused when it is set, and a run under a config holding one is refused", async () => {
    const h = await ready("1");
    const set = await cli(h, ["cap", "set", "1e16", "--seat", SEAT]);
    expect(set.code, set.err).toBe(0);
    const r = await cli(h, runArgs("jA"), { provider: new P() });
    expect(r.code, r.err).toBe(0);
    expect(ledger(h).at(-1)!.daily_cap).toBe(1e16);
    await cli(h, ["config", "set", "payer", "requester"]);
    const q = await cli(h, [...runArgs("jB"), "--job-budget", "1e16"], { provider: new P() });
    expect(q.code, q.err).toBe(0);
    expect(ledger(h).at(-1)!.job_budget).toBe(1e16);
  });
});
