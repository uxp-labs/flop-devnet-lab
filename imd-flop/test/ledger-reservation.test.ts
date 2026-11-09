/**
 * Unresolved spend stays reserved. A completion may report usage.cost_flop 0 while the
 * receipt spend is still null. That 0 is not a settlement: the pre-call reservation
 * remains the cap charge. Withholding the response text does not prove nothing was charged.
 * Positive and omitted reported costs, and an explicit settled spend (including 0),
 * keep their existing charges. The 64-hex marker is synthetic and is not a key.
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

type CostMode = number | "omit";

class ScriptedUsageProvider implements Provider {
  readonly name = "mock" as const;
  calls = 0;
  private readonly inner = new MockProvider("ok");
  constructor(
    private readonly text: string,
    private readonly cost: CostMode,
    private readonly settled: number | null,
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
  cap_charge: number;
  quote_padded: number | null;
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

function rowsFor(home: string, requestId: string): LedgerRow[] {
  return (readLines(join(home, "ledger.jsonl")) as LedgerRow[]).filter((row) => row.request_id === requestId);
}

async function runWithheld(job: string, cost: CostMode, settled: number | null) {
  const home = tmpHome();
  await readySeat(home, SEAT, "5");
  const provider = new ScriptedUsageProvider(MARKER_TEXT, cost, settled);
  const result = await cliP(home, ["run", "--seat", SEAT, "--job", job, "--prompt", "Say hi", "--max-tokens", "8", "--provider", "mock", "--json"], provider);
  return { home, provider, result, printed: result.json() as Printed };
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

describe("unresolved zero reported cost", () => {
  it("keeps the pre-call reservation when a withheld completion reports cost_flop 0 and spend is null", async () => {
    const { home, provider, result, printed } = await runWithheld("zero-withheld", 0, null);
    expect(result.code).toBe(0);
    expect(provider.calls).toBe(1);
    expect(printed.quote_padded).toBe(RESERVATION);
    expect(printed.receipt.reserved).toBe(RESERVATION);
    expect(printed.receipt.settled).toBeNull();
    expect(printed.receipt.state).toBe("estimated");
    expectWithheld(result.out, printed);

    const rows = rowsFor(home, printed.request_id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: "sent", spend: null, cost_reported: null, cap_charge: RESERVATION, quote_padded: RESERVATION });
    expect(rows[1]).toMatchObject({ state: "estimated", spend: null, cost_reported: 0, cap_charge: RESERVATION });
    expect(printed.cap_charge).toBe(RESERVATION);

    const status = await cli(home, ["status", "--seat", SEAT, "--json"]);
    expect(status.json().today_utc.mock).toBe(RESERVATION);
    expect(readFileSync(join(home, "ledger.jsonl"), "utf8").includes(MARKER_HEX)).toBe(false);
  });
});

describe("reported-cost controls", () => {
  it("positive cost_flop 0.18 on a withheld completion still charges 0.18", async () => {
    const { home, result, printed } = await runWithheld("positive-withheld", RESERVATION, null);
    expect(result.code).toBe(0);
    expect(printed.quote_padded).toBe(RESERVATION);
    expect(printed.receipt.reserved).toBe(RESERVATION);
    expect(printed.receipt.settled).toBeNull();
    expectWithheld(result.out, printed);
    expect(rowsFor(home, printed.request_id).at(-1)).toMatchObject({
      state: "estimated",
      spend: null,
      cost_reported: RESERVATION,
      cap_charge: RESERVATION,
    });
    expect(printed.cap_charge).toBe(RESERVATION);
  });

  it("omitted cost_flop on a withheld completion still charges the 0.18 reservation", async () => {
    const { home, result, printed } = await runWithheld("omitted-withheld", "omit", null);
    expect(result.code).toBe(0);
    expect(printed.quote_padded).toBe(RESERVATION);
    expect(printed.receipt.reserved).toBe(RESERVATION);
    expect(printed.receipt.settled).toBeNull();
    expectWithheld(result.out, printed);
    expect(rowsFor(home, printed.request_id).at(-1)).toMatchObject({
      state: "estimated",
      spend: null,
      cost_reported: null,
      cap_charge: RESERVATION,
    });
    expect(printed.cap_charge).toBe(RESERVATION);
  });

  it("a positive cost_flop below the reservation still charges that reported cost", async () => {
    const { home, result, printed } = await runWithheld("positive-below", 0.05, null);
    expect(result.code).toBe(0);
    expect(printed.quote_padded).toBe(RESERVATION);
    expect(printed.receipt.reserved).toBe(RESERVATION);
    expect(printed.receipt.settled).toBeNull();
    expect(rowsFor(home, printed.request_id).at(-1)).toMatchObject({
      state: "estimated",
      spend: null,
      cost_reported: 0.05,
      cap_charge: 0.05,
    });
    expect(printed.cap_charge).toBe(0.05);
  });
});

describe("known settlement", () => {
  it("an explicit settled spend wins over a zero usage report", async () => {
    const { home, result, printed } = await runWithheld("settled-positive", 0, 0.05);
    expect(result.code).toBe(0);
    expect(printed.quote_padded).toBe(RESERVATION);
    expect(printed.receipt.reserved).toBe(RESERVATION);
    expect(printed.receipt.settled).toBe(0.05);
    expect(printed.receipt.state).toBe("settled");
    expect(rowsFor(home, printed.request_id).at(-1)).toMatchObject({
      state: "settled",
      spend: 0.05,
      cost_reported: 0,
      cap_charge: 0.05,
    });
    expect(printed.cap_charge).toBe(0.05);
  });

  it("an explicit settled zero still charges zero over a positive usage report", async () => {
    const { home, result, printed } = await runWithheld("settled-zero", RESERVATION, 0);
    expect(result.code).toBe(0);
    expect(printed.quote_padded).toBe(RESERVATION);
    expect(printed.receipt.reserved).toBe(RESERVATION);
    expect(printed.receipt.settled).toBe(0);
    expect(printed.receipt.state).toBe("settled");
    expect(rowsFor(home, printed.request_id).at(-1)).toMatchObject({
      state: "settled",
      spend: 0,
      cost_reported: RESERVATION,
      cap_charge: 0,
    });
    expect(printed.cap_charge).toBe(0);
    const status = await cli(home, ["status", "--seat", SEAT, "--json"]);
    expect(status.json().today_utc.mock).toBe(0);
  });
});
