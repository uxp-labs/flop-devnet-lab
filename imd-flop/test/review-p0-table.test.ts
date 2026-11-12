/**
 * Review of P0 (132bb6a..576d4d7), attack B and G: promise P2 says the table and the kinds cannot be changed at
 * run time by a caller. Each test changes a value through a cast, as a caller in plain JavaScript can, and puts
 * it back afterwards.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER, kindOf, PROVIDER_NAMES, PROVIDER_NAMES_PAID_FIRST, UNLISTED_KIND } from "../src/providers/kinds.js";
import { makeProvider } from "../src/providers/make.js";
import { LEDGER_PROVIDERS } from "../src/ledger.js";
import { CliError } from "../src/errors.js";
import { MockProvider } from "../src/providers.js";
import { paidRun } from "./lib/scripted-gateway.js";
import { tmpHome } from "./helpers.js";

describe("review P0, P2: the table and its kinds are fixed at run time", () => {
  it("every kind object the table gives is frozen", () => {
    for (const n of PROVIDER_NAMES) expect({ n, frozen: Object.isFrozen(kindOf(n)) }).toEqual({ n, frozen: true });
    expect(Object.isFrozen(UNLISTED_KIND)).toBe(true);
  });
  it("a caller that sets kindOf('flop').paid to false does not turn the paid gate off for a flop run", async () => {
    const k = kindOf("flop") as { paid: boolean };
    let threw = false;
    try {
      k.paid = false;
    } catch {
      threw = true;
    }
    try {
      // The FLOP RPC answers another genesis, so the gate must refuse with exit 5 and nothing is sent.
      const r = await paidRun({}, `{"jsonrpc":"2.0","id":1,"result":"0x${"ab".repeat(32)}"}`);
      const rows = existsSync(join(r.h, "ledger.jsonl")) ? readFileSync(join(r.h, "ledger.jsonl"), "utf8").trim().split("\n").length : 0;
      expect({ threw, paid: kindOf("flop").paid, code: r.code, seen: r.gw.seen, rows }).toEqual({ threw: true, paid: true, code: 5, seen: ["chainId", "faucet"], rows: 0 });
    } finally {
      if (!Object.isFrozen(k)) k.paid = true;
    }
  });
  it("the list of names is frozen: a caller cannot add a name", () => {
    expect(Object.isFrozen(PROVIDER_NAMES)).toBe(true);
    expect(Object.isFrozen(PROVIDER_NAMES_PAID_FIRST)).toBe(true);
  });
  it("a name pushed onto PROVIDER_NAMES changes no message of the maker", () => {
    const list = PROVIDER_NAMES as string[];
    let pushed = false;
    try {
      list.push("extra");
      pushed = true;
    } catch {
      /* frozen: the rule holds */
    }
    try {
      let msg = "";
      try {
        makeProvider("nope", { home: tmpHome(), env: {} }, { for: "run", seat: "42" });
      } catch (e) {
        msg = (e as CliError).message;
      }
      expect(msg).toBe("--provider must be mock or flop");
    } finally {
      if (pushed) list.pop();
    }
  });
  it("note (as at 132bb6a): LEDGER_PROVIDERS is a plain Set, so a caller can add a name to it", () => {
    const s = LEDGER_PROVIDERS as Set<string>;
    s.add("extra");
    try {
      expect(LEDGER_PROVIDERS.has("extra")).toBe(true);
    } finally {
      s.delete("extra");
    }
    expect(DEFAULT_PROVIDER).toBe("mock");
    expect(makeProvider("mock", { home: tmpHome(), env: {} }, { for: "quote" })).toBeInstanceOf(MockProvider);
  });
});
