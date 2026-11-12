/**
 * The mock provider: a local OpenAI-shaped stub. Deterministic output, a fake request_id and a fake receipt,
 * no key, no network, no spend.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Estimate } from "../gateway.js";
import type { CompleteReq, CompleteRes, Provider, ReceiptRead } from "./interface.js";

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

