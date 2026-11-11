/**
 * The ledger text contract (review fixes 4, items 6 to 8), imd-flop's side. Every byte fixture in
 * contract/fixtures/ledger-text/ is read exactly as the ledger is (readFileSync(path, "utf8"), then
 * ledger-text.ts readLedgerText), and checked against expectations.json: the line count, the blank lines,
 * the unreadable lines with why, the groups, and each readable row's cap_charge as a known amount.
 * viewer/test_ledger_text.py checks the same file with the viewer's reader. Offline.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { knownAmount } from "../src/amount.js";
import { BLANK, groupRows, readLedgerText, REQUEST_ID } from "../src/ledger-text.js";

const DIR = join(import.meta.dirname, "..", "..", "contract", "fixtures", "ledger-text");
const expectations = JSON.parse(readFileSync(join(DIR, "expectations.json"), "utf8")).fixtures as Record<string, Record<string, unknown>>;
const rules = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "contract", "rules.json"), "utf8"));

/** What imd-flop reads in one fixture, in the expectation file's shape. */
function observe(name: string) {
  const lines = readLedgerText(readFileSync(join(DIR, name), "utf8"));
  return {
    lines: lines.length,
    blank: lines.filter((l) => l.kind === "blank").map((l) => l.n),
    unreadable: lines.flatMap((l) => (l.kind === "unreadable" ? [{ line: l.n, why: l.why }] : [])),
    groups: [...groupRows(lines).entries()],
    charges: Object.fromEntries(lines.flatMap((l) => (l.kind === "row" ? [[String(l.n), knownAmount(l.row.cap_charge)]] : []))),
  };
}

describe("the ledger text contract (imd-flop)", () => {
  it("every fixture file has an expectation, and every expectation a file", () => {
    const files = readdirSync(DIR).filter((f) => f !== "expectations.json").sort();
    expect(files).toEqual(Object.keys(expectations).sort());
    expect(files.length).toBeGreaterThanOrEqual(22);
  });

  it("rules.json LEDGER_TEXT names the blank set and REQUEST_ID that ledger-text.ts holds", () => {
    expect(rules.constants.LEDGER_TEXT.value.blank).toEqual([...BLANK]);
    expect(rules.constants.REQUEST_ID.value).toBe(REQUEST_ID.source);
  });

  for (const [name, want] of Object.entries(expectations)) {
    it(`${name}: ${want.note}`, () => {
      const { note: _note, ...expected } = want;
      expect(observe(name)).toEqual(expected);
    });
  }
});
