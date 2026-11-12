/**
 * The one reading of a JSON text this tool did not write: a body or a frame a server sent. gateway.ts reads its
 * bodies with readOutsideJson. The paid call's answer and the receipt read are parsed by @flop-labs/client, so
 * providers.ts gives the client a fetch of its own (nonFiniteSeam) that runs the same number check.
 *  - A text that is not JSON throws JSON.parse's own error, as res.json() did. Its message quotes the text, so a
 *    caller never repeats it unfiltered.
 *  - A text that holds a number that is not finite (1e999 and -1e999 parse to Infinity and -Infinity) is not JSON
 *    this tool reads either. It throws NonFiniteNumber, whose message is the fixed reason NON_FINITE_NUMBER and
 *    never a quote of the text or the number. JSON.stringify writes Infinity as null, and null means unknown in
 *    this tool, so such a body read as JSON could be stored with null where the server sent a number.
 *  - No depth limit: the ledger text contract's 32 levels apply to the files this tool wrote, not to server bodies.
 *    Nothing here recurses: the number scan is one loop over the text.
 */

/** The fixed reason a body with a number that is not finite is refused with, the same word spend-guard prints. */
export const NON_FINITE_NUMBER = "non_finite_number";

export class NonFiniteNumber extends Error {
  override name = "NonFiniteNumber";
  constructor() {
    super(NON_FINITE_NUMBER);
  }
}

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
/** The characters a JSON number token is made of after its first: digits, ".", "e", "E", "+" and "-". */
const inNumber = (c: number): boolean => isDigit(c) || c === 0x2e || c === 0x65 || c === 0x45 || c === 0x2b || c === 0x2d;

/**
 * True when a JSON text holds a number token whose value is not a finite double. Meant for text JSON.parse
 * accepted: outside a string every "-" or digit starts a number token, and Number() of a JSON number token is
 * the double JSON.parse gives for it. A string runs from an unescaped " to the next unescaped " (a backslash in a
 * string escapes the character after it), as in ledger-text.ts nestedTooDeep.
 */
export function holdsNonFiniteNumber(text: string): boolean {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x2d || isDigit(c)) {
      let end = i + 1;
      while (end < text.length && inNumber(text.charCodeAt(end))) end++;
      if (!Number.isFinite(Number(text.slice(i, end)))) return true;
      i = end - 1;
    }
  }
  return false;
}

/** One JSON text a server sent, read: JSON.parse's error for a text that is not JSON, NonFiniteNumber for one with a number that is not finite. */
export function readOutsideJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (holdsNonFiniteNumber(text)) throw new NonFiniteNumber();
  return value;
}

/** A response body read by readOutsideJson. It throws what res.text() throws, as res.json() did. */
export async function responseJson(res: Response): Promise<unknown> {
  return readOutsideJson(await res.text());
}

/**
 * The client's errors for a body nonFiniteSeam replaced (markNonFinite). Kept by identity, so the error itself is
 * never changed and the note does not depend on any field the client may set on its errors. A WeakSet holds no
 * error alive.
 */
const replacedBody = new WeakSet<object>();

/** True when the error is NonFiniteNumber, or is a client error for a body the seam replaced (markNonFinite). */
export function isNonFinite(e: unknown): boolean {
  return e instanceof NonFiniteNumber || (typeof e === "object" && e !== null && replacedBody.has(e));
}

/** What a place that refuses a body that is not JSON says: its own words, with the fixed reason when the body held a number that is not finite. */
export function notJsonBecause(said: string, e: unknown): string {
  return isNonFinite(e) ? `${said} (${NON_FINITE_NUMBER})` : said;
}

/** True when the text is JSON (JSON.parse reads it) and holds a number that is not finite. Never throws. */
export function isNonFiniteJson(text: string): boolean {
  try {
    JSON.parse(text);
  } catch {
    return false;
  }
  return holdsNonFiniteNumber(text);
}

/** The statuses whose Response may not carry a body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * A fetch for @flop-labs/client (its documented `fetch` option), made for one call, and what it met. It calls
 * the real fetch first, so it never stands before or in place of the send, and it never throws because of what
 * a body holds:
 *  - it reads the body text once, from a clone, and runs the number check on it (isNonFiniteJson);
 *  - a body that holds a number that is not finite is handed to the client as a NEW Response with the same
 *    status and headers and a body that is not JSON, the fixed text NON_FINITE_NUMBER, so the client takes its
 *    own path for a body that is not JSON, and so does everything above it. met() is then true;
 *  - any other body, or one whose read fails (an abort, a stream that fails), is handed on as the same
 *    Response: the client reads the other branch of the clone, which holds the same bytes or fails the same way.
 * The note is a closure of this one seam, so two calls never see each other's note. The body is read whole into
 * memory, as the client's own text() does. Nothing bounds its size.
 */
export function nonFiniteSeam(base: typeof fetch): { fetch: typeof fetch; met: () => boolean } {
  let met = false;
  const seamFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await base(input, init);
    let text: string;
    try {
      text = await res.clone().text();
    } catch {
      return res;
    }
    if (!isNonFiniteJson(text)) return res;
    met = true;
    return new Response(NULL_BODY.has(res.status) ? null : NON_FINITE_NUMBER, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
  return { fetch: seamFetch, met: () => met };
}

/**
 * Notes that this error is the client's error for a body nonFiniteSeam replaced, so the place that books the call
 * names the reason (notJsonBecause). The error is handed back as it came: same object, class, name, message and
 * fields, so it takes the same path. What is not an object (a thrown string) cannot be noted and is handed back.
 */
export function markNonFinite(e: unknown): unknown {
  if (typeof e === "object" && e !== null) replacedBody.add(e);
  return e;
}
