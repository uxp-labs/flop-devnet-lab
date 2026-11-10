/**
 * Fail-first probes for the v3 ledger, secret, refresh, timeout, and lock gaps.
 * Safe outcomes are asserted, so the current tree fails where the gap is real.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { utcDay } from "../src/ledger.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { cli, cliP, readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9001";
const HEX = "cd".repeat(64);
const quote = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 };

class V3Provider implements Provider {
  readonly name = "mock" as const;
  calls = 0;
  constructor(private readonly opts: {
    usage?: CompleteRes["usage"] | "missing";
    text?: string;
    error?: string | null;
    settledRaw?: string | null;
    state?: "estimated" | "settled" | "released";
    settled?: number | null;
    requestId?: string | "same";
  } = {}) {}
  estimate() {
    return Promise.resolve(quote);
  }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    const text = this.opts.text ?? "BENIGN-CONTROL-output";
    if (this.opts.usage === "missing") return { request_id: req.requestId, text } as CompleteRes;
    return { request_id: req.requestId, text, usage: this.opts.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  }
  readReceipt(requestId: string) {
    const id = this.opts.requestId === "same" || this.opts.requestId === undefined ? requestId : this.opts.requestId;
    return Promise.resolve({
      http: 200,
      error: this.opts.error ?? null,
      receipt: {
        request_id: id,
        correlation_id: "imd-job-v3",
        model: "audit",
        reserved_spend: 0.186,
        settled_spend: this.opts.settled === undefined ? null : this.opts.settled,
        settled_spend_raw: this.opts.settledRaw === undefined ? null : this.opts.settledRaw,
        terminal_event: null,
        channel_id: null,
        created_at: 0,
        state: this.opts.state ?? "estimated",
        response_status: 200,
      },
    });
  }
}

function runArgs(job: string, extra: string[] = []): string[] {
  return ["run", "--seat", SEAT, "--job", job, "--prompt", "Say hi", "--max-tokens", "8", "--provider", "mock", "--json", ...extra];
}

function seedCharge(home: string, cap: unknown) {
  const row: Record<string, unknown> = {
    ts: new Date().toISOString(),
    day: utcDay(),
    request_id: "seed-bad",
    seat: SEAT,
    did: "did:key:zseed",
    job: "seed",
    provider: "mock",
    network: "devnet",
    payer: "holder",
    model: "m",
    max_tokens: 8,
    prompt_sha256: "ab".repeat(32),
    quote_raw: 0.066,
    quote_padded: 0.186,
    per_call_cap: 5,
    daily_cap: 5,
    job_budget: null,
    spent_before: 0,
    state: "sent",
    reason: null,
    spend: null,
    cost_reported: null,
    http: null,
    mock: true,
  };
  if (cap !== "missing") row.cap_charge = cap;
  writeFileSync(join(home, "ledger.jsonl"), JSON.stringify(row) + "\n");
}

describe("v3 unusable cap_charge fails closed", () => {
  for (const cap of [null, "missing", "nope", -1, Number.NaN] as const) {
    it(`refuses the next call when a ledger cap_charge is ${String(cap)}`, async () => {
      const home = tmpHome();
      await readySeat(home, SEAT, "5");
      if (cap === Number.NaN) {
        const { usableCapCharge } = await import("../src/ledger.js");
        expect(usableCapCharge(Number.NaN)).toBe(false);
        expect(usableCapCharge(Number.POSITIVE_INFINITY)).toBe(false);
        return;
      }
      seedCharge(home, cap);
      const provider = new V3Provider();
      const run = await cliP(home, runArgs("after-bad-charge"), provider);
      expect(run.code, run.err).toBe(3);
      expect(run.err).toMatch(/ledger cap_charge unusable; next call refused/);
      expect(provider.calls).toBe(0);
    });
  }

  it("still allows a call when every cap_charge is a finite nonnegative number", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    seedCharge(home, 0.01);
    const provider = new V3Provider();
    const run = await cliP(home, runArgs("after-good-charge"), provider);
    expect(run.code, run.err).toBe(0);
    expect(provider.calls).toBe(1);
  });
});

describe("v3 secret fallback keeps the receipt and ledger", () => {
  it("redacts a hex hit in usage and still writes the receipt and reservation", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new V3Provider({
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, note: HEX } as CompleteRes["usage"],
    });
    const run = await cliP(home, runArgs("usage-hex"), provider);
    expect(run.code, run.err).toBe(0);
    expect(run.out.includes(HEX)).toBe(false);
    const printed = run.json() as { text: string | null; response_file: string; request_id: string; cap_charge: number };
    const response = readFileSync(printed.response_file, "utf8");
    const receipt = readFileSync(join(home, "receipts", `${printed.request_id}.json`), "utf8");
    expect(response.includes(HEX)).toBe(false);
    expect(receipt.includes(HEX)).toBe(false);
    const rows = readLines(join(home, "ledger.jsonl")) as { request_id: string | null; cap_charge: number | null; spend: number | null; state: string }[];
    const latest = rows.filter((row) => row.request_id === printed.request_id).at(-1);
    expect(latest?.state).not.toBe("sent");
    expect(latest?.spend).toBeNull();
    expect(latest?.cap_charge).toBe(0.186);
    expect(Number.isFinite(latest?.cap_charge)).toBe(true);
  });
});

describe("v3 hex in the receipt still leaves a ledger row", () => {
  it("writes the reservation when settled_raw contains a long hex value", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new V3Provider({ state: "settled", settled: 0.05, settledRaw: HEX, requestId: "same" });
    const run = await cliP(home, runArgs("raw-hex"), provider);
    expect(run.code, run.err).toBe(0);
    expect(run.out.includes(HEX)).toBe(false);
    const printed = run.json() as { request_id: string };
    const receipt = readFileSync(join(home, "receipts", `${printed.request_id}.json`), "utf8");
    expect(receipt.includes(HEX)).toBe(false);
    const rows = readLines(join(home, "ledger.jsonl")) as { request_id: string | null; cap_charge: number | null; spend: number | null; state: string }[];
    const latest = rows.filter((row) => row.request_id === printed.request_id).at(-1);
    expect(latest?.spend).toBeNull();
    expect(latest?.cap_charge).toBe(0.186);
    expect(Number.isFinite(latest?.cap_charge)).toBe(true);
  });
});

describe("v3 timeout bounds", () => {
  for (const value of ["NaN", "0", "-1", "1.5", "2147483648", "foo"]) {
    it(`rejects --timeout-ms ${value} before any call or ledger write`, async () => {
      const home = tmpHome();
      await readySeat(home, SEAT, "5");
      const provider = new V3Provider();
      const run = await cliP(home, runArgs("timeout", ["--timeout-ms", value]), provider);
      expect(run.code, run.err).toBe(2);
      expect(existsSync(join(home, "ledger.jsonl"))).toBe(false);
      expect(provider.calls).toBe(0);
    });
  }

  it("accepts a positive integer timeout and records the run", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const provider = new V3Provider();
    const run = await cliP(home, runArgs("timeout-ok", ["--timeout-ms", "5000"]), provider);
    expect(run.code, run.err).toBe(0);
    expect(provider.calls).toBe(1);
    expect(existsSync(join(home, "ledger.jsonl"))).toBe(true);
  });
});

describe("v3 receipt refresh writes the ledger", () => {
  it("appends a settled ledger row when refresh matches the request id", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const first = new V3Provider({ requestId: "same" });
    const opened = await cliP(home, runArgs("refresh-ok"), first);
    expect(opened.code, opened.err).toBe(0);
    const id = opened.json().request_id as string;
    const refresher = new V3Provider({ state: "settled", settled: 0.05, requestId: id });
    const refreshed = await cli(home, ["receipt", id, "--refresh", "--json", "--seat", SEAT], { provider: refresher });
    expect(refreshed.code, refreshed.err).toBe(0);
    const rows = readLines(join(home, "ledger.jsonl")) as { request_id: string | null; state: string; spend: number | null; cap_charge: number | null }[];
    expect(rows.filter((row) => row.request_id === id).at(-1)).toMatchObject({ state: "settled", spend: 0.05, cap_charge: 0.05 });
  });

  it("keeps the reservation and says the ledger disagrees when the refresh write fails", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const first = new V3Provider({ requestId: "same" });
    const opened = await cliP(home, runArgs("refresh-fail"), first);
    expect(opened.code, opened.err).toBe(0);
    const id = opened.json().request_id as string;
    const before = readFileSync(join(home, "ledger.jsonl"), "utf8");
    chmodSync(join(home, "ledger.jsonl"), 0o400);
    const refresher = new V3Provider({ state: "settled", settled: 0.05, requestId: id });
    const refreshed = await cli(home, ["receipt", id, "--refresh", "--json", "--seat", SEAT], { provider: refresher });
    const status = "receipt and ledger disagree; reservation held, chain-final green blocked";
    expect(refreshed.err).toBe(status);
    expect(JSON.stringify(refreshed.json())).toContain(status);
    expect(readFileSync(join(home, "ledger.jsonl"), "utf8")).toBe(before);
    const rows = readLines(join(home, "ledger.jsonl")) as { request_id: string | null; cap_charge: number | null }[];
    expect(rows.filter((row) => row.request_id === id).at(-1)?.cap_charge).toBe(0.186);
  });
});

describe("v3 ledger lock", () => {
  it("lets at most one of two concurrent CLI processes pass a one-call cap", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "0.186");
    const root = join(import.meta.dirname, "..");
    execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: root });
    const runner = join(home, "runner.mjs");
    writeFileSync(runner, `
import { main } from ${JSON.stringify(join(root, "dist", "cli.js"))};
const provider = {
  name: "mock",
  calls: 0,
  async estimate() {
    await new Promise((r) => setTimeout(r, 500));
    return { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 };
  },
  async complete() {
    this.calls += 1;
    return { request_id: "x", text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: 0.01 } };
  },
  async readReceipt(id) {
    return { http: 200, error: null, receipt: { request_id: id, correlation_id: "imd-job-" + process.env.JOB, state: "estimated", settled_spend: null, reserved_spend: 0.186, model: "m" } };
  },
};
const code = await main(["run", "--seat", ${JSON.stringify(SEAT)}, "--job", process.env.JOB, "--prompt", "Say hi", "--max-tokens", "8", "--provider", "mock"], {
  out(s) { process.stdout.write(s + "\\n"); },
  err(s) { process.stderr.write(s + "\\n"); },
  env: { ...process.env, IMD_FLOP_HOME: ${JSON.stringify(home)} },
  provider,
});
process.exit(code ?? 1);
`);
    const run = (job: string) => new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [runner], { env: { ...process.env, JOB: job, IMD_FLOP_HOME: home } });
      child.on("exit", (code) => resolve(code ?? 1));
    });
    const codes = await Promise.all([run("race-a"), run("race-b")]);
    const passed = codes.filter((code) => code === 0).length;
    expect(passed).toBe(1);
    expect(codes.every((code) => code === 0 || code === 3)).toBe(true);
  });

  it("does not let a second cap check run before the first reservation is appended", async () => {
    const { withLedgerLock, spentToday, appendLedger } = await import("../src/ledger.js");
    const home = tmpHome();
    await readySeat(home, SEAT, "0.186");
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const first = withLedgerLock(home, async () => {
      const spent = spentToday(home, SEAT, "mock");
      if (spent + 0.186 <= 0.186) {
        appendLedger(home, {
          ts: new Date().toISOString(), day: utcDay(), request_id: "lock-a", seat: SEAT, did: null,
          job: "lock-a", provider: "mock", network: "devnet", payer: "holder", model: "m", max_tokens: 8,
          prompt_sha256: "ab".repeat(32), quote_raw: 0.066, quote_padded: 0.186, per_call_cap: 0.186,
          daily_cap: 0.186, job_budget: null, spent_before: spent, state: "sent", reason: null, spend: null,
          cost_reported: null, cap_charge: 0.186, http: null, mock: true,
        });
      }
      await hold;
    });
    let secondSpent = -1;
    const second = withLedgerLock(home, async () => {
      secondSpent = spentToday(home, SEAT, "mock");
    });
    release();
    await first;
    await second;
    expect(secondSpent).toBe(0.186);
  });
});
