/**
 * ledger.jsonl: one line per state change of an attempt (spend-guard rule 6). The latest line for a
 * request_id wins. Tokens, keys and prompts are never written; only a prompt hash.
 * States: refused_local, sent, timeout_unknown, error, reserved, estimated, settled, released.
 * A pre-mint refusal appends refused_local (cap charge 0). That latest line supersedes the pre-call sent line.
 */
import { ledgerFile } from "./paths.js";
import { appendJsonlSafe, readJsonl } from "./store.js";
import type { Payer } from "./config.js";

export interface LedgerEntry {
  ts: string;
  day: string; // UTC date; the daily cap resets at 00:00 UTC
  request_id: string | null;
  seat: string; // NFT tokenId
  did: string | null; // the seat's FLOP did:key at call time
  job: string;
  provider: "mock" | "flop";
  network: string;
  payer: Payer;
  model: string;
  max_tokens: number;
  prompt_sha256: string;
  quote_raw: number | null;
  quote_padded: number | null;
  per_call_cap: number | null;
  daily_cap: number | null;
  job_budget: number | null;
  spent_before: number | null; // holder: today's spend; requester: this job's spend
  state: string;
  reason: string | null;
  spend: number | null; // settled spend from the receipt; null = unknown (never 0 by default)
  cost_reported: number | null; // usage.cost_flop from the completion, if any
  cap_charge: number; // what counts against the cap: spend, else cost_reported, else the padded quote
  http: number | null;
  mock: boolean;
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function appendLedger(h: string, e: LedgerEntry): void {
  appendJsonlSafe(ledgerFile(h), e, "ledger.jsonl");
}

/** Latest entry per attempt. Refusals have no request_id and never count. */
export function latestAttempts(h: string): LedgerEntry[] {
  const m = new Map<string, LedgerEntry>();
  for (const e of readJsonl<LedgerEntry>(ledgerFile(h))) if (e.request_id) m.set(e.request_id, e);
  return [...m.values()];
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function spentToday(h: string, seat: string, provider: string, day = utcDay()): number {
  return round6(
    latestAttempts(h)
      .filter((e) => e.seat === seat && e.provider === provider && e.payer === "holder" && e.day === day)
      .reduce((a, e) => a + e.cap_charge, 0),
  );
}

export function jobSpent(h: string, job: string, provider: string): number {
  return round6(
    latestAttempts(h)
      .filter((e) => e.job === job && e.provider === provider && e.payer === "requester")
      .reduce((a, e) => a + e.cap_charge, 0),
  );
}
