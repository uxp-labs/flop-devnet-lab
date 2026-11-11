/**
 * The second swarm audit, of commit 33f3b9f (IMD job b4e8e103). One describe per finding, named with its
 * number and severity. Each test asserts the safe outcome, so it fails on 33f3b9f and passes with its fix.
 * Findings 1 and 7 and finding 11 item (1) are the ledger lock: they are fixed and tested on their own branch.
 * The viewer's side of the shared rules is viewer/test_audit_33f3b9f.py on the same contract files.
 * Stub providers and library calls only; no network (test/setup.ts disables fetch).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLedger, spentToday, utcDay, type LedgerEntry } from "../src/ledger.js";
import { readLedgerText } from "../src/ledger-text.js";
import { ledgerFile } from "../src/paths.js";
import { appendJsonlSafe } from "../src/store.js";
import { tmpHome } from "./helpers.js";

const CONTRACT = join(import.meta.dirname, "..", "..", "contract");

/** A full ledger row as run writes it: seat 7, provider mock, today, state sent. */
function row(id: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    ts: new Date().toISOString(), day: utcDay(), request_id: id, seat: "7", did: "did:key:z", job: "j1", provider: "mock", network: "devnet",
    payer: "holder", model: "m", max_tokens: 8, prompt_sha256: "0", quote_raw: 0.1, quote_padded: 0.4, per_call_cap: 1, daily_cap: 1,
    job_budget: null, spent_before: 0, job_spent_before: null, state: "sent", reason: null, spend: null, spend_raw: null, cost_reported: null,
    cap_charge: 0.4, http: null, mock: true, ...extra,
  };
}

describe("finding 2 (low): every row starts on a fresh line", () => {
  it("a last line with no final newline gets the next row on its own line, and the total counts both", () => {
    const h = tmpHome();
    appendLedger(h, row("mock-7-a"));
    const path = ledgerFile(h);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n$/, ""));
    expect(spentToday(h, "7", "mock")).toBe(0.4);
    appendLedger(h, row("mock-7-b"));
    const lines = readLedgerText(readFileSync(path, "utf8"));
    expect(lines.map((l) => l.kind)).toEqual(["row", "row"]);
    expect(spentToday(h, "7", "mock")).toBe(0.8);
  });

  it("a torn last line stays named by the readers, and the row appended after it is whole on its own line", () => {
    const h = tmpHome();
    appendLedger(h, row("mock-7-a"));
    const path = ledgerFile(h);
    const torn = JSON.stringify(row("mock-7-b")).slice(0, 40);
    writeFileSync(path, readFileSync(path, "utf8") + torn);
    appendLedger(h, row("mock-7-c"));
    const lines = readLedgerText(readFileSync(path, "utf8"));
    expect(lines.map((l) => l.kind)).toEqual(["row", "unreadable", "row"]);
    const last = lines[2];
    expect(last.kind === "row" && last.row.request_id).toBe("mock-7-c");
    expect(() => spentToday(h, "7", "mock")).toThrow(/ledger line 2 cannot be read: not valid JSON/);
  });

  it("holds for every jsonl file the tool appends, not only the ledger", () => {
    const h = tmpHome();
    const path = join(h, "revocations.jsonl");
    writeFileSync(path, '{"a":1}');
    appendJsonlSafe(path, { b: 2 });
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
    appendJsonlSafe(path, { c: 3 });
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
    const empty = join(h, "empty.jsonl");
    writeFileSync(empty, "");
    appendJsonlSafe(empty, { d: 4 });
    expect(readFileSync(empty, "utf8")).toBe('{"d":4}\n');
  });
});
