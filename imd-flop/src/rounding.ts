/**
 * Amounts in whole millionths of a FLOP (micro units), the precision every FLOP amount is compared at. Pure.
 * No epsilon anywhere (review of the audit 33f3b9f fixes, defect 1):
 *  - An amount x is on the 6 decimal grid when n = floor(x * 1e6 + 0.5) gives back the same double:
 *    n / 1e6 === x. Then its count of millionths is n, exactly. Every amount this tool compares is at most
 *    AMOUNT_MAX (1e9 FLOP, amount.ts), and up to there every grid amount is found this way.
 *  - Only an amount off the grid is rounded, and the result is checked by comparison: up (money already
 *    spent, a charge) is the smallest n with n / 1e6 >= x; down (room left, a limit) is the largest n with
 *    n / 1e6 <= x.
 *  - Totals and the cap check are integers built from these counts (ledger.ts exactTotal, policy.ts
 *    checkBudget), never a float sum or a float subtraction. So for amounts on the grid every total and every
 *    cap decision is exact.
 * What is left for the cap (contract/rules.json residual R-g): an amount off the grid rounds the safe way, a
 * charge up and a limit down, so rounding never admits a call over the cap. It closes fully when money moves
 * to exact base units (money stage 2).
 */
const SCALE = 1e6;

/** The count of millionths of an amount on the grid, or null when it is off the grid (or not finite). */
export function gridMicro(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  const n = Math.floor(x * SCALE + 0.5);
  return n / SCALE === x ? n : null;
}

/** The amount rounded up, in millionths: its exact count on the grid, else the smallest n with n / 1e6 >= x. */
export function ceilMicro(x: number): number {
  const on = gridMicro(x);
  if (on !== null) return on;
  let n = Math.ceil(x * SCALE);
  while (n / SCALE < x) n += 1;
  while ((n - 1) / SCALE >= x) n -= 1;
  return n;
}

/** The amount rounded down, in millionths: its exact count on the grid, else the largest n with n / 1e6 <= x. */
export function floorMicro(x: number): number {
  const on = gridMicro(x);
  if (on !== null) return on;
  let n = Math.floor(x * SCALE);
  while (n / SCALE > x) n -= 1;
  while ((n + 1) / SCALE <= x) n += 1;
  return n;
}

/** Round up to 6 decimals: ceilMicro over 1e6. */
export function ceil6(n: number): number {
  return ceilMicro(n) / SCALE;
}

/** Round down to 6 decimals: floorMicro over 1e6. */
export function floor6(n: number): number {
  return floorMicro(n) / SCALE;
}
