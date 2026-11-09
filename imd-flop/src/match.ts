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

export interface ReceiptIds {
  job: string | null;
  seat?: string | null;
  did?: string | null;
  correlation_id?: string | null;
}

export async function matchReceipt(h: string, receipt: ReceiptIds | null, row: LedgerEntry | null): Promise<MatchResult> {
  if (!receipt) return { match: "pending", fields: [] };
  const fields: string[] = [];
  if (!row) fields.push("ledger_row_missing");
  else {
    if (receipt.job !== row.job) fields.push("job");
    if (receipt.seat !== row.seat) fields.push("seat");
    if (!receipt.did || receipt.did !== row.did) fields.push("did");
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
