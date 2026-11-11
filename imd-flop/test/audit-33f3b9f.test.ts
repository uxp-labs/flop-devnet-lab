/**
 * The second swarm audit, of commit 33f3b9f (IMD job b4e8e103). One describe per finding, named with its
 * number and severity. Each test asserts the safe outcome, so it fails on 33f3b9f and passes with its fix.
 * Findings 1 and 7 and finding 11 item (1) are the ledger lock: they are fixed and tested on their own branch.
 * The viewer's side of the shared rules is viewer/test_audit_33f3b9f.py on the same contract files.
 * Stub providers and library calls only; no network (test/setup.ts disables fetch).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { appendLedger, reportedSpendToday, spentToday, utcDay, type LedgerEntry } from "../src/ledger.js";
import { readLedgerText } from "../src/ledger-text.js";
import { ledgerFile } from "../src/paths.js";
import { appendJsonlSafe } from "../src/store.js";
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
