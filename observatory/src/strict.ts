// Strict readings shared by every module, so a rule cannot hold in one place and miss another.
// RULES.md 3.1 clause 14 (integers), clause 12 (one value per key) and section 1.1 (times).
// Escrow, census and status all use these; the Python recount implements the same rules
// independently.

/** An integer judged by value that is also safe, |v| <= 2^53 - 1. A boolean is never one. */
export function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

const ZONED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  // month is 1 to 12 here: parseZoned checks it first.
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].at(month - 1) as number;
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
  // The first three fraction digits, cut, never rounded: Number("0.9999999999999999999") is 1,
  // which would roll the time into the next second.
  const millis = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, "0"));
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

/**
 * The first key that appears twice in one object of a JSON text, or null. JSON.parse keeps the
 * last copy without a word and other parsers keep the first, so a file with a repeated key has
 * no one meaning (RULES.md 3.1 clause 12). Keys compare after their escapes are read, so "a" and
 * "\u0061" are the same key. Call it only on text that JSON.parse accepted.
 */
export function duplicateKey(text: string): string | null {
  const stack: ({ keys: Set<string>; expectKey: boolean } | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === "\\" ? 2 : 1;
      // A string that never closes is not JSON, which JSON.parse refuses first; stop rather than
      // read past the end (round 8 review L3).
      if (j >= text.length) return null;
      const top = stack.at(-1);
      if (top && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") {
      stack.push({ keys: new Set(), expectKey: true });
    } else if (c === "[") {
      stack.push(null);
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ",") {
      const top = stack.at(-1);
      if (top) top.expectKey = true;
    }
  }
  return null;
}

/** The deepest a page file's JSON may nest (RULES.md 3.1 clause 12). Real pages nest about 5 deep. */
export const MAX_NESTING = 64;

/**
 * How deep the arrays and objects of a text nest, reading strings so a bracket inside one does not
 * count. It works on any text, valid JSON or not, so it can run before the parser: parsers differ
 * on how deep they go, and one that runs out of stack must never be the judge.
 */
export function nestingDepth(text: string): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "[" || c === "{") {
      depth++;
      if (depth > deepest) deepest = depth;
    } else if (c === "]" || c === "}") {
      depth--;
    }
  }
  return deepest;
}

