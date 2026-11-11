/**
 * Rounding to 6 decimals, the precision every FLOP amount is compared at. Pure.
 * Money already spent rounds up and room left rounds down.
 * A value within 1e-12 of a 1e-6 boundary counts as on it. That keeps float noise from moving a 6 decimal
 * amount below 8192 FLOP. A larger amount on a boundary can move one whole step, because its float noise
 * can be larger than the tolerance. It only ever moves the safe way: spent up, room down. The smallest
 * amounts seen to move are just above 16384 FLOP: ceil6(16384.000047) is 16384.000048.
 * What that means for the cap (contract/rules.json residual R-g):
 *  - For charges and caps on the 6 decimal grid, rounding never admits a call over the cap. The tolerance
 *    absorbs their float noise and nothing else. This tool books every charge on that grid, except a charge
 *    a gateway amount raised above the padded quote (that booking prints PAST_ADMITTED).
 *  - A charge off the grid within 1e-12 FLOP above a step (a hand edit, a damaged row, or such a gateway
 *    amount) rounds down onto the step, so the next call can be admitted with the day over the cap by at
 *    most 1e-12 FLOP. A cap or budget set within 1e-12 FLOP below a step rounds room up by at most as much.
 *  - This closes when money moves to exact base units (money stage 2).
 */
const SCALE = 1e6;
const NOISE = 1e-6; // in scaled units, so 1e-12 FLOP

/** The boundary this scaled value sits on, or null when it lies between two. */
function boundary(scaled: number): number | null {
  const nearest = Math.round(scaled);
  return Math.abs(scaled - nearest) <= NOISE ? nearest : null;
}

/** Round up to 6 decimals. A value already on a 1e-6 boundary stays put below 8192 FLOP. A larger one can move up one step. */
export function ceil6(n: number): number {
  const scaled = n * SCALE;
  return (boundary(scaled) ?? Math.ceil(scaled)) / SCALE;
}

/** Round down to 6 decimals. A value already on a 1e-6 boundary stays put below 8192 FLOP. A larger one can move down one step. */
export function floor6(n: number): number {
  const scaled = n * SCALE;
  return (boundary(scaled) ?? Math.floor(scaled)) / SCALE;
}
