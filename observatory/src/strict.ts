// Strict readings shared by every module, so a rule cannot hold in one place and miss another.
// RULES.md 3.1 clause 14 (integers) and section 1.1 (times). Escrow, census and status all use
// these; the Python recount implements the same rules independently.

/** An integer judged by value that is also safe, |v| <= 2^53 - 1. A boolean is never one. */
export function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

const ZONED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
}

/**
 * Milliseconds since the epoch for an ISO 8601 time with an explicit zone (Z or an offset) and a
 * real calendar date and clock time, or null. A time without a zone would be read in the
 * machine's own zone, and Date.parse would roll an impossible date such as 2026-11-31 over to
 * December 1, so neither ever parses here.
 */
export function parseZoned(t: unknown): number | null {
  if (typeof t !== "string") return null;
  const m = ZONED.exec(t);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (m[8] !== "Z") {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (m[9] === "+" ? 1 : -1) * (oh * 60 + om);
  }
  const millis = m[7] === undefined ? 0 : Math.trunc(Number(`0.${m[7]}`) * 1000);
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, millis);
  return d.getTime() - offsetMinutes * 60_000;
}

/** Seconds from `earlier` to `later`, or null when either time does not parse. */
export function secondsBetween(earlier: unknown, later: unknown): number | null {
  const a = parseZoned(earlier);
  const b = parseZoned(later);
  return a !== null && b !== null ? (b - a) / 1000 : null;
}
