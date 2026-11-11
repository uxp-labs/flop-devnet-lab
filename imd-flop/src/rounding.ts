/**
 * Rounding to 6 decimals, the precision every FLOP amount is compared at. Pure.
 * Money already spent rounds up and room left rounds down, so rounding never admits a call.
 * A value within 1e-12 of a 1e-6 boundary counts as on it. That tolerance covers the float noise of a
 * 6 decimal amount below 8192 FLOP, so such an amount is not moved. From 8192 FLOP up the noise can be
 * larger than the tolerance, and an amount on a boundary can move one whole step. It only ever moves the
 * safe way: spent up, room down. For example ceil6(16384.000047) is 16384.000048.
 */
const SCALE = 1e6;
const NOISE = 1e-6; // in scaled units, so 1e-12 FLOP

/** The boundary this scaled value sits on, or null when it lies between two. */
function boundary(scaled: number): number | null {
  const nearest = Math.round(scaled);
  return Math.abs(scaled - nearest) <= NOISE ? nearest : null;
}

/** Round up to 6 decimals. Below 8192 FLOP a value already on a 1e-6 boundary stays put. Above that it can move up one step. */
export function ceil6(n: number): number {
  const scaled = n * SCALE;
  return (boundary(scaled) ?? Math.ceil(scaled)) / SCALE;
}

/** Round down to 6 decimals. Below 8192 FLOP a value already on a 1e-6 boundary stays put. Above that it can move down one step. */
export function floor6(n: number): number {
  const scaled = n * SCALE;
  return (boundary(scaled) ?? Math.floor(scaled)) / SCALE;
}
