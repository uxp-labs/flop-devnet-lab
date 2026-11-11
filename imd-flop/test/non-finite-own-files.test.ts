/**
 * Non-finite numbers in the files this tool wrote (brief 2026-11-11, non-finite reads, step 3): what imd-flop's
 * two readers of its own files do with 1e999 and -1e999, and with the bare words NaN, Infinity and -Infinity
 * (Python's json accepts those, JavaScript's does not). The viewer's side is viewer/test_non_finite_own_files.py
 * on the same bytes (LINES and RECEIPTS below are written out the same way there). Both readers agree today, so
 * these tests pin what both do and nothing was changed:
 *  - a ledger line holding 1e999 or -1e999 is a readable row whose number is not a known amount;
 *  - a ledger line holding NaN, Infinity or -Infinity is unreadable, "not valid JSON", named by its line;
 *  - a receipt file holding 1e999 is a readable receipt whose amount is not a known amount;
 *  - a receipt file holding NaN or Infinity is unreadable and listed by name.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { knownAmount } from "../src/amount.js";
import { readLedgerText } from "../src/ledger-text.js";
import { receiptsDir } from "../src/paths.js";
import { listReceipts } from "../src/receipt-store.js";
import { tmpHome } from "./helpers.js";

/** The same five lines as viewer/test_non_finite_own_files.py LINES. */
const LINES = ["1e999", "-1e999", "NaN", "Infinity", "-Infinity"].map((n, i) => `{"request_id":"r${i + 1}","seat":"9001","state":"estimated","cap_charge":${n}}`);
/** The same receipt files as viewer/test_non_finite_own_files.py RECEIPTS. */
const RECEIPTS: Record<string, string> = Object.fromEntries(
  ["1e999", "-1e999", "NaN", "Infinity", "-Infinity"].map((n, i) => [`r${i + 1}`, `{"request_id":"r${i + 1}","seat":"9001","job":"j","state":"settled","settled":${n}}`]),
);

describe("non-finite numbers in the tool's own files: imd-flop's readers (both readers agree, nothing changed)", () => {
  it("a ledger line with 1e999 or -1e999 is a readable row and its number is not a known amount", () => {
    const lines = readLedgerText(LINES.join("\n") + "\n");
    expect(lines.slice(0, 2).map((l) => l.kind)).toEqual(["row", "row"]);
    for (const l of lines.slice(0, 2)) {
      const charge = (l as { row: { cap_charge: unknown } }).row.cap_charge;
      expect(Number.isFinite(charge)).toBe(false);
      expect(knownAmount(charge)).toBeNull();
    }
  });
  it("a ledger line with the bare word NaN, Infinity or -Infinity is unreadable, not valid JSON, named by its line", () => {
    const lines = readLedgerText(LINES.join("\n") + "\n");
    expect(lines.slice(2)).toEqual([
      { n: 3, kind: "unreadable", why: "not valid JSON" },
      { n: 4, kind: "unreadable", why: "not valid JSON" },
      { n: 5, kind: "unreadable", why: "not valid JSON" },
    ]);
  });
  it("a receipt file with 1e999 or -1e999 is a readable receipt whose amount is not known; one with NaN or Infinity is unreadable and named", () => {
    const h = tmpHome();
    mkdirSync(receiptsDir(h), { recursive: true });
    for (const [rid, text] of Object.entries(RECEIPTS)) writeFileSync(join(receiptsDir(h), `${rid}.json`), text);
    const l = listReceipts(h);
    expect(l.receipts.map((r) => r.request_id).sort()).toEqual(["r1", "r2"]);
    expect(l.receipts.map((r) => knownAmount(r.settled))).toEqual([null, null]);
    expect(l.unreadable).toEqual(["r3.json", "r4.json", "r5.json"]);
  });
});
