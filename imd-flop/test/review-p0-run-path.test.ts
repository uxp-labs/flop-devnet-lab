/**
 * Review of P0 (132bb6a..576d4d7), attack C and E: the run path with provider objects of every name and kind
 * case. This file imports only modules that exist at 132bb6a too, so it runs on both builds. The expected
 * values are what 132bb6a does. A test here that fails on 576d4d7 is a change in behaviour (promise P1 or P4).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockProvider, type Provider } from "../src/providers.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";
import { defaults, ETH, paidSeat, PIN_FRAME, scriptedGateway, SEAT, withFrame } from "./lib/scripted-gateway.js";

type Row = { provider: unknown; mock: unknown; state: string; request_id: string | null };
const ledger = (h: string): Row[] => (existsSync(join(h, "ledger.jsonl")) ? (readLines(join(h, "ledger.jsonl")) as Row[]) : []);
const RUN = ["run", "--job", "job-abc", "--prompt", "Say hi", "--max-tokens", "8", "--seat", SEAT];

/** A provider object made in the test: the mock's behaviour, with a name that answers from a script per read. */
function stub(names: readonly string[], extra: Record<string, unknown> = {}): Provider & { reads: number } {
  const inner = new MockProvider("ok");
  let reads = 0;
  const p = {
    get name() {
      const n = names[Math.min(reads, names.length - 1)]!;
      reads++;
      return n;
    },
    get reads() {
      return reads;
    },
    get calls() {
      return inner.calls;
    },
    estimate: (b: Parameters<MockProvider["estimate"]>[0]) => inner.estimate(b),
    complete: (r: Parameters<MockProvider["complete"]>[0]) => inner.complete(r),
    readReceipt: (id: string) => inner.readReceipt(id),
    ...extra,
  };
  return p as unknown as Provider & { reads: number };
}

/** One run with a stub on a seat; walletSigned picks paidSeat (wallet signed link) or readySeat (FLOP side only). */
async function runWith(p: Provider, walletSigned: boolean, args: string[] = RUN) {
  let h: string;
  let owner = "0x" + "11".repeat(20);
  if (walletSigned) ({ h, owner } = await paidSeat());
  else {
    h = tmpHome();
    await readySeat(h, SEAT);
  }
  const gw = scriptedGateway(defaults(owner));
  const r = await withFrame(PIN_FRAME, () => cli(h, args, { provider: p, fetch: gw.fetch, env: { IMD_FLOP_HOME: h, ETH_RPC_URL: ETH } }));
  const rows = ledger(h);
  const receiptFile = rows[0]?.request_id ? join(h, "receipts", `${rows[0].request_id}.json`) : null;
  const receipt = receiptFile && existsSync(receiptFile) ? (JSON.parse(readFileSync(receiptFile, "utf8")) as Record<string, unknown>) : null;
  return {
    code: r.code,
    gate: gw.seen.includes("chainId") && gw.seen.includes("faucet"),
    ownerOf: gw.seen.includes("ownerOf"),
    calls: p.calls,
    rows: rows.map((x) => ({ provider: x.provider, mock: x.mock, state: x.state, prefix: x.request_id?.split("-")[0] ?? null })),
    receipt,
    err: r.err,
  };
}

describe("review P0, C: the run path by name case, as 132bb6a did it", () => {
  it("C1 a stub named flop: the paid gate runs before the call, the row says flop and not mock (holds)", async () => {
    const o = await runWith(stub(["flop"]), true);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, calls: o.calls, first: o.rows[0] }).toEqual({ code: 0, gate: true, ownerOf: true, calls: 1, first: { provider: "flop", mock: false, state: "sent", prefix: "imdflop" } });
  });
  it("C2 a stub named mock: no gate, no owner read, the row says mock (holds)", async () => {
    const o = await runWith(stub(["mock"]), false);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, calls: o.calls, first: o.rows[0] }).toEqual({ code: 0, gate: false, ownerOf: false, calls: 1, first: { provider: "mock", mock: true, state: "sent", prefix: "mock" } });
  });
  it("C3 note: a stub whose name is not in the table makes the call and writes a row with no paid gate and no wallet link, on both builds", async () => {
    const o = await runWith(stub(["nope"]), false);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, calls: o.calls, first: o.rows[0] }).toEqual({ code: 0, gate: false, ownerOf: false, calls: 1, first: { provider: "nope", mock: false, state: "sent", prefix: "imdflop" } });
  });
  it("C4 a name that reads mock first and flop after, on a seat with no wallet signature: 132bb6a refuses on the link (exit 4) and writes nothing", async () => {
    const o = await runWith(stub(["mock", "flop"]), false);
    expect({ code: o.code, gate: o.gate, calls: o.calls, rows: o.rows.length }).toEqual({ code: 4, gate: false, calls: 0, rows: 0 });
  });
  it("C5 a name that reads mock first and flop after, on a wallet signed seat: 132bb6a reads the owner and writes the row as flop, not mock", async () => {
    const o = await runWith(stub(["mock", "flop"]), true);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, first: o.rows[0] }).toEqual({ code: 0, gate: false, ownerOf: true, first: { provider: "flop", mock: false, state: "sent", prefix: "imdflop" } });
  });
  it("C6 a name that reads flop first and mock after, on a seat with no wallet signature: 132bb6a gates, needs no wallet, writes a mock row", async () => {
    const o = await runWith(stub(["flop", "mock"]), false);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, first: o.rows[0] }).toEqual({ code: 0, gate: true, ownerOf: false, first: { provider: "mock", mock: true, state: "sent", prefix: "mock" } });
  });
  it("C7 a name that reads flop at the gate and nope from the ledger write on: 132bb6a gates, needs no wallet, writes a nope row", async () => {
    const o = await runWith(stub(["flop", "nope"]), false);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, first: o.rows[0] }).toEqual({ code: 0, gate: true, ownerOf: false, first: { provider: "nope", mock: false, state: "sent", prefix: "imdflop" } });
  });
  it("C8 --no-link with a name that reads mock first and flop after: 132bb6a bypasses on the first read and gates on the second", async () => {
    const o = await runWith(stub(["mock", "flop"]), true, [...RUN, "--no-link"]);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, first: o.rows[0] }).toEqual({ code: 0, gate: true, ownerOf: false, first: { provider: "flop", mock: false, state: "sent", prefix: "imdflop" } });
  });
});

describe("review P0, E: the mock scenario written to the receipt file, as 132bb6a did it", () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ["no scenario member", {}, "ok"],
    ["scenario undefined", { scenario: undefined }, "ok"],
    ["scenario empty", { scenario: "" }, ""],
    ["scenario a number", { scenario: 7 }, 7],
    ["scenario null", { scenario: null }, "ok"],
    ["scenario settled", { scenario: "settled" }, "settled"],
  ];
  for (const [label, extra, want] of cases) {
    it(`E ${label}: mock_scenario is ${JSON.stringify(want)} (holds)`, async () => {
      const o = await runWith(stub(["mock"], extra), false);
      expect(o.code).toBe(0);
      expect(o.receipt?.mock_scenario).toEqual(want);
    });
  }
  it("E a stub named flop with a scenario: no mock_scenario is written (holds)", async () => {
    const o = await runWith(stub(["flop"], { scenario: "settled" }), true);
    expect(o.code).toBe(0);
    expect(o.receipt && "mock_scenario" in o.receipt).toBe(false);
  });
});
