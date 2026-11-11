/**
 * Independent review 2 of the hold floor branch: the third fix pass, 26cac18..5678633. Each DEFECT test asserts
 * the wrong behavior of 5678633, so it passes today and fails once the defect is fixed. The right behavior is
 * in each test's comment. Stub providers only; test/setup.ts disables fetch. The stress block uses real child
 * processes (dist/cli.js, built by `npm test`) on one ledger.
 */
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
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
type Row = Record<string, unknown> & { request_id: string | null; state: string; spend: number | null; cap_charge: number | null; reason?: string | null; day?: string };
const ledgerPath = (home: string) => join(home, "ledger.jsonl");
const ledger = (home: string) => (existsSync(ledgerPath(home)) ? (readLines(ledgerPath(home)) as Row[]) : []);
const status = async (home: string) => (await cli(home, ["status", "--seat", SEAT, "--json"])).json();
const anyPastAdmitted = (home: string) => ledger(home).some((r) => typeof r.reason === "string" && r.reason.includes(PAST_ADMITTED));
const settledAt = (spend: number) => (id: string) => receiptFor(id, { state: "settled", settled_spend: spend });
const preSend = async (): Promise<CompleteRes> => {
  throw new PreSendError("child key mint failed");
};
async function ready(cap = "1") {
  const h = tmpHome();
  await readySeat(h, SEAT, cap);
  return h;
}
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** The day's total as the ledger's latest row per request has it. */
const dayTotal = (home: string, day: string) => r6([...new Map(ledger(home).filter((r) => r.request_id).map((r) => [r.request_id, r])).values()].filter((r) => r.day === day).reduce((t, r) => t + (r.cap_charge as number), 0));

describe("review hold 2: rule 1, PAST_ADMITTED", () => {
  // Rule 1 says a charge that is not a known amount "is repaired and stays outside the rule ... such a row
  // refuses every call, so nothing was admitted against it". Calls were admitted against the request's earlier
  // known charge (its padded quote) before the line that holds the unknown charge was written. The repair
  // books max(padded quote, settled, cost), so a settlement above the hold takes the day over the cap, and
  // nothing says so. At 26cac18 pastAdmitted compared with the padded quote and did print the line here: this
  // is a regression of the third fix pass.
  // Right: a repair that books a charge above what the cap admitted for the request (its padded quote, or the
  // last known charge of the request) prints PAST_ADMITTED and records it in the row's reason.
  it("DEFECT 1: a repair of an unknown charge that books a settlement above the hold should print PAST_ADMITTED (today it takes the day to 0.436 of 0.4 silently)", async () => {
    const h = await ready("0.4");
    const a = await cli(h, runArgs("jA"), { provider: new P() });
    expect(a.code, a.err).toBe(0);
    const rid = a.json().request_id as string;
    // B is admitted against A's known charge 0.186: 0.186 + 0.186 = 0.372 <= 0.4.
    const b = await cli(h, runArgs("jB"), { provider: new P() });
    expect(b.code, b.err).toBe(0);
    // A's latest line is then damaged in its charge (a hand edit, a partial repair).
    const latest = ledger(h).filter((r) => r.request_id === rid).at(-1)!;
    appendFileSync(ledgerPath(h), JSON.stringify({ ...latest, ts: new Date().toISOString(), cap_charge: null }) + "\n");
    const refreshed = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.25) }) });
    expect(refreshed.code, refreshed.err).toBe(0);
    const s = await status(h);
    expect({ total: s.today_utc.mock, over: s.over_cap_today_utc.mock }).toEqual({ total: 0.436, over: true });
    // Wrong today: no line on stderr, no row carries it.
    expect(refreshed.err).not.toContain(PAST_ADMITTED);
    expect(anyPastAdmitted(h)).toBe(false);
  });

  // README "One booking step": when the ledger no longer holds the request's row (the file was moved or
  // removed during the call), the booking step writes run's sent row again. Calls admitted meanwhile were
  // admitted against a ledger without that charge, so writing the seed again raises the day past what the cap
  // admitted: from nothing to the padded quote. pastAdmitted compares the booking with the seed itself, so
  // nothing says so.
  // Right: writing the seed row again is a raise of the request's charge (from no row, 0) and prints
  // PAST_ADMITTED and records it (in the seed's or the booking's reason).
  it("DEFECT 2: the seed row written again after the ledger was moved during the call should print PAST_ADMITTED (today the day ends at 0.372 of 0.3 silently)", async () => {
    const h = await ready("0.3");
    let inner: Awaited<ReturnType<typeof cli>> | null = null;
    const complete = async (req: CompleteReq): Promise<CompleteRes> => {
      renameSync(ledgerPath(h), `${ledgerPath(h)}.moved`);
      inner = await cli(h, runArgs("jB"), { provider: new P() });
      return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    };
    const a = await cli(h, runArgs("jA"), { provider: new P({ complete }) });
    expect(a.code, a.err).toBe(0);
    expect(inner!.code, inner!.err).toBe(0);
    const s = await status(h);
    expect({ total: s.today_utc.mock, over: s.over_cap_today_utc.mock }).toEqual({ total: 0.372, over: true });
    expect(a.err).not.toContain(PAST_ADMITTED);
    expect(anyPastAdmitted(h)).toBe(false);
  });

  // README: "A hold that comes back on an earlier day is shown by its row, whose reason carries the past
  // admitted line, and by the viewer, which flags that row". Both read the request's latest row only. The next
  // booking of that request (a later read that settles, with no raise) writes a new latest row whose reason is
  // recomputed without PAST_ADMITTED. The earlier day stays over its cap, status never marks an earlier day,
  // and the latest row no longer says anything.
  // Right: once a request's booking passed what the cap admitted, every later row of it keeps PAST_ADMITTED in
  // its reason (or the viewer reads the request's history), so the earlier day stays visible.
  it("DEFECT 3: a later booking of a revived request on an earlier day should keep PAST_ADMITTED on its latest row (today the mark is dropped and yesterday's 0.372 of 0.3 is shown nowhere)", async () => {
    const h = await ready("0.3");
    expect((await cli(h, runArgs("jA"), { provider: new P({ complete: preSend }) })).code).toBe(11);
    expect((await cli(h, runArgs("jB"), { provider: new P() })).code).toBe(0);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const moved = readLines(ledgerPath(h)).map((r: Record<string, unknown>) => ({ ...r, day: yesterday }));
    writeFileSync(ledgerPath(h), moved.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const rid = moved[0].request_id as string;
    const revived = await cli(h, refreshArgs(rid), { provider: new P() });
    expect(revived.err).toContain(PAST_ADMITTED);
    expect(ledger(h).at(-1)!.reason).toContain(PAST_ADMITTED);
    // The next read of the same request settles below the hold: no raise, a new latest row.
    const settled = await cli(h, refreshArgs(rid), { provider: new P({ read: settledAt(0.05) }) });
    expect(settled.code, settled.err).toBe(0);
    const latest = ledger(h).filter((r) => r.request_id === rid).at(-1)!;
    expect({ state: latest.state, cap_charge: latest.cap_charge }).toEqual({ state: "settled", cap_charge: 0.186 });
    expect(dayTotal(h, yesterday)).toBe(0.372);
    // Wrong today: the latest row of the request no longer carries the mark, and status shows nothing.
    expect(String(latest.reason ?? "")).not.toContain(PAST_ADMITTED);
    expect((await status(h)).over_cap_today_utc).toEqual({ flop: false, mock: false });
  });
});

describe("review hold 2: rule 2, ledgerLines and the lock", () => {
  // Before the third fix pass a reader that met a damaged line named it without touching the lock, so a home
  // the reader may read but not write (an auditor, a second user, a read only mount) got the line named. Now
  // ledgerLines takes the lock first, which creates ledger.jsonl.lock: EACCES is neither a damaged line nor
  // LedgerLockError, so status prints the raw filesystem error and names no line.
  // Right: a lock that cannot be created is the ledger being busy or unreadable, and the reader still names a
  // line that does not parse (or at least says the ledger is busy, as rule 2 says), never a raw EACCES.
  it("DEFECT 4: status on a home it can read but not write, with a damaged line, should name the line (today it exits 1 with a raw EACCES and names no line)", async () => {
    const h = await ready("1");
    expect((await cli(h, runArgs("jA"), { provider: new P() })).code).toBe(0);
    appendFileSync(ledgerPath(h), "not json\n");
    const writable = await cli(h, ["status", "--seat", SEAT, "--json"]);
    expect({ code: writable.code, named: writable.err.includes("ledger line 3 cannot be read") }).toEqual({ code: 1, named: true });
    chmodSync(h, 0o555);
    try {
      // This test needs the review's run with root's file override dropped (setpriv), so the mode is enforced.
      let enforced = false;
      try {
        closeSync(openSync(join(h, "probe"), "wx"));
        unlinkSync(join(h, "probe"));
      } catch {
        enforced = true;
      }
      expect(enforced, "run this suite with dac_override dropped (setpriv)").toBe(true);
      const ro = await cli(h, ["status", "--seat", SEAT, "--json"]);
      expect(ro.code).toBe(1);
      expect(ro.err).toContain("EACCES");
      expect(ro.err).not.toContain("cannot be read");
      expect(ro.err).not.toContain("ledger lock timeout");
    } finally {
      chmodSync(h, 0o755);
    }
  });

  // A holder that crashed after creating ledger.jsonl.lock and before writing its owner into it leaves an
  // empty lock file. readOwner reads it as no owner, provablyDead says "alive", and the lock is never
  // reclaimed, however old. Every run then exits 10 (nothing sent) forever, and the message is only
  // "ledger lock timeout": it does not name the lock file. Not introduced by the third fix pass (takeLock is
  // unchanged), but rule 2 now sends every reader that meets a line in flight to this lock as well.
  // Right: an old lock with no readable owner is named in the refusal (path and age), or is reclaimed after
  // the open and write window has long passed.
  it("DEFECT 5: an empty lock file left by a holder that crashed should not lock the seat out silently (today every run exits 10 with a message that does not name the lock)", async () => {
    const h = await ready("1");
    const lock = `${ledgerPath(h)}.lock`;
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 600_000);
    utimesSync(lock, old, old);
    const p = new P();
    const r = await cli(h, runArgs("jA"), { provider: p });
    expect({ code: r.code, sent: p.calls }, r.err).toEqual({ code: 10, sent: 0 });
    expect(r.err).toContain("ledger lock timeout");
    expect(r.err).not.toContain(".lock");
    expect(existsSync(lock)).toBe(true);
  }, 30_000);
});

describe("review hold 2: imd-flop against the viewer on the same text", () => {
  // The viewer (build-lane.py read_ledger) opens ledger.jsonl in text mode, so Python's universal newlines
  // split a line at a bare \r. imd-flop splits at \n only. Same text, different lines. The viewer side of each
  // case is viewer/test_review_hold_2.py, on text of the same shape.
  // Right: both parts frame lines the same way (split at \n only; the viewer opens with newline="").
  const row = (i: number, extra: Record<string, unknown> = {}) => ({ ts: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), request_id: `mock-${SEAT}-r${i}`, seat: SEAT, did: "did:key:z", job: `j${i}`, provider: "mock", network: "devnet", payer: "holder", model: "m", max_tokens: 8, prompt_sha256: "0", quote_raw: 0.066, quote_padded: 0.186, per_call_cap: 1, daily_cap: 1, job_budget: null, spent_before: 0, job_spent_before: null, state: "estimated", reason: null, spend: null, cost_reported: null, cap_charge: 0.186, http: 200, mock: true, ...extra });

  it("DEFECT 6: two rows joined by a bare \\r on one line should be one verdict in both parts (today imd-flop names ledger line 1 and refuses, the viewer shows two good rows)", async () => {
    const h = await ready("1");
    writeFileSync(ledgerPath(h), JSON.stringify(row(1)) + "\r" + JSON.stringify(row(2)) + "\n");
    const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
    expect({ code: st.code, named: st.err.includes("ledger line 1 cannot be read") }).toEqual({ code: 1, named: true });
    const p = new P();
    const r = await cli(h, runArgs("jZ"), { provider: p });
    expect({ code: r.code, sent: p.calls }).toEqual({ code: 3, sent: 0 });
  });

  it("DEFECT 6b: a row with a bare \\r between its tokens is one good row to imd-flop, and the damaged line after it is line 2 (the viewer calls it line 3)", async () => {
    const h = await ready("1");
    const text = JSON.stringify(row(1)).replace(',"seat"', ',\r"seat"') + "\n" + "not json\n";
    writeFileSync(ledgerPath(h), text);
    const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
    expect({ code: st.code, named: st.err.includes("ledger line 2 cannot be read") }).toEqual({ code: 1, named: true });
  });

  it("DEFECT 6c: a line holding only \\x1f is damaged to imd-flop, which names ledger line 2 and refuses (the viewer skips it as blank)", async () => {
    const h = await ready("1");
    writeFileSync(ledgerPath(h), JSON.stringify(row(1)) + "\n\x1f\n");
    const p = new P();
    const r = await cli(h, runArgs("jZ"), { provider: p });
    expect({ code: r.code, sent: p.calls, named: r.err.includes("ledger line 2 cannot be read") }, r.err).toEqual({ code: 3, sent: 0, named: true });
  });

  // imd-flop reads ledger.jsonl as UTF-8 with replacement: a row with an invalid byte inside a string parses and
  // counts. build-lane.py raises UnicodeDecodeError out of from_files and builds no lane at all
  // (viewer/test_review_hold_2.py DEFECT 8). Right: both read the row, or the viewer shows one unreadable row.
  it("DEFECT 8: a row with an invalid UTF-8 byte in its model string is read and counted by imd-flop (the viewer aborts its whole rebuild)", async () => {
    const h = await ready("1");
    const bad = Buffer.from(JSON.stringify(row(2, { model: "m-X" })).replace("m-X", "m-\u0000"), "utf8");
    bad[bad.indexOf(0)] = 0xff;
    writeFileSync(ledgerPath(h), Buffer.concat([Buffer.from(JSON.stringify(row(1)) + "\n"), bad, Buffer.from("\n")]));
    const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
    expect(st.code, st.err).toBe(0);
    expect(st.json().today_utc.mock).toBe(0.372);
  });

  // ledger.ts groups rows by isRequestId (1 to 128 printable ASCII, no space); build-lane.py read_ledger groups
  // by present() (any non empty string). For a request id with a space, imd-flop treats every line as its own
  // entry and refuses on the sent line, while the viewer keeps only the latest line, a refusal, and never says
  // a line cannot be placed.
  // Right: the viewer groups by the same request id rule (REQUEST_ID), so each such line is its own entry and
  // the sent line is flagged "ledger row cannot be placed in a total (request_id)".
  it("DEFECT 7: a sent line and then a refusal under the request id \"a b\" refuse the next call naming line 1 (the viewer flags neither: viewer/test_review_hold_2.py)", async () => {
    const h = await ready("1");
    writeFileSync(ledgerPath(h), JSON.stringify(row(1, { request_id: "a b", state: "sent", http: null })) + "\n" + JSON.stringify(row(1, { request_id: "a b", state: "refused_local", cap_charge: 0, reason: "nothing sent" })) + "\n");
    const p = new P();
    const r = await cli(h, runArgs("jZ"), { provider: p });
    expect({ code: r.code, sent: p.calls, named: r.err.includes("ledger line 1 cannot be placed") && r.err.includes('request_id "a b"') }, r.err).toEqual({ code: 3, sent: 0, named: true });
  });
});

/**
 * The review's own stress modes aimed at rule 2, with real child processes on one IMD_FLOP_HOME. Size:
 * STRESS_PROCS processes x STRESS_OPS operations x STRESS_ROUNDS rounds (defaults 6 x 20 x 1 here; the review
 * ran 6 x 60 x 20 by env). STRESS_REPORT, when set, is a path prefix: each mode writes <prefix>.<mode>.json.
 *  - torn: a third of the processes are tearers that take the ledger lock by hand (as withLedgerLock does),
 *    append half of a valid row of another seat, sleep 0 to 30 ms holding the lock, then append the rest and
 *    release. The rest run `run` and `status`. No command may name a line (every line is whole under the lock),
 *    and the day stays within the cap.
 *  - hammer: two thirds of the processes hammer `status` with no pause while the rest book (run and
 *    refresh). Counts the bookers' exits 10 and 1 (lock starvation) and checks no booking is lost: every
 *    request a booker completed has its sent row on the books and nothing breaks the cap.
 * Plus one fixed sequence: a writer killed in the middle of a line while holding the lock.
 */
describe("review hold 2 stress: rule 2 under real concurrent processes", () => {
  const PROCS = Number(process.env.STRESS_PROCS ?? 6);
  const OPS = Number(process.env.STRESS_OPS ?? 20);
  const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 1);
  const CAP = 2;
  const root = join(import.meta.dirname, "..");

  function worker(home: string, seed: number, role: "tearer" | "booker" | "reader"): Promise<{ code: number; out: string; err: string }> {
    const script = join(home, `w-${seed}.mjs`);
    writeFileSync(script, `
const { main } = await import(${JSON.stringify(join(root, "dist", "cli.js"))});
const fs = await import("node:fs");
const { hostname } = await import("node:os");
let s = ${seed} * 2654435761 % 4294967296 || 1;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = ${JSON.stringify(home)};
const LEDGER = home + "/ledger.jsonl";
const ROLE = ${JSON.stringify(role)};
class P { name = "mock"; calls = 0;
  async estimate() { return { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }; }
  async complete(req) { this.calls++; await sleep(rnd() * 10); return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; }
  async readReceipt(id) { await sleep(rnd() * 10); const st = ["reserved", "estimated", "settled", "released"][Math.floor(rnd() * 4)]; return { http: 200, error: null, receipt: { request_id: id, correlation_id: "c", state: st, settled_spend: st === "settled" ? 0.05 : null, reserved_spend: 0.186 } }; } }
const t = { codes: {}, named: 0, busy: 0, completed: [], namedText: [] };
const other = (i) => JSON.stringify({ ts: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), request_id: "mock-9002-" + ${seed} + "-" + i, seat: "9002", did: "did:key:z", job: "t", provider: "mock", network: "devnet", payer: "holder", model: "m", max_tokens: 8, prompt_sha256: "0", quote_raw: 0.066, quote_padded: 0.186, per_call_cap: 1, daily_cap: 1, job_budget: null, spent_before: 0, job_spent_before: null, state: "sent", reason: null, spend: null, cost_reported: null, cap_charge: 0.186, http: null, mock: true }) + "\\n";
for (let i = 0; i < ${OPS}; i++) {
  if (ROLE === "tearer") {
    const lock = LEDGER + ".lock";
    let fd = null; const start = Date.now();
    while (fd === null) { try { fd = fs.openSync(lock, "wx"); } catch { if (Date.now() - start > 5000) break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); } }
    if (fd === null) { t.codes.lockfail = (t.codes.lockfail ?? 0) + 1; continue; }
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token: "tear" + i })); fs.closeSync(fd);
    const line = other(i); const cut = 1 + Math.floor(rnd() * (line.length - 2));
    fs.appendFileSync(LEDGER, line.slice(0, cut));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(rnd() * 30));
    fs.appendFileSync(LEDGER, line.slice(cut));
    fs.unlinkSync(lock);
    await sleep(rnd() * 5);
    continue;
  }
  const errs = [];
  const io = (p) => ({ out: () => {}, err: (m) => errs.push(m), env: { IMD_FLOP_HOME: home }, provider: p });
  let code; let rid = null;
  if (ROLE === "reader") code = await main(["status", "--seat", "${SEAT}", "--json"], io(new P()));
  else if (rnd() < 0.7) {
    const outs = [];
    const p = new P();
    code = await main(["run", "--seat", "${SEAT}", "--job", "j" + Math.floor(rnd() * 3), "--prompt", "hi", "--provider", "mock", "--max-tokens", "8", "--json"], { ...io(p), out: (m) => outs.push(m) });
    if (code === 0) t.completed.push(JSON.parse(outs.join("\\n")).request_id);
    else if (p.calls > 0) t.completed.push("sent-but-" + code);
  } else {
    const ids = [];
    for (const l of fs.readFileSync(LEDGER, "utf8").split("\\n")) { try { const r = JSON.parse(l); if (r.seat === "${SEAT}" && r.request_id) ids.push(r.request_id); } catch {} }
    if (ids.length === 0) continue;
    code = await main(["receipt", ids[Math.floor(rnd() * ids.length)], "--refresh", "--seat", "${SEAT}"], io(new P()));
  }
  t.codes[code] = (t.codes[code] ?? 0) + 1;
  const e = errs.join(" | ");
  if (e.includes("cannot be read")) { t.named++; if (t.namedText.length < 3) t.namedText.push(e.slice(0, 200)); }
  if (e.includes("ledger lock timeout") || e.includes("ledger busy")) t.busy++;
}
process.stdout.write(JSON.stringify(t));
`);
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, IMD_FLOP_HOME: home } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    return new Promise((resolve) => child.on("exit", (c) => resolve({ code: c ?? 1, out, err })));
  }

  function checkLedger(home: string, completed: string[]) {
    const problems: string[] = [];
    const text = readFileSync(ledgerPath(home), "utf8").split("\n").filter(Boolean);
    const rows: Row[] = [];
    text.forEach((l, i) => {
      try {
        rows.push(JSON.parse(l));
      } catch {
        problems.push(`line ${i + 1} does not parse`);
      }
    });
    const latest = new Map<string, Row>();
    for (const r of rows) if (r.request_id && (r as { seat?: string }).seat === SEAT) latest.set(r.request_id, r);
    const total = r6([...latest.values()].reduce((t, r) => t + (r.cap_charge as number), 0));
    if (total > CAP + 1e-9) problems.push(`day ${total} over cap ${CAP}`);
    for (const id of completed) if (!id.startsWith("sent-but-") && !latest.has(id)) problems.push(`completed request ${id} has no row`);
    for (const r of latest.values()) if (r.state !== "refused_local" && (r.cap_charge as number) < 0.186 - 1e-12) problems.push(`${r.request_id} charged below its hold`);
    return { lines: text.length, requests: latest.size, total, problems };
  }

  for (const mode of ["torn", "hammer"] as const) {
    it(`${mode}: ${PROCS} processes x ${OPS} operations x ${ROUNDS} rounds`, async () => {
      const tally = { codes: {} as Record<string, Record<string, number>>, named: 0, busy: {} as Record<string, number>, namedText: [] as string[] };
      const summary: ReturnType<typeof checkLedger>[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const h = await ready(String(CAP));
        writeFileSync(ledgerPath(h), "");
        const roles = Array.from({ length: PROCS }, (_, p) => (mode === "torn" ? (p % 3 === 0 ? "tearer" : p % 3 === 1 ? "booker" : "reader") : p % 3 === 0 ? "booker" : "reader") as "tearer" | "booker" | "reader");
        const results = await Promise.all(roles.map((role, p) => worker(h, round * 100 + p + 1 + 9000, role)));
        const completed: string[] = [];
        results.forEach((r, p) => {
          expect(r.code, r.err).toBe(0);
          const t = JSON.parse(r.out) as { codes: Record<string, number>; named: number; busy: number; completed: string[]; namedText: string[] };
          const role = roles[p];
          tally.codes[role] ??= {};
          for (const [k, n] of Object.entries(t.codes)) tally.codes[role][k] = (tally.codes[role][k] ?? 0) + n;
          tally.named += t.named;
          tally.busy[role] = (tally.busy[role] ?? 0) + t.busy;
          tally.namedText.push(...t.namedText.slice(0, Math.max(0, 3 - tally.namedText.length)));
          completed.push(...t.completed);
        });
        const c = checkLedger(h, completed);
        summary.push(c);
        expect(c.problems).toEqual([]);
      }
      if (process.env.STRESS_REPORT) writeFileSync(`${process.env.STRESS_REPORT}.${mode}.json`, JSON.stringify({ mode, procs: PROCS, ops: OPS, rounds: ROUNDS, tally, summary: summary.map(({ problems: _p, ...s }) => s) }));
      expect({ named: tally.named, text: tally.namedText }).toEqual({ named: 0, text: [] });
    }, 7_200_000);
  }

  // A writer killed while it holds the lock, in the middle of a line: the lock file names a dead pid, and the
  // last line is torn with no newline. While the lock is young every reader says busy and names nothing. Once
  // it is older than 30 s the next command reclaims it and names the torn line. The holder removes that line
  // and the seat runs again.
  it("killed writer: busy while the dead holder's lock is young, then the torn last line is named, and removing it lets the seat run", async () => {
    const h = await ready("1");
    const a = await cli(h, runArgs("jA"), { provider: new P() });
    expect(a.code, a.err).toBe(0);
    const before = readFileSync(ledgerPath(h), "utf8");
    const nLines = before.split("\n").filter(Boolean).length;
    const script = join(h, "dying.mjs");
    const next = JSON.stringify({ ...ledger(h).at(-1)!, ts: new Date().toISOString(), state: "settled", spend: 0.05 });
    writeFileSync(script, `
const fs = await import("node:fs");
const { hostname } = await import("node:os");
const fd = fs.openSync(${JSON.stringify(`${ledgerPath(h)}.lock`)}, "wx");
fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token: "dying" })); fs.closeSync(fd);
fs.appendFileSync(${JSON.stringify(ledgerPath(h))}, ${JSON.stringify(next.slice(0, 120))});
process.stdout.write("torn");
setInterval(() => {}, 1000);
`);
    const child = spawn(process.execPath, [script]);
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const young = await cli(h, ["status", "--seat", SEAT, "--json"]);
    expect({ code: young.code, busy: young.err.includes("ledger lock timeout"), named: young.err.includes("cannot be read") }).toEqual({ code: 1, busy: true, named: false });
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${ledgerPath(h)}.lock`, old, old);
    const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
    expect({ code: st.code, named: st.err.includes(`ledger line ${nLines + 1} cannot be read`) }, st.err).toEqual({ code: 1, named: true });
    const p = new P();
    const refused = await cli(h, runArgs("jB"), { provider: p });
    expect({ code: refused.code, sent: p.calls, named: refused.err.includes(`ledger line ${nLines + 1} cannot be read`) }).toEqual({ code: 3, sent: 0, named: true });
    // The refusal row was appended to the torn line (it had no newline): the holder removes that one line.
    const lines = readFileSync(ledgerPath(h), "utf8").split("\n");
    expect(lines.filter(Boolean).length).toBe(nLines + 1);
    writeFileSync(ledgerPath(h), lines.slice(0, nLines).join("\n") + "\n");
    const p2 = new P();
    const again = await cli(h, runArgs("jB"), { provider: p2 });
    expect({ code: again.code, sent: p2.calls }, again.err).toEqual({ code: 0, sent: 1 });
  }, 60_000);
});
