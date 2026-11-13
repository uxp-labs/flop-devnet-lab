/**
 * P2, rules T5, A1, A4, B1, B2 and C7, as tests over the source text: the list of files under src/chain-read; its
 * pure files hold none of the patterns banned in src/chain; only door.ts imports the observatory, and only its door;
 * only shape-file.ts reads a shape file, through the package; only the five read methods appear; nothing of the
 * encoder is imported; one place opens a socket; and no test of chain-read opens one. The P2 fix round, rule X7: under
 * all of src no file holds a dynamic import, and import.meta, createRequire, a require call and require.resolve appear
 * only in chain-read/shape-file.ts, so every module a source file loads is named by a static import of a literal text.
 * Each scan proves itself on a planted sample first.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { READ_METHODS } from "../src/chain-read/node.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PKG, "src");
const DIR = join(SRC, "chain-read");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const text = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => relative(PKG, p);
const CHAIN_READ = files(DIR);
const ALL_SRC = files(SRC);

/** The module names a text imports or resolves: static and dynamic imports, require and require.resolve. */
function specifiers(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'`]([^"'`]+)["'`]/g)) out.push(m[1] as string);
  for (const m of t.matchAll(/\brequire(?:\.resolve)?\(\s*["'`]([^"'`$]*)/g)) out.push(m[1] as string);
  return out;
}

/**
 * A source text with its comments taken out, so a word in a comment is not code (rule X7). Strings and template
 * texts are kept whole, and a comment marker inside one is not a comment. A template's ${...} is read as code.
 */
function code(t: string): string {
  let out = "";
  let i = 0;
  const stack: ("tpl" | "brace")[] = [];
  while (i < t.length) {
    const c = t[i] as string;
    const n = t[i + 1];
    if (stack.at(-1) === "tpl") {
      if (c === "\\") { out += c + (n ?? ""); i += 2; continue; }
      if (c === "`") { stack.pop(); out += c; i++; continue; }
      if (c === "$" && n === "{") { stack.push("brace"); out += "${"; i += 2; continue; }
      out += c; i++; continue;
    }
    if (c === "/" && n === "/") { while (i < t.length && t[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const end = t.indexOf("*/", i + 2); i = end < 0 ? t.length : end + 2; out += " "; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < t.length && t[j] !== c && t[j] !== "\n") j += t[j] === "\\" ? 2 : 1;
      out += t.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "`") { stack.push("tpl"); out += c; i++; continue; }
    if (c === "{" && stack.length > 0) stack.push("brace");
    if (c === "}" && stack.at(-1) === "brace") stack.pop();
    out += c; i++;
  }
  // A text that ends inside a template was misread (a backtick in a regular expression, say): never a pass.
  if (stack.length > 0) throw new Error("the text ends inside a template text");
  return out;
}

/** The forms rule X7 scans for, each over a text with its comments taken out. */
const LOADERS = {
  "a dynamic import": /\bimport\s*\(/,
  "import.meta": /\bimport\s*\.\s*meta\b/,
  createRequire: /\bcreateRequire\b/,
  "a require call": /(?<![\w$.])require\s*\(/,
  "require.resolve": /\brequire\s*\.\s*resolve\b/,
} as const;
const holds = (form: keyof typeof LOADERS, t: string): boolean => LOADERS[form].test(code(t));

/** The two files of chain-read that are not pure: the transport and the shape file's read. */
const NOT_PURE = ["node.ts", "shape-file.ts"];

/** The pattern src/chain's purity test (test/chain-refusals.test.ts, E1 and E13) bans, read from that file. */
function bannedOfChain(): RegExp {
  const m = text(join(PKG, "test", "chain-refusals.test.ts")).match(/const banned = \/(.+)\/;\n/);
  if (m === null) throw new Error("test/chain-refusals.test.ts holds no banned pattern");
  return new RegExp(m[1] as string);
}

/** RPC method names a text holds in a string: a namespace, an underscore and a name. */
const METHOD = /["'`]((?:chain|state|author|system|rpc|payment|childstate|offchain|grandpa|babe|beefy|mmr|dev|sync|transaction|transactionWatch|archive|chainHead|chainSpec)_[A-Za-z0-9]+)["'`]/g;
const methodsIn = (t: string) => [...t.matchAll(METHOD)].map((m) => m[1] as string);

describe("A1, T5: the files of src/chain-read", () => {
  it("are exactly these", () => {
    expect(CHAIN_READ.map((f) => relative(DIR, f)).sort()).toEqual([
      "bytes.ts",
      "cross-check.ts",
      "door.ts",
      "freeze.ts",
      "key-table-types.ts",
      "key-table.ts",
      "keys.ts",
      "node.ts",
      "read.ts",
      "result.ts",
      "session-state.ts",
      "shape-file.ts",
    ]);
  });

  it("the pattern src/chain bans is read from its test, and finds each banned form (control)", () => {
    const banned = bannedOfChain();
    for (const s of [`import x from "node:fs"`, "readFileSync(p)", "await fetch(u)", "new WebSocket(u)", "Date.now()", "Math.random()", "process.env.X", "Buffer.from(x)", "setTimeout(f)"]) expect(banned.test(s)).toBe(true);
  });

  it("every file but node.ts and shape-file.ts holds none of the patterns banned in src/chain", () => {
    const banned = bannedOfChain();
    const pure = CHAIN_READ.filter((f) => !NOT_PURE.some((n) => f.endsWith(`/${n}`)));
    expect(pure.length).toBe(CHAIN_READ.length - NOT_PURE.length);
    expect(pure.filter((f) => banned.test(text(f))).map(rel)).toEqual([]);
  });
});

describe("A4, T5: only door.ts imports the observatory, and only its door; only shape-file.ts reads a shape file", () => {
  it("the specifier scan finds each form (control)", () => {
    expect(specifiers(`import { a } from "flop-observatory/scale/block";\nconst b = await import("x/y");\nrequire.resolve(\`flop-observatory/\${f}\`); require("z")`)).toEqual(["flop-observatory/scale/block", "x/y", "flop-observatory/", "z"]);
  });

  it("of every file under src, only door.ts imports flop-observatory, and it imports flop-observatory/scale/block alone", () => {
    const importers = ALL_SRC.filter((f) => specifiers(text(f)).some((s) => s.startsWith("flop-observatory") && !(f.endsWith("chain-read/shape-file.ts") && s === "flop-observatory/")));
    expect(importers.map(rel)).toEqual(["src/chain-read/door.ts"]);
    expect(specifiers(text(join(DIR, "door.ts"))).filter((s) => s.startsWith("flop-observatory"))).toEqual(["flop-observatory/scale/block"]);
  });

  it("only shape-file.ts resolves a module name built at run time, and it resolves flop-observatory/shapes/<name>.json only", () => {
    const resolvers = ALL_SRC.filter((f) => /require\.resolve\(/.test(text(f)));
    expect(resolvers.map(rel)).toEqual(["src/chain-read/shape-file.ts"]);
    const t = text(join(DIR, "shape-file.ts"));
    expect(t).toContain("require.resolve(`flop-observatory/${shapeFile}`)");
    expect(t).toContain("const SHAPE_FILE = /^shapes\\/[a-z0-9][a-z0-9.-]*\\.json$/;");
  });

  it("no string of any file under src names a path into the observatory's folder, and only shape-file.ts under src/chain-read reads a file", () => {
    const into = /["'`][^"'`\n]*(?:\.\.\/observatory|observatory\/shapes|observatory\/dist|observatory\/src)[^"'`\n]*["'`]/;
    for (const s of [`"../observatory/shapes/x.json"`, "`../../observatory/dist/scale/block.js`", `'flop-observatory/shapes/x.json'`]) expect(into.test(s)).toBe(true);
    expect(ALL_SRC.filter((f) => /["'`][^"'`\n]*(?:\.\.\/observatory|observatory\/shapes|observatory\/dist|observatory\/src)[^"'`\n]*["'`]/.test(text(f))).map(rel)).toEqual([]);
    expect(CHAIN_READ.filter((f) => /readFileSync|readFile\(|openSync|createReadStream/.test(text(f))).map(rel)).toEqual(["src/chain-read/shape-file.ts"]);
  });

  it("no file under src imports the reference decoder (a dev dependency)", () => {
    expect(ALL_SRC.filter((f) => specifiers(text(f)).some((s) => s.startsWith("@polkadot-api"))).map(rel)).toEqual([]);
  });
});

describe("X7: every module a source file loads is named by a static import of a literal text", () => {
  it("each scan finds its planted samples, the reviewer's form among them (control)", () => {
    const reviewer = 'const m = await import(new URL(["..", "x", "y.js"].join("/"), import.meta.url).href);';
    expect(holds("a dynamic import", reviewer)).toBe(true);
    expect(holds("import.meta", reviewer)).toBe(true);
    expect(holds("a dynamic import", 'await import("./x.js")')).toBe(true);
    expect(holds("a dynamic import", "await import /* x */ (`./${n}.js`)")).toBe(true);
    expect(holds("import.meta", "const u = import . meta.url;")).toBe(true);
    expect(holds("createRequire", 'import { createRequire } from "node:module";')).toBe(true);
    expect(holds("a require call", 'const x = require("./x.cjs");')).toBe(true);
    expect(holds("a require call", "const x = require (name);")).toBe(true);
    expect(holds("require.resolve", "require.resolve(`x/${n}`)")).toBe(true);
    expect(holds("require.resolve", "require\n  .resolve(n)")).toBe(true);
  });

  it("a word in a comment is not code, and a static import or a name that starts with require is not a load (control)", () => {
    for (const form of Object.keys(LOADERS) as (keyof typeof LOADERS)[]) {
      expect(holds(form, "// import(x); import.meta; createRequire; require(x); require.resolve(x)")).toBe(false);
      expect(holds(form, "/* import(x)\n import.meta createRequire require(x) require.resolve(x) */")).toBe(false);
    }
    expect(holds("a dynamic import", 'import { a } from "./a.js";\nimport type { B } from "./b.js";')).toBe(false);
    expect(holds("a require call", "requireCap(caps, seat); if (requireWallet) x.require(y);")).toBe(false);
    expect(holds("a require call", 'const u = "ws://x"; require(y);')).toBe(true);
    expect(holds("a dynamic import", "const t = `a ${b} // c`; import(d);")).toBe(true);
  });

  it("every file under src is read to its end in code, not inside a template text", () => {
    expect(() => code("const a = `x ${b} y`;")).not.toThrow();
    expect(() => code("const r = /[`]/; import(x);")).toThrow("the text ends inside a template text");
    for (const f of ALL_SRC) expect(() => code(text(f)), rel(f)).not.toThrow();
  });

  it("no file under src holds a dynamic import", () => {
    expect(ALL_SRC.filter((f) => holds("a dynamic import", text(f))).map(rel)).toEqual([]);
  });

  for (const form of ["import.meta", "createRequire", "a require call", "require.resolve"] as const) {
    it(`${form} appears only in src/chain-read/shape-file.ts`, () => {
      expect(ALL_SRC.filter((f) => holds(form, text(f))).map(rel).filter((f) => f !== "src/chain-read/shape-file.ts")).toEqual([]);
    });
  }
});

describe("B2, T5: only the five read methods appear under src/chain-read", () => {
  it("the method scan finds a planted name (control)", () => {
    expect(methodsIn(`t("author_submitExtrinsic", []); t('state_call')`)).toEqual(["author_submitExtrinsic", "state_call"]);
  });

  it("the five are chain_getFinalizedHead, chain_getHeader, chain_getBlockHash, state_getStorage and state_getMetadata", () => {
    expect([...READ_METHODS].sort()).toEqual(["chain_getBlockHash", "chain_getFinalizedHead", "chain_getHeader", "state_getMetadata", "state_getStorage"]);
  });

  it("no other method name, and no author_ name at all, appears in any file under src/chain-read", () => {
    const found = CHAIN_READ.flatMap((f) => methodsIn(text(f)).filter((m) => !(READ_METHODS as readonly string[]).includes(m)).map((m) => `${rel(f)}: ${m}`));
    expect(found).toEqual([]);
    expect(CHAIN_READ.filter((f) => /author_/.test(text(f))).map(rel)).toEqual([]);
  });
});

describe("C7, A1: chain-read does not reach the encoder", () => {
  it("no file under src/chain-read imports src/chain", () => {
    expect(CHAIN_READ.filter((f) => specifiers(text(f)).some((s) => /(^|\/)chain\//.test(s))).map(rel)).toEqual([]);
  });
});

describe("B1: one place opens a socket to a node", () => {
  it("node-rpc.ts is the only file under src that constructs a WebSocket, and it exports rpcCall", () => {
    expect(ALL_SRC.filter((f) => /new\s+WebSocket\b/.test(text(f))).map(rel)).toEqual(["src/node-rpc.ts"]);
    expect(text(join(SRC, "node-rpc.ts"))).toMatch(/^export function rpcCall\(/m);
  });

  it("gateway.ts and chain-read/node.ts both take rpcCall from node-rpc.ts, and gateway.ts defines none", () => {
    expect(specifiers(text(join(SRC, "gateway.ts")))).toContain("./node-rpc.js");
    expect(text(join(SRC, "gateway.ts"))).not.toMatch(/function rpcCall\b/);
    expect(specifiers(text(join(DIR, "node.ts")))).toContain("../node-rpc.js");
  });
});

describe("T5: no test of chain-read opens a socket", () => {
  // This file is left out: it holds the planted samples of the scans above, as text. A test that needs a socket puts
  // a fake socket class in place of the global WebSocket for its own run (node-rpc.test.ts, chain-read-node.test.ts,
  // chain-read-unknown.test.ts, review-chain-read-lead.test.ts): that is how those tests work, and no real socket is
  // made. The list grows by the reviewer's six files and the fix round's (rule X7), and is held against the folder.
  const NAMES = [
    "chain-read-head.test.ts",
    "chain-read-keys.test.ts",
    "chain-read-node.test.ts",
    "chain-read-pair.test.ts",
    "chain-read-pin.test.ts",
    "chain-read-replay.test.ts",
    "chain-read-state.test.ts",
    "chain-read-unknown.test.ts",
    "node-rpc.test.ts",
    "review-chain-read-block.test.ts",
    "review-chain-read-cross-check.test.ts",
    "review-chain-read-lead.test.ts",
    "review-chain-read-runtime.test.ts",
    "review-chain-read-tables-package.test.ts",
    "review-chain-read-unknown.test.ts",
  ];
  const TESTS = [...NAMES.map((n) => join(PKG, "test", n)), join(PKG, "test", "lib", "recorded-node.ts")];

  it("the list is every chain-read test file of the folder, and node-rpc.test.ts", () => {
    const found = readdirSync(join(PKG, "test")).filter((n) => /^(?:review-)?chain-read-[a-z-]+\.test\.ts$/.test(n) && n !== "chain-read-source.test.ts");
    expect([...found, "node-rpc.test.ts"].sort()).toEqual(NAMES);
  });

  it("the chain-read tests and their scripted node import no network module and construct no socket", () => {
    const net = /["'`]node:(?:net|http|https|http2|tls|dgram|dns)["'`]|\bfetch\(|new\s+WebSocket\b/;
    for (const s of [`import x from "node:net"`, "await fetch(u)", "new WebSocket(u)"]) expect(net.test(s)).toBe(true);
    expect(TESTS.filter((f) => net.test(text(f))).map(rel)).toEqual([]);
  });

  it("the WebSocket the tests see is the one test/setup.ts blocks", () => {
    expect(() => new (globalThis.WebSocket as unknown as new (u: string) => unknown)("ws://scripted.invalid")).toThrow("network disabled in tests");
  });
});
