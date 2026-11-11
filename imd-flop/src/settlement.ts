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
import { exactAmount, knownAmount } from "./amount.js";

/**
 * Receipt states that settle an attempt. Per the gateway's OpenAPI (CredentialReceipt), read 2026-11-11:
 * `reserved` (quota held, no completion checkpoint) and `estimated` (reservation kept after completion, no
 * reconciled spend) are unresolved. `settled` (spend reconciled) and `released` (reservation returned to
 * quota) are terminal ledger states.
 */
export const SETTLES: ReadonlySet<string> = new Set(["settled", "released"]);
/** Shown (stderr, receipt status) when the ledger cannot be reconciled with the receipt. Same text as the viewer. */
export const DISAGREE = "receipt and ledger disagree; reservation held, chain-final green blocked";
/**
 * Printed on stderr, and recorded in the row's reason, by a booking that puts the day in a state the cap did
 * not admit (decideBooking, pastAdmitted): any booking that raises the request's known booked charge.
 */
export const PAST_ADMITTED = "booked past what the cap admitted; the day may end over its cap";

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
  /** The receipt's settled_spend_raw as it arrived, unchecked. Absent is unknown. Only exactAfter reads it, through the exact amount rule. */
  settledRaw?: unknown;
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
  /**
   * The exact spend in base units (money stage 1), decided by exactAfter. Recorded beside the float figures:
   * no cap, quote, charge or settlement decision reads it. Absent on a row written before money stage 1.
   */
  spend_raw?: string | null;
  /**
   * True when a trusted read of this request was booked and left the row in state sent (a receipt with no
   * state): the gateway knows the request, so decideFailure never releases its hold on "nothing was sent".
   * Every other state a trusted read leaves (reserved, estimated, settled, released) already says so. Absent
   * otherwise, and on a row written before the hold floor.
   */
  receipt_seen?: boolean;
}

/** usage.cost_flop as the completion reported it. It counts only when it is a finite number. Recorded, never a settlement. */
export function reportedCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A reported cost may raise a charge, never lower it. */
function raisedBy(charge: number, costReported: number | null): number {
  return costReported !== null ? Math.max(charge, costReported) : charge;
}

/**
 * A booked known settlement is never lowered by a later read. True when the row is in a settling state
 * with a known spend and a trusted read settles below it. This is about the spend field, what the gateway
 * says was spent. The cap charge has its own floor (holdFloor).
 */
function lowersSettlement(prev: { state: string; spend: unknown }, o: ReadOutcome): boolean {
  const booked = SETTLES.has(prev.state) ? knownAmount(prev.spend) : null;
  const settled = settledSpend(o);
  return booked !== null && settled !== null && settled < booked;
}

/**
 * The state after a read. Only a trusted read moves it, and never from a settling state to a non settling
 * one. A trusted read with no state moves no state forward. On a released row (refused_local) it still shows
 * the gateway knows the request, so the row goes back to sent: the call was sent after all.
 */
function stateAfter(prev: string, o: ReadOutcome): string {
  if (!trustedRead(o)) return prev;
  if (o.state === null) return prev === "refused_local" ? "sent" : prev;
  return SETTLES.has(prev) && !SETTLES.has(o.state) ? prev : o.state;
}

/**
 * The exact spend after a read that is booked (money stage 1): the row's spend_raw, the exact spend in base
 * units (10^18 per FLOP) as a canonical digit string, or null for unknown. It describes the booked float
 * spend, so the two are set as a pair. `settled` is the float spend this read books, or null when it books
 * none.
 *  - A read that books a float spend the row did not hold (the row's float was unknown, or a different
 *    known amount) sets the pair: its own exact amount (amount.ts exactAmount), or unknown.
 *  - A read that books no float spend never sets or changes the exact spend beside a known float spend.
 *  - Otherwise (the same float spend again, or no float spend on either side) the exact spend only rises:
 *    only a trusted read in a settling state brings an exact amount, an unknown booked one is filled, a
 *    higher one replaces a lower one, and an equal or lower one changes nothing. A booked value that is not
 *    an exact amount (a row written before money stage 1 has none) is unknown, never 0.
 * decideBooking does not ask this for a read it refuses: that read sets nothing.
 * Per FLOP's own sources, read 2026-11-11: the chain counts money in whole base units in a u128, and the
 * gateway's settled_spend_raw is the exact amount, while settled_spend comes from a legacy floating point
 * ledger. The float and exact figures are not compared yet: the right tolerance needs a live receipt.
 */
function exactAfter(prev: { spend: unknown; spend_raw?: string | null }, o: ReadOutcome, settled: number | null): string | null | undefined {
  const booked = prev.spend_raw;
  const incoming = trustedRead(o) && o.state !== null && SETTLES.has(o.state) ? exactAmount(o.settledRaw) : null;
  const before = knownAmount(prev.spend);
  if (settled !== null && settled !== before) return incoming;
  if (settled === null && before !== null) return booked;
  if (incoming === null) return booked;
  const known = exactAmount(booked);
  return known === null || BigInt(incoming) > BigInt(known) ? incoming : booked;
}

/** The previous row as decideBooking sees it: its booking and its padded quote. */
export interface PrevBooking<C> extends Booking<C> {
  /** The hold of the request, as the row records it. A file can hold anything in it. */
  quote_padded: unknown;
}

/**
 * The hold floor: the least the cap charge can be after a read, before a settlement or a reported cost
 * raises it. Null when it is not a known amount, and then the read is not booked.
 *  - On a row the call was sent for, the booked charge. From the moment a call is sent its charge is the
 *    padded quote it was admitted with, and a read only raises it (and a raise says PAST_ADMITTED). A row an older version booked below
 *    its hold keeps its booked charge: it is not migrated.
 *  - On a released row (refused_local, "nothing was sent"), a trusted read shows the gateway knows the
 *    request after all, so the hold comes back: the row's padded quote (or the booked charge if that is
 *    higher). Null when the padded quote is not a known amount.
 *  - A booked charge that is not a known amount (only a damaged file holds one) is never replaced by a guess.
 *    Only a read that proves a settlement books it again, at the padded quote, and only when that is a
 *    known amount.
 */
function holdFloor(prev: PrevBooking<unknown>, o: ReadOutcome, proven: boolean): number | null {
  const booked = knownAmount(prev.cap_charge);
  const quote = knownAmount(prev.quote_padded);
  if (booked === null) return proven ? quote : null;
  if (prev.state === "refused_local" && trustedRead(o)) return quote === null ? null : Math.max(booked, quote);
  return booked;
}

/**
 * The booking puts the day in a state the cap did not admit: it raises the request's known booked charge.
 * The charge a row holds is what every later admission counted, so any booking that makes it larger passes
 * what the cap admitted. A released hold that comes back (from 0), a charge raised above the padded quote,
 * and a row an older version booked below its hold climbing back to it are all this one rule. A booked
 * charge that is not a known amount is not raised but repaired, and is outside the rule: such a row refuses
 * every call, so nothing was admitted against it.
 */
function pastAdmitted(prev: PrevBooking<unknown>, charge: number): boolean {
  const booked = knownAmount(prev.cap_charge);
  return booked !== null && charge > booked;
}

/** What a read does to a booking: the next booking, whether the read disagrees with what is booked, and whether the booking passes what the cap admitted. */
export interface Decision<C> {
  booking: Booking<C | number>;
  /** The read was not booked: it would lower a booked settlement, or the hold floor is not a known amount. */
  disagree: boolean;
  /** The booking puts the day in a state the cap did not admit (pastAdmitted). The caller prints PAST_ADMITTED and records it in the row's reason. */
  pastAdmitted: boolean;
}

/**
 * The one decision for every receipt read: `run`'s own read after its call and `receipt --refresh` alike.
 * `prev` is the latest ledger row of the request. `costReported` is the cost its completion reported, if any.
 *  - Only a trusted read changes state or spend. `spend` records what the gateway says was spent.
 *  - The hold floor: the cap charge counts what the call was allowed to spend, not what it ended up
 *    costing. A gateway read (settled or released, with any amount or none) and a reported cost can only
 *    raise it above the floor (holdFloor). A gateway read is not final: per the gateway's OpenAPI
 *    (CredentialReceipt), read 2026-11-11, later reconciliation can change its ledger observation. The
 *    child key's cap, the padded quote, is the one bound the gateway enforces.
 *  - A trusted read that would lower a booked known settlement disagrees. State and spend stay, and a
 *    reported cost may still raise the charge.
 *  - Otherwise a proven settlement replaces the booked spend. The state moves only forward: never from a
 *    settling state to a non settling one.
 *  - Any trusted read, a receipt with no state included, shows the gateway knows the request. On a
 *    released row (refused_local) it brings the hold back. A row it leaves in state sent is marked
 *    receipt_seen, so a later "nothing was sent" report does not release it (decideFailure).
 *  - A hold floor that is not a known amount is never replaced by a guess, and never by 0: the read
 *    disagrees and nothing changes.
 *  - The exact spend (money stage 1) follows exactAfter on every read that is not refused: it is set as a
 *    pair with the float spend it describes. A read that disagrees sets nothing, exact spend included. The
 *    exact spend never changes state, spend or charge.
 * Two reads of one request can differ, and that is normal, not an attack. So two trusted reads book the same
 * spend and charge in either order (test/decision-properties.test.ts). They book the same pair of spend and
 * exact spend in either order too, except for the shapes that test counts.
 * The rule this encodes for the future: a gateway read alone never lowers a booked settlement, and never
 * lowers a charge. On FLOP a refund comes from an upheld fraud verdict, which is proven on chain: per FLOP's
 * docs, a session's payment sits in escrow against the proof, and an upheld fraud verdict refunds the agent.
 * Nothing in imd-flop verifies the chain yet. The one place where chain proof plugs in is marked below.
 */
export function decideBooking<C>(prev: PrevBooking<C>, o: ReadOutcome, costReported: number | null): Decision<C> {
  const kept: Booking<C | number> = { state: prev.state, spend: prev.spend, cap_charge: prev.cap_charge, spend_raw: prev.spend_raw };
  const refused: Decision<C> = { booking: kept, disagree: true, pastAdmitted: false };
  if (lowersSettlement(prev, o)) {
    const booked = knownAmount(prev.cap_charge);
    if (booked === null) return refused;
    const charge = raisedBy(booked, costReported);
    return { booking: { ...kept, cap_charge: charge }, disagree: true, pastAdmitted: pastAdmitted(prev, charge) };
  }
  const settled = settledSpend(o);
  const floor = holdFloor(prev, o, settled !== null);
  if (floor === null) return refused;
  // CHAIN PROOF PLUGS IN HERE, and nowhere else. Today the floor holds until the call's settlement is
  // proven on chain, and no such proof exists in imd-flop yet. When it does, a settlement proven on chain
  // for this request is the one thing that may lift the floor: the charge may then be lowered to the proven
  // amount, and a chain proven refund may lower a booked settlement. No code for it is written yet.
  const charge = raisedBy(settled === null ? floor : Math.max(floor, settled), costReported);
  const state = stateAfter(prev.state, o);
  const booking: Booking<C | number> = { state, spend: settled ?? prev.spend, cap_charge: charge, spend_raw: exactAfter(prev, o, settled), ...(trustedRead(o) && state === "sent" ? { receipt_seen: true } : {}) };
  return { booking, disagree: false, pastAdmitted: pastAdmitted(prev, charge) };
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
 *  - "Nothing was sent" releases the reservation: refused_local, charge 0. It is a local fact: the paid
 *    request never left the process. Only from a row still in state sent that no trusted read has reached
 *    (receipt_seen). A trusted read shows the gateway knows the request, and it beats a "nothing was sent"
 *    report: the row stays. This is the one step that lowers a charge.
 *  - A charge that is not a known amount is never replaced by a guess, as in decideBooking: the row stays.
 * A report is not a receipt read. Only a read books a settlement, and that is decideBooking.
 */
export function decideFailure<C>(prev: Booking<C>, failure: Failure): Booking<C | number> | null {
  if (SETTLES.has(prev.state) || knownAmount(prev.cap_charge) === null) return null;
  if (failure === "refused_local") return prev.state === "sent" && prev.receipt_seen !== true ? { state: failure, spend: prev.spend, cap_charge: 0 } : null;
  return { state: failure, spend: prev.spend, cap_charge: prev.cap_charge };
}

/** Ledger reason for a settled row whose cap charge the reported cost raised above its padded quote and its settled spend. */
export const CHARGE_RAISED = "cap charge raised to reported cost";

/** A booking with the cost and the padded quote its row records, as bookingReason reads them. */
export type ReasonRow = Booking & { cost_reported?: number | null; quote_padded?: unknown };

/**
 * The reported cost raised this settled row's charge: the charge is the reported cost, and that cost is
 * above the padded quote (the hold floor) and above the settled spend. A cost at or below the padded quote
 * leaves the charge at the hold, so it raised nothing. False when the padded quote is not a known amount.
 */
function raisedByCost(b: ReasonRow): boolean {
  const quote = knownAmount(b.quote_padded);
  const cost = b.cost_reported ?? null;
  return b.spend !== null && cost !== null && quote !== null && cost > quote && b.cap_charge === cost && b.cap_charge > b.spend;
}

/**
 * The ledger reason for a booking. PAST_ADMITTED first when the booking passes what the cap admitted
 * (Decision.pastAdmitted). Then the receipt flag when there is one, else CHARGE_RAISED when the reported
 * cost raised the charge of a settled row (raisedByCost). Null when there is nothing to say.
 */
export function bookingReason(b: ReasonRow, flag: string | null, past = false): string | null {
  const raised = raisedByCost(b) ? CHARGE_RAISED : null;
  const parts = [past ? PAST_ADMITTED : null, flag ?? raised].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** How the ledger reason names a failure report that was recorded and not booked. */
const REPORTED: Record<Failure, string> = { timeout_unknown: "timeout reported", error: "gateway error reported", refused_local: "nothing sent reported" };

/**
 * The ledger reason for a row that records a failure report decideFailure did not book. It names the report
 * and says the booking was kept, and it keeps the note of a charge raised to the reported cost.
 */
export function keptReason(failure: Failure, kept: ReasonRow): string {
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
 * The cap charge is not compared: it may be above the settled spend, held at the padded quote or raised by
 * a reported cost (decideBooking, the hold floor).
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
