/**
 * The one reading of a JSON text this tool did not write: a body or a frame a server sent (gateway.ts). Pure.
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

/** What a place that refuses a body that is not JSON says: its own words, with the fixed reason when the body held a number that is not finite. */
export function notJsonBecause(said: string, e: unknown): string {
  return e instanceof NonFiniteNumber ? `${said} (${NON_FINITE_NUMBER})` : said;
}
