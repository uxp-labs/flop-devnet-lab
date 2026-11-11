/**
 * Receipt files: where they live, how they are listed and written (one secret-scan fallback), and the
 * `receipt --refresh` flow that re-reads a receipt, stores it and books it through the booking step
 * (booking.ts). Behavior is pinned by contract/vectors/settlement-refresh.json and failed-read.json.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT } from "./errors.js";
import { readIdentity } from "./keys.js";
import { bookRead } from "./booking.js";
import { latestAttempts, type LedgerEntry } from "./ledger.js";
import { matchable } from "./match.js";
import { receiptsDir } from "./paths.js";
import type { Provider } from "./providers.js";
import { classifyReceipt, type Classified } from "./receipts.js";
import { redactFlagged } from "./secrets.js";
import { DISAGREE, isFreshRead, receiptIdentity } from "./settlement.js";
import { readJson, writeJsonSafe } from "./store.js";

export type SavedReceipt = Classified & { seat: string; mock_scenario?: string };

export const receiptPath = (h: string, requestId: string): string => join(receiptsDir(h), `${requestId}.json`);

export function readSavedReceipt(h: string, requestId: string): SavedReceipt | null {
  return readJson<SavedReceipt>(receiptPath(h, requestId));
}

/**
 * One receipt file as a receipt that can be listed, or null when it cannot: it is not JSON, it is not a
 * JSON object, or its seat is one matchReceipt cannot use (match.ts matchable).
 */
function readReceiptFile(path: string): Classified | null {
  try {
    const body = readJson<unknown>(path);
    return body !== null && typeof body === "object" && !Array.isArray(body) && matchable(body) ? (body as Classified) : null;
  } catch {
    return null;
  }
}

const observedAt = (c: Classified): string => (typeof c.observed_at === "string" ? c.observed_at : "");

/**
 * Every receipt that can be read and matched, newest first, and the names of the receipt files that
 * cannot (see readReceiptFile). Such a file is named and never hides the others.
 */
export function listReceipts(h: string): { receipts: Classified[]; unreadable: string[] } {
  const dir = receiptsDir(h);
  if (!existsSync(dir)) return { receipts: [], unreadable: [] };
  const receipts: Classified[] = [];
  const unreadable: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const receipt = readReceiptFile(join(dir, name));
    if (receipt) receipts.push(receipt);
    else unreadable.push(name);
  }
  receipts.sort((a, b) => observedAt(b).localeCompare(observedAt(a)));
  return { receipts, unreadable: unreadable.sort() };
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
 * `receipt <id> --refresh`: read the receipt again, store it, and book what it proves through the booking
 * step, against the latest ledger row of the request. `warn` receives the DISAGREE line when the read is
 * not booked: the booking step refused it, or the step could not run.
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
  const saved = written.body as SavedReceipt;
  const refused = (row: LedgerEntry | undefined) => {
    warn(DISAGREE);
    return { saved: { ...saved, status: DISAGREE } as SavedReceipt, ledgerRow: row };
  };

  try {
    const booked = bookRead(h, rid, { fresh, identityOk, redacted: written.redacted, state: saved.state ?? null, settled: saved.settled }, { flag: saved.flag ?? null });
    if (booked.outcome === "no_row") return { saved, ledgerRow: undefined };
    // Disagree: a read below a booked settlement, or an unknown charge with no proven settlement (never substitute 0).
    return booked.outcome === "disagree" ? refused(booked.row) : { saved, ledgerRow: booked.row };
  } catch {
    // The booking step could not run: the ledger lock could not be taken, or the append failed. The read
    // is stored and not booked, and the latest row keeps its reservation.
    return refused(latestAttempts(h).find((e) => e.request_id === rid));
  }
}
