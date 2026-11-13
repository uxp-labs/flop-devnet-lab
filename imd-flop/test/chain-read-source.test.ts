/**
 * P2, rules T5, A1, A4, B1, B2 and C7, as tests over the source text: the list of files under src/chain-read; its
 * pure files hold none of the patterns banned in src/chain; only door.ts imports the observatory, and only its door;
 * only shape-file.ts reads a shape file, through the package; only the five read methods appear; nothing of the
 * encoder is imported; one place opens a socket; and no test of chain-read opens one. Each scan proves itself on a
 * planted sample first.
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
  // This file is left out: it holds the planted samples of the scans above, as text.
  const TESTS = [...files(join(PKG, "test")).filter((f) => /\/chain-read-[a-z-]+\.test\.ts$/.test(f) && !f.endsWith("chain-read-source.test.ts")), join(PKG, "test", "lib", "recorded-node.ts")];

  it("the chain-read tests and their scripted node import no network module and construct no socket", () => {
    expect(TESTS.length).toBe(5);
    const net = /["'`]node:(?:net|http|https|http2|tls|dgram|dns)["'`]|\bfetch\(|new\s+WebSocket\b/;
    expect(TESTS.filter((f) => net.test(text(f))).map(rel)).toEqual([]);
  });

  it("the WebSocket the tests see is the one test/setup.ts blocks", () => {
    expect(() => new (globalThis.WebSocket as unknown as new (u: string) => unknown)("ws://scripted.invalid")).toThrow("network disabled in tests");
  });
});
