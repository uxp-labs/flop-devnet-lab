/**
 * Review of P6a, attack 9 (Q8): the reviewer's own scan of src/miner's imports and names, written apart from the
 * builder's test/miner-source.test.ts. It reads committed source files only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const MINER = join(SRC, "miner");
const all = readdirSync(MINER).filter((f) => f.endsWith(".ts")).sort();
/** P6b's seven files, the client part that talks, are held by test/miner-client-source.test.ts (S1); these scans hold P6a's ten. */
const CLIENT = ["calls.ts", "client-errors.ts", "client.ts", "endpoint.ts", "http.ts", "requests.ts", "timing.ts"];
const files = all.filter((f) => !CLIENT.includes(f));
const code = (f: string) =>
  readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const specifiers = (text: string) => [...text.matchAll(/(?:import|export)[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1] as string);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : []));
}

describe("Q8 by the reviewer's own scan", () => {
  it("HOLDS: src/miner holds P6a's ten files and P6b's seven, and each of the ten imports only its brief's list", () => {
    expect(all).toEqual([...files, ...CLIENT].sort());
    expect(files).toEqual(["check.ts", "errors.ts", "expected.ts", "forms.ts", "identity.ts", "input.ts", "leaf.ts", "money.ts", "verify.ts", "wire.ts"]);
    const allowed = /^(\.\/[a-z-]+\.js|\.\.\/channel\/[a-z-]+\.js|\.\.\/(plain-input|freeze|outside-json|server-text|errors|ss58)\.js|@noble\/hashes\/[a-z0-9]+\.js)$/;
    for (const f of files) for (const s of specifiers(code(join(MINER, f)))) expect(s, `${f}: ${s}`).toMatch(allowed);
    for (const f of files) expect(code(join(MINER, f)), f).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });

  it("HOLDS: no file of src/miner names a key maker, a socket, a clock, a random source, the environment or a node module, in its code", () => {
    const banned = /\b(newChannelKey|channelKeyFromSeed|fetch|WebSocket|process|Date|performance|setTimeout|Math\.random|getRandomValues|randomBytes|globalThis|eval|readFileSync|writeFileSync)\b|node:|\bnew Function\b|\.sign\(/;
    for (const f of files) expect(code(join(MINER, f)), f).not.toMatch(banned);
  });

  it("HOLDS: src/channel imports nothing from src/miner, and nothing outside src/miner imports it", () => {
    for (const f of walk(SRC).filter((p) => !p.startsWith(MINER + "/")))
      for (const s of specifiers(code(f))) expect(s, f).not.toMatch(/(^|\/)miner\//);
  });
});
