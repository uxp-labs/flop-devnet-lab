/**
 * The booking step: the only code that reads a request's latest ledger row, decides and appends. Every
 * row written for a request after its paid call goes through it, under one ledger lock: `run`'s own
 * receipt read and `receipt --refresh` through bookRead, and what `run` saw when the call itself failed
 * through bookFailure. In real use one seat has several processes at once: workers running jobs, and
 * something refreshing open receipts. Two of them can book the same request, and the gateway may answer
 * them differently. The lock makes each one decide against what the other already booked.
 * When the ledger no longer holds the request's row (the file was moved or removed during the call), `run`
 * gives the step the row it wrote before the call as a seed, and the step writes it again under the same
 * lock before it decides, marked PAST_ADMITTED (calls admitted meanwhile did not count it). So `run` appends no
 * ledger row of its own after the paid call. Every row it appends for a request already booked past what the
 * cap admitted keeps that mark (settlement.ts carryPastAdmitted).
 * The decisions themselves are settlement.ts decideBooking and decideFailure. The network read and the
 * receipt file write happen before this step, outside the lock.
 */
import { appendLedger, latestAttempts, withLedgerLock, type LedgerEntry } from "./ledger.js";
import { storedReportedCost } from "./response-store.js";
import { bookingReason, carriesPastAdmitted, carryPastAdmitted, decideBooking, decideFailure, keptReason, reportedCost, type Failure, type ReadOutcome } from "./settlement.js";

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
 *  - recorded: the failure report was not booked (settlement.ts decideFailure). One row was appended that
 *    keeps state, spend and charge exactly and records the report in reason and http.
 *  - no_row: the ledger holds no row for the request and the caller gave no seed row. Nothing was appended.
 */
export type BookResult = { outcome: "no_row" } | Booked;
/**
 * What the booking step did when the ledger held a row for the request, or was given a seed row for it.
 * pastAdmitted: the appended row puts the day in a state the cap did not admit (settlement.ts
 * decideBooking). The caller prints settlement.ts PAST_ADMITTED on stderr; the row's reason already records it.
 */
export type Booked = { outcome: "appended" | "unchanged" | "disagree" | "recorded"; row: LedgerEntry; pastAdmitted: boolean };

/**
 * The row fields the booking step can change. A row is appended when one of them does, or when it records a
 * report. spend_raw is the exact spend (money stage 1): an exact amount that arrives on a later read is a
 * recorded change, and a row that lacks the field stays as it is until a read sets it. receipt_seen (the
 * hold floor) is set by a trusted read that leaves the row in state sent.
 */
const RECORDED = ["state", "spend", "cap_charge", "spend_raw", "receipt_seen", "cost_reported", "http"] as const;

/**
 * The step itself. Under the ledger lock: read the latest row of the request, or write the seed row when
 * there is none and the caller gave one, let `decide` say what the row becomes, and append one row when a
 * recorded field changes or `decide` records a report that was not booked. Throws what the lock or the append throws (LedgerLockError when the lock cannot
 * be taken), and then no booking was appended: the latest row stays, and with it the reservation it holds.
 */
function book(h: string, requestId: string, seed: LedgerEntry | undefined, decide: (prev: LedgerEntry) => { next: LedgerEntry; disagree?: boolean; recorded?: boolean; pastAdmitted?: boolean }): BookResult {
  return withLedgerLock<BookResult>(h, () => {
    let prev = latestAttempts(h).find((e) => e.request_id === requestId);
    // The ledger lost the request's row: calls admitted meanwhile did not count it. Writing it again raises
    // the request's charge from nothing, so it is a booking past what the cap admitted.
    let seeded = false;
    if (!prev && seed) {
      prev = { ...seed, reason: carryPastAdmitted(seed.reason, true) };
      appendLedger(h, prev);
      seeded = true;
    }
    if (!prev) return { outcome: "no_row" };
    const decided = decide(prev);
    const { disagree = false, recorded = false } = decided;
    const pastAdmitted = seeded || decided.pastAdmitted === true;
    // The one carry: every later row of a request booked past what the cap admitted keeps the mark.
    const next: LedgerEntry = { ...decided.next, reason: carryPastAdmitted(decided.next.reason, decided.pastAdmitted === true || carriesPastAdmitted(prev.reason)) };
    if (!recorded && RECORDED.every((k) => next[k] === prev[k])) return { outcome: disagree ? "disagree" : "unchanged", row: prev, pastAdmitted: seeded };
    const row: LedgerEntry = { ...next, ts: new Date().toISOString() };
    appendLedger(h, row);
    return { outcome: recorded ? "recorded" : disagree ? "disagree" : "appended", row, pastAdmitted };
  });
}

/**
 * Book one receipt read (settlement.ts decideBooking). The reported cost of the request is resolved here
 * and nowhere else, each through reportedCost: the caller's when it has one, else the one the row records,
 * else the one in the stored response file. So a cost is not lost when `run` could not book it. When a
 * cost is found, the row records it in cost_reported. `seed` is written first when the ledger holds no row
 * for the request (see the header).
 */
export function bookRead(h: string, requestId: string, read: ReadOutcome, info: ReadInfo, seed: LedgerEntry): Booked;
export function bookRead(h: string, requestId: string, read: ReadOutcome, info: ReadInfo, seed?: LedgerEntry): BookResult;
export function bookRead(h: string, requestId: string, read: ReadOutcome, info: ReadInfo, seed?: LedgerEntry): BookResult {
  return book(h, requestId, seed, (prev) => {
    const { flag, cost_reported: own, ...seen } = info;
    const cost = reportedCost(own) ?? reportedCost(prev.cost_reported) ?? storedReportedCost(h, requestId);
    const known: LedgerEntry = { ...prev, ...seen, cost_reported: cost ?? prev.cost_reported };
    const { booking, disagree, pastAdmitted } = decideBooking(known, read, cost);
    const next = { ...known, ...booking };
    return { next: { ...next, reason: bookingReason(next, flag, pastAdmitted) }, disagree, pastAdmitted };
  });
}

/**
 * Book what `run` saw when its paid call failed (settlement.ts decideFailure). A booked report records
 * `run`'s reason and HTTP status on the row it moves. A report that is not booked (the row settles, a
 * trusted read beat "nothing was sent", or the charge is not a known amount) is still recorded: one row
 * keeps state, spend and charge exactly, with the report in its reason (settlement.ts keptReason) and http.
 * `seed` is written first when the ledger holds no row for the request (see the header).
 */
export function bookFailure(h: string, requestId: string, failure: Failure, info: FailureInfo, seed: LedgerEntry): Booked;
export function bookFailure(h: string, requestId: string, failure: Failure, info: FailureInfo, seed?: LedgerEntry): BookResult;
export function bookFailure(h: string, requestId: string, failure: Failure, info: FailureInfo, seed?: LedgerEntry): BookResult {
  return book(h, requestId, seed, (prev) => {
    const booking = decideFailure(prev, failure);
    if (booking) return { next: { ...prev, ...booking, ...info } };
    return { next: { ...prev, reason: keptReason(failure, prev), http: info.http }, recorded: true };
  });
}
