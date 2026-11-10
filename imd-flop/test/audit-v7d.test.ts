/**
 * Fail-first regression for IMD audit e99a2cf1 info #12 (imd-flop at 288a03e):
 * withLedgerLock released the lock as soon as an async body returned its promise.
 * The safe outcome is asserted: a promise-returning body is refused, and no lock is left behind.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tmpHome } from "./helpers.js";

describe("TS-I12 withLedgerLock body must be synchronous", () => {
  it("TS-I12 refuses a promise-returning body (outer and re-entrant) and leaves no lock behind", async () => {
    const { withLedgerLock } = await import("../src/ledger.js");
    const home = tmpHome();
    const lock = `${join(home, "ledger.jsonl")}.lock`;
    let afterAwait = false;
    expect(() => withLedgerLock(home, async () => { await Promise.resolve(); afterAwait = true; }))
      .toThrow(/synchronous/);
    expect(existsSync(lock)).toBe(false);
    expect(() => withLedgerLock(home, () => withLedgerLock(home, () => Promise.resolve(1))))
      .toThrow(/synchronous/);
    expect(existsSync(lock)).toBe(false);
    // A plain synchronous body still works and returns its value.
    expect(withLedgerLock(home, () => 42)).toBe(42);
    expect(existsSync(lock)).toBe(false);
    await Promise.resolve();
    expect(afterAwait).toBe(true); // the refused body's tail ran outside the lock, which is why it is refused
  });
});
