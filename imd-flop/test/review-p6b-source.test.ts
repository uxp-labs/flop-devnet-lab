/**
 * Review of P6b, attack 9 (C5, C12): the reviewer's own scan of the seven new files, with every pattern P6a's scan
 * holds its ten files to (test/miner-source.test.ts), less only what the client needs: http.ts may name fetch, the
 * abort controller and a timer; client.ts and http.ts may be async; client.ts calls C. And a walk of the files
 * around a whole run.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PAYABLE, turnArgs } from "./lib/miner-run.js";
import { fetchRig } from "./lib/review-p6b-fetch.js";
import { referenceReady } from "./lib/sr25519-reference.js";

beforeAll(referenceReady);

const PKG = join(import.meta.dirname, "..");
const DIR = join(PKG, "src", "miner");
const SEVEN = ["calls.ts", "client-errors.ts", "client.ts", "endpoint.ts", "http.ts", "requests.ts", "timing.ts"];
const text = (f: string) => readFileSync(join(DIR, f), "utf8");

/** P6a's list (test/miner-source.test.ts, BANNED), copied by its patterns, comments included. */
const BANNED: Record<string, RegExp> = {
  newChannelKey: /\bnewChannelKey\b/,
  channelKeyFromSeed: /\bchannelKeyFromSeed\b/,
  "a signing call of C": /\bsign(?:Receipt|TurnAck|Request)\b/,
  "the sr25519 library": /@scure\/sr25519|@polkadot\//,
  fetch: /\bfetch\b/,
  WebSocket: /\bWebSocket\b|\bXMLHttpRequest\b/,
  process: /\bprocess\b|\bDeno\b|\bBun\b/,
  Date: /\bDate\b|\bperformance\b|\bhrtime\b/,
  "Math.random": /Math\s*\.\s*random/,
  "crypto.getRandomValues": /\bgetRandomValues\b|\brandomBytes\b|\brandomUUID\b|\bcrypto\s*\.\s*subtle\b/,
  "a node: module": /["'`]node:/,
  "a file read or write": /\b(?:readFileSync|writeFileSync|appendFileSync|openSync|readFile|writeFile|createReadStream|createWriteStream)\b/,
  "a timer": /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/,
  "a dynamic import": /\bimport\s*\(/,
  "import.meta": /\bimport\s*\.\s*meta\b/,
  "a require": /(?<![\w$.])require\s*[.(]|\bcreateRequire\b/,
  eval: /\beval\s*\(|\bnew\s+Function\b/,
  globalThis: /\bglobalThis\b/,
  "async code": /\basync\b|\bawait\b|\bPromise\b/,
  "src/chain or src/chain-read": /["'`][^"'`\n]*\bchain(?:-read)?\/[^"'`\n]*["'`]/,
  "the store, the ledger, paths, config or keys": /["'`]\.\.\/(?:store|ledger|ledger-text|paths|config|keys|lock|receipts|receipt-store|response-store|secrets)\.js["'`]/,
};
/** What a file of the seven may hold of that list. */
const MAY: Record<string, string[]> = {
  "http.ts": ["fetch", "a timer", "async code"],
  "client.ts": ["a signing call of C", "async code"],
  "calls.ts": ["async code"],
};

describe("C5, C12 by the reviewer's own scan of the seven", () => {
  it("HOLDS: the seven files hold none of P6a's banned patterns but what each needs (performance, hrtime, randomUUID, crypto.subtle, eval, require, import.meta and a dynamic import included)", () => {
    expect(readdirSync(DIR).filter((f) => SEVEN.includes(f)).sort()).toEqual(SEVEN);
    const found = SEVEN.flatMap((f) => Object.entries(BANNED).filter(([n, re]) => !(MAY[f] ?? []).includes(n) && re.test(text(f))).map(([n]) => `${f}: ${n}`));
    expect(found).toEqual([]);
  });
  it("HOLDS: http.ts names the platform's fetch nowhere but as the parameter handed in", () => {
    const code = text("http.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\\n]|\\.)*"|`[^`]*`/g, '""');
    const uses = [...code.matchAll(/\bfetch\w*\b/g)].map((m) => m[0]);
    expect(new Set(uses)).toEqual(new Set(["fetchImpl"]));
  });
  it("HOLDS: no file outside src/miner, under src, imports any file of src/miner, by any spelling", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const src = join(PKG, "src");
    const found = walk(src).filter((p) => !p.startsWith(DIR + "/") && /miner\//.test(readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
    expect(found).toEqual([]);
  });
});

describe("C12: a whole run writes nothing", () => {
  function snapshot(root: string, depth: number): Map<string, string> {
    const out = new Map<string, string>();
    const go = (d: string, n: number) => {
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch {
        return;
      }
      for (const name of names) {
        if (name === "node_modules" || name === ".git" || name === "dist") continue;
        const p = join(d, name);
        try {
          const s = statSync(p);
          out.set(p, `${s.size}:${s.mtimeMs}`);
          if (s.isDirectory() && n > 0) go(p, n - 1);
        } catch {
          // gone between the list and the stat
        }
      }
    };
    go(root, depth);
    return out;
  }
  it("HOLDS: the package's files and the temporary folder are the same before and after a whole run", async () => {
    const before = snapshot(PKG, 4);
    const tmpBefore = new Set(readdirSync(tmpdir()));
    const r = fetchRig();
    await r.run.prove();
    await r.run.authenticate({ channelId: r.miner.scenario.channelId });
    await r.run.notifyOpen();
    await r.run.turn(turnArgs());
    await r.run.close({ payable: PAYABLE });
    const after = snapshot(PKG, 4);
    const changed = [...after].filter(([p, v]) => before.get(p) !== v && !p.includes("/test-results")).map(([p]) => p);
    expect(changed).toEqual([]);
    // Other agents share /tmp: only a new name that holds "flop" or "miner" would be this run's.
    const fresh = readdirSync(tmpdir()).filter((n) => !tmpBefore.has(n) && /flop|miner/i.test(n));
    expect(fresh).toEqual([]);
  });
});
