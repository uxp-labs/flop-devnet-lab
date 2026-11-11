/**
 * Reservation and settlement: the one copy of the rules that turn a receipt read into the next ledger
 * booking (decideBooking), the rules for what `run` reports when its paid call fails (decideFailure), and
 * the one verdict for a stored receipt beside the latest ledger row of its request (reconcile). Pure: no
 * file, network or ledger access. `run` (after its call) and `receipt --refresh` both book through
 * decideBooking, and `run` books a failed call through decideFailure, all in booking.ts. `run`,
 * `receipt <id>` and `status` all show the reconcile verdict. Behavior is pinned by
 * contract/vectors/settlement-run.json, settlement-refresh.json and reconcile.json, and the properties of
 * the two decisions by test/decision-properties.test.ts.
 */
import { knownAmount } from "./amount.js";

/**
 * Receipt states that settle an attempt. Per the gateway's OpenAPI (CredentialReceipt), read 2026-11-11:
 * `reserved` (quota held, no completion checkpoint) and `estimated` (reservation kept after completion, no
 * reconciled spend) are unresolved. `settled` (spend reconciled) and `released` (reservation returned to
 * quota) are terminal ledger states.
 */
export const SETTLES: ReadonlySet<string> = new Set(["settled", "released"]);
/** Shown (stderr, receipt status) when the ledger cannot be reconciled with the receipt. Same text as the viewer. */
export const DISAGREE = "receipt and ledger disagree; reservation held, chain-final green blocked";

/** A fresh read is an HTTP 200 answer carrying a receipt object. */
export function isFreshRead(rr: { http: unknown; receipt: unknown }): boolean {
  return rr.http === 200 && rr.receipt !== null && typeof rr.receipt === "object";
}

/**
 * Identity is decided on the raw gateway receipt: its own request_id must be a non-empty string equal to
 * ours. The classifier's requestId fallback never decides identity, settlement or the stored request_id.
 */
export function receiptIdentity(receipt: unknown, requestId: string | null): { rawId: unknown; identityOk: boolean } {
  const rawId = receipt && typeof receipt === "object" ? (receipt as { request_id?: unknown }).request_id : undefined;
  return { rawId, identityOk: typeof rawId === "string" && rawId.length > 0 && rawId === requestId };
}

/** The identity fields a stored receipt and a ledger row both carry. A file can hold anything in them. */
export interface AttemptIds {
  request_id?: unknown;
  job?: unknown;
  seat?: unknown;
  did?: unknown;
}

/**
 * The identity fields of a stored receipt that differ from a ledger row, in this order: job, seat, did,
 * request_id. Empty when the receipt is for the row's attempt. The job and the seat must be equal, the DID
 * must be there and equal, and the request id follows receiptIdentity. match.ts builds the `match` verdict
 * on this. reconcile uses the viewer's stricter rule, sameAttempt.
 */
export function identityDiff(receipt: AttemptIds, row: AttemptIds): ("job" | "seat" | "did" | "request_id")[] {
  const diff: ("job" | "seat" | "did" | "request_id")[] = [];
  if (receipt.job !== row.job) diff.push("job");
  if (receipt.seat !== row.seat) diff.push("seat");
  if (!receipt.did || receipt.did !== row.did) diff.push("did");
  if (!receiptIdentity(receipt, typeof row.request_id === "string" ? row.request_id : null).identityOk) diff.push("request_id");
  return diff;
}

const present = (v: unknown): boolean => typeof v === "string" && v.length > 0;

/**
 * The viewer's identity rule for a stored receipt beside a ledger row (build-lane.py identity_ok): the
 * request_id, job, seat and did are each a non-empty string on both sides, and equal. It is stricter than
 * identityDiff, where a job or a seat that is null on both sides is equal; `match` keeps that rule.
 */
function sameAttempt(receipt: AttemptIds, row: AttemptIds): boolean {
  return (["request_id", "job", "seat", "did"] as const).every((k) => present(receipt[k]) && present(row[k]) && receipt[k] === row[k]);
}

/** What a receipt read tells the ledger. `fresh`, `identityOk` and `redacted` say whether it may prove a settlement. */
export interface ReadOutcome {
  fresh: boolean;
  identityOk: boolean;
  /** The stored copy of this receipt had to be redacted by the secret scan. */
  redacted: boolean;
  state: string | null;
  settled: unknown;
}

/**
 * A read is trusted only when it is fresh, identity-matched and stored without redaction. A receipt body
 * that had to be redacted never proves a settlement and never moves the state.
 */
function trustedRead(o: ReadOutcome): boolean {
  return o.fresh && o.identityOk && !o.redacted;
}

/**
 * A known settlement: a trusted read in a settling state with a finite spend >= 0 (explicit 0 included).
 * The spend is the receipt's settled_spend. Per the gateway's OpenAPI (CredentialReceipt), read 2026-11-11,
 * that field is a number or null from the gateway's legacy floating point ledger, and null means unknown,
 * including for a released reservation. So a settling state with no amount books no spend, and never 0.
 */
export function settledSpend(o: ReadOutcome): number | null {
  return trustedRead(o) && o.state !== null && SETTLES.has(o.state) ? knownAmount(o.settled) : null;
}

/**
 * The ledger fields a read can change. C is the type of the cap charge: a number on a row this program
 * wrote, and whatever the file holds on a row that was read back.
 */
export interface Booking<C = number> {
  state: string;
  spend: number | null;
  cap_charge: C;
}

/** usage.cost_flop as the completion reported it. It counts only when it is a finite number. Recorded, never a settlement. */
export function reportedCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A reported cost may raise a charge, never lower it: a hold and a proven settlement alike. */
function raisedBy(charge: number, costReported: number | null): number {
  return costReported !== null ? Math.max(charge, costReported) : charge;
}

/**
 * A booked known settlement is never lowered by a later read. True when the row is in a settling state
 * with a known spend and a trusted read settles below it.
 */
function lowersSettlement(prev: { state: string; spend: unknown }, o: ReadOutcome): boolean {
  const booked = SETTLES.has(prev.state) ? knownAmount(prev.spend) : null;
  const settled = settledSpend(o);
  return booked !== null && settled !== null && settled < booked;
}

/** The state after a read. Only a trusted read moves it, and never from a settling state to a non settling one. */
function stateAfter(prev: string, o: ReadOutcome): string {
  if (!trustedRead(o) || o.state === null) return prev;
  return SETTLES.has(prev) && !SETTLES.has(o.state) ? prev : o.state;
}

/** The previous row as decideBooking sees it: its booking and its padded quote. */
export interface PrevBooking<C> extends Booking<C> {
  /** The hold of the request, as the row records it. A file can hold anything in it. */
  quote_padded: unknown;
}

/**
 * The charge held when no settlement is booked from a read: the booked charge, or null when that is not a
 * known amount. One exception: a trusted read that moves a refused_local row shows the gateway holds the
 * request after all, so the reservation comes back. That hold is the row's padded quote, or null when the
 * padded quote is not a known amount.
 */
function heldCharge(prev: PrevBooking<unknown>, state: string): number | null {
  const booked = knownAmount(prev.cap_charge);
  return booked !== null && prev.state === "refused_local" && state !== prev.state ? knownAmount(prev.quote_padded) : booked;
}

/** What a read does to a booking: the next booking, and whether the read disagrees with what is booked. */
export interface Decision<C> {
  booking: Booking<C | number>;
  /** The read was not booked: it would lower a booked settlement, or the charge it would hold is not a known amount. */
  disagree: boolean;
}

/**
 * The one decision for every receipt read: `run`'s own read after its call and `receipt --refresh` alike.
 * `prev` is the latest ledger row of the request. `costReported` is the cost its completion reported, if any.
 *  - Only a trusted read changes state or spend.
 *  - A reported cost may raise a charge and never lowers it, on a hold and on a settlement alike.
 *  - A trusted read that would lower a booked known settlement disagrees. State and spend stay.
 *  - Otherwise a proven settlement replaces the booked spend, and its charge replaces the hold. The state
 *    moves only forward: never from a settling state to a non settling one.
 *  - A trusted read that moves a refused_local row ("nothing was sent", charge 0) shows the gateway holds
 *    the request after all: the reservation comes back, the row's padded quote.
 *  - A charge that is not a known amount is never replaced by a guess, and never by 0. That is a booked
 *    charge that is not a known amount, or a padded quote that is not one on a refused_local row a trusted
 *    read moves. Unless a proven settlement replaces it, the read disagrees and nothing changes.
 * Two reads of one request can differ, and that is normal, not an attack: per the gateway's OpenAPI
 * (CredentialReceipt), read 2026-11-11, later reconciliation can change the gateway's ledger observation.
 * So two trusted reads book the same spend and charge in either order (test/decision-properties.test.ts).
 * The rule this encodes for the future: a gateway read alone never lowers a booked settlement. On FLOP a
 * refund comes from an upheld fraud verdict, which is proven on chain: per FLOP's docs, a session's payment
 * sits in escrow against the proof, and an upheld fraud verdict refunds the agent. Nothing in imd-flop
 * verifies the chain yet. When chain verification exists, a chain proven refund is the one thing that may
 * lower a booking, and that change belongs in this function.
 */
export function decideBooking<C>(prev: PrevBooking<C>, o: ReadOutcome, costReported: number | null): Decision<C> {
  const lowers = lowersSettlement(prev, o);
  const state = lowers ? prev.state : stateAfter(prev.state, o);
  const settled = settledSpend(o);
  if (settled !== null && !lowers) return { booking: { state, spend: settled, cap_charge: raisedBy(settled, costReported) }, disagree: false };
  const held = heldCharge(prev, state);
  if (held === null) return { booking: { state: prev.state, spend: prev.spend, cap_charge: prev.cap_charge }, disagree: true };
  return { booking: { state, spend: prev.spend, cap_charge: raisedBy(held, costReported) }, disagree: lowers };
}

/**
 * What `run` reports when its paid call brought back no completion, as the ledger state it asks for.
 *  - timeout_unknown: no answer in time, or the connection dropped. The gateway may have done paid work.
 *  - error: the gateway answered the paid call with an HTTP error.
 *  - refused_local: nothing was sent. The failure came before the paid request left.
 */
export type Failure = "timeout_unknown" | "error" | "refused_local";

/**
 * The one decision for a failure report, beside decideBooking. `prev` is the latest ledger row of the
 * request: another process may have refreshed the request and booked its read while the call ran. Returns
 * the next booking, or null when the report is not booked and the booking stays exactly as it is. The booking
 * step still records a report that is not booked (keptReason).
 *  - A failure report never replaces a booked settlement. A row in a settling state stays. `run` keeps its
 *    own exit code and message for what it saw.
 *  - A timeout or a gateway error moves a row that does not settle to timeout_unknown or error. The spend
 *    stays and the charge stays, so the reservation is held.
 *  - "Nothing was sent" releases the reservation: refused_local, charge 0. Only from a row still in state
 *    sent. Any other row came from a trusted gateway read or another report, and a trusted read beats a
 *    "nothing was sent" report: the row stays. A booking is never lowered on a report otherwise.
 *  - A charge that is not a known amount is never replaced by a guess, as in decideBooking: the row stays.
 * A report is not a receipt read. Only a read books a settlement, and that is decideBooking.
 */
export function decideFailure<C>(prev: Booking<C>, failure: Failure): Booking<C | number> | null {
  if (SETTLES.has(prev.state) || knownAmount(prev.cap_charge) === null) return null;
  if (failure === "refused_local") return prev.state === "sent" ? { state: failure, spend: prev.spend, cap_charge: 0 } : null;
  return { state: failure, spend: prev.spend, cap_charge: prev.cap_charge };
}

/** Ledger reason for a settled row whose cap charge is the reported cost, above its settled spend. */
export const CHARGE_RAISED = "cap charge raised to reported cost";

/** The ledger reason for a booking: the receipt flag when there is one, else a note when the charge was raised. */
export function bookingReason(b: Booking, flag: string | null): string | null {
  return flag ?? (b.spend !== null && b.cap_charge > b.spend ? CHARGE_RAISED : null);
}

/** How the ledger reason names a failure report that was recorded and not booked. */
const REPORTED: Record<Failure, string> = { timeout_unknown: "timeout reported", error: "gateway error reported", refused_local: "nothing sent reported" };

/**
 * The ledger reason for a row that records a failure report decideFailure did not book. It names the report
 * and says the booking was kept, and it keeps the note of a charge raised to the reported cost.
 */
export function keptReason(failure: Failure, kept: Booking): string {
  const what = SETTLES.has(kept.state) ? "booked settlement kept" : "booked row kept";
  const raised = bookingReason(kept, null);
  return [REPORTED[failure], what, ...(raised ? [raised] : [])].join("; ");
}

/** Ledger states of a call whose outcome is not known: it timed out, or the gateway answered it with an error. */
export const UNRESOLVED: ReadonlySet<string> = new Set(["timeout_unknown", "error"]);

/** The fields of a stored receipt file that the verdict reads. A file can hold anything in them. */
export interface StoredReceipt extends AttemptIds {
  state?: unknown;
  settled?: unknown;
  chain_final?: unknown;
  http?: unknown;
  error?: unknown;
  flag?: unknown;
}

/** The fields of a ledger row that the verdict reads. */
export interface BookedRow extends AttemptIds {
  state: string;
  spend?: unknown;
}

/**
 * The stored file shows a failed read: it carries the key_expired flag, an HTTP status other than 200, or
 * an error text. Such a file holds the last known state, not a fresh read, so it cannot be compared. This is
 * the viewer's test on the same file (build-lane.py classify). isFreshRead is the test on a live answer.
 */
function storedReadFailed(receipt: StoredReceipt): boolean {
  const httpOk = receipt.http === undefined || receipt.http === null || receipt.http === 200;
  return receipt.flag === "key_expired" || !httpOk || (typeof receipt.error === "string" && receipt.error.length > 0);
}

/**
 * What a stored receipt and the latest ledger row of its request say about each other.
 *  - not_compared: there is nothing to compare. No row, no receipt, a locally refused row, a stored read
 *    that failed, or a receipt whose identity does not match the row's by the viewer's rule (sameAttempt).
 *  - disagree: receipt and ledger cannot both be right.
 *  - settled_unknown: both say the call settled and neither knows the amount. They agree.
 *  - agree: they agree.
 */
export type Verdict = "not_compared" | "disagree" | "settled_unknown" | "agree";

/**
 * The one verdict for a stored receipt beside the latest ledger row of its request. It is worked out from
 * the two files each time and never stored. It is the decision the viewer makes for the same files
 * (build-lane.py classify, disagrees and settled_unknown), pinned for both by contract/vectors/reconcile.json.
 * Like the viewer, it compares only once the receipt was read and its identity matches by the viewer's rule.
 *  - A settled or released receipt needs a settled or released row with the same spend. An amount on one
 *    side only is a disagreement. No amount on either side is settled_unknown.
 *  - A receipt in any other state needs a row that claims no settlement, and it cannot be chain final.
 *  - A row whose call timed out or errored disagrees with any receipt until a read is booked for it.
 * The cap charge is not compared: it may be above the settled spend when the completion reported more.
 */
export function reconcile(row: BookedRow | null | undefined, receipt: StoredReceipt | null | undefined): Verdict {
  if (!row || !receipt || row.state === "refused_local") return "not_compared";
  if (storedReadFailed(receipt) || !sameAttempt(receipt, row)) return "not_compared";
  const rowSettles = SETTLES.has(row.state);
  const receiptSettles = typeof receipt.state === "string" && SETTLES.has(receipt.state);
  const spend = knownAmount(row.spend);
  const settled = knownAmount(receipt.settled);
  const differs = receiptSettles ? !rowSettles || spend !== settled : rowSettles || receipt.chain_final === true;
  if (differs || UNRESOLVED.has(row.state)) return "disagree";
  return receiptSettles && settled === null ? "settled_unknown" : "agree";
}
