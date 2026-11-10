/**
 * Fail-first regressions for Sonar's independent check of the IMD re-audit at 716819c
 * (pr6-716819c-imd-reaudit-independent/REPORT.md). Each test asserts the SAFE outcome, so it
 * fails on 716819c and passes after its fix-v8 commit. Mock providers only; no network
 * (test/setup.ts disables fetch).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PreSendError } from "../src/gateway.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9001";
const quote = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 };
type Receipt = { http: number; error: string | null; receipt: Record<string, unknown> | null };
interface Opts { complete?: (req: CompleteReq) => Promise<CompleteRes>; receipt?: (id: string) => Receipt }
class P implements Provider {
  readonly name = "mock" as const;
  estimates = 0;
  calls = 0;
  constructor(private readonly o: Opts = {}) {}
  async estimate() { this.estimates += 1; return quote; }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    if (this.o.complete) return this.o.complete(req);
    return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } as CompleteRes["usage"] };
  }
  async readReceipt(id: string) {
    if (this.o.receipt) return this.o.receipt(id) as never;
    return { http: 200, error: null, receipt: { request_id: id, correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: null, state: "estimated" } } as never;
  }
}
const runArgs = (job: string, extra: string[] = []) => ["run", "--seat", SEAT, "--job", job, "--prompt", "Say hi", "--max-tokens", "8", "--provider", "mock", "--json", ...extra];
type Row = { request_id: string | null; state: string; spend: number | null; cap_charge: number; payer: unknown };
const ledger = (home: string) => (existsSync(join(home, "ledger.jsonl")) ? (readLines(join(home, "ledger.jsonl")) as Row[]) : []);
async function ready(cap: string) {
  const h = tmpHome();
  await readySeat(h, SEAT, cap);
  return h;
}

describe("v8 item 1 (TS-a, run.ts:219): a payer outside holder|requester fails closed", () => {
  for (const payer of ["sponsor", "Holder", "", null, 7] as unknown[]) {
    it(`TS-a payer ${JSON.stringify(payer)} is refused with exit 3 before the estimate, and nothing is booked as sent`, async () => {
      const h = await ready("0.2");
      const cfgP = join(h, "config.json");
      const cfg = JSON.parse(readFileSync(cfgP, "utf8"));
      cfg.payer = payer;
      writeFileSync(cfgP, JSON.stringify(cfg));
      const p = new P();
      const codes: number[] = [];
      for (const j of ["p1", "p2", "p3"]) codes.push((await cli(h, runArgs(j), { provider: p })).code);
      expect(codes).toEqual([3, 3, 3]);
      expect(p.estimates).toBe(0);
      expect(p.calls).toBe(0);
      expect(ledger(h).filter((r) => r.state === "sent")).toHaveLength(0);
    });
  }
  it("TS-a control: payer holder still enforces the 0.2 cap (exits [0,3,3], one completion)", async () => {
    const h = await ready("0.2");
    const p = new P();
    const codes: number[] = [];
    for (const j of ["p1", "p2", "p3"]) codes.push((await cli(h, runArgs(j), { provider: p })).code);
    expect(codes).toEqual([0, 3, 3]);
    expect(p.calls).toBe(1);
  });
  it("TS-a control: payer requester with --job-budget still runs within budget", async () => {
    const h = await ready("0.2");
    const cfgP = join(h, "config.json");
    const cfg = JSON.parse(readFileSync(cfgP, "utf8"));
    cfg.payer = "requester";
    writeFileSync(cfgP, JSON.stringify(cfg));
    const p = new P();
    const codes: number[] = [];
    for (const j of ["p1", "p1"]) codes.push((await cli(h, runArgs(j, ["--job-budget", "0.2"]), { provider: p })).code);
    expect(codes).toEqual([0, 3]);
    expect(p.calls).toBe(1);
  });
});

describe("v8 item 2 (TS-b, run.ts:250): a pre-send refusal releases its reservation", () => {
  const HEX = "ee".repeat(32);
  const flagged: Record<string, string> = {
    "bare 64hex": "eth_chainId error: " + HEX,
    "78-digit decimal chain id": `Ethereum chain id ${BigInt("0x" + "f".repeat(64)).toString()} is not 1`,
    "Bearer": "rpc error: Bearer SYNTHETICNOTAKEY0123456789",
    "flop_ek_": "rpc error: flop_ek_SYNTHETICNOTAKEY0123456789",
  };
  const controls: Record<string, string> = { "clean (control)": "eth_chainId mismatch", "0x+64hex (control)": "tx 0x" + HEX };
  for (const [name, msg] of Object.entries({ ...flagged, ...controls })) {
    it(`TS-b ${name}: exit 1, latest row refused_local with cap_charge 0, next run is not capped`, async () => {
      const h = await ready("0.186");
      const p = new P({ complete: async () => { throw new PreSendError(msg); } });
      const r1 = await cli(h, runArgs("m1"), { provider: p });
      expect(r1.code).toBe(1);
      const ids = [...new Set(ledger(h).filter((r) => r.request_id).map((r) => r.request_id))];
      expect(ids).toHaveLength(1);
      const latest = ledger(h).filter((r) => r.request_id === ids[0]).at(-1)!;
      expect(latest.state).toBe("refused_local");
      expect(latest.cap_charge).toBe(0);
      // Nothing key-shaped reaches the ledger or stderr.
      const raw = readFileSync(join(h, "ledger.jsonl"), "utf8");
      for (const needle of ["SYNTHETICNOTAKEY", BigInt("0x" + "f".repeat(64)).toString(), "error: " + HEX]) {
        expect(raw).not.toContain(needle);
        if (name in flagged) expect(r1.err).not.toContain(needle);
      }
      const p2 = new P();
      const r2 = await cli(h, runArgs("m2"), { provider: p2 });
      expect(r2.code).toBe(0);
      expect(p2.calls).toBe(1);
    });
  }
});

const hang = (req: CompleteReq) => new Promise<CompleteRes>((_, rej) => req.signal?.addEventListener("abort", () => rej(req.signal!.reason)));
const settledReceipt = (spend: number) => (id: string): Receipt => ({ http: 200, error: null, receipt: { request_id: id, correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: spend, state: "settled" } });
async function timedOutRun(h: string): Promise<string> {
  const r = await cli(h, runArgs("j1", ["--timeout-ms", "50"]), { provider: new P({ complete: hang }) });
  expect(r.code).toBe(6);
  const rid = ledger(h).find((x) => x.request_id)!.request_id!;
  expect(existsSync(join(h, "receipts", `${rid}.json`))).toBe(false);
  return rid;
}

describe("v8 item 3 (TS-c, cli.ts:418): receipt --refresh after a timeout keeps the seat identity", () => {
  it("TS-c refresh after a timeout writes seat/did/ss58/network and matches, on every refresh", async () => {
    const h = await ready("5");
    const rid = await timedOutRun(h);
    const ident = JSON.parse(readFileSync(join(h, "seats", SEAT, "identity.json"), "utf8"));
    const pr = new P({ receipt: settledReceipt(0.05) });
    for (let i = 0; i < 2; i++) {
      const r = await cli(h, ["receipt", rid, "--refresh", "--json"], { provider: pr });
      expect(r.code).toBe(0);
      expect(r.json().match).toEqual({ match: "matches", fields: [] });
      const file = JSON.parse(readFileSync(join(h, "receipts", `${rid}.json`), "utf8"));
      expect(file.seat).toBe(SEAT);
      expect(file.did).toBe(ident.did);
      expect(file.ss58).toBe(ident.ss58);
      expect(file.network).toBe("devnet");
    }
    const st = await cli(h, ["status", "--seat", SEAT, "--json"]);
    expect(st.out).not.toMatch(/mismatch/);
    const latest = ledger(h).filter((x) => x.request_id === rid).at(-1)!;
    expect([latest.state, latest.spend, latest.cap_charge]).toEqual(["settled", 0.05, 0.05]);
  });
});
