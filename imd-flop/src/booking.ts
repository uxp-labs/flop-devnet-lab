/**
 * The booking step: the only code that reads a request's latest ledger row, decides and appends. `run`
 * (its own receipt read after the paid call) and `receipt --refresh` both book through bookRead, under one
 * ledger lock. In real use one seat has several processes at once: workers running jobs, and something
 * refreshing open receipts. Two of them can read the same request, and the gateway may answer them
 * differently. The lock makes each one decide against what the other already booked.
 * The decision itself is settlement.ts decideBooking. The network read and the receipt file write happen
 * before this step, outside the lock.
 */
import { appendLedger, latestAttempts, withLedgerLock, type LedgerEntry } from "./ledger.js";
import { bookingReason, decideBooking, reportedCost, type ReadOutcome } from "./settlement.js";

/** What the caller knows beside the read. */
export interface ReadInfo {
  /** The receipt flag of this read (key_expired), or null. It is the reason of a row this read appends. */
  flag: string | null;
  /** Only `run` knows the cost its completion reported. A refresh leaves it out and the row keeps what it records. */
  cost_reported?: number | null;
  /** Only `run` records the HTTP status of its receipt read. A refresh leaves it out and the row keeps what it records. */
  http?: number | null;
}

/**
 * What the booking step did, with the request's latest ledger row after it.
 *  - appended: a recorded field changed and one row was appended.
 *  - unchanged: nothing to record, nothing appended.
 *  - disagree: the read was not booked (settlement.ts decideBooking). The row still carries what the
 *    caller alone knows, so a row may have been appended for that.
 *  - no_row: the ledger holds no row for the request. Nothing was appended.
 */
export type BookResult = { outcome: "no_row" } | { outcome: "appended" | "unchanged" | "disagree"; row: LedgerEntry };

/** The row fields the booking step can change. A row is appended only when one of them does. */
const RECORDED = ["state", "spend", "cap_charge", "cost_reported", "http"] as const;

/**
 * Book one receipt read: under the ledger lock, read the latest row of the request, decide, and append one
 * row when a recorded field changes. The reported cost is the caller's when it has one, else the one the
 * row records. Throws what the lock or the append throws (LedgerLockError when the lock cannot be taken),
 * and then nothing was appended: the latest row stays, and with it the reservation it holds.
 */
export function bookRead(h: string, requestId: string, read: ReadOutcome, info: ReadInfo): BookResult {
  return withLedgerLock<BookResult>(h, () => {
    const prev = latestAttempts(h).find((e) => e.request_id === requestId);
    if (!prev) return { outcome: "no_row" };
    const { flag, ...own } = info;
    const known: LedgerEntry = { ...prev, ...own };
    const { booking, disagree } = decideBooking(known, read, reportedCost(known.cost_reported));
    const next: LedgerEntry = { ...known, ...booking };
    if (RECORDED.every((k) => next[k] === prev[k])) return { outcome: disagree ? "disagree" : "unchanged", row: prev };
    const row: LedgerEntry = { ...next, ts: new Date().toISOString(), reason: bookingReason(booking, flag) };
    appendLedger(h, row);
    return { outcome: disagree ? "disagree" : "appended", row };
  });
}
