/**
 * P4, rules A1 to A5, D1, D8, D9, F1 and T8, as tests over the source text and the package files: the files of
 * src/channel; what each may import; no clock, environment, randomness, timer, file, socket or dynamic import; only
 * key.ts names the sr25519 library and channelKeyFromSeed; no polkadot package under src; the exact versions and the
 * lock's integrity; and every export frozen, with no typed array exported. Each scan proves itself on a planted
 * sample first.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PKG, "src");
const DIR = join(SRC, "channel");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const text = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => relative(PKG, p);
const ALL_SRC = files(SRC);
const CHANNEL = files(DIR);

/** The module names a text imports or re-exports, statically or dynamically, or requires. */
function specifiers(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'`]([^"'`]+)["'`]/g)) out.push(m[1] as string);
  for (const m of t.matchAll(/\brequire(?:\.resolve)?\(\s*["'`]([^"'`$]*)/g)) out.push(m[1] as string);
  return out;
}

/** The names a text imports from one module, type imports included. */
function namesFrom(t: string, spec: string): string[] {
  const out: string[] = [];
  const quoted = spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const m of t.matchAll(new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${quoted}["']`, "g"))) {
    for (const n of (m[1] as string).split(",")) {
      const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0] as string;
      if (name) out.push(name);
    }
  }
  return out;
}

/** What A2 allows each file to import, and nothing else. */
const ALLOWED: Record<string, string[]> = {
  "errors.ts": ["../errors.js", "../freeze.js"],
  "bytes.ts": ["../plain-input.js", "./errors.js", "../freeze.js"],
  "transcript.ts": ["@noble/hashes/blake2.js", "./bytes.js", "./errors.js", "../freeze.js"],
  "auth.ts": ["@noble/hashes/blake2.js", "./bytes.js", "./errors.js", "../freeze.js"],
  "key.ts": ["@scure/sr25519", "@noble/hashes/utils.js", "../secrets.js", "./transcript.js", "./auth.js", "./bytes.js", "./errors.js", "../freeze.js"],
};

/** A3: what no file under src/channel may hold, comments included. */
const BANNED: Record<string, RegExp> = {
  "a node: module": /["'`]node:/,
  "fs": /\bfrom\s*["'`](?:fs|fs\/promises|path|os|child_process|net|http|https|tls|dgram|dns|worker_threads)["'`]/,
  "a file read or write": /\b(?:readFileSync|writeFileSync|appendFileSync|openSync|readFile|writeFile|createReadStream|createWriteStream)\b/,
  "the clock": /\bDate\b|\bperformance\b|\bhrtime\b/,
  "the environment or the process": /\bprocess\b|\bDeno\b|\bBun\b/,
  "Math.random": /Math\s*\.\s*random/,
  "the web crypto": /\bcrypto\s*\.\s*(?:subtle|randomUUID|randomBytes|webcrypto)\b|\bgetRandomValues\b/,
  "a timer": /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/,
  "the network": /\bfetch\b|\bWebSocket\b|\bXMLHttpRequest\b/,
  "a dynamic import": /\bimport\s*\(/,
  "import.meta": /\bimport\s*\.\s*meta\b/,
  "a require": /(?<![\w$.])require\s*[.(]|\bcreateRequire\b/,
  "eval": /\beval\s*\(|\bnew\s+Function\b/,
  "a Node Buffer": /\bBuffer\b/,
  "globalThis": /\bglobalThis\b/,
  "src/chain or src/chain-read": /["'`][^"'`\n]*\bchain(?:-read)?\/[^"'`\n]*["'`]/,
  "the store, the ledger, paths, config or keys": /["'`]\.\.\/(?:store|ledger|ledger-text|paths|config|keys|lock|receipts|receipt-store|response-store)\.js["'`]/,
};

describe("A1, T8: the files of src/channel", () => {
  it("are exactly the five, with no barrel file", () => {
    expect(CHANNEL.map((f) => relative(DIR, f)).sort()).toEqual(["auth.ts", "bytes.ts", "errors.ts", "key.ts", "transcript.ts"]);
  });
});

describe("A2, T8: what each file imports", () => {
  it("the specifier scan finds static, type, dynamic and re-export forms (control)", () => {
    expect(specifiers(`import { a } from "./a.js";\nimport type { B } from "./b.js";\nexport { c } from "./c.js";\nconst d = await import("./d.js");\nrequire("e");`)).toEqual(["./a.js", "./b.js", "./c.js", "./d.js", "e"]);
    expect(namesFrom(`import { randomBytes, bytesToHex as h } from "@noble/hashes/utils.js";\nimport type { X } from "@noble/hashes/utils.js";`, "@noble/hashes/utils.js")).toEqual(["randomBytes", "bytesToHex", "X"]);
  });

  for (const [file, allowed] of Object.entries(ALLOWED)) {
    it(`${file} imports only ${allowed.join(", ")}`, () => {
      const found = specifiers(text(join(DIR, file)));
      expect(found.length).toBeGreaterThan(0);
      expect(found.filter((s) => !allowed.includes(s))).toEqual([]);
    });
  }

  it("freeze.ts imports nothing", () => {
    expect(specifiers(text(join(SRC, "freeze.ts")))).toEqual([]);
  });

  it("key.ts takes randomBytes alone from @noble/hashes/utils.js, and registerSecret alone from ../secrets.js", () => {
    const t = text(join(DIR, "key.ts"));
    expect(namesFrom(t, "@noble/hashes/utils.js")).toEqual(["randomBytes"]);
    expect(namesFrom(t, "../secrets.js")).toEqual(["registerSecret"]);
  });
});

describe("A3, S43, T8: no file under src/channel reaches the world", () => {
  it("each banned pattern finds its planted sample (control)", () => {
    const samples: Record<string, string> = {
      "a node: module": 'import { x } from "node:fs";',
      "fs": 'import { x } from "fs";',
      "a file read or write": "writeFileSync(p, d)",
      "the clock": "const t = Date.now();",
      "the environment or the process": "process.env.HOME",
      "Math.random": "Math.random()",
      "the web crypto": "crypto.getRandomValues(b)",
      "a timer": "setTimeout(f, 1)",
      "the network": "await fetch(u)",
      "a dynamic import": 'await import("./x.js")',
      "import.meta": "import.meta.url",
      "a require": 'require("x")',
      "eval": "eval(s)",
      "a Node Buffer": "Buffer.from(x)",
      "globalThis": "globalThis.x",
      "src/chain or src/chain-read": 'import { a } from "../chain/fields.js";',
      "the store, the ledger, paths, config or keys": 'import { a } from "../store.js";',
    };
    expect(Object.keys(samples).sort()).toEqual(Object.keys(BANNED).sort());
    for (const [name, re] of Object.entries(BANNED)) expect(re.test(samples[name] as string), name).toBe(true);
    expect(BANNED["src/chain or src/chain-read"]!.test('import { a } from "../chain-read/door.js";')).toBe(true);
  });

  it("no file holds any of them", () => {
    const found = CHANNEL.flatMap((f) => Object.entries(BANNED).filter(([, re]) => re.test(text(f))).map(([name]) => `${rel(f)}: ${name}`));
    expect(found).toEqual([]);
  });

  it("randomBytes appears only in key.ts", () => {
    expect(CHANNEL.filter((f) => /\brandomBytes\b/.test(text(f))).map(rel)).toEqual(["src/channel/key.ts"]);
  });

  it("plain-input.ts, which bytes.ts imports, holds none of them either", () => {
    const t = text(join(SRC, "plain-input.ts"));
    expect(Object.entries(BANNED).filter(([, re]) => re.test(t)).map(([n]) => n)).toEqual([]);
  });
});

describe("A4, D8, T8: the sr25519 library, polkadot and the seeded key", () => {
  it("outside src/channel/key.ts no file under src names @scure/sr25519", () => {
    expect(ALL_SRC.filter((f) => text(f).includes("@scure/sr25519")).map(rel)).toEqual(["src/channel/key.ts"]);
  });

  it("no file under src imports a package under @polkadot/ (control: the scan finds one)", () => {
    const polkadot = (t: string) => specifiers(t).some((s) => s.startsWith("@polkadot/"));
    expect(polkadot('import { x } from "@polkadot/wasm-crypto";')).toBe(true);
    expect(ALL_SRC.filter((f) => polkadot(text(f))).map(rel)).toEqual([]);
  });

  it("no file under src other than key.ts names channelKeyFromSeed", () => {
    expect(ALL_SRC.filter((f) => /\bchannelKeyFromSeed\b/.test(text(f))).map(rel)).toEqual(["src/channel/key.ts"]);
  });

  it("of the tests, only test/lib/sr25519-reference.ts imports a package under @polkadot/", () => {
    // This file is left out: it holds a planted sample of the scan, as text.
    const tests = files(join(PKG, "test")).filter((f) => !f.endsWith("channel-source.test.ts"));
    expect(tests.filter((f) => specifiers(text(f)).some((s) => s.startsWith("@polkadot/"))).map(rel)).toEqual(["test/lib/sr25519-reference.ts"]);
  });
});

/** A text with its comments taken out. Strings and template texts are kept, and a comment mark inside one is not a comment. */
function withoutComments(t: string): string {
  let out = "";
  let i = 0;
  while (i < t.length) {
    const c = t[i] as string;
    const d = t[i + 1];
    if (c === "/" && d === "/") {
      while (i < t.length && t[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      const end = t.indexOf("*/", i + 2);
      i = end === -1 ? t.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < t.length && t[j] !== c) j += t[j] === "\\" ? 2 : 1;
      out += t.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** S1 to S3, S6: what no file under src/channel holds in its code. The channel modules are synchronous and name no way to reach the world by text. */
const BANNED_CODE: Record<string, RegExp> = {
  "eval": /\beval\b/,
  "a call of the Function constructor": /\bFunction\s*\(|\bnew\s+Function\b/,
  "globalThis": /\bglobalThis\b/,
  "Promise": /\bPromise\b/,
  "async": /\basync\b/,
  "await": /\bawait\b/,
  "queueMicrotask": /\bqueueMicrotask\b/,
};

describe("S2, S3, S6, T8: the channel modules are synchronous and reach nothing by text, in their code", () => {
  it("the comment stripper keeps code and strings and drops comments (control)", () => {
    expect(withoutComments("a(); // Promise\nb(); /* eval\n globalThis */ c();")).toBe("a(); \nb();  c();");
    expect(withoutComments('const u = "http://x"; // gone')).toBe('const u = "http://x"; ');
    expect(withoutComments("const q = `a // b ${1}`; /* x */")).toBe("const q = `a // b ${1}`; ");
  });

  it("each banned form finds its planted sample in code, and not in a comment (control)", () => {
    const samples: Record<string, string> = {
      "eval": "(0, eval)(s);",
      "a call of the Function constructor": "const f = Function('return 1');",
      "globalThis": "const g = globalThis;",
      "Promise": "const p = Promise.resolve(1);",
      "async": "const f = async () => 1;",
      "await": "const x = await y;",
      "queueMicrotask": "queueMicrotask(f);",
    };
    expect(Object.keys(samples).sort()).toEqual(Object.keys(BANNED_CODE).sort());
    for (const [name, re] of Object.entries(BANNED_CODE)) {
      expect(re.test(withoutComments(samples[name] as string)), name).toBe(true);
      expect(re.test(withoutComments(`// ${samples[name]}\n/* ${samples[name]} */`)), `${name} in a comment`).toBe(false);
    }
    expect(BANNED_CODE["a call of the Function constructor"]!.test("const f = new Function('x');")).toBe(true);
    expect(BANNED_CODE["a call of the Function constructor"]!.test("<F extends Function>(f: F)")).toBe(false);
  });

  it("no file under src/channel holds any of them", () => {
    const found = CHANNEL.flatMap((f) => Object.entries(BANNED_CODE).filter(([, re]) => re.test(withoutComments(text(f)))).map(([name]) => `${rel(f)}: ${name}`));
    expect(found).toEqual([]);
  });
});

/** S1: how a file under src may take what src/channel/key.ts exports. Outside key.ts: named imports of two functions, and types. */
const KEY_PATH = join(DIR, "key.js");
const KEY_VALUES = ["newChannelKey", "verifyChannelSignature"];

function keyImportProblems(t: string, from: string): string[] {
  const out: string[] = [];
  const isKey = (spec: string) => spec.startsWith(".") && resolve(dirname(from), spec) === KEY_PATH;
  for (const m of t.matchAll(/(?:^|[;{}\n])\s*(import|export)\s+(type\s+)?([^;"'`]*?)\s*from\s*["'`]([^"'`]+)["'`]/g)) {
    const [, kind, isType, clause, spec] = m as unknown as [string, "import" | "export", string | undefined, string, string];
    if (!isKey(spec)) continue;
    if (kind === "export") out.push(`re-exports from key.js: ${clause.trim()}`);
    else if (clause.includes("*")) out.push("imports key.js as a namespace");
    else if (!clause.trim().startsWith("{")) out.push("imports a default or a bare name from key.js");
    else if (!isType) {
      for (const n of clause.replace(/[{}]/g, "").split(",")) {
        const item = n.trim();
        if (item === "" || item.startsWith("type ")) continue;
        const name = item.split(/\s+as\s+/)[0] as string;
        if (!KEY_VALUES.includes(name)) out.push(`imports ${name} from key.js`);
      }
    }
  }
  for (const m of t.matchAll(/\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]/g)) if (isKey(m[1] as string)) out.push("loads key.js by a call");
  return out;
}

describe("S1, T8: outside key.ts, what is taken from key.js", () => {
  const FROM = join(SRC, "provider-x.ts");

  it("the scan finds each form (control)", () => {
    expect(keyImportProblems('import * as k from "./channel/key.js";', FROM)).toEqual(["imports key.js as a namespace"]);
    expect(keyImportProblems('export { newChannelKey } from "./channel/key.js";', FROM)).toEqual(["re-exports from key.js: { newChannelKey }"]);
    expect(keyImportProblems('export * from "./channel/key.js";', FROM)).toEqual(["re-exports from key.js: *"]);
    expect(keyImportProblems('import { channelKeyFromSeed } from "./channel/key.js";', FROM)).toEqual(["imports channelKeyFromSeed from key.js"]);
    expect(keyImportProblems('import { newChannelKey, channelKeyFromSeed as c } from "./channel/key.js";', FROM)).toEqual(["imports channelKeyFromSeed from key.js"]);
    expect(keyImportProblems('import k from "./channel/key.js";', FROM)).toEqual(["imports a default or a bare name from key.js"]);
    expect(keyImportProblems('const k = await import("./channel/key.js");', FROM)).toEqual(["loads key.js by a call"]);
    expect(keyImportProblems('import { newChannelKey } from "../channel/key.js";', join(SRC, "a", "b.ts"))).toEqual([]);
    expect(keyImportProblems('import { x } from "./channel/key.js";', join(SRC, "a", "b.ts"))).toEqual([]);
    expect(keyImportProblems('import { x } from "../channel/key.js";', join(SRC, "a", "b.ts"))).toEqual(["imports x from key.js"]);
    expect(keyImportProblems('import * as k from "../channel/key.js";', join(SRC, "a", "b.ts"))).toEqual(["imports key.js as a namespace"]);
    expect(keyImportProblems('import * as k from "./key.js";', join(DIR, "auth.ts"))).toEqual(["imports key.js as a namespace"]);
  });

  it("what is allowed: the two functions, and types", () => {
    expect(keyImportProblems('import { newChannelKey, verifyChannelSignature } from "./channel/key.js";', FROM)).toEqual([]);
    expect(keyImportProblems('import type { ChannelKey, Signed } from "./channel/key.js";', FROM)).toEqual([]);
    expect(keyImportProblems('import { newChannelKey, type ChannelKey } from "./channel/key.js";', FROM)).toEqual([]);
    expect(keyImportProblems('import * as k from "./other/key.js";', FROM)).toEqual([]);
  });

  it("no file under src but key.ts takes anything else from key.js", () => {
    const found = ALL_SRC.filter((f) => f !== join(DIR, "key.ts")).flatMap((f) => keyImportProblems(withoutComments(text(f)), f).map((p) => `${rel(f)}: ${p}`));
    expect(found).toEqual([]);
  });
});

describe("D9, T8: key.ts exports exactly three functions, and types", () => {
  it("the export scan finds each form (control)", () => {
    const exportsOf = (t: string) => [...t.matchAll(/^export\s+(?!interface\b|type\b)(?:async\s+)?(?:function\*?|const|let|var|class|default)\s*([A-Za-z_$][\w$]*)?/gm)].map((m) => m[1] ?? "default");
    expect(exportsOf("export function a() {}\nexport const b = 1;\nexport class C {}\nexport interface I {}\nexport type T = 1;\nexport default x;")).toEqual(["a", "b", "C", "x"]);
    expect(exportsOf(text(join(DIR, "key.ts"))).sort()).toEqual(["channelKeyFromSeed", "newChannelKey", "verifyChannelSignature"]);
    expect(/^export\s*\{|^export\s*\*/m.test(text(join(DIR, "key.ts")))).toBe(false);
  });
});

describe("D1, F1, F2: the versions and the lock", () => {
  const pkg = JSON.parse(text(join(PKG, "package.json")));
  const lock = JSON.parse(text(join(PKG, "package-lock.json")));

  it("@scure/sr25519 is a runtime dependency at exactly 2.4.0, with the integrity the brief gives", () => {
    expect(pkg.dependencies["@scure/sr25519"]).toBe("2.4.0");
    expect(pkg.devDependencies["@scure/sr25519"]).toBeUndefined();
    const entry = lock.packages["node_modules/@scure/sr25519"];
    expect(entry.version).toBe("2.4.0");
    expect(entry.integrity).toBe("sha512-Xzpy/MuVqR8wNHrXrz6HHLqCI8nPirQmJEhOMabZ8jSrM6bQiDg+1xkUgw4+Kr7857u3xxQL/PfKFeav9rodZg==");
    expect(entry.dev).toBeUndefined();
    expect(lock.packages[""].dependencies["@scure/sr25519"]).toBe("2.4.0");
  });

  it("the reference is three dev dependencies at exact versions, dev in the lock", () => {
    const REF = { "@polkadot/wasm-crypto": "7.5.4", "@polkadot/util": "14.0.3", "@polkadot/x-randomvalues": "14.0.3" };
    for (const [name, version] of Object.entries(REF)) {
      expect(pkg.devDependencies[name]).toBe(version);
      expect(pkg.dependencies[name]).toBeUndefined();
      expect(lock.packages[`node_modules/${name}`].version).toBe(version);
      expect(lock.packages[`node_modules/${name}`].dev).toBe(true);
    }
  });

  it("no package under @polkadot/, nor tslib, bn.js or @types/bn.js, is a runtime package, and none has an install script", () => {
    for (const [path, entry] of Object.entries(lock.packages as Record<string, { dev?: boolean; hasInstallScript?: boolean }>)) {
      if (/^node_modules\/(?:@polkadot\/|tslib$|bn\.js$|@types\/bn\.js$)/.test(path)) expect(entry.dev, path).toBe(true);
      if (/^node_modules\/(?:@polkadot\/|@scure\/sr25519$|tslib$|bn\.js$|@types\/bn\.js$)/.test(path)) expect(entry.hasInstallScript, path).toBeUndefined();
    }
  });
});

describe("A5, T9: every export of src/channel is a function, a text, a number or a frozen object; no typed array", () => {
  /** Every object reachable from `value`, with its path. */
  function objects(value: unknown, path: string, out: [string, unknown][] = []): [string, unknown][] {
    if (value === null || typeof value !== "object") return out;
    out.push([path, value]);
    if (!ArrayBuffer.isView(value)) for (const [k, v] of Object.entries(value)) objects(v, `${path}.${k}`, out);
    return out;
  }

  it("the check finds an open object and a typed array (control)", () => {
    const found = objects({ a: { b: new Uint8Array(1) } }, "x");
    expect(found.filter(([, o]) => !Object.isFrozen(o) || ArrayBuffer.isView(o)).map(([p]) => p)).toEqual(["x", "x.a", "x.a.b"]);
  });

  for (const file of ["errors.ts", "bytes.ts", "transcript.ts", "auth.ts", "key.ts"]) {
    it(`${file}, imported first and alone`, async () => {
      vi.resetModules();
      const mod = (await import(join(DIR, file.replace(/\.ts$/, ".js")))) as Record<string, unknown>;
      const open: string[] = [];
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === "function" || typeof value === "string" || typeof value === "number") continue;
        for (const [path, o] of objects(value, name)) if (ArrayBuffer.isView(o) || !Object.isFrozen(o)) open.push(path);
        if (typeof value !== "object") open.push(`${name}: a ${typeof value}`);
      }
      vi.resetModules();
      expect(open).toEqual([]);
    });
  }

  it("no export is a typed array made at load, by the text", () => {
    const made = /^export\s+const\s+\w+\s*(?::[^=]+)?=\s*(?:new\s+(?:Uint8Array|TextEncoder)|Uint8Array\.|\w+Of\()/m;
    expect(made.test("export const D = new Uint8Array(3);")).toBe(true);
    expect(made.test('export const D = asciiOf("x", "y");')).toBe(true);
    expect(CHANNEL.filter((f) => made.test(text(f))).map(rel)).toEqual([]);
  });
});
