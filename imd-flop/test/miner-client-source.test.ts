/**
 * P6b, S1: the source scans of the client part of src/miner. Only http.ts names the platform's fetch, Request,
 * Response, AbortSignal or AbortController, and a timer. Only client.ts calls C's signing functions. No file names
 * process, Date, Math.random, crypto.getRandomValues, a node: module, newChannelKey or channelKeyFromSeed. Each file
 * imports only what P6a's brief allowed and its siblings. Each scan proves itself on a planted sample first. The
 * scans read comments too.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "..", "src", "miner");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();
const text = (f: string) => readFileSync(join(DIR, f), "utf8");

/** What P6a's brief allowed src/miner to import, and nothing more (S1). */
const ALLOWED = new Set(["../plain-input.js", "../freeze.js", "../outside-json.js", "../server-text.js", "../errors.js", "../ss58.js", "../channel/bytes.js", "../channel/key.js", "@noble/hashes/blake2.js"]);
const specifiers = (t: string) => [...t.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1] as string);

const PLATFORM = /\bfetch\b|\bRequest\b|\bResponse\b|\bAbortSignal\b|\bAbortController\b/;
const TIMER = /\bsetTimeout\b|\bsetInterval\b|\bclearTimeout\b|\bsetImmediate\b/;
const SIGNING = /\bsign(?:Receipt|TurnAck|Request)\s*\(/;
const BANNED: Record<string, RegExp> = {
  process: /\bprocess\b/,
  Date: /\bDate\b/,
  "Math.random": /Math\s*\.\s*random/,
  getRandomValues: /\bgetRandomValues\b|\brandomBytes\b/,
  "a node: module": /["'`]node:/,
  newChannelKey: /\bnewChannelKey\b/,
  channelKeyFromSeed: /\bchannelKeyFromSeed\b/,
  globalThis: /\bglobalThis\b/,
  WebSocket: /\bWebSocket\b|\bXMLHttpRequest\b/,
};

describe("S1: the scans find their planted samples (control)", () => {
  it("each", () => {
    expect(PLATFORM.test("await fetch(u)")).toBe(true);
    expect(PLATFORM.test("new AbortController()")).toBe(true);
    expect(PLATFORM.test("x: Response")).toBe(true);
    expect(PLATFORM.test("fetchSessionInfoProof")).toBe(false);
    expect(TIMER.test("setTimeout(f, 1)")).toBe(true);
    expect(SIGNING.test("key.signTurnAck({")).toBe(true);
    const samples: Record<string, string> = { process: "process.env", Date: "Date.now()", "Math.random": "Math.random()", getRandomValues: "crypto.getRandomValues(b)", "a node: module": 'from "node:fs"', newChannelKey: "newChannelKey()", channelKeyFromSeed: "channelKeyFromSeed({})", globalThis: "globalThis.fetch", WebSocket: "new WebSocket(u)" };
    for (const [n, re] of Object.entries(BANNED)) expect(re.test(samples[n] as string), n).toBe(true);
    expect(specifiers('import { a } from "../x.js";\nimport type { B } from "./b.js";')).toEqual(["../x.js", "./b.js"]);
  });
});

describe("S1: the files of src/miner", () => {
  it("only http.ts names fetch, Request, Response, AbortSignal or AbortController", () => {
    expect(FILES.filter((f) => PLATFORM.test(text(f)))).toEqual(["http.ts"]);
  });
  it("only http.ts names a timer", () => {
    expect(FILES.filter((f) => TIMER.test(text(f)))).toEqual(["http.ts"]);
  });
  it("only client.ts calls C's signing functions", () => {
    expect(FILES.filter((f) => SIGNING.test(text(f)))).toEqual(["client.ts"]);
  });
  it("no file names process, Date, Math.random, getRandomValues, a node: module, newChannelKey or channelKeyFromSeed", () => {
    const found = FILES.flatMap((f) => Object.entries(BANNED).filter(([, re]) => re.test(text(f))).map(([n]) => `${f}: ${n}`));
    expect(found).toEqual([]);
  });
  it("each file imports only what P6a's brief allowed and its siblings", () => {
    const found = FILES.flatMap((f) => specifiers(text(f)).filter((s) => !ALLOWED.has(s) && !(/^\.\/[a-z-]+\.js$/.test(s) && FILES.includes(s.slice(2).replace(/\.js$/, ".ts")))).map((s) => `${f}: ${s}`));
    expect(found).toEqual([]);
  });
  it("from src/channel/key.js the client part takes only the type ChannelKey, and from bytes.js only hexOf", () => {
    for (const f of ["calls.ts", "client-errors.ts", "endpoint.ts", "requests.ts", "timing.ts", "http.ts", "client.ts"]) {
      for (const m of text(f).matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']\.\.\/channel\/(key|bytes)\.js["']/g)) {
        const names = (m[2] as string).split(",").map((n) => n.trim()).filter(Boolean);
        if (m[3] === "key") expect({ f, type: m[1] !== undefined, names }).toEqual({ f, type: true, names: ["ChannelKey"] });
        else expect({ f, names }).toEqual({ f, names: ["hexOf"] });
      }
    }
  });
  it("no file outside src/miner imports the client part", () => {
    const src = join(DIR, "..");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const found = walk(src).filter((p) => !p.startsWith(DIR + "/") && /miner\/(?:client|http|endpoint|calls|requests|timing|client-errors)\.js/.test(readFileSync(p, "utf8")));
    expect(found.map((p) => relative(src, p))).toEqual([]);
  });
});
