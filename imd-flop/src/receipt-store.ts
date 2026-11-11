/**
 * Receipt files: where they live, how they are listed and written (one secret-scan fallback), the two
 * verdicts a receipt is shown with, and the `receipt --refresh` flow that re-reads a receipt, stores it and
 * books it through the booking step (booking.ts). Behavior is pinned by
 * contract/vectors/settlement-refresh.json and failed-read.json.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT } from "./errors.js";
import { readIdentity } from "./keys.js";
import { bookRead } from "./booking.js";
import { latestAttempts, LedgerLockError, type LedgerEntry } from "./ledger.js";
import { matchable, matchReceipt, type ReceiptIds } from "./match.js";
import { receiptsDir } from "./paths.js";
import type { Provider, ReceiptRead } from "./providers.js";
import { classifyReceipt, type Classified, type MatchResult } from "./receipts.js";
import { redactFlagged } from "./secrets.js";
import { DISAGREE, isFreshRead, PAST_ADMITTED, receiptIdentity, reconcile, type ReadOutcome, type StoredReceipt } from "./settlement.js";
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

/**
 * The two verdicts a receipt is shown with, by `run`, `receipt <id>` and `status` alike. `match` is the
 * identity verdict (match.ts). `status` is the DISAGREE text, set only when the stored receipt and the
 * latest ledger row of its request disagree (settlement.ts reconcile). Both are worked out from the files
 * each time and are never stored.
 */
export async function receiptVerdicts(h: string, receipt: (ReceiptIds & StoredReceipt) | null, row: LedgerEntry | null): Promise<{ match: MatchResult; status?: string }> {
  const match = await matchReceipt(h, receipt, row);
  return reconcile(row, receipt) === "disagree" ? { match, status: DISAGREE } : { match };
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

/**
 * The fields of a stored receipt that come from the gateway's receipt. A failed read brings none of them, so
 * it keeps every one as stored (null when there is none), and chain_final stays as stored too. Losing
 * channel_id on a failed read would lose the key that later ties the receipt to the chain's events.
 */
const GATEWAY_FIELDS = ["request_id", "correlation_id", "state", "reserved", "settled", "settled_raw", "terminal_event", "channel_id"] as const;

/** The receipt file body after a re-read. A failed read keeps what was stored (GATEWAY_FIELDS, chain_final) and says when it was last known. */
function bodyAfterRead(saved: SavedReceipt | null, ident: Record<string, unknown>, c: Classified, read: { fresh: boolean; rawId: unknown; identityOk: boolean }): Record<string, unknown> {
  if (read.fresh) {
    return { ...ident, ...saved, ...c, request_id: typeof read.rawId === "string" ? read.rawId : "", ...(read.identityOk ? {} : { settled: null, chain_final: false }) };
  }
  const kept = Object.fromEntries(GATEWAY_FIELDS.map((k) => [k, saved?.[k] ?? (k === "request_id" ? "" : null)]));
  return { ...ident, ...saved, ...c, ...kept, chain_final: saved?.chain_final ?? false, last_known_at: saved?.observed_at ?? null };
}

/** The stored receipt file as an object, or null when there is none or it is not a JSON object. A file that cannot be read is not merged. */
function storedBody(path: string): SavedReceipt | null {
  try {
    const body = readJson<unknown>(path);
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as SavedReceipt) : null;
  } catch {
    return null;
  }
}

/**
 * The one owner of what a receipt file holds after a read, for `run`'s own read and `receipt --refresh`
 * alike. It reads the stored file just before it writes, and merges the read into it (bodyAfterRead): a
 * fresh read brings its own gateway fields, and a failed read keeps every gateway field the stored file
 * holds. `seed` gives the identity fields (seat, did, ss58, network) to write when the caller has them to
 * add; a value the stored file already holds wins. The file is written outside the ledger lock, so two
 * reads at once leave the one written last. Returns the body as written (after any redaction) and what
 * the read tells the booking step.
 */
export function storeRead(h: string, rid: string, rr: ReceiptRead, c: Classified, seed: (stored: SavedReceipt | null) => Record<string, unknown>): { saved: SavedReceipt; read: ReadOutcome } {
  const path = receiptPath(h, rid);
  const stored = storedBody(path);
  const fresh = isFreshRead(rr);
  const { rawId, identityOk } = fresh ? receiptIdentity(rr.receipt, rid) : { rawId: undefined, identityOk: false };
  const written = writeReceipt(path, bodyAfterRead(stored, seed(stored), c, { fresh, rawId, identityOk }));
  const saved = written.body as SavedReceipt;
  return { saved, read: { fresh, identityOk, redacted: written.redacted, state: saved.state ?? null, settled: saved.settled, settledRaw: saved.settled_raw } };
}

/**
 * What `receipt --refresh` prints on stderr when it could not take the ledger lock: another process held
 * it. The read is stored and nothing is booked. That is not a disagreement, so it is not the DISAGREE line.
 */
export const LEDGER_BUSY = "ledger busy; the receipt read was stored and nothing was booked";

/**
 * `receipt <id> --refresh`: read the receipt again, store it, and book what it proves through the booking
 * step, against the latest ledger row of the request. `warn` receives one line when the read is not
 * booked: LEDGER_BUSY when the ledger lock could not be taken (LedgerLockError), and DISAGREE when the
 * booking step refused the read or threw anything else, a failed append for one. It also receives
 * PAST_ADMITTED when the booking puts the day in a state the cap did not admit. Whether the stored receipt
 * and the ledger disagree afterwards is not decided here: receiptVerdicts reads it from the files.
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
  // No file yet, or an older file without seat/did (716819c era): seed them from the ledger row. Stored values win.
  const seed = (file: SavedReceipt | null) => {
    const lacksIdentity = !file || (ledgerRow !== undefined && (!present(file.seat) || !present((file as { did?: unknown }).did)));
    return lacksIdentity && ledgerRow !== undefined ? identityFromLedger(h, ledgerRow) : {};
  };
  const { saved, read } = storeRead(h, rid, rr, c, seed);

  try {
    const booked = bookRead(h, rid, read, { flag: saved.flag ?? null });
    if (booked.outcome === "no_row") return { saved, ledgerRow: undefined };
    // Disagree: a read below a booked settlement, or an unknown charge with no proven settlement (never substitute 0).
    if (booked.outcome === "disagree") warn(DISAGREE);
    if (booked.pastAdmitted) warn(PAST_ADMITTED);
    return { saved, ledgerRow: booked.row };
  } catch (e) {
    // The booking step could not run. The read is stored and not booked, and the latest row keeps its
    // reservation. A lock that could not be taken says nothing about the read, so it gets its own line.
    // Any other exception, a failed append for one, may mean a booking was due and is not in the ledger.
    const ledgerRow = latestAttempts(h).find((row) => row.request_id === rid);
    warn(e instanceof LedgerLockError ? `${LEDGER_BUSY} (${e.message})` : DISAGREE);
    return { saved, ledgerRow };
  }
}
