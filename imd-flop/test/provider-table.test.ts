/**
 * P0 of the provider plan (brief 2026-11-12-p0-provider-interface, rules B1, B2 and B7, and the fix round,
 * rules F1 to F7): the facts about a provider come from one table by its name (src/providers/kinds.ts), and the
 * five files that use providers never name one with a literal or reach for a concrete provider.
 *
 * The source check guards against a careless change, not a hostile one: every diff is read by the lead and by an
 * independent reviewer. A name built at run time (a prefix test, two strings joined, an escape) is out of scope by
 * rule (F2); test/review-p0-source-scan.test.ts pins that the check does not flag those shapes.
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
/** What the concrete provider modules export: none of it may be named in the five files. */
const CONCRETE = new Set([...Object.keys(mockModule), ...Object.keys(gatewayModule)]);

/**
 * A TypeScript source text in three parts: its string literals (quoted strings, and template literals with no
 * substitution), its regular expression literal bodies, and its code. In the code, comments are gone and every
 * literal is a placeholder \u0000<n>\u0000 (n: the index of a string, or -1 for a template with substitutions or a
 * regular expression); the code inside ${} stays code. A small lexer, enough for this package's own sources; its
 * own fixtures are below.
 */
function lex(text: string): { strings: { raw: string; value: string }[]; regexes: string[]; code: string } {
  const strings: { raw: string; value: string }[] = [];
  const regexes: string[] = [];
  let code = "";
  const braces: number[] = []; // for each open ${, the brace depth at which it closes
  let depth = 0;
  let prev = ""; // the last significant code character, to tell a regex from a division
  let i = 0;
  const hold = (n: number) => (code += `\u0000${n}\u0000`);
  const readString = (q: string): void => {
    const start = i++;
    let value = "";
    while (i < text.length && text[i] !== q) {
      if (text[i] === "\\") value += text[i++];
      value += text[i++];
    }
    i++;
    strings.push({ raw: text.slice(start, i), value });
    hold(strings.length - 1);
  };
  const readTemplate = (fresh: boolean): void => {
    // fresh: i is at an opening backtick. Otherwise i is just after the } that closes a ${. Reads to the closing
    // backtick or the next ${. Only a template with no ${} at all is a string literal.
    const start = i;
    let value = "";
    if (fresh) i++;
    while (i < text.length) {
      if (text[i] === "\\") { value += text[i++] + text[i++]; continue; }
      if (text[i] === "`") {
        i++;
        if (fresh) { strings.push({ raw: text.slice(start, i), value }); hold(strings.length - 1); } else hold(-1);
        return;
      }
      if (text[i] === "$" && text[i + 1] === "{") { i += 2; hold(-1); braces.push(depth); depth++; return; }
      value += text[i++];
    }
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; code += " "; continue; }
    if (c === '"' || c === "'") { readString(c); prev = "a"; continue; }
    if (c === "`") { readTemplate(true); prev = "a"; continue; }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(return|typeof|case|of|in)$/.test(code.trimEnd()))) {
      const start = ++i;
      let cls = false;
      while (i < text.length && (cls || text[i] !== "/")) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") cls = true;
        else if (text[i] === "]") cls = false;
        i++;
      }
      regexes.push(text.slice(start, i));
      i++;
      while (/[a-z]/.test(text[i] ?? "")) i++;
      hold(-1);
      prev = "a";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (braces.length > 0 && braces[braces.length - 1] === depth) { braces.pop(); i++; readTemplate(false); prev = "a"; continue; }
    }
    if (!/\s/.test(c)) prev = /[\w$)\].]/.test(c) ? "a" : c;
    code += c;
    i++;
  }
  return { strings, regexes, code };
}

/** The string literals of a source text, in order (lex). */
function stringLiterals(text: string): { raw: string; value: string }[] {
  return lex(text).strings;
}

/** A module specifier that is a concrete provider module or the module that re-exports them (rule a). */
const CONCRETE_MODULE = /(^|\/)providers(\/(gateway|mock))?(\.[cm]?[jt]s)?$/;

/**
 * What a source text does that B2 forbids. The check guards against a careless change, not a hostile one: every
 * diff is read by the lead and by an independent reviewer. So a name built at run time (a prefix test, two strings
 * joined, an escape in a string) is out of scope by rule, and the tests below pin that the check does not flag it.
 * - literal: a string literal whose whole text is a provider name.
 * - (a) reaches: any string that is the specifier of a concrete provider module or of ./providers.js, whatever form
 *   uses it (static, dynamic, export from, namespace import). The concrete modules' exports are not named either,
 *   so a cast or an instanceof cannot be written.
 * - (b) DEFAULT_PROVIDER on one side of a comparison or a case; PROVIDER_NAMES or PROVIDER_NAMES_PAID_FIRST taken
 *   by index, by at() or by destructuring.
 * - (c) an object key that is a provider name, other than the field name mock.
 * - (d) a regular expression literal that holds a provider name as a whole word.
 */
function providerNameFindings(text: string): string[] {
  const found: string[] = [];
  const { strings, regexes, code } = lex(text);
  for (const lit of strings) {
    if (isProviderName(lit.value)) found.push(`literal ${lit.raw}`);
    if (CONCRETE_MODULE.test(lit.value)) found.push(`reaches ${lit.value}`);
  }
  for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) if (CONCRETE.has(m[0])) found.push(`names ${m[0]}`);
  if (/(?:===?|!==?)\s*DEFAULT_PROVIDER\b|\bDEFAULT_PROVIDER\s*(?:===?|!==?)|\bcase\s+DEFAULT_PROVIDER\b/.test(code)) found.push("compares DEFAULT_PROVIDER");
  if (/\bPROVIDER_NAMES(?:_PAID_FIRST)?\s*(?:\[|\.\s*at\s*\()|\[[^\]]*\]\s*=\s*PROVIDER_NAMES(?:_PAID_FIRST)?\b/.test(code)) found.push("indexes PROVIDER_NAMES");
  for (const m of code.matchAll(/[{,]\s*(?:([A-Za-z_$][\w$-]*)|\u0000(\d+)\u0000)\s*:/g)) {
    const key = m[1] ?? strings[Number(m[2])]?.value;
    if (key !== undefined && key !== "mock" && isProviderName(key)) found.push(`key ${key}`);
  }
  for (const body of regexes) for (const w of body.replace(/\\./g, " ").match(/[A-Za-z][\w-]*/g) ?? []) if (isProviderName(w)) found.push(`regex /${body}/`);
  return found;
}

describe("B2 and F2: the five files ask the table, never a name or a concrete provider", () => {
  it("literal: a provider name as a whole string, in any quote", () => {
    expect(providerNameFindings(`if (provider.name !== "mock") throw x;`)).toEqual(['literal "mock"']);
    expect(providerNameFindings(`if (provider.name === 'flop') {`)).toEqual(["literal 'flop'"]);
    expect(providerNameFindings("spentToday(h, seat, `flop`)")).toEqual(["literal `flop`"]);
  });
  it("(a) a concrete provider module or ./providers.js reached in any form, and their exports named", () => {
    expect(providerNameFindings(`import { MockProvider, type Provider } from "./providers.js";`)).toEqual(["reaches ./providers.js", "names MockProvider"]);
    expect(providerNameFindings(`import type { Provider } from "./providers.js";`)).toEqual(["reaches ./providers.js"]);
    expect(providerNameFindings(`import { x } from "./providers/gateway.js";`)).toEqual(["reaches ./providers/gateway.js"]);
    expect(providerNameFindings(`import * as m from "./providers/mock.js";`)).toEqual(["reaches ./providers/mock.js"]);
    expect(providerNameFindings(`const g = await import("./providers/gateway.js");`)).toEqual(["reaches ./providers/gateway.js"]);
    expect(providerNameFindings(`export * from "./providers/mock.js";`)).toEqual(["reaches ./providers/mock.js"]);
    expect(providerNameFindings(`const s = (provider as MockProvider).scenario; if (p instanceof FlopProvider) {}`)).toEqual(["names MockProvider", "names FlopProvider"]);
    // The HTTP client and the table modules are not concrete providers.
    expect(providerNameFindings(`import { postEstimate } from "./gateway.js"; import { kindOf } from "./providers/kinds.js"; import type { Provider } from "./providers/interface.js";`)).toEqual([]);
  });
  it("(b) DEFAULT_PROVIDER compared, and a name taken from the lists by position", () => {
    expect(providerNameFindings(`if (r.provider === DEFAULT_PROVIDER) x();`)).toEqual(["compares DEFAULT_PROVIDER"]);
    expect(providerNameFindings(`if (DEFAULT_PROVIDER != p) x(); switch (p) { case DEFAULT_PROVIDER: }`)).toEqual(["compares DEFAULT_PROVIDER"]);
    expect(providerNameFindings(`const n = PROVIDER_NAMES_PAID_FIRST[0];`)).toEqual(["indexes PROVIDER_NAMES"]);
    expect(providerNameFindings(`const n = PROVIDER_NAMES.at(-1);`)).toEqual(["indexes PROVIDER_NAMES"]);
    expect(providerNameFindings(`const [first] = PROVIDER_NAMES;`)).toEqual(["indexes PROVIDER_NAMES"]);
    expect(providerNameFindings(`const pname = values.provider ?? DEFAULT_PROVIDER; for (const p of PROVIDER_NAMES) f(p);`)).toEqual([]);
  });
  it("(c) an object key that is a provider name, bare or quoted; the field mock stays allowed", () => {
    expect(providerNameFindings(`const m = { mock: true, flop: false };`)).toEqual(["key flop"]);
    expect(providerNameFindings(`const m = { "flop": 1 };`)).toEqual(['literal "flop"', "key flop"]);
    expect(providerNameFindings(`const row = { ...base, mock: kind.mock }; const t = a ? flop : b;`)).toEqual([]);
  });
  it("(d) a regular expression literal that holds a provider name as a whole word", () => {
    expect(providerNameFindings(`if (!/^mock$/.test(name)) x();`)).toEqual(["regex /^mock$/"]);
    expect(providerNameFindings(`const re = /\\bflop\\b/i;`)).toEqual(["regex /\\bflop\\b/"]);
    expect(providerNameFindings(`const re = /flopper|mocked/; const d = a / b / c;`)).toEqual([]);
  });
  it("the lexer reads strings past comments, regular expressions and template literals with substitutions", () => {
    const src = [
      "const a = `${x ? \"q\" : `in ${y}`} and ${'z'}`; // a \"mock\" in a comment",
      "/* \"flop\" in a block */ const re = /^[\"'`]{1,2}$/g; const d = n / 2 / 3;",
      "if (rid.includes(\"/\") || p === \"mock\") f(`flop`);",
    ].join("\n");
    expect(stringLiterals(src).map((l) => l.value)).toEqual(["q", "z", "/", "mock", "flop"]);
    expect(lex(src).regexes).toEqual(["^[\"'`]{1,2}$"]);
    expect(providerNameFindings(src)).toEqual(['literal "mock"', "literal `flop`"]);
  });
  it("finds nothing in text that only mentions a name inside a longer string or a comment", () => {
    expect(providerNameFindings('throw new Error("--provider must be mock or flop"); // the "mock" provider')).toEqual([]);
  });
  for (const f of FIVE) {
    it(`${f} names no provider and reaches no concrete provider`, () => {
      expect(providerNameFindings(readFileSync(join(PKG, f), "utf8"))).toEqual([]);
    });
  }
});

describe("F3: the run path reads the provider's name once", () => {
  it("a whole run, through the CLI to the printed result, reads name once", async () => {
    const h = tmpHome();
    await readySeat(h, "42");
    const inner = new mockModule.MockProvider("settled");
    let reads = 0;
    const p = {
      get name() {
        reads++;
        return "mock" as const;
      },
      get calls() {
        return inner.calls;
      },
      scenario: inner.scenario,
      estimate: (b: Parameters<typeof inner.estimate>[0]) => inner.estimate(b),
      complete: (r: Parameters<typeof inner.complete>[0]) => inner.complete(r),
      readReceipt: (id: string) => inner.readReceipt(id),
    };
    const r = await cli(h, ["run", "--seat", "42", "--job", "j1", "--prompt", "hi", "--max-tokens", "8"], { provider: p });
    expect({ code: r.code, reads, marked: r.out.startsWith("[MOCK] ") }).toEqual({ code: 0, reads: 1, marked: true });
  });
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
