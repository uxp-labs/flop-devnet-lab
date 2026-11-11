/**
 * The ledger text contract (review fixes 4, items 6 to 8): what ledger.jsonl is as text, the one rule both
 * imd-flop and the viewer (build-lane.py read_ledger_text) implement, written down in contract/README.md and
 * contract/rules.json LEDGER_TEXT, and pinned by the byte fixtures in contract/fixtures/ledger-text/. Pure.
 *  - The file is bytes, decoded as UTF-8 the way Node does it (readFileSync(path, "utf8")): an invalid byte
 *    becomes U+FFFD and never aborts the file.
 *  - Lines end at \n only. A \r is an ordinary character (and JSON whitespace between tokens).
 *  - Lines are numbered from 1, blank ones included. A final empty piece after the last \n is not a line.
 *  - A line is blank when every character is in BLANK: the characters JavaScript's String.prototype.trim
 *    removes, which is what imd-flop did before this contract.
 *  - A line that is not blank is one JSON value in JSON.parse's grammar, and it must be an object. Anything
 *    else is unreadable: "not valid JSON" or "not a JSON object".
 *  - A number is a double (JSON.parse). A boolean is never a number (amount.ts knownAmount).
 *  - Rows are grouped by request id when it is a usable one (isRequestId, contract/rules.json REQUEST_ID);
 *    a row with no usable request id is a group of its own, keyed by its line.
 */

/** The characters a blank line may hold (contract/rules.json LEDGER_TEXT.blank): JavaScript trim()'s set. */
export const BLANK: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

/** contract/rules.json REQUEST_ID: 1 to 128 printable ASCII characters, no space. */
export const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

/** A usable request id (REQUEST_ID): the ids `run` writes, and what `receipt <id>` accepts. */
export function isRequestId(v: unknown): v is string {
  return typeof v === "string" && REQUEST_ID.test(v);
}

export type TextLine =
  | { n: number; kind: "blank" }
  | { n: number; kind: "unreadable"; why: "not valid JSON" | "not a JSON object" }
  | { n: number; kind: "row"; row: Record<string, unknown> };

const isBlank = (text: string): boolean => [...text].every((ch) => BLANK.has(ch.codePointAt(0)!));

/** Every line of a ledger text, numbered from 1, as blank, unreadable or a row. */
export function readLedgerText(text: string): TextLine[] {
  const pieces = text.split("\n");
  if (pieces[pieces.length - 1] === "") pieces.pop();
  return pieces.map((piece, i): TextLine => {
    const n = i + 1;
    if (isBlank(piece)) return { n, kind: "blank" };
    let value: unknown;
    try {
      value = JSON.parse(piece);
    } catch {
      return { n, kind: "unreadable", why: "not valid JSON" };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { n, kind: "unreadable", why: "not a JSON object" };
    return { n, kind: "row", row: value as Record<string, unknown> };
  });
}

/** The group a row belongs to: its request id when usable, else its own line ("line <n>"). */
export function groupKey(row: Record<string, unknown>, n: number): string {
  return isRequestId(row.request_id) ? row.request_id : `line ${n}`;
}

/** The readable rows grouped by groupKey, in the order each group first appears, with their line numbers. */
export function groupRows(lines: TextLine[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const line of lines) {
    if (line.kind !== "row") continue;
    const key = groupKey(line.row, line.n);
    groups.set(key, [...(groups.get(key) ?? []), line.n]);
  }
  return groups;
}
