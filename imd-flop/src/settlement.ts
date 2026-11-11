/**
 * Reservation and settlement: the one copy of the rules that turn a receipt read into the next ledger
 * booking. Pure: no file, network or ledger access. `run` (after its call) and `receipt --refresh` both
 * use it. Behavior is pinned by contract/vectors/settlement-run.json and settlement-refresh.json.
 */
import { knownAmount } from "./receipts.js";
import { usableCapCharge } from "./ledger.js";

/** Receipt states that settle an attempt. */
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

/** A known settlement: a trusted read in a settling state with a finite spend >= 0 (explicit 0 included). */
export function settledSpend(o: ReadOutcome): number | null {
  return trustedRead(o) && o.state !== null && SETTLES.has(o.state) ? knownAmount(o.settled) : null;
}

/** The ledger fields a read can change. */
export interface Booking {
  state: string;
  spend: number | null;
  cap_charge: number;
}

/** usage.cost_flop as the completion reported it. It counts only when it is a finite number. Recorded, never a settlement. */
export function reportedCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A reported cost may raise a charge, never lower it. */
function raisedBy(charge: number, costReported: number | null): number {
  return costReported !== null ? Math.max(charge, costReported) : charge;
}

/** While spend is unknown the padded quote stays reserved; a reported cost may raise that reservation, never lower it. */
export function holdCharge(padded: number, costReported: number | null): number {
  return raisedBy(padded, costReported);
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

/**
 * The next booking after a read. A known settlement replaces the booked spend, and its charge (see
 * settledCharge) replaces the hold; otherwise `hold` stays charged and the booked spend stays. Only a
 * trusted read moves the state, and never from a settling state back to a non-settling one. A read that
 * proves nothing changes nothing, and neither does a read that would lower a booked settlement.
 */
export function nextBooking(prev: { state: string; spend: number | null }, o: ReadOutcome, hold: number, costReported: number | null): Booking {
  if (lowersSettlement(prev, o)) return { state: prev.state, spend: prev.spend, cap_charge: hold };
  const settled = settledSpend(o);
  const regresses = SETTLES.has(prev.state) && !(o.state !== null && SETTLES.has(o.state));
  const state = trustedRead(o) && o.state !== null && !regresses ? o.state : prev.state;
  return { state, spend: settled ?? prev.spend, cap_charge: settled !== null ? settledCharge(settled, costReported) : hold };
}

/** Ledger reason for a settled row whose cap charge is the reported cost, above its settled spend. */
export const CHARGE_RAISED = "cap charge raised to reported cost";

/** The ledger reason for a booking: the receipt flag when there is one, else a note when the charge was raised. */
export function bookingReason(b: Booking, flag: string | null): string | null {
  return flag ?? (b.spend !== null && b.cap_charge > b.spend ? CHARGE_RAISED : null);
}

export type RefreshBooking = { kind: "append"; booking: Booking } | { kind: "unchanged" } | { kind: "disagree" };

/**
 * `receipt --refresh` against the latest ledger row. An unusable booked charge with no proven settlement
 * is never replaced, and a booked settlement is never lowered (disagree, nothing appended). A row is
 * appended only when a derived field changes. The reported cost is the one the ledger row recorded.
 */
export function refreshBooking(prev: { state: string; spend: number | null; cap_charge: unknown; cost_reported: unknown }, o: ReadOutcome): RefreshBooking {
  if (settledSpend(o) === null && !usableCapCharge(prev.cap_charge)) return { kind: "disagree" };
  if (lowersSettlement(prev, o)) return { kind: "disagree" };
  const booking = nextBooking(prev, o, prev.cap_charge as number, reportedCost(prev.cost_reported));
  const changed = booking.state !== prev.state || booking.spend !== prev.spend || booking.cap_charge !== prev.cap_charge;
  return changed ? { kind: "append", booking } : { kind: "unchanged" };
}
