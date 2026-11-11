/**
 * Providers. `mock` (default) is a local OpenAI-shaped stub: deterministic output, a fake
 * request_id and a fake receipt, no key, no network, no spend. `flop` is the real devnet
 * gateway via @flop-labs/client and is gated behind --live.
 * complete() re-checks the Ethereum chain id and the pinned genesis before it mints a child key.
 */
import { statSync } from "node:fs";
import { readSecretFile } from "./store.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { FlopClient, FlopHTTPError } from "@flop-labs/client";
import { CliError, EXIT } from "./errors.js";
import { assertPaidNetwork, mintChildKey, postEstimate, PreSendError, uaFetch, type Estimate, type Fetch } from "./gateway.js";
import { NON_FINITE_NUMBER, NonFiniteNumber, nonFiniteSeam, notJsonBecause, withNonFiniteCause } from "./outside-json.js";
import type { NetworkInfo } from "./networks.js";
import type { GatewayReceipt } from "./receipts.js";
import { registerSecret } from "./secrets.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}
export interface CompleteReq {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  requestId: string; // sent as Idempotency-Key; the gateway's receipt lookup accepts it
  correlationId: string;
  maxCostFlop: number; // server-side cap too (max_cost_flop)
  signal: AbortSignal;
}
export interface CompleteRes {
  request_id: string;
  text: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost_flop?: number };
}
export interface ReceiptRead {
  http: number;
  receipt: GatewayReceipt | null;
  error: string | null;
}
export interface Provider {
  readonly name: "mock" | "flop";
  estimate(body: { model: string; prompt: string; max_tokens: number }): Promise<Estimate>;
  complete(req: CompleteReq): Promise<CompleteRes>;
  readReceipt(requestId: string): Promise<ReceiptRead>;
  calls: number; // complete() invocations, so tests can prove "no retry"
}

export const MOCK_SCENARIOS = ["ok", "timeout", "settled", "key_expired", "estimate_error"] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];
export const MOCK_PRICE_PER_TOKEN = 0.006; // matches the live devnet quote for qwen2.5-0.5b

const approxTokens = (s: string) => Math.max(1, Math.ceil(utf8ToBytes(s).length / 4));

export class MockProvider implements Provider {
  readonly name = "mock" as const;
  calls = 0;
  private reserved = new Map<string, { cost: number; correlation: string }>();
  constructor(readonly scenario: MockScenario = "ok") {}

  async estimate(body: { model: string; prompt: string; max_tokens: number }): Promise<Estimate> {
    if (this.scenario === "estimate_error") throw new Error("mock estimate failure");
    const tin = approxTokens(body.prompt);
    const tout = body.max_tokens;
    return { model: body.model, estimated_input_tokens: tin, estimated_output_tokens: tout, estimated_cost_flop: +((tin + tout) * MOCK_PRICE_PER_TOKEN).toFixed(6) };
  }

  async complete(req: CompleteReq): Promise<CompleteRes> {
    this.calls++;
    if (this.scenario === "timeout") {
      // Never answers; the caller's AbortSignal ends it, like a dropped gateway connection.
      await new Promise((_, reject) => {
        req.signal.addEventListener("abort", () => reject(req.signal.reason ?? new Error("aborted")), { once: true });
      });
    }
    const user = req.messages.map((m) => m.content).join("\n");
    const digest = bytesToHex(sha256(utf8ToBytes(user))).slice(0, 12);
    const text = `[MOCK, no inference ran] ${req.correlationId}: received ${approxTokens(user)} prompt tokens (sha256 ${digest}…).`;
    const prompt_tokens = approxTokens(user) + 20; // the chat-template wrap the real model bills
    const completion_tokens = Math.min(req.max_tokens, approxTokens(text));
    const cost = +((prompt_tokens + completion_tokens) * MOCK_PRICE_PER_TOKEN).toFixed(6);
    this.reserved.set(req.requestId, { cost, correlation: req.correlationId });
    return { request_id: req.requestId, text, usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens, cost_flop: cost } };
  }

  async readReceipt(requestId: string): Promise<ReceiptRead> {
    if (this.scenario === "key_expired") return { http: 401, receipt: null, error: "api_key_expired" };
    const seen = this.reserved.get(requestId);
    const reserved = seen?.cost ?? null;
    const settled = this.scenario === "settled";
    return {
      http: 200,
      error: null,
      receipt: {
        request_id: requestId,
        correlation_id: seen?.correlation ?? "mock",
        model: "mock",
        reserved_spend: reserved,
        settled_spend: settled ? reserved : null, // pending: unknown, not 0
        settled_spend_raw: null,
        terminal_event: null,
        channel_id: null,
        created_at: Date.now(),
        state: settled ? "settled" : "estimated",
        response_status: 200,
      },
    };
  }
}

/** Real devnet gateway. Requires a gateway bearer in seats/<seat>/gateway.key (0600) from `enroll --live`. */
export class FlopProvider implements Provider {
  readonly name = "flop" as const;
  calls = 0;
  private parent: string;
  constructor(
    private net: NetworkInfo,
    gatewayKeyPath: string,
    private f: Fetch = globalThis.fetch,
    private ethRpc?: string,
  ) {
    let raw: string;
    try {
      const mode = statSync(gatewayKeyPath).mode & 0o777;
      if (mode & 0o077) throw new CliError(`gateway key file is mode ${mode.toString(8)}; expected 600`, EXIT.REFUSED_RULE);
      raw = readSecretFile(gatewayKeyPath).trim();
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError("no gateway key for this seat (run `imd-flop enroll --live` on the holder's machine first)", EXIT.USAGE);
    }
    this.parent = raw;
    registerSecret(raw);
  }

  estimate(body: { model: string; prompt: string; max_tokens: number }): Promise<Estimate> {
    return postEstimate(this.net, body, this.f);
  }

  async complete(req: CompleteReq): Promise<CompleteRes> {
    // run's timer may fire during the pre-flight. Until the completion request starts nothing is sent,
    // so an abort before then is a pre-send refusal (refused_local, reservation released), not a timeout.
    const notAborted = (stage: string) => {
      if (req.signal.aborted) throw new PreSendError(`aborted before send (${stage}): ${(req.signal.reason as Error | undefined)?.message ?? "aborted"}`);
    };
    notAborted("before the network check");
    // Throws PaidGateError, a PreSendError: the gate runs before the mint, so nothing was sent.
    await assertPaidNetwork(this.net, this.ethRpc, this.f);
    notAborted("after the network check");
    this.calls++;
    // Spend-guard rule 3: the broad key only mints a single-use child capped at this call's quote.
    const child = await mintChildKey(this.net, this.parent, { model: req.model, maxSpend: req.maxCostFlop }, this.f, req.signal);
    registerSecret(child.token);
    notAborted("after the child-key mint");
    // The client parses the answer: its fetch checks the body for a number that is not finite (outside-json.ts).
    const seam = nonFiniteSeam(uaFetch(this.f));
    const client = new FlopClient({ baseURL: this.net.gateway, apiKey: child.token, fetch: seam.fetch });
    let res: Awaited<ReturnType<FlopClient["createChatCompletion"]>>;
    try {
      res = await client.createChatCompletion(
        { model: req.model, messages: req.messages, max_tokens: req.max_tokens, max_cost_flop: req.maxCostFlop } as Parameters<FlopClient["createChatCompletion"]>[0],
        { signal: req.signal, idempotencyKey: req.requestId, correlationId: req.correlationId },
      );
    } catch (e) {
      // The same error, so the same path; run.ts names the reason when the seam replaced the body.
      throw seam.met() ? withNonFiniteCause(e) : e;
    }
    const u = res.usage as CompleteRes["usage"];
    return { request_id: req.requestId, text: res.choices[0]?.message?.content ?? "", usage: u };
  }

  async readReceipt(requestId: string): Promise<ReceiptRead> {
    const seam = nonFiniteSeam(uaFetch(this.f));
    const client = new FlopClient({ baseURL: this.net.gateway, apiKey: this.parent, fetch: seam.fetch });
    try {
      const r = (await client.getCredentialReceipt(requestId)) as unknown as GatewayReceipt;
      return { http: 200, receipt: r, error: null };
    } catch (e) {
      // A body the seam replaced takes the path of a body that is not JSON, and the error says why.
      if (e instanceof FlopHTTPError) {
        const err = seam.met() ? NON_FINITE_NUMBER : ((e.body as { error?: string } | undefined)?.error ?? null);
        return { http: e.status, receipt: null, error: err };
      }
      return { http: 0, receipt: null, error: seam.met() ? notJsonBecause((e as Error).message, new NonFiniteNumber()) : (e as Error).message };
    }
  }
}
