/**
 * The two amount rules. Pure, and they import nothing, so receipts.ts, ledger.ts, policy.ts and
 * settlement.ts can all build on them.
 *  - knownAmount: the float rule every cap, quote, charge and settlement decision runs on today.
 *  - exactAmount: the exact rule for amounts in base units (money stage 1). It is recorded beside the float
 *    figures and decides nothing about the cap yet.
 */

/**
 * The largest float amount: 1e9 FLOP. Up to it every amount on the 6 decimal grid is its own double, and
 * x * 1e6 is within 0.5 of the exact integer, so rounding.ts recovers the integer numerator of every grid
 * amount and the sums in ledger.ts are exact. Above about 2^33 FLOP a double cannot hold the grid at all
 * (swarm audit 33f3b9f, finding 5). It is also far below 2^53, so the viewer's Python and JavaScript read the
 * same JSON number as the same amount. contract/rules.json AMOUNT_MAX.
 */
export const AMOUNT_MAX = 1_000_000_000;

/**
 * The float amount rule. A known amount is a finite number that is not negative and not above AMOUNT_MAX.
 * Null, a negative number, a non-finite number, a number above AMOUNT_MAX and anything that is not a number
 * are unknown, never 0. Exact amounts in base units are digit strings and follow exactAmount instead.
 */
export function knownAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= AMOUNT_MAX ? value : null;
}

/**
 * Exact amounts are below 2^128. Per FLOP's own sources, read 2026-11-11: the chain counts money in whole
 * base units, 10^18 per FLOP, in a u128. Its spec forbids floating point conversion in encoders, and its
 * official test vectors carry money as decimal digit strings. contract/rules.json EXACT_AMOUNT_BOUND.
 */
export const EXACT_BOUND = 2n ** 128n;
/** The most digits a canonical exact amount can have: 2^128 - 1 has 39. */
const EXACT_DIGITS = (EXACT_BOUND - 1n).toString().length;

/**
 * The exact amount rule (money stage 1). An exact amount is a string of ASCII decimal digits only whose
 * value is below 2^128. It is returned in canonical form: no leading zeros, "0" for zero. Anything else is
 * unknown (null), never 0: a number, an empty string, a sign, a decimal point, hex, whitespace, a value at
 * or above 2^128, null, undefined. Per the gateway's OpenAPI (CredentialReceipt), read 2026-11-11,
 * settled_spend_raw is the exact amount: a string matching ^[0-9]+$ in base units, or null, and null means
 * unavailable, never an inferred zero. Pinned by contract/vectors/exact-amount.json, shared with the viewer.
 */
export function exactAmount(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const digits = value.replace(/^0+/, "") || "0";
  return digits.length <= EXACT_DIGITS && BigInt(digits) < EXACT_BOUND ? digits : null;
}
