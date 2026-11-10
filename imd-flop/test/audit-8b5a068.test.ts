/**
 * The IMD audit of PRs #1, #3 and #4 at 8b5a068 (job ba164ffa): 3 medium and 4 low findings.
 *
 * Findings 1 to 5 were closed by the shared settlement and redaction rules of the refactor. Each is
 * pinned where the rule lives, not copied here:
 *   1  negative settled spend           contract vector run-settled-negative; ledger-reservation.test.ts
 *   2  settlement on an unsettled or    contract vectors run-estimated-with-settled-amount,
 *      foreign receipt                  run-reserved-with-settled-amount, run-settled-wrong-request-id
 *   3  mint after the deadline          presend-abort.test.ts; audit-v7.test.ts TS-L11
 *   4  key-shaped refusal text          audit-v8.test.ts TS-b
 *   5  secret hit outside the text      audit-v3.test.ts (hex hit in usage); audit-v7.test.ts TS-M3, TS-M4
 *
 * This file holds the two that were still open at b6f4e0f. Each test asserts the safe outcome, so it
 * fails there and passes with its fix:
 *   6  a refusal at the pre-mint gate exits 5, as the same refusal does at the first gate
 *   7  the Ethereum RPC URL, which often carries a key, never reaches stderr or the ledger
 * Stub providers and scripted fetches only; no network (test/setup.ts disables fetch).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/errors.js";
import { assertPaidNetwork, PaidGateError, PreSendError, readEthereumChainId, readSeatOwner } from "../src/gateway.js";
import { NETWORKS } from "../src/networks.js";
import type { CompleteReq, CompleteRes, Provider } from "../src/providers.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9002";
const quote = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 };
class P implements Provider {
  calls = 0;
  constructor(
    readonly name: "mock" | "flop",
    private readonly onComplete?: (req: CompleteReq) => Promise<CompleteRes>,
  ) {}
  async estimate() {
    return quote;
  }
  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls += 1;
    if (this.onComplete) return this.onComplete(req);
    return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } as CompleteRes["usage"] };
  }
  async readReceipt(id: string) {
    return { http: 200, error: null, receipt: { request_id: id, correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: null, state: "estimated" } } as never;
  }
}
const runArgs = (job: string) => ["run", "--seat", SEAT, "--job", job, "--prompt", "Say hi", "--max-tokens", "8", "--provider", "mock", "--json"];
type Row = { request_id: string | null; state: string; cap_charge: number; reason: string | null };
const ledger = (home: string) => (existsSync(join(home, "ledger.jsonl")) ? (readLines(join(home, "ledger.jsonl")) as Row[]) : []);

describe("finding 6: a pre-mint gate refusal exits 5 (REFUSED_RULE), other pre-send failures exit 1", () => {
  const GATE = "FLOP genesis check failed: pinned a vs faucet b vs rpc c (genesis mismatch). Devnet may have reset.";
  const cases: { name: string; error: () => Error; code: number }[] = [
    { name: "the gate refuses", error: () => new PaidGateError(GATE), code: EXIT.REFUSED_RULE },
    { name: "the child-key mint fails (control)", error: () => new PreSendError("child key mint HTTP 500"), code: EXIT.ERROR },
    { name: "the run is aborted before send (control)", error: () => new PreSendError("aborted before send (after the network check): no answer within 50 ms"), code: EXIT.ERROR },
  ];
  for (const c of cases) {
    it(`${c.name}: exit ${c.code}, the reservation is released, and the next run is not capped`, async () => {
      const h = tmpHome();
      await readySeat(h, SEAT, "0.186");
      const r1 = await cli(h, runArgs("g1"), { provider: new P("mock", async () => Promise.reject(c.error())) });
      expect(r1.code, r1.err).toBe(c.code);
      expect(r1.err).toMatch(/nothing sent/);
      const latest = ledger(h).filter((r) => r.request_id).at(-1)!;
      expect(latest).toMatchObject({ state: "refused_local", cap_charge: 0 });
      const p2 = new P("mock");
      expect((await cli(h, runArgs("g2"), { provider: p2 })).code).toBe(0);
      expect(p2.calls).toBe(1);
    });
  }

  it("the gate itself raises PaidGateError, which is a PreSendError, for every way it can refuse", async () => {
    const down = (async () => {
      throw new Error("eth rpc down");
    }) as unknown as typeof fetch;
    for (const eth of [undefined, "", "   ", "https://eth.example/rpc"]) {
      const e = await assertPaidNetwork(NETWORKS.devnet, eth, down).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e, String(eth)).toBeInstanceOf(PaidGateError);
      expect(e, String(eth)).toBeInstanceOf(PreSendError);
    }
  });
});

describe("finding 7: the Ethereum RPC URL never reaches an error message, stderr or the ledger", () => {
  const PASSWORD = "hunter2-NOT-A-REAL-PASSWORD";
  const PATH_KEY = "PATHKEYNOTAREALKEY0123";
  // Port 99999 makes the URL unparsable. fetch's own error for that repeats the whole URL.
  const MALFORMED = `https://user:${PASSWORD}@eth.example:99999/v3/${PATH_KEY}`;
  const VALID = `https://user:${PASSWORD}@eth.example/v3/${PATH_KEY}`;
  const leaks = (text: string) => [PASSWORD, PATH_KEY].filter((s) => text.includes(s));
  const message = (p: Promise<unknown>) =>
    p.then(
      () => "(resolved)",
      (e: unknown) => (e as Error).message,
    );

  /** Fails the way Node's fetch does: the URL is parsed first, and a parse error names the whole URL. */
  const likeNodeFetch = (async (input: unknown, init?: RequestInit) => {
    new Request(String(input), init);
    throw new Error("offline test: nothing is sent");
  }) as typeof fetch;
  /** A transport that repeats the URL it was given in its own error, as some proxies and clients do. */
  const echoing = (async (input: unknown) => {
    throw new Error(`connect ECONNREFUSED ${String(input)}`);
  }) as typeof fetch;

  it("control: Node's own parse error does repeat the URL, so the stub is a fair stand-in", () => {
    expect(() => new Request(MALFORMED)).toThrow(PASSWORD);
  });

  it("a malformed URL is refused before fetch, by a message that does not quote it", async () => {
    let fetched = 0;
    const counting = (async (input: unknown, init?: RequestInit) => {
      fetched += 1;
      return likeNodeFetch(input as string, init);
    }) as typeof fetch;
    const chain = await message(readEthereumChainId(MALFORMED, counting));
    const owner = await message(readSeatOwner(MALFORMED, "0x" + "1".repeat(40), "1", counting));
    for (const m of [chain, owner]) {
      expect(m).toMatch(/not a valid http\(s\) URL/);
      expect(leaks(m)).toEqual([]);
    }
    expect(fetched).toBe(0);
  });

  it("a URL that is not http or https is refused the same way", async () => {
    const m = await message(readEthereumChainId(`ftp://user:${PASSWORD}@eth.example/${PATH_KEY}`, likeNodeFetch));
    expect(m).toMatch(/not a valid http\(s\) URL/);
    expect(leaks(m)).toEqual([]);
  });

  it("a transport error that repeats a valid URL has it replaced", async () => {
    const chain = await message(readEthereumChainId(VALID, echoing));
    const owner = await message(readSeatOwner(VALID, "0x" + "1".repeat(40), "1", echoing));
    for (const m of [chain, owner]) {
      expect(m).toContain("connect ECONNREFUSED [ETH_RPC_URL]");
      expect(leaks(m)).toEqual([]);
    }
  });

  it("a paid run with a malformed ETH_RPC_URL exits 5 with nothing of the URL on stderr or in the ledger", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT, "1");
    const p = new P("flop");
    const r = await cli(h, ["run", "--seat", SEAT, "--job", "u1", "--prompt", "Say hi", "--max-tokens", "8", "--provider", "flop", "--live", "--json"], {
      provider: p,
      fetch: likeNodeFetch,
      env: { IMD_FLOP_HOME: h, ETH_RPC_URL: MALFORMED },
    });
    expect(r.code, r.err).toBe(EXIT.REFUSED_RULE);
    expect(r.err).toMatch(/nothing sent/);
    expect(leaks(r.err + r.out)).toEqual([]);
    expect(p.calls).toBe(0);
    const raw = existsSync(join(h, "ledger.jsonl")) ? readFileSync(join(h, "ledger.jsonl"), "utf8") : "";
    expect(leaks(raw)).toEqual([]);
  });

  it("link verify --eth-rpc with a malformed URL fails the verify without quoting it", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT, "1");
    const file = join(h, "seats", SEAT, "link.json");
    const copy = join(h, "link-copy.json");
    writeFileSync(copy, readFileSync(file, "utf8"));
    const r = await cli(h, ["link", "verify", copy, "--eth-rpc", MALFORMED], { fetch: likeNodeFetch });
    expect(r.code).not.toBe(0);
    expect(leaks(r.err + r.out)).toEqual([]);
  });
});
