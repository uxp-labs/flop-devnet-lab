/**
 * Receipt <-> ledger <-> link agreement. A receipt "matches" only when its job, seat tokenId and DID
 * equal the ledger row for the same request_id AND the seat's current, verifying link
 * (statement.tokenId and statement.flopDid). Anything else is "mismatch" with the fields named,
 * and is never displayed as OK. No receipt yet is "pending".
 */
import { linkFile } from "./paths.js";
import { readJson } from "./store.js";
import { verifyLink, type LinkFile } from "./link.js";
import { revokedDids } from "./keys.js";
import type { LedgerEntry } from "./ledger.js";
import type { MatchResult } from "./receipts.js";

export const RECEIPT_IDENTITY_STATUS = "receipt identity mismatch; chain-final green blocked";

export interface ReceiptIds {
  job: string | null;
  seat?: string | null;
  did?: string | null;
  correlation_id?: string | null;
  request_id?: string | null;
}

/**
 * Whether a stored receipt can be handed to matchReceipt. matchReceipt builds the link path from the
 * receipt's seat, so the seat must be a string when there is one. A number or an object in its place makes
 * matchReceipt throw (quirk Q-IDENTITY-FIELDS). The other identity fields are only compared.
 */
export function matchable(receipt: { seat?: unknown }): boolean {
  return receipt.seat === undefined || receipt.seat === null || typeof receipt.seat === "string";
}

export async function matchReceipt(h: string, receipt: ReceiptIds | null, row: LedgerEntry | null): Promise<MatchResult> {
  if (!receipt) return { match: "pending", fields: [] };
  const fields: string[] = [];
  if (!row) fields.push("ledger_row_missing");
  else {
    if (receipt.job !== row.job) fields.push("job");
    if (receipt.seat !== row.seat) fields.push("seat");
    if (!receipt.did || receipt.did !== row.did) fields.push("did");
    const sameId = typeof receipt.request_id === "string" && receipt.request_id.length > 0 && receipt.request_id === row.request_id;
    if (!sameId) fields.push(RECEIPT_IDENTITY_STATUS);
  }
  // The gateway echoes our X-Correlation-ID; it must name the same job.
  if (receipt.job && receipt.correlation_id && receipt.correlation_id !== `imd-job-${receipt.job}`) fields.push("job(correlation_id)");
  const seat = receipt.seat ?? row?.seat ?? null;
  const lf = seat ? readJson<LinkFile>(linkFile(h, seat)) : null;
  if (!lf) fields.push("link_missing");
  else {
    const v = await verifyLink(lf);
    if (!v.ok) fields.push("link_invalid");
    if (lf.statement.tokenId !== receipt.seat) fields.push("seat(link)");
    if (lf.statement.flopDid !== receipt.did) fields.push("did(link)");
    if (revokedDids(h).has(lf.statement.flopDid)) fields.push("did(revoked)");
  }
  return fields.length ? { match: "mismatch", fields } : { match: "matches", fields: [] };
}
