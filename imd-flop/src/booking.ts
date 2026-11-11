/**
 * The booking step: the only code that reads a request's latest ledger row, decides and appends. Every
 * row written for a request after its paid call goes through it, under one ledger lock: `run`'s own
 * receipt read and `receipt --refresh` through bookRead, and what `run` saw when the call itself failed
 * through bookFailure. In real use one seat has several processes at once: workers running jobs, and
 * something refreshing open receipts. Two of them can book the same request, and the gateway may answer
 * them differently. The lock makes each one decide against what the other already booked.
 * The decisions themselves are settlement.ts decideBooking and decideFailure. The network read and the
 * receipt file write happen before this step, outside the lock.
 */
import { appendLedger, latestAttempts, withLedgerLock, type LedgerEntry } from "./ledger.js";
import { storedReportedCost } from "./response-store.js";
import { bookingReason, decideBooking, decideFailure, reportedCost, type Failure, type ReadOutcome } from "./settlement.js";

/** What the caller knows beside the read. */
export interface ReadInfo {
  /** The receipt flag of this read (key_expired), or null. It is the reason of a row this read appends. */
  flag: string | null;
  /** Only `run` knows the cost its completion reported. A refresh leaves it out (see bookRead for where the cost then comes from). */
  cost_reported?: number | null;
  /** Only `run` records the HTTP status of its receipt read. A refresh leaves it out and the row keeps what it records. */
  http?: number | null;
}

/** What `run` records beside a failure report: why the call failed, and the HTTP status if the gateway answered. */
export interface FailureInfo {
  reason: string;
  http: number | null;
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
 * The step itself. Under the ledger lock: read the latest row of the request, let `decide` say what the
 * row becomes, and append one row when a recorded field changes. Throws what the lock or the append throws
 * (LedgerLockError when the lock cannot be taken), and then nothing was appended: the latest row stays,
 * and with it the reservation it holds.
 */
function book(h: string, requestId: string, decide: (prev: LedgerEntry) => { next: LedgerEntry; disagree: boolean }): BookResult {
  return withLedgerLock<BookResult>(h, () => {
    const prev = latestAttempts(h).find((e) => e.request_id === requestId);
    if (!prev) return { outcome: "no_row" };
    const { next, disagree } = decide(prev);
    if (RECORDED.every((k) => next[k] === prev[k])) return { outcome: disagree ? "disagree" : "unchanged", row: prev };
    const row: LedgerEntry = { ...next, ts: new Date().toISOString() };
    appendLedger(h, row);
    return { outcome: disagree ? "disagree" : "appended", row };
  });
}

/**
 * Book one receipt read (settlement.ts decideBooking). The reported cost of the request is resolved here
 * and nowhere else, each through reportedCost: the caller's when it has one, else the one the row records,
 * else the one in the stored response file. So a cost is not lost when `run` could not book it. When a
 * cost is found, the row records it in cost_reported.
 */
export function bookRead(h: string, requestId: string, read: ReadOutcome, info: ReadInfo): BookResult {
  return book(h, requestId, (prev) => {
    const { flag, cost_reported: own, ...seen } = info;
    const cost = reportedCost(own) ?? reportedCost(prev.cost_reported) ?? storedReportedCost(h, requestId);
    const known: LedgerEntry = { ...prev, ...seen, cost_reported: cost ?? prev.cost_reported };
    const { booking, disagree } = decideBooking(known, read, cost);
    return { next: { ...known, ...booking, reason: bookingReason(booking, flag) }, disagree };
  });
}

/**
 * Book what `run` saw when its paid call failed (settlement.ts decideFailure). When the report is not
 * booked, because the row already settles or its charge is not a known amount, nothing is appended: the
 * reason and the HTTP status belong to the report, and are recorded only on a row the report moves.
 */
export function bookFailure(h: string, requestId: string, failure: Failure, info: FailureInfo): BookResult {
  return book(h, requestId, (prev) => {
    const booking = decideFailure(prev, failure);
    return { next: booking ? { ...prev, ...booking, ...info } : prev, disagree: false };
  });
}
