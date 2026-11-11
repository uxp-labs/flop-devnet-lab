/**
 * Response files: one per completed call, responses/<request_id>.json. `run` writes it after its call and
 * before it reads the receipt. The booking step (booking.ts) reads back the cost it reports.
 */
import { join } from "node:path";
import { responsesDir } from "./paths.js";
import { reportedCost } from "./settlement.js";
import { readJson } from "./store.js";

export const responsePath = (h: string, requestId: string): string => join(responsesDir(h), `${requestId}.json`);

/**
 * The cost the stored response of a request reports: its usage.cost_flop, through reportedCost. Null when
 * the file is missing, cannot be read or parsed, or has no usable cost. Never 0 in place of a cost.
 */
export function storedReportedCost(h: string, requestId: string): number | null {
  try {
    const body = readJson<{ usage?: { cost_flop?: unknown } | null } | null>(responsePath(h, requestId));
    return reportedCost(body?.usage?.cost_flop);
  } catch {
    return null;
  }
}
