/**
 * The second swarm audit, of commit 33f3b9f (IMD job b4e8e103). One describe per finding, named with its
 * number and severity. Each test asserts the safe outcome, so it fails on 33f3b9f and passes with its fix.
 * Findings 1 and 7 and finding 11 item (1) are the ledger lock: they are fixed and tested on their own branch.
 * The viewer's side of the shared rules is viewer/test_audit_33f3b9f.py on the same contract files.
 * Stub providers and library calls only; no network (test/setup.ts disables fetch).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { appendLedger, reportedSpendToday, spentToday, utcDay, type LedgerEntry } from "../src/ledger.js";
import { MAX_DEPTH, readLedgerText } from "../src/ledger-text.js";
import { ledgerFile, seatDir } from "../src/paths.js";
import { appendJsonlSafe } from "../src/store.js";
import { isSeatId, UNASSIGNED, validateSeat } from "../src/keys.js";
import { EXIT } from "../src/errors.js";
import { assertPaidNetwork, PreSendError, readSeatOwner, readVerifiedSeatOwner, type Fetch } from "../src/gateway.js";
import { network } from "../src/networks.js";
import { runJob } from "../src/run.js";
import { scanForSecrets } from "../src/secrets.js";
import { decideBooking, type ReadOutcome } from "../src/settlement.js";
import { AMOUNT_MAX, knownAmount } from "../src/amount.js";
import * as rounding from "../src/rounding.js";
import { checkBudget } from "../src/policy.js";
import { cli, readLines, tmpHome } from "./helpers.js";

const CONTRACT = join(import.meta.dirname, "..", "..", "contract");

/** A full ledger row as run writes it: seat 7, provider mock, today, state sent. */
function row(id: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: new Date().toISOString(), day: utcDay(), request_id: id, seat: "7", did: "did:key:z", job: "j1", provider: "mock", network: "devnet",
    payer: "holder", model: "m", max_tokens: 8, prompt_sha256: "0", quote_raw: 0.1, quote_padded: 0.4, per_call_cap: 1, daily_cap: 1,
    job_budget: null, spent_before: 0, job_spent_before: null, state: "sent", reason: null, spend: null, spend_raw: null, cost_reported: null,
    cap_charge: 0.4, http: null, mock: true, ...extra,
  };
}

describe("finding 2 (low): every row starts on a fresh line", () => {
  it("a last line with no final newline gets the next row on its own line, and the total counts both", () => {
    const h = tmpHome();
    appendLedger(h, row("mock-7-a"));
    const path = ledgerFile(h);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n$/, ""));
    expect(spentToday(h, "7", "mock")).toBe(0.4);
    appendLedger(h, row("mock-7-b"));
    const lines = readLedgerText(readFileSync(path, "utf8"));
    expect(lines.map((l) => l.kind)).toEqual(["row", "row"]);
    expect(spentToday(h, "7", "mock")).toBe(0.8);
  });

  it("a torn last line stays named by the readers, and the row appended after it is whole on its own line", () => {
    const h = tmpHome();
    appendLedger(h, row("mock-7-a"));
    const path = ledgerFile(h);
    const torn = JSON.stringify(row("mock-7-b")).slice(0, 40);
    writeFileSync(path, readFileSync(path, "utf8") + torn);
    appendLedger(h, row("mock-7-c"));
    const lines = readLedgerText(readFileSync(path, "utf8"));
    expect(lines.map((l) => l.kind)).toEqual(["row", "unreadable", "row"]);
    const last = lines[2];
    expect(last.kind === "row" && last.row.request_id).toBe("mock-7-c");
    expect(() => spentToday(h, "7", "mock")).toThrow(/ledger line 2 cannot be read: not valid JSON/);
  });

  it("holds for every jsonl file the tool appends, not only the ledger", () => {
    const h = tmpHome();
    const path = join(h, "revocations.jsonl");
    writeFileSync(path, '{"a":1}');
    appendJsonlSafe(path, { b: 2 });
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
    appendJsonlSafe(path, { c: 3 });
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
    const empty = join(h, "empty.jsonl");
    writeFileSync(empty, "");
    appendJsonlSafe(empty, { d: 4 });
    expect(readFileSync(empty, "utf8")).toBe('{"d":4}\n');
  });
});

/** Two instants on either side of 00:00 UTC. */
const D = "2026-11-11";
const D1 = "2026-11-12";
const BEFORE_MIDNIGHT = new Date(`${D}T23:59:59.000Z`);
const AFTER_MIDNIGHT = new Date(`${D1}T00:00:01.000Z`);

/** A mock-named stub whose estimate can move the clock, so a UTC day change lands between the early check and the lock. */
class Stub implements Provider {
  readonly name = "mock" as const;
  calls = 0;
  constructor(private readonly o: { estimate?: Record<string, unknown>; onEstimate?: () => void; complete?: (req: CompleteReq) => Promise<CompleteRes> } = {}) {}
  async estimate() {
    this.o.onEstimate?.();
    return (this.o.estimate ?? { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }) as never;
  }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    if (this.o.complete) return this.o.complete(req);
    return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } as CompleteRes["usage"] };
  }
  async readReceipt(id: string) {
    return { http: 200, error: null, receipt: { request_id: id, correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: null, state: "estimated" } } as never;
  }
}

/** A seat with a cap, ready for `run --no-link` with the mock name. */
async function seat7(cap: string, perCall?: string) {
  const h = tmpHome();
  expect((await cli(h, ["init", "--seat", "7"])).code).toBe(0);
  expect((await cli(h, ["cap", "set", cap, "--seat", "7", ...(perCall ? ["--per-call", perCall] : [])])).code).toBe(0);
  return h;
}
const runArgs = (job = "j1") => ["run", "--seat", "7", "--job", job, "--prompt", "hi", "--provider", "mock", "--max-tokens", "8", "--no-link", "--json"];
const ledgerRows = (h: string) => readLines(ledgerFile(h)) as LedgerEntry[];

/** Run with the clock just before 00:00 UTC, and let the estimate move it just past. */
async function runAcrossMidnight(h: string, provider: (cross: () => void) => Stub) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BEFORE_MIDNIGHT);
  return cli(h, runArgs(), { provider: provider(() => vi.setSystemTime(AFTER_MIDNIGHT)) });
}

describe("finding 12 (info): a refusal row carries the day the locked check used", () => {
  afterEach(() => vi.useRealTimers());

  it("a refusal written inside the lock after the estimate crossed 00:00 UTC is dated the new day", async () => {
    const h = await seat7("1", "0.5");
    // 0.3 pads to 0.845455, over the per-call cap 0.5: refused inside the locked check.
    const r = await runAcrossMidnight(h, (cross) => new Stub({ estimate: { estimated_cost_flop: 0.3, estimated_input_tokens: 3, estimated_output_tokens: 8 }, onEstimate: cross }));
    expect(r.code, r.err).toBe(3);
    expect(r.err).toContain("over the per-call cap 0.5");
    const last = ledgerRows(h).at(-1)!;
    expect({ state: last.state, day: last.day }).toEqual({ state: "refused_local", day: D1 });
  });

  it("control: a refusal before the estimate keeps the day the early check used", async () => {
    const h = await seat7("0.1");
    appendLedger(h, row("mock-7-seed", { day: D, cap_charge: 0.1 }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BEFORE_MIDNIGHT);
    const r = await cli(h, runArgs(), { provider: new Stub() });
    expect(r.code, r.err).toBe(3);
    expect(r.err).toContain("daily cap reached");
    expect(ledgerRows(h).at(-1)!.day).toBe(D);
  });
});

describe("finding 13 (info): an unknown spend is never shown as 0", () => {
  const settled = (id: string, spend: number | null) => row(id, { state: "settled", spend, cap_charge: 0.4, http: 200 });

  it("reportedSpendToday sums the known spends and counts the sent calls whose spend is unknown", () => {
    const h = tmpHome();
    appendLedger(h, settled("mock-7-a", 0.05));
    appendLedger(h, settled("mock-7-b", null));
    expect(reportedSpendToday(h, "7", "mock")).toEqual({ spent: 0.05, unknownRows: 1 });
    const g = tmpHome();
    appendLedger(g, settled("mock-7-a", 0.05));
    appendLedger(g, settled("mock-7-b", 0));
    expect(reportedSpendToday(g, "7", "mock")).toEqual({ spent: 0.05, unknownRows: 0 });
  });

  it("with no known spend and at least one unknown, the total is null, never 0", () => {
    const h = tmpHome();
    appendLedger(h, row("mock-7-a"));
    expect(reportedSpendToday(h, "7", "mock")).toEqual({ spent: null, unknownRows: 1 });
    expect(reportedSpendToday(tmpHome(), "7", "mock")).toEqual({ spent: 0, unknownRows: 0 });
  });

  it("a refused_local row is not an unknown spend: nothing was sent", () => {
    const h = tmpHome();
    appendLedger(h, row("mock-7-a", { state: "refused_local", cap_charge: 0, quote_padded: null }));
    appendLedger(h, row("", { request_id: null, state: "refused_local", cap_charge: 0, reason: "daily cap reached" }));
    expect(reportedSpendToday(h, "7", "mock")).toEqual({ spent: 0, unknownRows: 0 });
  });

  it("status --json adds gateway_spend_unknown_rows per provider, and the text line says the count in words", async () => {
    const h = await seat7("1");
    appendLedger(h, settled("mock-7-a", null));
    const st = await cli(h, ["status", "--seat", "7", "--json"]);
    expect(st.code, st.err).toBe(0);
    expect({ spent: st.json().gateway_spent_today_utc, unknown: st.json().gateway_spend_unknown_rows }).toEqual({ spent: { flop: 0, mock: null }, unknown: { flop: 0, mock: 1 } });
    const text = await cli(h, ["status", "--seat", "7"]);
    const line = text.out.split("\n").find((l) => l.includes("gateway reported spent"))!;
    expect(line).toContain("mock  (1 call with no reported spend)");
    expect(line).not.toMatch(/mock 0\b/);
    appendLedger(h, settled("mock-7-b", 0.05));
    appendLedger(h, settled("mock-7-c", null));
    const two = (await cli(h, ["status", "--seat", "7"])).out.split("\n").find((l) => l.includes("gateway reported spent"))!;
    expect(two).toContain("mock 0.05 (2 calls with no reported spend)");
    expect(two).toContain("flop 0 ");
    expect(two).not.toContain("flop 0 (");
  });
});

describe("finding 4 (medium): one spelling per seat", () => {
  const rules = JSON.parse(readFileSync(join(CONTRACT, "rules.json"), "utf8"));
  const MAX = (2n ** 256n - 1n).toString();
  const OVER = (2n ** 256n).toString();

  it("isSeatId accepts the placeholder and canonical decimal tokenIds up to 2^256 - 1, nothing else", () => {
    for (const ok of [UNASSIGNED, "0", "7", "42", "9001", MAX]) expect(isSeatId(ok), ok).toBe(true);
    for (const bad of ["042", "00", "0042", "", "-1", "+1", "4 2", " 42", "42 ", "1e3", "0x2a", OVER, "9".repeat(79), 42, null]) expect(isSeatId(bad), String(bad)).toBe(false);
  });

  it("rules.json SEAT_ID is the rule keys.ts holds", () => {
    const seat = rules.constants.SEAT_ID.value;
    expect(seat.placeholder).toBe(UNASSIGNED);
    expect(seat.max).toBe(MAX);
    const digits = new RegExp(seat.digits);
    for (const v of ["0", "42", "042", "00", MAX, OVER]) expect(isSeatId(v), v).toBe(digits.test(v) && BigInt(v) <= BigInt(seat.max));
  });

  it("validateSeat refuses a non canonical seat with exit 2, and shows the canonical spelling for leading zeros", () => {
    const err = (v: string) => { try { validateSeat(v); return null; } catch (e) { return e as Error & { code: number }; } };
    expect(err("042")?.code).toBe(EXIT.USAGE);
    expect(err("042")?.message).toContain("write 42, not 042");
    expect(err("00")?.message).toContain("write 0, not 00");
    expect(err(OVER)?.code).toBe(EXIT.USAGE);
    expect(err(OVER)?.message).not.toContain("write");
    expect(err("0" + OVER)?.message).not.toContain("write");
    expect(err("42")).toBeNull();
  });

  it("init --seat 042 after init --seat 42 is a usage error and makes no second key", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "42"])).code).toBe(0);
    const second = await cli(h, ["init", "--seat", "042"]);
    expect({ code: second.code, hint: second.err.includes("write 42, not 042") }).toEqual({ code: EXIT.USAGE, hint: true });
    expect(existsSync(seatDir(h, "042"))).toBe(false);
    expect((await cli(h, ["cap", "set", "0.2", "--seat", "042"])).code).toBe(EXIT.USAGE);
    expect((await cli(h, ["run", "--seat", "042", "--job", "j1", "--prompt", "hi", "--no-link", "--json"], { provider: new Stub() })).code).toBe(EXIT.USAGE);
  });

  it("the audit's reproduction: a seat has one cap and one daily total, and a row spelled with a leading zero refuses the next call", async () => {
    const h = await seat7("0.2");
    const args = (job: string) => ["run", "--seat", "7", "--job", job, "--prompt", "hi", "--max-tokens", "8", "--no-link", "--json"];
    expect((await cli(h, args("j1"), { provider: new Stub() })).code).toBe(0);
    const p = new Stub();
    const again = await cli(h, args("j2"), { provider: p });
    expect({ code: again.code, sent: p.calls }).toEqual({ code: 3, sent: 0 });
    // A row an edit or an older version wrote with seat 07: it cannot be placed, so the call is refused and the line named.
    appendLedger(h, row("mock-07-x", { seat: "07", cap_charge: 0.186 }));
    const n = ledgerRows(h).length;
    const q = new Stub();
    const r = await cli(h, args("j3"), { provider: q });
    expect({ code: r.code, sent: q.calls, line: r.err.includes(`ledger line ${n} cannot be placed`) }, r.err).toEqual({ code: 3, sent: 0, line: true });
  });
});

describe("finding 8 (low): a nesting limit in the ledger text contract", () => {
  const rules = JSON.parse(readFileSync(join(CONTRACT, "rules.json"), "utf8"));
  const deep = (levels: number) => `{"request_id":"r1","cap_charge":1,"x":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}\n`;

  it("the audit's line (9998 levels) is unreadable, nested too deep, not a row", () => {
    expect(readLedgerText(deep(9998))).toEqual([{ n: 1, kind: "unreadable", why: "nested too deep" }]);
  });

  it("32 levels is a row and 33 is not, and the limit is rules.json LEDGER_TEXT.max_depth", () => {
    expect(rules.constants.LEDGER_TEXT.value.max_depth).toBe(MAX_DEPTH);
    expect(readLedgerText(deep(32))[0].kind).toBe("row");
    expect(readLedgerText(deep(33))[0]).toEqual({ n: 1, kind: "unreadable", why: "nested too deep" });
  });

  it("depth is counted on the text: invalid JSON over the limit is nested too deep, and brackets in strings do not count", () => {
    expect(readLedgerText("[".repeat(33) + "\n")[0]).toEqual({ n: 1, kind: "unreadable", why: "nested too deep" });
    expect(readLedgerText("[".repeat(32) + "\n")[0]).toEqual({ n: 1, kind: "unreadable", why: "not valid JSON" });
    expect(readLedgerText(`{"a":"${"[".repeat(100)}\\"${"{".repeat(100)}"}\n`)[0].kind).toBe("row");
  });

  it("a ledger line nested too deep refuses the next call and names the line", async () => {
    const h = await seat7("1");
    writeFileSync(ledgerFile(h), deep(40));
    const p = new Stub();
    const r = await cli(h, runArgs(), { provider: p });
    expect({ code: r.code, sent: p.calls, named: r.err.includes("ledger line 1 cannot be read: nested too deep") }, r.err).toEqual({ code: 3, sent: 0, named: true });
  });
});

describe("finding 3 (low): Ethereum RPC server text never carries the RPC URL", () => {
  const URL_GIVEN = "https://User:p4ss-W0rd-1234@ETH.Example.invalid:443/v2/k3y-AbCdEf0123456789-path-token?apikey=Q9q9Q9q9";
  const parsed = new URL(URL_GIVEN);
  const PIECES = [URL_GIVEN, parsed.href, parsed.origin + parsed.pathname, "User:p4ss-W0rd-1234", parsed.pathname, "k3y-AbCdEf0123456789-path-token", "p4ss-W0rd-1234"];
  const leaks = (m: string) => PIECES.filter((p) => m.includes(p));
  const message = async (p: Promise<unknown>) => { try { await p; return "(no error)"; } catch (e) { return (e as Error).message; } };
  /** A JSON-RPC server that answers eth_chainId with an error message built from what it was asked. */
  const erroring = (echo: (input: string) => string): Fetch => async (input) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: echo(String(input)) } }), { status: 200 });

  it("the audit's reproduction: the eth_chainId error text has the URL replaced by the mark", async () => {
    const url = "https://eth.example.invalid/v2/k3y-AbCdEf0123456789-path-token";
    const m = await message(assertPaidNetwork(network("devnet"), url, erroring((input) => `unauthorized for ${input}`)));
    expect(m).toBe("eth_chainId error: unauthorized for [ETH_RPC_URL]");
    expect(m).not.toContain("k3y");
    expect(m).not.toContain("eth.example.invalid");
  });

  it("every form the URL can be echoed in is replaced: as given, href, origin with path, userinfo, path alone", async () => {
    const forms = [URL_GIVEN, parsed.href, parsed.origin + parsed.pathname, `${parsed.username}:${parsed.password}`, parsed.pathname];
    for (const form of forms) {
      const m = await message(readVerifiedSeatOwner(URL_GIVEN, "0x" + "1".repeat(40), "1", erroring(() => `bad key at ${form} (retry later)`)));
      expect(m, form).toContain("[ETH_RPC_URL]");
      expect(leaks(m), form).toEqual([]);
      expect(scanForSecrets({ reason: m })).toEqual([]);
    }
  });

  it("server text is cut to a bounded length", async () => {
    const m = await message(readVerifiedSeatOwner(URL_GIVEN, "0x" + "1".repeat(40), "1", erroring(() => "x".repeat(100_000))));
    expect(m.length).toBeLessThan(400);
    expect(m.startsWith("eth_chainId error: xxx")).toBe(true);
  });

  it("an eth_call answer that is not JSON never quotes the body", async () => {
    const f: Fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "eth_chainId") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 });
      return new Response(`unauthorized for ${URL_GIVEN}`, { status: 200 });
    };
    const m = await message(readSeatOwner(URL_GIVEN, "0x" + "1".repeat(40), "1", f));
    expect(m).toBe("eth_call returned malformed JSON");
    expect(leaks(m)).toEqual([]);
  });
});

describe("finding 10 (low): stderr shows the same pre-send reason the ledger row gets", () => {
  it("a 0x 64 hex value in a mint failure is stripped on stderr as in the ledger row", async () => {
    const h = await seat7("1");
    const stub = new Stub({ complete: async () => { throw new PreSendError("child key mint failed (TypeError: 0x" + "ab".repeat(32) + ")"); } });
    let err: (Error & { code?: number }) | null = null;
    try { await runJob(h, stub, { job: "j1", prompt: "hi", maxTokens: 8, seat: "7", noLink: true, timeoutMs: 5000 }, { warn() {} }); } catch (e) { err = e as Error & { code?: number }; }
    const last = ledgerRows(h).at(-1)!;
    expect({ state: last.state, reason: last.reason }).toEqual({ state: "refused_local", reason: "nothing sent: child key mint failed (TypeError: [hash])" });
    expect({ code: err?.code, message: err?.message }).toEqual({ code: EXIT.NOT_SENT, message: last.reason });
    expect(err?.message).not.toContain("abab");
  });

  it("a key shaped message is withheld on stderr and in the ledger row alike", async () => {
    const h = await seat7("1");
    const stub = new Stub({ complete: async () => { throw new PreSendError("rpc error: Bearer SYNTHETICNOTAKEY0123456789"); } });
    const r = await cli(h, runArgs(), { provider: stub });
    const last = ledgerRows(h).at(-1)!;
    expect({ code: r.code, reason: last.reason }).toEqual({ code: EXIT.NOT_SENT, reason: "nothing sent: provider error withheld by the secret scan" });
    expect(r.err).toContain(last.reason!);
    expect(r.err).not.toContain("SYNTHETIC");
  });

  it("an outside message is cut to a bounded length on both sinks", async () => {
    const h = await seat7("1");
    const stub = new Stub({ complete: async () => { throw new PreSendError("child key mint failed (" + "y".repeat(50_000) + ")"); } });
    const r = await cli(h, runArgs(), { provider: stub });
    const last = ledgerRows(h).at(-1)!;
    expect(r.code).toBe(EXIT.NOT_SENT);
    expect(last.reason!.length).toBeLessThan(1100);
    expect(r.err).toContain(last.reason!);
  });
});

describe("finding 6 (low): a row that cannot be placed is named by line and field, never by its raw value", () => {
  const damaged = (day: unknown) => JSON.stringify({ request_id: "mock-7-00112233aabbccdd", seat: "7", provider: "mock", day, state: "sent", cap_charge: 0.1, payer: "holder", job: "j1", quote_padded: 0.1 }) + "\n";

  it("the audit's reproduction: a key shaped day refuses with exit 3, names the line, and the refusal row is written", async () => {
    const h = await seat7("1", "0.5");
    writeFileSync(ledgerFile(h), damaged("a".repeat(64)));
    const p = new Stub();
    const r = await cli(h, runArgs(), { provider: p });
    expect({ code: r.code, sent: p.calls }, r.err).toEqual({ code: 3, sent: 0 });
    expect(r.err).toContain("ledger line 1 cannot be placed in the daily total");
    expect(r.err).toContain("day a string of 64 characters is not a usable value");
    expect(r.err).not.toContain("a".repeat(64));
    const last = ledgerRows(h).at(-1)!;
    expect({ state: last.state, named: last.reason?.includes("ledger line 1") }).toEqual({ state: "refused_local", named: true });
  });

  it("a short string the scan passes is quoted; anything else is described by type and length", async () => {
    const cases: Array<[unknown, string]> = [
      ["zz", 'day "zz"'],
      ["z".repeat(32), `day "${"z".repeat(32)}"`],
      ["z".repeat(33), "day a string of 33 characters"],
      ["Bearer abcdefgh1234", "day a string of 19 characters"],
      [5, "day a number"],
      [true, "day a boolean"],
      [null, "day null"],
      [["a", "b"], "day an array of 2 items"],
      [{ k: "v" }, "day an object of 1 key"],
    ];
    for (const [day, want] of cases) {
      const h = await seat7("1");
      writeFileSync(ledgerFile(h), damaged(day));
      const r = await cli(h, runArgs(), { provider: new Stub() });
      expect({ code: r.code, has: r.err.includes(`${want} is not a usable value`) }, `${JSON.stringify(day)}: ${r.err}`).toEqual({ code: 3, has: true });
    }
  });

  it("status names the line and the field the same way", async () => {
    const h = await seat7("1");
    writeFileSync(ledgerFile(h), damaged("f".repeat(70)));
    const st = await cli(h, ["status", "--seat", "7"]);
    expect({ code: st.code, named: st.err.includes("ledger line 1 cannot be placed") && st.err.includes("day a string of 70 characters") }, st.err).toEqual({ code: 1, named: true });
  });
});

describe("finding 11 (low): tests that kill three wrong rules", () => {
  describe("item 2: the cap check and the sent row use the UTC day read inside the lock", () => {
    afterEach(() => vi.useRealTimers());

    it("a call admitted after the estimate crossed 00:00 UTC books its sent row on the new day", async () => {
      const h = await seat7("1");
      const r = await runAcrossMidnight(h, (cross) => new Stub({ onEstimate: cross }));
      expect(r.code, r.err).toBe(0);
      const sent = ledgerRows(h).find((x) => x.state === "sent")!;
      expect({ day: sent.day, spent_before: sent.spent_before }).toEqual({ day: D1, spent_before: 0 });
    });

    it("the locked cap check counts the new day: a day that is full after midnight refuses, though the day before was empty", async () => {
      const h = await seat7("1");
      appendLedger(h, row("mock-7-seed", { day: D1, cap_charge: 0.9, state: "settled", spend: 0.9 }));
      const p = new Stub();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(BEFORE_MIDNIGHT);
      const r = await cli(h, runArgs(), { provider: new Stub({ onEstimate: () => vi.setSystemTime(AFTER_MIDNIGHT), complete: async (req) => { p.calls += 1; return { request_id: req.requestId, text: "ok", usage: null } as never; } }) });
      expect({ code: r.code, sent: p.calls }, r.err).toEqual({ code: 3, sent: 0 });
      expect(r.err).toContain("over the remaining daily cap 0.1");
      const last = ledgerRows(h).at(-1)!;
      expect({ state: last.state, day: last.day, spent_before: last.spent_before }).toEqual({ state: "refused_local", day: D1, spent_before: 0.9 });
    });
  });

  describe("item 3: a booking one 1e-6 step above what the cap admitted carries PAST_ADMITTED", () => {
    // This file's own reading of the rule (README "The hold floor"): what the cap admitted for a request is its
    // known booked charge, or its padded quote when that charge is not a known amount. A booking above it, by
    // any amount, passes what the cap admitted. The amounts sit one step either side of the admitted charge.
    const STEP = 1e-6;
    const HOLD = 0.186;
    const near = (a: number) => [a - STEP, a, a + STEP].map((x) => Math.round(x * 1e6) / 1e6);
    const TRUSTED = { fresh: true, identityOk: true, redacted: false };
    const rows = [
      ...["sent", "estimated", "reserved"].map((state) => ({ state, spend: null, cap_charge: HOLD, quote_padded: HOLD })),
      ...["settled", "released"].map((state) => ({ state, spend: 0.05, cap_charge: HOLD, quote_padded: HOLD })),
      { state: "settled", spend: 0.05, cap_charge: HOLD - STEP, quote_padded: HOLD },
      { state: "estimated", spend: null, cap_charge: null, quote_padded: HOLD },
    ];
    const admittedOf = (r: { cap_charge: number | null; quote_padded: number }) => r.cap_charge ?? r.quote_padded;

    it("over every row, read and reported cost near the admitted charge, pastAdmitted is exactly 'the charge is above it'", () => {
      const failures: string[] = [];
      let walked = 0;
      let passed = 0;
      for (const prev of rows) {
        const a = admittedOf(prev);
        for (const settled of [null, ...near(a)]) {
          for (const state of ["settled", "released", "estimated"]) {
            for (const cost of [null, ...near(a)]) {
              walked += 1;
              const read: ReadOutcome = { ...TRUSTED, state, settled };
              const d = decideBooking(prev, read, cost);
              const charge = d.booking.cap_charge as number;
              const want = !d.disagree && charge > a;
              if (want) passed += 1;
              if (d.pastAdmitted !== want) failures.push(JSON.stringify({ prev, read, cost, d }));
            }
          }
        }
      }
      expect({ walked, failures: failures.slice(0, 3), failed: failures.length, passed }).toEqual({ walked: 7 * 4 * 3 * 4, failures: [], failed: 0, passed: 120 });
    });

    it("the audit's case: a settled spend one step above the hold is booked with PAST_ADMITTED", () => {
      const d = decideBooking({ state: "estimated", spend: null, cap_charge: HOLD, quote_padded: HOLD }, { ...TRUSTED, state: "settled", settled: 0.186001 }, null);
      expect({ charge: d.booking.cap_charge, past: d.pastAdmitted }).toEqual({ charge: 0.186001, past: true });
      const c = decideBooking({ state: "estimated", spend: null, cap_charge: HOLD, quote_padded: HOLD }, { ...TRUSTED, state: "estimated", settled: null }, 0.186001);
      expect({ charge: c.booking.cap_charge, past: c.pastAdmitted }).toEqual({ charge: 0.186001, past: true });
    });
  });

  describe("item 4: exact amounts are compared as numbers, never as text", () => {
    const TRUSTED = { fresh: true, identityOk: true, redacted: false };
    const prev = (spend_raw: string) => ({ state: "settled", spend: 0.05, cap_charge: 0.186, quote_padded: 0.186, spend_raw });
    const read = (settledRaw: string) => ({ ...TRUSTED, state: "settled", settled: 0.05, settledRaw });

    it("booked 9, read 10: 10 is booked", () => {
      expect(decideBooking(prev("9"), read("10"), null).booking.spend_raw).toBe("10");
    });

    it("booked 10, read 9: 10 stays", () => {
      expect(decideBooking(prev("10"), read("9"), null).booking.spend_raw).toBe("10");
    });
  });
});

/** A small deterministic PRNG (mulberry32), so a property test walks the same numbers on every run. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("finding 5 (low): exact sums under an AMOUNT_MAX the 6 decimal grid survives", () => {
  const rules = JSON.parse(readFileSync(join(CONTRACT, "rules.json"), "utf8"));
  const micro = rounding as unknown as { ceilMicro?: (n: number) => number; floorMicro?: (n: number) => number };

  it("AMOUNT_MAX is 1e9 FLOP, here and in rules.json; an amount above it is not a known amount", () => {
    expect(AMOUNT_MAX).toBe(1_000_000_000);
    expect(rules.constants.AMOUNT_MAX.value).toBe(AMOUNT_MAX);
    expect(knownAmount(1e9)).toBe(1e9);
    expect(knownAmount(1000000000.000001)).toBeNull();
    expect(knownAmount(17179869184)).toBeNull();
  });

  it("property: for random integers k up to 1e15, the double nearest k / 1e6 scales back to k by rounding to nearest", () => {
    const rand = prng(33);
    const ks = [0, 1, 999_999, 1_000_000, 1e15 - 1, 1e15];
    for (let i = 0; i < 200_000; i++) ks.push(Math.floor(rand() * 2 ** 21) * 2 ** 29 + Math.floor(rand() * 2 ** 29));
    const bad = ks.filter((k) => k <= 1e15 && Math.round((k / 1e6) * 1e6) !== k);
    expect({ walked: ks.filter((k) => k <= 1e15).length > 100_000, bad: bad.slice(0, 3) }).toEqual({ walked: true, bad: [] });
  });

  it("rounding.ts exposes the integer numerators, and ceil6 and floor6 are them over 1e6", () => {
    expect(typeof micro.ceilMicro).toBe("function");
    expect(micro.ceilMicro!(0.186)).toBe(186000);
    expect(micro.floorMicro!(0.1859999)).toBe(185999);
    expect(micro.ceilMicro!(1e9)).toBe(1e15);
    const rand = prng(5);
    for (let i = 0; i < 10_000; i++) {
      const n = rand() * 1e9;
      expect(rounding.ceil6(n)).toBe(micro.ceilMicro!(n) / 1e6);
      expect(rounding.floor6(n)).toBe(micro.floorMicro!(n) / 1e6);
    }
  });

  it("cap set above 1e9 is refused with exit 2; 1e9 itself is a cap", async () => {
    const h = await seat7("1");
    expect((await cli(h, ["cap", "set", "1000000000.000001", "--seat", "7"])).code).toBe(EXIT.USAGE);
    expect((await cli(h, ["cap", "set", "17179869184.00001", "--seat", "7"])).code).toBe(EXIT.USAGE);
    expect((await cli(h, ["cap", "set", "1000000000", "--seat", "7", "--per-call", "1"])).code).toBe(0);
  });

  it("a row with a charge above 1e9 is an unusable charge: run refuses and names the line", async () => {
    const h = await seat7("1");
    appendLedger(h, row("mock-7-big", { cap_charge: 17179869184 }));
    const p = new Stub();
    const r = await cli(h, runArgs(), { provider: p });
    expect({ code: r.code, sent: p.calls, named: r.err.includes("cap_charge unusable") && r.err.includes("ledger line 1") }, r.err).toEqual({ code: 3, sent: 0, named: true });
  });

  it("the day's total is the exact sum of the charges: 4096.1 and ten charges of 0.000001 is 4096.10001", () => {
    const h = tmpHome();
    appendLedger(h, row("mock-7-seed", { cap_charge: 4096.1 }));
    for (let i = 0; i < 10; i++) appendLedger(h, row(`mock-7-c${i}`, { cap_charge: 0.000001 }));
    expect(spentToday(h, "7", "mock")).toBe(4096.10001);
  });

  it("at the largest size: a total near 1e9, a cap ten steps above it, admits exactly ten charges of 0.000001 and refuses the eleventh", () => {
    const h = tmpHome();
    appendLedger(h, row("mock-7-seed", { cap_charge: 999999999 }));
    const cap = { daily: 999999999.00001, perCall: 1 };
    let admitted = 0;
    for (let i = 0; i < 50; i++) {
      const spentBefore = spentToday(h, "7", "mock");
      if (checkBudget({ padded: 0.000001, cap, payer: "holder", spentBefore }) !== null) break;
      admitted += 1;
      appendLedger(h, row(`mock-7-c${i}`, { cap_charge: 0.000001 }));
    }
    expect({ admitted, total: spentToday(h, "7", "mock") }).toEqual({ admitted: 10, total: 999999999.00001 });
  });

  it("a total above AMOUNT_MAX is not a known amount: run refuses with exit 3 and nothing sent, and status says the same", async () => {
    const h = await seat7("1");
    appendLedger(h, row("mock-7-a", { cap_charge: 600000000 }));
    appendLedger(h, row("mock-7-b", { cap_charge: 600000000 }));
    const p = new Stub();
    const r = await cli(h, runArgs(), { provider: p });
    expect({ code: r.code, sent: p.calls }, r.err).toEqual({ code: 3, sent: 0 });
    expect(r.err).toContain("is above 1000000000 FLOP, the largest amount this tool compares");
    const st = await cli(h, ["status", "--seat", "7"]);
    expect({ code: st.code, says: st.err.includes("the largest amount this tool compares") }).toEqual({ code: 1, says: true });
    const cs = await cli(h, ["cap", "show", "--seat", "7"]);
    expect({ code: cs.code, says: cs.err.includes("the largest amount this tool compares") }).toEqual({ code: 1, says: true });
  });
});

describe("finding 9 (low): the viewer decides the daily cap with imd-flop's expression", () => {
  it("the audit's triple is admitted with room 4027.974074 (contract/vectors/cap-compare.json pins the viewer's side)", () => {
    expect(checkBudget({ padded: 4027.974074, cap: { daily: 8197.132493, perCall: 8197.132493 }, payer: "holder", spentBefore: 4169.158419 })).toBeNull();
  });
});
