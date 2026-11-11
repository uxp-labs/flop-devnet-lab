/**
 * Receipt files: where they live, how they are written (one secret-scan fallback), and the
 * `receipt --refresh` flow that re-reads a receipt and books the result through settlement.ts.
 * Behavior is pinned by contract/vectors/settlement-refresh.json and failed-read.json.
 */
import { join } from "node:path";
import { CliError, EXIT } from "./errors.js";
import { readIdentity } from "./keys.js";
import { appendLedger, latestAttempts, type LedgerEntry } from "./ledger.js";
import { receiptsDir } from "./paths.js";
import type { Provider } from "./providers.js";
import { classifyReceipt, type Classified } from "./receipts.js";
import { redactFlagged } from "./secrets.js";
import { bookingReason, DISAGREE, isFreshRead, receiptIdentity, refreshBooking } from "./settlement.js";
import { readJson, writeJsonSafe } from "./store.js";

export type SavedReceipt = Classified & { seat: string; mock_scenario?: string };

export const receiptPath = (h: string, requestId: string): string => join(receiptsDir(h), `${requestId}.json`);

export function readSavedReceipt(h: string, requestId: string): SavedReceipt | null {
  return readJson<SavedReceipt>(receiptPath(h, requestId));
}

/**
 * Write a receipt file. If the write is refused (secret scan), null only the flagged fields and write that.
 * If redaction cannot clear the scan, refuse (exit 5) rather than write anything.
 */
export function writeReceipt(path: string, body: unknown): { body: unknown; redacted: boolean } {
  try {
    writeJsonSafe(path, body, "receipt");
    return { body, redacted: false };
  } catch {
    const r = redactFlagged(body);
    if (r.residual.length > 0) throw new CliError("secret scan blocked writing receipt and redaction could not clear it", EXIT.REFUSED_RULE);
    writeJsonSafe(path, r.copy, "receipt");
    return { body: r.copy, redacted: true };
  }
}

const present = (v: unknown): boolean => typeof v === "string" && v.length > 0;

/**
 * A timeout leaves a ledger row but no receipt file. Take the seat identity from that row (what run recorded
 * at call time), never from the gateway, so the first receipt file is not a permanent mismatch.
 */
function identityFromLedger(h: string, row: LedgerEntry): Record<string, unknown> {
  const id = readIdentity(h, row.seat);
  return { seat: row.seat, did: row.did, ss58: id && id.did === row.did ? id.ss58 : null, network: row.network };
}

/** The receipt file body after a re-read. A failed read keeps what was stored, including its request_id. */
function refreshedBody(saved: SavedReceipt | null, ident: Record<string, unknown>, c: Classified, read: { fresh: boolean; rawId: unknown; identityOk: boolean }): Record<string, unknown> {
  if (read.fresh) {
    return { ...ident, ...saved, ...c, request_id: typeof read.rawId === "string" ? read.rawId : "", ...(read.identityOk ? {} : { settled: null, chain_final: false }) };
  }
  return { ...ident, ...saved, ...c, request_id: saved?.request_id ?? "", state: saved?.state ?? null, reserved: saved?.reserved ?? null, settled: saved?.settled ?? null, chain_final: saved?.chain_final ?? false, last_known_at: saved?.observed_at ?? null };
}

/**
 * `receipt <id> --refresh`: read the receipt again, store it, and book what it proves against the latest
 * ledger row. `warn` receives the DISAGREE line when the ledger cannot be reconciled.
 */
export async function refreshReceipt(
  h: string,
  rid: string,
  provider: Provider,
  current: { saved: SavedReceipt | null; ledgerRow: LedgerEntry | undefined },
  warn: (s: string) => void,
): Promise<{ saved: SavedReceipt; ledgerRow: LedgerEntry | undefined }> {
  const { saved: stored, ledgerRow } = current;
  const pname = stored?.provider ?? ledgerRow!.provider;
  const rr = await provider.readReceipt(rid);
  const c = classifyReceipt(rr.receipt, { job: stored?.job ?? ledgerRow?.job ?? null, provider: pname, http: rr.http, error: rr.error, requestId: rid, mock: pname === "mock" });
  const fresh = isFreshRead(rr);
  const { rawId, identityOk } = fresh ? receiptIdentity(rr.receipt, rid) : { rawId: undefined, identityOk: false };
  // No file yet, or an older file without seat/did (716819c era): seed them from the ledger row. Stored values win.
  const lacksIdentity = !stored || (ledgerRow !== undefined && (!present(stored.seat) || !present((stored as { did?: unknown }).did)));
  const ident = lacksIdentity ? identityFromLedger(h, ledgerRow!) : {};
  const written = writeReceipt(receiptPath(h, rid), refreshedBody(stored, ident, c, { fresh, rawId, identityOk }));
  let saved = written.body as SavedReceipt;

  const prev = latestAttempts(h).find((e) => e.request_id === rid);
  if (!prev) return { saved, ledgerRow };
  const next = refreshBooking(prev, { fresh, identityOk, redacted: written.redacted, state: saved?.state ?? null, settled: saved?.settled });
  const disagree = () => {
    warn(DISAGREE);
    saved = { ...saved, status: DISAGREE } as SavedReceipt;
  };
  // Disagree: an unknown charge with no exact-identity settlement (never substitute 0), or a read below a booked settlement.
  if (next.kind === "disagree") disagree();
  else if (next.kind === "append") {
    try {
      appendLedger(h, { ...prev, ts: new Date().toISOString(), state: next.booking.state, reason: bookingReason(next.booking, saved?.flag ?? null), spend: next.booking.spend, cap_charge: next.booking.cap_charge });
    } catch {
      disagree();
    }
  }
  return { saved, ledgerRow: latestAttempts(h).find((e) => e.request_id === rid) };
}
