/**
 * Review of P0 (132bb6a..576d4d7), attack C and E: the run path with provider objects of every name and kind
 * case. This file imports only modules that exist at 132bb6a too, so it runs on both builds. The expected
 * values are what 132bb6a does. A test here that fails on 576d4d7 is a change in behaviour (promise P1 or P4).
 *
 * The lead ruled C3 to C11 in brief 2026-11-12-fix-p0-provider-table: rule F5 for C3 to C9 (under F3, the run
 * path reads the provider's name once, at its top, and uses that value throughout; under F4, it refuses a provider
 * object whose name is not in the table, exit 2, before anything else), and rules G1 to G3 for C3, C9, C10 and
 * C11. Their expectations are that ruling, not what 132bb6a did.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
    response: rows[0]?.request_id && existsSync(join(h, "responses", `${rows[0].request_id}.json`)) ? (JSON.parse(readFileSync(join(h, "responses", `${rows[0].request_id}.json`), "utf8")) as Record<string, unknown>) : null,
    out: r.out,
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
  it("C3 (ruled, F4, F5, G1) a stub whose name is not in the table: refused with exit 2, no estimate, no call, no row", async () => {
    let estimates = 0;
    const o = await runWith(stub(["nope"], { estimate: async () => { estimates++; return {}; } }), false);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, estimates, calls: o.calls, rows: o.rows.length, err: o.err }).toEqual({ code: 2, gate: false, ownerOf: false, estimates: 0, calls: 0, rows: 0, err: "imd-flop: --provider must be mock or flop" });
  });
  it("C4 (ruled, F5) a name that reads mock first and flop after, on a seat with no wallet signature: treated as mock throughout", async () => {
    const o = await runWith(stub(["mock", "flop"]), false);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, first: o.rows[0] }).toEqual({ code: 0, gate: false, ownerOf: false, first: { provider: "mock", mock: true, state: "sent", prefix: "mock" } });
    expect(o.rows.every((x) => x.provider === "mock" && x.mock === true && x.prefix === "mock")).toBe(true);
  });
  it("C5 (ruled, F5) a name that reads mock first and flop after, on a wallet signed seat: treated as mock throughout", async () => {
    const o = await runWith(stub(["mock", "flop"]), true);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, first: o.rows[0] }).toEqual({ code: 0, gate: false, ownerOf: false, first: { provider: "mock", mock: true, state: "sent", prefix: "mock" } });
    expect(o.rows.every((x) => x.provider === "mock" && x.mock === true && x.prefix === "mock")).toBe(true);
  });
  it("C6 (ruled, F5) a name that reads flop first and mock after, on a seat with no wallet signature: treated as flop, exit 4, nothing written", async () => {
    const o = await runWith(stub(["flop", "mock"]), false);
    expect({ code: o.code, calls: o.calls, rows: o.rows.length }).toEqual({ code: 4, calls: 0, rows: 0 });
  });
  it("C7 (ruled, F5) a name that reads flop first and nope after: treated as flop, exit 4", async () => {
    const o = await runWith(stub(["flop", "nope"]), false);
    expect({ code: o.code, calls: o.calls, rows: o.rows.length }).toEqual({ code: 4, calls: 0, rows: 0 });
  });
  it("C8 (ruled, F5) --no-link with a name that reads mock first and flop after: treated as mock, link bypassed, no gate, a mock row", async () => {
    const o = await runWith(stub(["mock", "flop"]), true, [...RUN, "--no-link"]);
    expect({ code: o.code, gate: o.gate, ownerOf: o.ownerOf, first: o.rows[0], bypassed: o.err.includes("--no-link: link check bypassed") }).toEqual({ code: 0, gate: false, ownerOf: false, first: { provider: "mock", mock: true, state: "sent", prefix: "mock" }, bypassed: true });
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

describe("review P0, C and A: a name not in the table, and the order of names in --json output, as 132bb6a did it", () => {
  it("C9 (ruled, F5, G1) a stub whose name is not in the table with --no-link: refused with exit 2, nothing written", async () => {
    const o = await runWith(stub(["nope"]), false, [...RUN, "--no-link"]);
    expect({ code: o.code, calls: o.calls, rows: o.rows.length }).toEqual({ code: 2, calls: 0, rows: 0 });
  });
  it("C10 (ruled, G2) a stub whose name is not in the table, through the CLI: exit 2, the usage text on stderr, nothing on stdout, no row", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT);
    const r = await cli(h, RUN, { provider: stub(["nope"]) });
    expect({ code: r.code, err: r.err, out: r.out, rows: ledger(h).length }).toEqual({ code: 2, err: "imd-flop: --provider must be mock or flop", out: "", rows: 0 });
  });
  it("C11 (ruled, G3) receipt --refresh of a stored row whose provider is not in the table, with a stub of that name: the read is not marked mock", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT);
    // The row is put into the home by the test, not made by a run: a copy of a mock run's sent row, with a
    // provider not in the table and a request id of its own.
    expect((await cli(h, RUN)).code).toBe(0);
    const sent = ledger(h).find((x) => x.state === "sent")! as Row & Record<string, unknown>;
    const rid = "imdflop-42-00000000000000cc";
    appendFileSync(join(h, "ledger.jsonl"), JSON.stringify({ ...sent, provider: "nope", mock: false, request_id: rid }) + "\n");
    const p = stub(["nope"]);
    const r = await cli(h, ["receipt", rid, "--refresh", "--json"], { provider: p });
    const text = r.out;
    expect(text).not.toContain('"mock": true');
    expect(text).not.toContain("[MOCK]");
  });
  it("A cap show --json prints spent_today_mock before spent_today_flop, byte for byte (holds)", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT);
    const r = await cli(h, ["cap", "show", "--json"]);
    expect(r.out.indexOf('"spent_today_mock"')).toBeGreaterThan(0);
    expect(r.out.indexOf('"spent_today_mock"')).toBeLessThan(r.out.indexOf('"spent_today_flop"'));
  });
  it("A status --json prints flop before mock in each per provider object, byte for byte (holds)", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT);
    const r = await cli(h, ["status", "--json"]);
    expect(r.code).toBe(0);
    for (const key of ["today_utc", "gateway_spent_today_utc", "gateway_spend_unknown_rows", "over_cap_today_utc"]) {
      const at = r.out.indexOf(`"${key}"`);
      const tail = r.out.slice(at);
      expect({ key, flopFirst: tail.indexOf('"flop"') < tail.indexOf('"mock"') }).toEqual({ key, flopFirst: true });
    }
  });
});

describe("review P0, A: a mock scenario not in the list", () => {
  it("run --mock-scenario bad is a usage error (exit 2) with the list, and writes nothing (holds)", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT);
    const r = await cli(h, [...RUN, "--mock-scenario", "bad"]);
    expect({ code: r.code, err: r.err, rows: ledger(h).length }).toEqual({ code: 2, err: "imd-flop: --mock-scenario must be one of ok, timeout, settled, key_expired, estimate_error", rows: 0 });
  });
});
