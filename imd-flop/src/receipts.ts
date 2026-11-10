/**
 * Receipt rules, ported from spend-guard/guard.py classify_receipt and receipts.py, matching the viewer:
 *  - stage is "gateway observed" until chain settlement is checked (never "gateway settled");
 *  - chain_final is false unless verified (nothing verifies it yet: InferenceReceipt not observed);
 *  - settled_spend counts only when it is finite and >= 0; null, negative, and non-finite stay null and show blank, never 0;
 *  - a 401 api_key_expired gets its own key_expired flag (and keeps the last known receipt).
 */
export interface GatewayReceipt {
  request_id: string;
  correlation_id?: string;
  model?: string;
  reserved_spend?: number | null;
  settled_spend?: number | null;
  settled_spend_raw?: string | null;
  terminal_event?: string | null;
  channel_id?: string | null;
  created_at?: number;
  state?: "reserved" | "estimated" | "settled" | "released" | null;
  response_status?: number | null;
}

export const STAGE_GATEWAY = "gateway observed";
export const STAGE_CHAIN = "settled on chain";

export interface Classified {
  request_id: string;
  correlation_id: string | null;
  job: string | null;
  provider: string;
  state: string | null;
  reserved: number | null;
  settled: number | null; // null = unknown, shown blank
  settled_raw: string | null;
  stage: string;
  chain_final: boolean;
  terminal_event: string | null;
  flag: "key_expired" | null;
  http: number | null;
  error: string | null;
  observed_at: string;
  mock: boolean;
}

/** A known settlement is a finite amount >= 0. Negative, non-finite, and non-numeric values are unknown, not zero. */
export function knownSettledSpend(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function classifyReceipt(
  r: GatewayReceipt | null,
  ctx: { job: string | null; provider: string; http?: number; error?: string | null; requestId?: string; chainVerified?: boolean; mock?: boolean },
): Classified {
  const err = ctx.error ?? null;
  return {
    request_id: r?.request_id ?? ctx.requestId ?? "",
    correlation_id: r?.correlation_id ?? null,
    job: ctx.job,
    provider: ctx.provider,
    state: r?.state ?? null,
    reserved: typeof r?.reserved_spend === "number" ? r.reserved_spend : null,
    settled: knownSettledSpend(r?.settled_spend),
    settled_raw: r?.settled_spend_raw ?? null,
    stage: ctx.chainVerified === true ? STAGE_CHAIN : STAGE_GATEWAY,
    chain_final: ctx.chainVerified === true, // terminal_event may be pooled; not proof of finality
    terminal_event: r?.terminal_event ?? null,
    flag: ctx.http === 401 && err === "api_key_expired" ? "key_expired" : null,
    http: ctx.http ?? null,
    error: err,
    observed_at: new Date().toISOString(),
    mock: ctx.mock === true,
  };
}

/** Display rule: unknown spend is blank, never 0. */
export const blank = (v: number | null | undefined): string => (typeof v === "number" ? String(v) : "");

export function receiptLine(c: Classified): string {
  const parts = [
    c.request_id,
    `job=${c.job ?? ""}`,
    `state=${c.state ?? ""}`,
    `reserved=${blank(c.reserved)}`,
    `settled=${blank(c.settled)}`,
    `stage=${c.stage}`,
    `chain_final=${c.chain_final}`,
  ];
  if (c.flag) parts.push(`flag=${c.flag}`);
  const m = (c as { match?: MatchResult }).match;
  if (m) parts.push(`match=${m.match}${m.fields.length ? `(${m.fields.join(",")})` : ""}`);
  if (c.mock) parts.push("[MOCK]");
  return parts.join("  ");
}

export interface MatchResult {
  match: "matches" | "mismatch" | "pending";
  fields: string[]; // which fields disagree (mismatch only)
}
