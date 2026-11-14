/**
 * P4, rules A1 to A5, D1, D8, D9, F1 and T8, as tests over the source text and the package files: the files of
 * src/channel; what each may import; no clock, environment, randomness, timer, file, socket or dynamic import; only
 * key.ts names the sr25519 library and channelKeyFromSeed; no polkadot package under src; the exact versions and the
 * lock's integrity; and every export frozen, with no typed array exported. Each scan proves itself on a planted
 * sample first.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
  "errors.ts": ["../errors.js"],
  "bytes.ts": ["../plain-input.js", "./errors.js"],
  "transcript.ts": ["@noble/hashes/blake2.js", "./bytes.js", "./errors.js"],
  "auth.ts": ["@noble/hashes/blake2.js", "./bytes.js", "./errors.js"],
  "key.ts": ["@scure/sr25519", "@noble/hashes/utils.js", "../secrets.js", "./transcript.js", "./auth.js", "./bytes.js", "./errors.js"],
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
