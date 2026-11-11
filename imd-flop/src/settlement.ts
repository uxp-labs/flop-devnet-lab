/**
 * Reservation and settlement: the one copy of the rules that turn a receipt read into the next ledger
 * booking (decideBooking). Pure: no file, network or ledger access. `run` (after its call) and
 * `receipt --refresh` both decide through it. Behavior is pinned by contract/vectors/settlement-run.json
 * and settlement-refresh.json.
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
export function receiptIdentity(receipt: unknown, requestId: string): { rawId: unknown; identityOk: boolean } {
  const rawId = receipt && typeof receipt === "object" ? (receipt as { request_id?: unknown }).request_id : undefined;
  return { rawId, identityOk: typeof rawId === "string" && rawId.length > 0 && rawId === requestId };
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
export function trustedRead(o: ReadOutcome): boolean {
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

/** A reported cost may raise a charge, never lower it. */
function raisedBy(charge: number, costReported: number | null): number {
  return costReported !== null ? Math.max(charge, costReported) : charge;
}

/** While no settlement is booked from a read, the charge already held stays; a reported cost may raise it, never lower it. */
export function holdCharge(held: number, costReported: number | null): number {
  return raisedBy(held, costReported);
}

/** A proven settlement is charged in full; a reported cost may raise that charge too, never lower it. */
export function settledCharge(settled: number, costReported: number | null): number {
  return raisedBy(settled, costReported);
}

/**
 * A booked known settlement is never lowered by a later read. True when the row is in a settling state
 * with a known spend and a trusted read settles below it.
 */
export function lowersSettlement(prev: { state: string; spend: unknown }, o: ReadOutcome): boolean {
  const booked = SETTLES.has(prev.state) ? knownAmount(prev.spend) : null;
  const settled = settledSpend(o);
  return booked !== null && settled !== null && settled < booked;
}

/** The state after a read. Only a trusted read moves it, and never from a settling state to a non settling one. */
function stateAfter(prev: string, o: ReadOutcome): string {
  if (!trustedRead(o) || o.state === null) return prev;
  return SETTLES.has(prev) && !SETTLES.has(o.state) ? prev : o.state;
}

/** What a read does to a booking: the next booking, and whether the read disagrees with what is booked. */
export interface Decision<C> {
  booking: Booking<C | number>;
  /** The read was not booked: it would lower a booked settlement, or the booked charge is not a known amount. */
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
 *  - A booked charge that is not a known amount is never replaced by a guess, and never by 0. Unless a
 *    proven settlement replaces it, the read disagrees and nothing changes.
 * Two reads of one request can differ, and that is normal, not an attack: per the gateway's OpenAPI
 * (CredentialReceipt), read 2026-11-11, later reconciliation can change the gateway's ledger observation.
 * So two trusted reads book the same spend and charge in either order.
 * The rule this encodes for the future: a gateway read alone never lowers a booked settlement. On FLOP a
 * refund comes from an upheld fraud verdict, which is proven on chain: per FLOP's docs, a session's payment
 * sits in escrow against the proof, and an upheld fraud verdict refunds the agent. Nothing in imd-flop
 * verifies the chain yet. When chain verification exists, a chain proven refund is the one thing that may
 * lower a booking, and that change belongs in this function.
 */
export function decideBooking<C>(prev: Booking<C>, o: ReadOutcome, costReported: number | null): Decision<C> {
  const lowers = lowersSettlement(prev, o);
  const state = lowers ? prev.state : stateAfter(prev.state, o);
  const settled = settledSpend(o);
  if (settled !== null && !lowers) return { booking: { state, spend: settled, cap_charge: settledCharge(settled, costReported) }, disagree: false };
  const held = knownAmount(prev.cap_charge);
  if (held === null) return { booking: { state: prev.state, spend: prev.spend, cap_charge: prev.cap_charge }, disagree: true };
  return { booking: { state, spend: prev.spend, cap_charge: holdCharge(held, costReported) }, disagree: lowers };
}

/** Ledger reason for a settled row whose cap charge is the reported cost, above its settled spend. */
export const CHARGE_RAISED = "cap charge raised to reported cost";

/** The ledger reason for a booking: the receipt flag when there is one, else a note when the charge was raised. */
export function bookingReason(b: Booking, flag: string | null): string | null {
  return flag ?? (b.spend !== null && b.cap_charge > b.spend ? CHARGE_RAISED : null);
}
