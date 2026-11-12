/**
 * What the run path and the receipt refresh use of a provider. The facts about a provider (paid, mock, needs a
 * wallet link) are not members: they come from the table in kinds.ts by the provider's name.
 */
import type { Estimate } from "../gateway.js";
import type { GatewayReceipt } from "../receipts.js";
import type { ProviderName } from "./kinds.js";

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
  readonly name: ProviderName;
  /** A mock's scenario. The run path writes it to the receipt file (mock_scenario), so a refresh makes the same mock. */
  readonly scenario?: string;
  estimate(body: { model: string; prompt: string; max_tokens: number }): Promise<Estimate>;
  complete(req: CompleteReq): Promise<CompleteRes>;
  readReceipt(requestId: string): Promise<ReceiptRead>;
  calls: number; // complete() invocations, so tests can prove "no retry"
}
