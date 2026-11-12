/**
 * P0 of the provider plan (brief 2026-11-12-p0-provider-interface, rules B1, B2 and B7): the facts about a
 * provider come from one table by its name (src/providers/kinds.ts), and the five files that use providers
 * never name one with a literal or reach for a concrete provider.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER, isProviderName, kindOf, PROVIDER_NAMES, PROVIDER_NAMES_PAID_FIRST, requestIdPrefix, UNLISTED_KIND } from "../src/providers/kinds.js";
import { makeProvider } from "../src/providers/make.js";
import * as mockModule from "../src/providers/mock.js";
import * as gatewayModule from "../src/providers/gateway.js";
import { LEDGER_PROVIDERS } from "../src/ledger.js";
import { CliError, EXIT } from "../src/errors.js";
import { cli, readySeat, tmpHome } from "./helpers.js";

const PKG = join(import.meta.dirname, "..");
const RULES = JSON.parse(readFileSync(join(PKG, "..", "contract", "rules.json"), "utf8")) as { constants: Record<string, { value: unknown }> } & Record<string, unknown>;
/** contract/rules.json LEDGER_PROVIDERS, wherever the file keeps it. */
function rulesLedgerProviders(): unknown {
  const seen: unknown[] = [];
  const walk = (v: unknown): void => {
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (k === "LEDGER_PROVIDERS" ? seen.push((x as { value: unknown }).value) : walk(x));
  };
  walk(RULES);
  expect(seen).toHaveLength(1);
  return seen[0];
}

/** B2: the files that use providers and must ask the table instead of naming one. */
const FIVE = ["src/run.ts", "src/cli.ts", "src/receipt-store.ts", "src/booking.ts", "src/settlement.ts"];
/** What the concrete provider modules export: none of it may be imported by the five files. */
const CONCRETE = new Set([...Object.keys(mockModule), ...Object.keys(gatewayModule)]);

/**
 * The string literals of a TypeScript source text, in order: quoted strings, and template literals with no
 * substitution. Comments, regular expression literals and the code inside ${} are skipped as code, so a quote
 * inside any of them does not start a string. It is a small lexer, enough for this package's own sources
 * (the test below runs it on fixtures and on the five files).
 */
function stringLiterals(text: string): { raw: string; value: string }[] {
  const out: { raw: string; value: string }[] = [];
  const braces: number[] = []; // for each open ${, the brace depth at which it closes
  let depth = 0;
  let prev = ""; // the last significant token character, to tell a regex from a division
  let i = 0;
  const readString = (q: string): void => {
    const start = i++;
    let value = "";
    while (i < text.length && text[i] !== q) {
      if (text[i] === "\\") value += text[i++];
      value += text[i++];
    }
    i++;
    out.push({ raw: text.slice(start, i), value });
  };
  const readTemplate = (fresh: boolean): void => {
    // fresh: i is at an opening backtick. Otherwise i is just after the } that closes a ${. Reads to the closing
    // backtick or the next ${. Only a template with no ${} at all is a literal.
    const start = i;
    let value = "";
    if (fresh) i++;
    while (i < text.length) {
      if (text[i] === "\\") { value += text[i++] + text[i++]; continue; }
      if (text[i] === "`") { i++; if (fresh) out.push({ raw: text.slice(start, i), value }); return; }
      if (text[i] === "$" && text[i + 1] === "{") { i += 2; braces.push(depth); depth++; return; }
      value += text[i++];
    }
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (c === '"' || c === "'") { readString(c); prev = "a"; continue; }
    if (c === "`") { readTemplate(true); prev = "a"; continue; }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(return|typeof|case|of|in)$/.test(text.slice(Math.max(0, i - 8), i).trimEnd()))) {
      i++;
      let cls = false;
      while (i < text.length && (cls || text[i] !== "/")) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") cls = true;
        else if (text[i] === "]") cls = false;
        i++;
      }
      i++;
      while (/[a-z]/.test(text[i] ?? "")) i++;
      prev = "a";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (braces.length > 0 && braces[braces.length - 1] === depth) { braces.pop(); i++; readTemplate(false); prev = "a"; continue; }
    }
    if (!/\s/.test(c)) prev = /[\w$)\].]/.test(c) ? "a" : c;
    i++;
  }
  return out;
}

/**
 * What a source text does that B2 forbids: a string literal (any quote) whose whole text is a provider name, an
 * import from a concrete provider module, an import of anything those modules export, or a cast or instanceof
 * with a concrete provider class.
 */
function providerNameFindings(text: string): string[] {
  const found: string[] = [];
  for (const lit of stringLiterals(text)) if (isProviderName(lit.value)) found.push(`literal ${lit.raw}`);
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (/(^|\/)providers\/(mock|gateway)(\.js)?$/.test(m[2]!)) found.push(`import from ${m[2]}`);
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!;
      if (CONCRETE.has(name)) found.push(`import ${name}`);
    }
  }
  for (const m of text.matchAll(/import\s+(?:type\s+)?\*\s+as\s+\w+\s+from\s*["']([^"']*providers\/(?:mock|gateway)(?:\.js)?)["']/g)) found.push(`import from ${m[1]}`);
  for (const m of text.matchAll(/\b(as|instanceof)\s+(\w+)/g)) if (CONCRETE.has(m[2]!)) found.push(`${m[1]} ${m[2]}`);
  return found;
}

describe("B2: the five files ask the table, never a name or a concrete provider", () => {
  it("the check finds each thing it looks for (the shapes the files had before P0)", () => {
    expect(providerNameFindings(`if (provider.name !== "mock") throw x;`)).toEqual(['literal "mock"']);
    expect(providerNameFindings(`if (provider.name === 'flop') {`)).toEqual(["literal 'flop'"]);
    expect(providerNameFindings("spentToday(h, seat, `flop`)")).toEqual(["literal `flop`"]);
    expect(providerNameFindings(`import { FlopProvider, MOCK_SCENARIOS, MockProvider, type MockScenario, type Provider } from "./providers.js";`)).toEqual(["import FlopProvider", "import MOCK_SCENARIOS", "import MockProvider"]);
    expect(providerNameFindings(`import { x } from "./providers/gateway.js";`)).toEqual(["import from ./providers/gateway.js"]);
    expect(providerNameFindings(`import * as m from "./providers/mock.js";`)).toEqual(["import from ./providers/mock.js"]);
    expect(providerNameFindings(`const s = (provider as MockProvider).scenario; if (p instanceof FlopProvider) {}`)).toEqual(["as MockProvider", "instanceof FlopProvider"]);
  });
  it("reads strings past comments, regular expressions and template literals with substitutions", () => {
    const src = [
      "const a = `${x ? \"q\" : `in ${y}`} and ${'z'}`; // a \"mock\" in a comment",
      "/* \"flop\" in a block */ const re = /^[\"'`]{1,2}$/g; const d = n / 2 / 3;",
      "if (rid.includes(\"/\") || p === \"mock\") f(`flop`);",
    ].join("\n");
    expect(stringLiterals(src).map((l) => l.value)).toEqual(["q", "z", "/", "mock", "flop"]);
    expect(providerNameFindings(src)).toEqual(['literal "mock"', "literal `flop`"]);
  });
  it("finds nothing in text that only mentions a name inside a longer string or a comment without quotes", () => {
    expect(providerNameFindings('throw new Error("--provider must be mock or flop"); // the mock provider')).toEqual([]);
    expect(providerNameFindings(`import { kindOf } from "./providers/kinds.js";`)).toEqual([]);
  });
  for (const f of FIVE) {
    it(`${f} names no provider and imports no concrete provider`, () => {
      expect(providerNameFindings(readFileSync(join(PKG, f), "utf8"))).toEqual([]);
    });
  }
});

describe("F7: the quote provider reads fetch when the estimate is asked", () => {
  it("a globalThis.fetch replaced after the provider is made is the one the estimate uses", async () => {
    const p = makeProvider("flop", { home: tmpHome(), env: {} }, { for: "quote" });
    const before = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ model: "m", estimated_input_tokens: 1, estimated_output_tokens: 8, estimated_cost_flop: 0.054 }), { status: 200 });
    }) as typeof fetch;
    try {
      const est = await p.estimate({ model: "m", prompt: "hi", max_tokens: 8 });
      expect({ est, seen: seen.map((u) => u.endsWith("/models/estimate")) }).toEqual({ est: { model: "m", estimated_input_tokens: 1, estimated_output_tokens: 8, estimated_cost_flop: 0.054 }, seen: [true] });
    } finally {
      globalThis.fetch = before;
    }
  });
});

describe("F6: a mock scenario not in the list", () => {
  it("run --provider mock --mock-scenario <a bad value> is refused with exit 2 and the list of scenarios", async () => {
    const h = tmpHome();
    await readySeat(h, "42");
    const r = await cli(h, ["run", "--seat", "42", "--job", "j1", "--prompt", "hi", "--provider", "mock", "--mock-scenario", "nope"]);
    expect({ code: r.code, err: r.err, out: r.out }).toEqual({ code: EXIT.USAGE, err: `imd-flop: --mock-scenario must be one of ${mockModule.MOCK_SCENARIOS.join(", ")}`, out: "" });
    expect(mockModule.MOCK_SCENARIOS).toEqual(["ok", "timeout", "settled", "key_expired", "estimate_error"]);
  });
});

describe("B1: one table of provider names and kinds", () => {
  it("its names are contract/rules.json LEDGER_PROVIDERS, in that order, and the ledger's list is the same", () => {
    expect([...PROVIDER_NAMES]).toEqual(rulesLedgerProviders());
    expect([...LEDGER_PROVIDERS]).toEqual([...PROVIDER_NAMES]);
  });
  it("src/ledger.ts takes its list and its row type from the table: it names no provider itself (A5)", () => {
    expect(providerNameFindings(readFileSync(join(PKG, "src/ledger.ts"), "utf8"))).toEqual([]);
  });
  it("every name has a kind of three booleans", () => {
    for (const n of PROVIDER_NAMES) {
      const k = kindOf(n);
      expect(k).not.toBe(UNLISTED_KIND);
      expect(Object.keys(k).sort()).toEqual(["mock", "needsWalletLink", "paid"]);
      expect(Object.values(k).every((v) => typeof v === "boolean")).toBe(true);
    }
  });
  it("the kinds are today's: mock is the mock, flop is paid and needs the wallet link", () => {
    expect(PROVIDER_NAMES.map((n) => [n, kindOf(n)])).toEqual([
      ["mock", { paid: false, mock: true, needsWalletLink: false }],
      ["flop", { paid: true, mock: false, needsWalletLink: true }],
    ]);
    expect(DEFAULT_PROVIDER).toBe("mock");
    expect(PROVIDER_NAMES_PAID_FIRST).toEqual(["flop", "mock"]);
    expect(PROVIDER_NAMES.map((n) => requestIdPrefix(kindOf(n)))).toEqual(["mock", "imdflop"]);
  });
  it("a name not in the table gets the unlisted kind (not paid, not a mock, no wallet link), as the run path treated it before", () => {
    for (const n of ["nope", "", "Mock", "flop-channel", "__proto__", "toString"]) {
      expect(isProviderName(n)).toBe(false);
      expect(kindOf(n)).toBe(UNLISTED_KIND);
    }
    expect(UNLISTED_KIND).toEqual({ paid: false, mock: false, needsWalletLink: false });
    expect(requestIdPrefix(UNLISTED_KIND)).toBe("imdflop");
  });
  it("the maker refuses a name not in the table for a run, and gives the mock for a quote (B6, as before)", () => {
    const ctx = { home: tmpHome(), env: {} };
    let err: unknown = null;
    try {
      makeProvider("nope", ctx, { for: "run", seat: "42" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect({ message: (err as CliError).message, code: (err as CliError).code }).toEqual({ message: "--provider must be mock or flop", code: EXIT.USAGE });
    expect(makeProvider("nope", ctx, { for: "quote" })).toBeInstanceOf(mockModule.MockProvider);
    expect(makeProvider("__proto__", ctx, { for: "quote" })).toBeInstanceOf(mockModule.MockProvider);
    expect(makeProvider("flop", ctx, { for: "quote" }).name).toBe("flop");
  });
});
