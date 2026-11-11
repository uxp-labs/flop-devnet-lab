/**
 * Rounding to 6 decimals, the precision every FLOP amount is compared at. Pure.
 * Money already spent rounds up and room left rounds down. ceilMicro and floorMicro give the integer
 * numerator in millionths of a FLOP (micro units), and ceil6 and floor6 are those over 1e6.
 * A value within 1e-12 FLOP of a 1e-6 step counts as on it. Every amount this tool compares is at most
 * AMOUNT_MAX (1e9 FLOP, amount.ts). Up to there an amount on the grid is its own double, and x * 1e6 is within
 * 0.5 of the exact integer, so the grid survives the float: on one amount the tolerance absorbs float noise and
 * the numerator is exact.
 * A day or job total is the exact sum of the charges' integer numerators (ledger.ts sumCharges), never a float
 * sum. The room left is floor6(allowed - spent) (policy.ts roomLeft). That subtraction is a float one, and above
 * about 8192 FLOP its noise can be larger than the tolerance. Then the room can come out one whole step short.
 * It only ever moves the safe way: room down, never up.
 * What that means for the cap (contract/rules.json residual R-g):
 *  - For charges and caps on the 6 decimal grid, rounding never admits a call over the cap. This tool books
 *    every charge on that grid, except a charge a gateway amount raised above the padded quote (that booking
 *    prints PAST_ADMITTED).
 *  - A charge off the grid within 1e-12 FLOP above a step (a hand edit, a damaged row, or such a gateway
 *    amount) rounds down onto the step, so the next call can be admitted with the day over the cap by at most
 *    1e-12 FLOP for each such charge. A cap or budget set within 1e-12 FLOP below a step rounds room up by at
 *    most as much.
 *  - This closes when money moves to exact base units (money stage 2).
 */
const SCALE = 1e6;
const NOISE = 1e-6; // in scaled units, so 1e-12 FLOP

/** The boundary this scaled value sits on, or null when it lies between two. */
function boundary(scaled: number): number | null {
  const nearest = Math.round(scaled);
  return Math.abs(scaled - nearest) <= NOISE ? nearest : null;
}

/** The value rounded up to 6 decimals, as an integer count of millionths. A value on a 1e-6 step stays on it. */
export function ceilMicro(n: number): number {
  const scaled = n * SCALE;
  return boundary(scaled) ?? Math.ceil(scaled);
}

/** The value rounded down to 6 decimals, as an integer count of millionths. A value on a 1e-6 step stays on it. */
export function floorMicro(n: number): number {
  const scaled = n * SCALE;
  return boundary(scaled) ?? Math.floor(scaled);
}

/** Round up to 6 decimals: ceilMicro over 1e6. */
export function ceil6(n: number): number {
  return ceilMicro(n) / SCALE;
}

/** Round down to 6 decimals: floorMicro over 1e6. */
export function floor6(n: number): number {
  return floorMicro(n) / SCALE;
}
