/**
 * P6a, W1, W2, W3 and T7: the files of src/miner, what each imports, what none names, who imports src/miner, and
 * every export frozen with no typed array. Each scan proves itself on a planted sample first.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PKG, "src");
const DIR = join(SRC, "miner");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const text = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => relative(PKG, p);
const ALL = files(DIR);

function specifiers(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'`]([^"'`]+)["'`]/g)) out.push(m[1] as string);
  for (const m of t.matchAll(/\brequire(?:\.resolve)?\(\s*["'`]([^"'`$]*)/g)) out.push(m[1] as string);
  return out;
}

/** What W2 allows: src/channel's byte helpers and key verify, the shared helpers, @noble/hashes, and each other. */
const SHARED = ["../plain-input.js", "../freeze.js", "../outside-json.js", "../server-text.js", "../errors.js", "../ss58.js"];
const ALLOWED_OUTSIDE = new Set([...SHARED, "../channel/bytes.js", "../channel/key.js", "@noble/hashes/blake2.js"]);
const isSibling = (s: string) => /^\.\/[a-z-]+\.js$/.test(s);

/** The ten files of P6a, the miner's words with no I/O. The scans below hold these. */
const FILES = ["check.ts", "errors.ts", "expected.ts", "forms.ts", "identity.ts", "input.ts", "leaf.ts", "money.ts", "verify.ts", "wire.ts"];
/** The seven files of P6b, the client part that talks. test/miner-client-source.test.ts holds their scans (S1). */
const CLIENT_FILES = ["calls.ts", "client-errors.ts", "client.ts", "endpoint.ts", "http.ts", "requests.ts", "timing.ts"];
const MINER = ALL.filter((f) => FILES.includes(relative(DIR, f)));

describe("W1: the files of src/miner", () => {
  it(`are exactly ${FILES.length + CLIENT_FILES.length}, flat, with no barrel file: P6a's ten and P6b's seven`, () => {
    expect(ALL.map((f) => relative(DIR, f)).sort()).toEqual([...FILES, ...CLIENT_FILES].sort());
    expect(MINER).toHaveLength(FILES.length);
  });
});

describe("W2, T7: what each file imports", () => {
  it("the specifier scan finds static, type, dynamic and re-export forms (control)", () => {
    expect(specifiers(`import { a } from "./a.js";\nimport type { B } from "../b.js";\nexport { c } from "./c.js";\nconst d = await import("./d.js");\nrequire("e");`)).toEqual(["./a.js", "../b.js", "./c.js", "./d.js", "e"]);
  });

  it("each file imports only the allowed modules and its siblings", () => {
    const found = MINER.flatMap((f) => specifiers(text(f)).filter((s) => !ALLOWED_OUTSIDE.has(s) && !isSibling(s)).map((s) => `${rel(f)}: ${s}`));
    expect(found).toEqual([]);
    expect(MINER.every((f) => specifiers(text(f)).length > 0)).toBe(true);
  });

  it("each sibling it imports is a file of P6a: none of the client part", () => {
    for (const f of MINER) for (const s of specifiers(text(f)).filter(isSibling)) expect(FILES).toContain(s.slice(2).replace(/\.js$/, ".ts"));
  });

  it("from src/channel/key.js only verifyChannelSignature is taken, and from src/channel/bytes.js only concat and uintLE", () => {
    const names = (t: string, spec: string) => [...t.matchAll(new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${spec.replace(/[./]/g, "\\$&")}["']`, "g"))].flatMap((m) => (m[1] as string).split(",").map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean));
    expect(names('import { a, b as c } from "../channel/key.js";', "../channel/key.js")).toEqual(["a", "b"]);
    for (const f of MINER) {
      for (const n of names(text(f), "../channel/key.js")) expect(n, rel(f)).toBe("verifyChannelSignature");
      for (const n of names(text(f), "../channel/bytes.js")) expect(["concat", "uintLE"], rel(f)).toContain(n);
    }
  });
});

/** What no file under src/miner may hold, comments included (W2, W3). */
const BANNED: Record<string, RegExp> = {
  "newChannelKey": /\bnewChannelKey\b/,
  "channelKeyFromSeed": /\bchannelKeyFromSeed\b/,
  "a signing call of C": /\bsign(?:Receipt|TurnAck|Request)\b/,
  "the sr25519 library": /@scure\/sr25519|@polkadot\//,
  "fetch": /\bfetch\b/,
  "WebSocket": /\bWebSocket\b|\bXMLHttpRequest\b/,
  "process": /\bprocess\b|\bDeno\b|\bBun\b/,
  "Date": /\bDate\b|\bperformance\b|\bhrtime\b/,
  "Math.random": /Math\s*\.\s*random/,
  "crypto.getRandomValues": /\bgetRandomValues\b|\brandomBytes\b|\brandomUUID\b|\bcrypto\s*\.\s*subtle\b/,
  "a node: module": /["'`]node:/,
  "a Node built in": /\bfrom\s*["'`](?:fs|fs\/promises|path|os|child_process|net|http|https|tls|dgram|dns|worker_threads|crypto)["'`]/,
  "a file read or write": /\b(?:readFileSync|writeFileSync|appendFileSync|openSync|readFile|writeFile|createReadStream|createWriteStream)\b/,
  "a timer": /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/,
  "a dynamic import": /\bimport\s*\(/,
  "import.meta": /\bimport\s*\.\s*meta\b/,
  "a require": /(?<![\w$.])require\s*[.(]|\bcreateRequire\b/,
  "eval": /\beval\s*\(|\bnew\s+Function\b/,
  "globalThis": /\bglobalThis\b/,
  "async code": /\basync\b|\bawait\b|\bPromise\b/,
  "src/chain or src/chain-read": /["'`][^"'`\n]*\bchain(?:-read)?\/[^"'`\n]*["'`]/,
  "the store, the ledger, paths, config or keys": /["'`]\.\.\/(?:store|ledger|ledger-text|paths|config|keys|lock|receipts|receipt-store|response-store|secrets)\.js["'`]/,
};

describe("W2, W3, T7: no file under src/miner reaches the world, a key or a clock", () => {
  it("each banned pattern finds its planted sample (control)", () => {
    const samples: Record<string, string> = {
      "newChannelKey": "const k = newChannelKey();",
      "channelKeyFromSeed": "channelKeyFromSeed({ seed })",
      "a signing call of C": "key.signReceipt(x)",
      "the sr25519 library": 'import { sign } from "@scure/sr25519";',
      "fetch": "await fetch(u)",
      "WebSocket": "new WebSocket(u)",
      "process": "process.env.HOME",
      "Date": "Date.now()",
      "Math.random": "Math.random()",
      "crypto.getRandomValues": "crypto.getRandomValues(b)",
      "a node: module": 'import { x } from "node:fs";',
      "a Node built in": 'import { x } from "crypto";',
      "a file read or write": "readFileSync(p)",
      "a timer": "setTimeout(f, 1)",
      "a dynamic import": 'import("./x.js")',
      "import.meta": "import.meta.url",
      "a require": 'require("x")',
      "eval": "eval(s)",
      "globalThis": "globalThis.x",
      "async code": "async function f() {}",
      "src/chain or src/chain-read": 'import { a } from "../chain-read/door.js";',
      "the store, the ledger, paths, config or keys": 'import { a } from "../store.js";',
    };
    expect(Object.keys(samples).sort()).toEqual(Object.keys(BANNED).sort());
    for (const [name, re] of Object.entries(BANNED)) expect(re.test(samples[name] as string), name).toBe(true);
  });

  it("no file holds any of them", () => {
    const found = MINER.flatMap((f) => Object.entries(BANNED).filter(([, re]) => re.test(text(f))).map(([name]) => `${rel(f)}: ${name}`));
    expect(found).toEqual([]);
  });
});

describe("W2, T7: the boundaries of src/miner", () => {
  const MINER_SPEC = /["'`][^"'`\n]*\bminer\/[a-z-]+\.js["'`]/;
  it("the scan finds an import of src/miner (control)", () => {
    expect(MINER_SPEC.test('import { x } from "../miner/wire.js";')).toBe(true);
    expect(MINER_SPEC.test('import { x } from "./miner/wire.js";')).toBe(true);
    expect(MINER_SPEC.test('import { x } from "./miner-admission.js";')).toBe(false);
  });
  it("src/channel imports nothing from src/miner", () => {
    expect(files(join(SRC, "channel")).filter((f) => MINER_SPEC.test(text(f))).map(rel)).toEqual([]);
  });
  it("no file under src outside src/miner imports it yet", () => {
    expect(files(SRC).filter((f) => !f.startsWith(DIR) && MINER_SPEC.test(text(f))).map(rel)).toEqual([]);
  });
});

describe("W3: every export of src/miner is a function, a text, a number or a frozen object; no typed array", () => {
  function objects(value: unknown, path: string, out: [string, unknown][] = []): [string, unknown][] {
    if (value === null || typeof value !== "object") return out;
    out.push([path, value]);
    if (!ArrayBuffer.isView(value)) for (const [k, v] of Object.entries(value)) objects(v, `${path}.${k}`, out);
    return out;
  }

  for (const file of [...FILES, ...CLIENT_FILES]) {
    it(`${file}, imported first and alone`, async () => {
      vi.resetModules();
      const mod = (await import(join(DIR, file.replace(/\.ts$/, ".js")))) as Record<string, unknown>;
      const open: string[] = [];
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === "function") {
          if (!Object.isFrozen(value)) open.push(`${name}: an open function`);
          continue;
        }
        if (typeof value === "string" || typeof value === "number") continue;
        if (typeof value !== "object") open.push(`${name}: a ${typeof value}`);
        for (const [path, o] of objects(value, name)) if (ArrayBuffer.isView(o) || !Object.isFrozen(o)) open.push(path);
      }
      vi.resetModules();
      expect(open).toEqual([]);
    });
  }
});
