/**
 * Fail-first regressions for Sonar's independent check of the IMD re-audit at 716819c
 * (pr6-716819c-imd-reaudit-independent/REPORT.md). Each test asserts the SAFE outcome, so it
 * fails on 716819c and passes after its fix-v8 commit. Mock providers only; no network
 * (test/setup.ts disables fetch).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
