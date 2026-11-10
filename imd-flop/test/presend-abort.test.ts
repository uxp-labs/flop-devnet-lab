/**
 * [fix: TS-M2] IMD TS medium #2 (providers.ts:140): run's --timeout-ms timer firing during the paid pre-flight
 * (network check, child-key mint) is a pre-send refusal, not timeout_unknown. FlopProvider.complete must throw
 * PreSendError and never enter the completion request once the signal is aborted, so run.ts books refused_local
 * with cap_charge 0 (the existing pre-send path, contract vector run-pre-send-refusal). Offline: scripted fetch and
 * a fake WebSocket only; the synthetic keys are not keys.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PreSendError } from "../src/gateway.js";
import { NETWORKS } from "../src/networks.js";
import { FlopProvider, type CompleteReq } from "../src/providers.js";
import { gatewayKeyFile } from "../src/paths.js";
import { writeSecretFile } from "../src/store.js";
import { clearSecretRegistry } from "../src/secrets.js";
import { tmpHome } from "./helpers.js";

const PIN = NETWORKS.devnet.genesisHash;
const ETH = "http://eth.test";
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeNet(mintDelayMs: number) {
  const seen = { mint: 0, completion: 0 };
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === ETH) return json({ jsonrpc: "2.0", id: 1, result: "0x1" });
    if (url.endsWith("/chain")) return json({ genesisHash: PIN });
    if (url.includes("/keys/ephemeral")) {
      seen.mint++;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, mintDelayMs);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(init.signal!.reason); }, { once: true });
      });
      return json({ token: "flop_ek_SYNTHETICCHILD0123456789", expires_at: 0 }, 201);
    }
    if (url.includes("/chat/completions")) {
      seen.completion++;
      if (init?.signal?.aborted) throw init.signal.reason; // what fetch does with an already-aborted signal
      return json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { f, seen };
}

const real = globalThis.WebSocket;
function pinnedWs() {
  (globalThis as { WebSocket: unknown }).WebSocket = class {
    onopen?: () => void;
    onmessage?: (ev: { data: string }) => void;
    constructor() { setTimeout(() => this.onopen?.(), 0); }
    send() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ result: PIN }) }), 0); }
    close() {}
  };
}
afterEach(() => {
  globalThis.WebSocket = real;
  clearSecretRegistry();
});

function provider(mintDelayMs: number) {
  const h = tmpHome();
  writeSecretFile(gatewayKeyFile(h, "9001"), "flop_sk_SYNTHETICPARENT0123456789\n");
  const net = fakeNet(mintDelayMs);
  return { p: new FlopProvider(NETWORKS.devnet, gatewayKeyFile(h, "9001"), net.f, ETH), seen: net.seen };
}
const req = (signal: AbortSignal): CompleteReq => ({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 8, requestId: "imdflop-9001-aa", correlationId: "imd-job-j1", maxCostFlop: 0.186, signal });
const timeoutAfter = (ms: number) => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(new DOMException(`no answer within ${ms} ms`, "TimeoutError")), ms);
  return ac.signal;
};

describe("[fix: TS-M2] an abort during the paid pre-flight is a pre-send refusal", () => {
  it("timer fires during the child-key mint: PreSendError, completion never entered", async () => {
    pinnedWs();
    const { p, seen } = provider(150);
    const err = await p.complete(req(timeoutAfter(50))).catch((e) => e);
    expect(err).toBeInstanceOf(PreSendError);
    expect(String(err.message)).toMatch(/no answer within 50 ms/); // the mint stops on the abort (child key mint failed) or the gate catches it
    expect(seen.completion).toBe(0);
  });
  it("signal already aborted when complete is called: PreSendError, nothing minted or sent", async () => {
    pinnedWs();
    const { p, seen } = provider(0);
    const ac = new AbortController();
    ac.abort(new DOMException("no answer within 1 ms", "TimeoutError"));
    const err = await p.complete(req(ac.signal)).catch((e) => e);
    expect(err).toBeInstanceOf(PreSendError);
    expect(seen.mint).toBe(0);
    expect(seen.completion).toBe(0);
  });
  it("control: no abort, the completion request is entered once", async () => {
    pinnedWs();
    const { p, seen } = provider(0);
    // The scripted reply is not a full chat-completion body, so the client may reject it; only the send matters here.
    const out = await p.complete(req(new AbortController().signal)).catch((e) => e);
    expect(out).not.toBeInstanceOf(PreSendError);
    expect(seen.mint).toBe(1);
    expect(seen.completion).toBe(1);
  });
});
