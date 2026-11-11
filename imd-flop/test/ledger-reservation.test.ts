/**
 * While spend is unresolved, reported usage must not lower the pre-call reservation.
 * A higher report raises exposure. An explicit settled amount, including settled 0,
 * is the booked spend. It is also the charge, unless the reported cost is higher
 * (swarm audit of 8ddc5d2, finding 2). Withholding the response text does not prove
 * nothing was charged.
 * The 64-hex marker is synthetic and is not a key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { MockProvider } from "../src/providers.js";
import { cli, cliP, readLines, readySeat, tmpHome } from "./helpers.js";

const MARKER_HEX = "ee".repeat(32);
const MARKER_TEXT = `SYNTHETIC-NOT-A-KEY ${MARKER_HEX}`;
const SEAT = "9001";
const RESERVATION = 0.18;
const HIGHER = 0.25;

type CostMode = number | "omit";

class ScriptedUsageProvider implements Provider {
  readonly name = "mock" as const;
  calls = 0;
  private readonly inner = new MockProvider("ok");
  constructor(
    private readonly text: string,
    private readonly cost: CostMode,
    private readonly settled: unknown,
  ) {}
  estimate(body: { model: string; prompt: string; max_tokens: number }) {
    return this.inner.estimate(body);
  }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    const res = await this.inner.complete(req);
    const usage: CompleteRes["usage"] = { ...res.usage };
    if (this.cost === "omit") delete usage.cost_flop;
    else usage.cost_flop = this.cost;
    return { ...res, text: this.text, usage };
  }
  async readReceipt(requestId: string) {
    const rr = await this.inner.readReceipt(requestId);
    if (!rr.receipt) return rr;
    return {
      ...rr,
      receipt: {
        ...rr.receipt,
        settled_spend: this.settled,
        state: this.settled === null ? ("estimated" as const) : ("settled" as const),
      },
    };
  }
}

type LedgerRow = {
  request_id: string | null;
  state: string;
  spend: number | null;
  cost_reported: number | null;
  cap_charge: number | null;
  quote_padded: number | null;
  spent_before: number | null;
};

type Printed = {
  request_id: string;
  quote_padded: number;
  cap_charge: number;
  text: string | null;
  withheld?: string;
  response_file: string;
  receipt: { reserved: number | null; settled: number | null; state: string | null };
};

type RunOut = { code: number; out: string };

function rowsFor(home: string, requestId: string): LedgerRow[] {
  return (readLines(join(home, "ledger.jsonl")) as LedgerRow[]).filter((row) => row.request_id === requestId);
}

async function runOn(home: string, job: string, cost: CostMode, settled: unknown) {
  const provider = new ScriptedUsageProvider(MARKER_TEXT, cost, settled);
  const result = await cliP(home, ["run", "--seat", SEAT, "--job", job, "--prompt", "Say hi", "--max-tokens", "8", "--provider", "mock", "--json"], provider);
  return { provider, result, printed: result.json() as Printed };
}

async function runWithheld(job: string, cost: CostMode, settled: unknown) {
  const home = tmpHome();
  await readySeat(home, SEAT, "5");
  return { home, ...(await runOn(home, job, cost, settled)) };
}

function expectWithheld(stdout: string, printed: Printed) {
  const fileBlob = readFileSync(printed.response_file, "utf8");
  const file = JSON.parse(fileBlob) as { text: string | null; withheld?: string };
  expect(stdout.includes(MARKER_HEX)).toBe(false);
  expect(fileBlob.includes(MARKER_HEX)).toBe(false);
  expect(printed.text).toBeNull();
  expect(printed.withheld).toMatch(/secret scan blocked/);
  expect(String(printed.withheld).includes(MARKER_HEX)).toBe(false);
  expect(file.text).toBeNull();
  expect(file.withheld).toBe(printed.withheld);
}

async function expectExposure(
  home: string,
  result: RunOut,
  printed: Printed,
  latest: { state: string; spend: number | null; cost_reported: number | null; cap_charge: number },
  exposure: { dayTotal?: number; spentBefore?: number } = {},
) {
  const spentBefore = exposure.spentBefore ?? 0;
  const dayTotal = exposure.dayTotal ?? latest.cap_charge;
  expect(result.code).toBe(0);
  expect(printed.quote_padded).toBe(RESERVATION);
  expect(printed.receipt.reserved).toBe(RESERVATION);
  expect(printed.receipt.settled).toBe(latest.spend);
  expect(printed.receipt.state).toBe(latest.state);
  expectWithheld(result.out, printed);
  const rows = rowsFor(home, printed.request_id);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ state: "sent", spend: null, cost_reported: null, cap_charge: RESERVATION, quote_padded: RESERVATION, spent_before: spentBefore });
  expect(rows[1]).toMatchObject({ ...latest, spent_before: spentBefore });
  expect(printed.cap_charge).toBe(latest.cap_charge);
  expect(Number.isFinite(rows[1].cap_charge)).toBe(true);
  const status = await cli(home, ["status", "--seat", SEAT, "--json"]);
  const today = status.json().today_utc as { mock: number; flop: number };
  expect(today.mock).toBe(dayTotal);
  expect(today.flop).toBe(0);
  expect(readFileSync(join(home, "ledger.jsonl"), "utf8").includes(MARKER_HEX)).toBe(false);
}

describe("unresolved reported usage does not lower the reservation", () => {
  it("keeps the pre-call reservation when a withheld completion reports cost_flop 0 and spend is null", async () => {
    const { home, provider, result, printed } = await runWithheld("zero-withheld", 0, null);
    expect(provider.calls).toBe(1);
    await expectExposure(home, result, printed, { state: "estimated", spend: null, cost_reported: 0, cap_charge: RESERVATION });
  });

  it("keeps the 0.18 reservation when unresolved usage reports 0.01", async () => {
    const { home, provider, result, printed } = await runWithheld("small-001", 0.01, null);
    expect(provider.calls).toBe(1);
    await expectExposure(home, result, printed, { state: "estimated", spend: null, cost_reported: 0.01, cap_charge: RESERVATION });
  });

  it("keeps the 0.18 reservation when unresolved usage reports 0.05", async () => {
    const { home, provider, result, printed } = await runWithheld("small-005", 0.05, null);
    expect(provider.calls).toBe(1);
    await expectExposure(home, result, printed, { state: "estimated", spend: null, cost_reported: 0.05, cap_charge: RESERVATION });
  });

  it("an equal cost_flop 0.18 on a withheld completion still charges 0.18", async () => {
    const { home, result, printed } = await runWithheld("equal-withheld", RESERVATION, null);
    await expectExposure(home, result, printed, { state: "estimated", spend: null, cost_reported: RESERVATION, cap_charge: RESERVATION });
  });

  it("omitted cost_flop on a withheld completion still charges the 0.18 reservation", async () => {
    const { home, result, printed } = await runWithheld("omitted-withheld", "omit", null);
    await expectExposure(home, result, printed, { state: "estimated", spend: null, cost_reported: null, cap_charge: RESERVATION });
  });

  it("a higher unresolved cost_flop 0.25 raises exposure above the 0.18 reservation", async () => {
    const { home, result, printed } = await runWithheld("higher-withheld", HIGHER, null);
    await expectExposure(home, result, printed, { state: "estimated", spend: null, cost_reported: HIGHER, cap_charge: HIGHER });
  });
});

describe("known settlement", () => {
  it("an explicit settled spend of 0.05 wins over unresolved-looking usage of 0.01", async () => {
    const { home, result, printed } = await runWithheld("settled-positive", 0.01, 0.05);
    await expectExposure(home, result, printed, { state: "settled", spend: 0.05, cost_reported: 0.01, cap_charge: 0.05 });
  });

  // Swarm audit of 8ddc5d2, finding 2: this test was "an explicit settled zero still charges zero over a
  // higher usage report" and expected cap_charge 0. A reported cost may raise the charge and never lower
  // it, also after settlement. Spend stays the settled 0 and the cap charge is the reported 0.25.
  it("an explicit settled zero is the spend, and a higher usage report is the cap charge", async () => {
    const { home, result, printed } = await runWithheld("settled-zero", HIGHER, 0);
    await expectExposure(home, result, printed, { state: "settled", spend: 0, cost_reported: HIGHER, cap_charge: HIGHER });
  });
});

describe("rejected settled_spend is not a known settlement", () => {
  it("negative settled_spend -1 keeps the 0.18 reservation and the day total", async () => {
    const { home, result, printed } = await runWithheld("settled-neg-1", 0.01, -1);
    await expectExposure(home, result, printed, { state: "settled", spend: null, cost_reported: 0.01, cap_charge: RESERVATION });
  });

  it("negative settled_spend -0.01 keeps the 0.18 reservation and the day total", async () => {
    const { home, result, printed } = await runWithheld("settled-neg-small", 0.01, -0.01);
    await expectExposure(home, result, printed, { state: "settled", spend: null, cost_reported: 0.01, cap_charge: RESERVATION });
  });

  it("NaN settled_spend keeps a finite 0.18 reservation in the ledger and the day total", async () => {
    const { home, result, printed } = await runWithheld("settled-nan", 0.01, Number.NaN);
    await expectExposure(home, result, printed, { state: "settled", spend: null, cost_reported: 0.01, cap_charge: RESERVATION });
  });

  it("Infinity settled_spend keeps a finite 0.18 reservation in the ledger and the day total", async () => {
    const { home, result, printed } = await runWithheld("settled-inf", 0.01, Number.POSITIVE_INFINITY);
    await expectExposure(home, result, printed, { state: "settled", spend: null, cost_reported: 0.01, cap_charge: RESERVATION });
  });

  it("-Infinity settled_spend keeps a finite 0.18 reservation in the ledger and the day total", async () => {
    const { home, result, printed } = await runWithheld("settled-neginf", 0.01, Number.NEGATIVE_INFINITY);
    await expectExposure(home, result, printed, { state: "settled", spend: null, cost_reported: 0.01, cap_charge: RESERVATION });
  });

  it("a negative settled attempt then an unresolved attempt keeps both reservations in the day total", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const first = await runOn(home, "seq-neg", 0.01, -1);
    const second = await runOn(home, "seq-neg-next", "omit", null);
    const today = (await cli(home, ["status", "--seat", SEAT, "--json"])).json().today_utc as { mock: number; flop: number };
    expect(today.mock).toBe(RESERVATION * 2);
    expect(today.flop).toBe(0);
    expect(rowsFor(home, second.printed.request_id)[0].spent_before).toBe(RESERVATION);
    await expectExposure(home, first.result, first.printed, { state: "settled", spend: null, cost_reported: 0.01, cap_charge: RESERVATION }, { dayTotal: RESERVATION * 2 });
    await expectExposure(home, second.result, second.printed, { state: "estimated", spend: null, cost_reported: null, cap_charge: RESERVATION }, { dayTotal: RESERVATION * 2, spentBefore: RESERVATION });
  });

  it("a nonfinite settled attempt then an unresolved attempt keeps both reservations in the day total", async () => {
    const home = tmpHome();
    await readySeat(home, SEAT, "5");
    const first = await runOn(home, "seq-nan", 0.01, Number.NaN);
    const second = await runOn(home, "seq-nan-next", "omit", null);
    const today = (await cli(home, ["status", "--seat", SEAT, "--json"])).json().today_utc as { mock: number; flop: number };
    expect(today.mock).toBe(RESERVATION * 2);
    expect(today.flop).toBe(0);
    expect(rowsFor(home, second.printed.request_id)[0].spent_before).toBe(RESERVATION);
    await expectExposure(home, first.result, first.printed, { state: "settled", spend: null, cost_reported: 0.01, cap_charge: RESERVATION }, { dayTotal: RESERVATION * 2 });
    await expectExposure(home, second.result, second.printed, { state: "estimated", spend: null, cost_reported: null, cap_charge: RESERVATION }, { dayTotal: RESERVATION * 2, spentBefore: RESERVATION });
  });

  it("a numeric string settled_spend stays unknown and keeps the reservation", async () => {
    const { home, result, printed } = await runWithheld("settled-string", 0.01, "0.05");
    await expectExposure(home, result, printed, { state: "settled", spend: null, cost_reported: 0.01, cap_charge: RESERVATION });
  });

  it("an object settled_spend stays unknown and keeps the reservation", async () => {
    const { home, result, printed } = await runWithheld("settled-object", 0.01, { amount: 0.05 });
    await expectExposure(home, result, printed, { state: "settled", spend: null, cost_reported: 0.01, cap_charge: RESERVATION });
  });
});
