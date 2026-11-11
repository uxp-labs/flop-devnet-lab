/**
 * Rounding to 6 decimals, the precision every FLOP amount is compared at. Pure.
 * Money already spent rounds up and room left rounds down, so rounding never admits a call.
 * A value within 1e-12 of a 1e-6 boundary counts as on it, so float noise never moves it a whole step.
 */
const SCALE = 1e6;
const NOISE = 1e-6; // in scaled units, so 1e-12 FLOP

/** The boundary this scaled value sits on, or null when it lies between two. */
function boundary(scaled: number): number | null {
  const nearest = Math.round(scaled);
  return Math.abs(scaled - nearest) <= NOISE ? nearest : null;
}

/** Round up to 6 decimals. A value already on a 1e-6 boundary stays put. */
export function ceil6(n: number): number {
  const scaled = n * SCALE;
  return (boundary(scaled) ?? Math.ceil(scaled)) / SCALE;
}

/** Round down to 6 decimals. A value already on a 1e-6 boundary stays put. */
export function floor6(n: number): number {
  const scaled = n * SCALE;
  return (boundary(scaled) ?? Math.floor(scaled)) / SCALE;
}
