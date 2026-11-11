/**
 * The one amount rule. A known amount is a finite number that is not negative. Null, a negative number,
 * a non-finite number and anything that is not a number are unknown, never 0. Pure, and it imports
 * nothing, so receipts.ts, ledger.ts, policy.ts and settlement.ts can all build on it.
 */
export function knownAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
