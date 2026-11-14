/**
 * Review of P5a, attacks 9 and 10 of the review brief (P11, P12, P13): runtimeIdOf, sessionConstants, what src/chain
 * exports new and what it imports. The constants are those of research/2026-11-12-session-rerun-1014020/facts-1014020.json.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as calls from "../src/chain/calls.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import * as owner from "../src/chain/owner-calls.js";
import * as reader from "../src/chain/reader.js";
import * as shape from "../src/chain/shape.js";
import * as table from "../src/chain/table.js";
import { PKG, readJson, RERUN, RT, RUNTIME_ID } from "./lib/chain-fixtures.js";

const facts = readJson(`${RERUN}/facts-1014020.json`).constants.FlopSessionKeys;
const NAMES = { specName: RT.specName, specVersion: RT.specVersion, genesisHash: RT.genesisHash };

function outcome(f: () => unknown): string {
  try {
    const v = f();
    return `ok ${JSON.stringify(v)}`;
  } catch (e) {
    return e instanceof ChainEncodeError ? `refused ${e.refusal}` : `raw ${(e as Error)?.constructor?.name}`;
  }
}

describe("review P5a, attack 9 (P11, P12)", () => {
  it("HOLDS: runtimeIdOf and runtimeFor give the same kind of answer for the same hostile names", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const getter = { ...RUNTIME_ID };
    Object.defineProperty(getter, "specName", { enumerable: true, get: () => RT.specName });
    const hostile: unknown[] = [
      null,
      undefined,
      5,
      "x",
      [],
      getter,
      Object.create(RUNTIME_ID),
      { ...RUNTIME_ID, specVersion: BigInt(RT.specVersion) },
      { ...RUNTIME_ID, specVersion: String(RT.specVersion) },
      { ...RUNTIME_ID, specVersion: -0 === 0 ? RT.specVersion + 0.5 : 0 },
      { ...RUNTIME_ID, specName: cyclic },
      { ...RUNTIME_ID, specName: { toJSON: () => RT.specName } },
      { ...RUNTIME_ID, [Symbol("specName")]: RT.specName },
      new Proxy({ ...RUNTIME_ID }, { get: () => "lie" }),
    ];
    for (const h of hostile) {
      const a = outcome(() => table.runtimeFor(h as never)).replace(/^ok .*/, "ok");
      const b = outcome(() => table.runtimeIdOf(h as never)).replace(/^ok .*/, "ok");
      expect(`${String(typeof h)} ${b}`).toBe(`${String(typeof h)} ${a}`);
    }
  });

  it("HOLDS: runtimeIdOf counts the same Proxy traps as runtimeFor and returns a new frozen object of exactly the four names each time", () => {
    const traps = (f: (p: object) => unknown) => {
      const used: string[] = [];
      const p = new Proxy({ ...RUNTIME_ID }, {
        ownKeys: (t) => (used.push("ownKeys"), Reflect.ownKeys(t)),
        getOwnPropertyDescriptor: (t, k) => (used.push(`gopd ${String(k)}`), Reflect.getOwnPropertyDescriptor(t, k)),
        get: (t, k) => (used.push(`get ${String(k)}`), Reflect.get(t, k)),
        has: (t, k) => (used.push(`has ${String(k)}`), Reflect.has(t, k)),
      });
      f(p);
      return used;
    };
    const idOf = traps((p) => table.runtimeIdOf(p as never));
    expect(idOf.filter((u) => u.startsWith("get") || u.startsWith("has"))).toEqual([]);
    expect(idOf).toEqual(traps((p) => table.runtimeFor(p as never)).filter((u) => u !== "gopd transactionVersion"));
    const a = table.runtimeIdOf(NAMES);
    const b = table.runtimeIdOf(NAMES);
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Reflect.ownKeys(a)).toEqual(["specName", "specVersion", "transactionVersion", "genesisHash"]);
    expect(table.runtimeFor(a)).toBe(RT);
  });

  it("HOLDS: sessionConstants gives the facts' two values, frozen, a new object each call, and only for the four names", () => {
    const c = owner.sessionConstants(RUNTIME_ID);
    expect(c).toEqual({ maxSessionDuration: Number(facts.MaxSessionDuration.value), sessionEpochLength: Number(facts.SessionEpochLength.value) });
    expect(Object.isFrozen(c)).toBe(true);
    expect(owner.sessionConstants(RUNTIME_ID)).not.toBe(c);
    expect(outcome(() => owner.sessionConstants(NAMES as never))).toBe("refused RUNTIME_UNKNOWN");
    expect(outcome(() => owner.sessionConstants(RT))).toBe(`ok ${JSON.stringify(c)}`);
  });
});

describe("review P5a, attack 10 (P13)", () => {
  it("HOLDS: the new exports are frozen, and what they return cannot reach the table", () => {
    expect(Object.isFrozen(calls.OWNER_NAMES)).toBe(true);
    expect(Object.isFrozen(calls.OWNER_CONSTANTS)).toBe(true);
    for (const f of [calls.isOwnerName, calls.allowedPallets, owner.encodeOwnerCall, owner.sessionConstants, reader.readOwnerCall, shape.reviewedOwnerRuntime, table.runtimeIdOf]) {
      expect(Object.isFrozen(f)).toBe(true);
      if (f.prototype) expect(Object.isFrozen(f.prototype)).toBe(true);
    }
    const r = shape.reviewedOwnerRuntime(RUNTIME_ID);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.calls)).toBe(true);
    expect(Object.isFrozen(r.calls.create_session.fields)).toBe(true);
    // allowedPallets gives a fresh list each time: a change of one is not seen by the next or by the encoder.
    const l = calls.allowedPallets();
    l[0][0] = 0x63;
    l.push(new Uint8Array(1));
    expect(calls.allowedPallets().map((b) => new TextDecoder().decode(b))).toEqual(["ComputeChannel"]);
    // What readOwnerCall returns is the caller's own: changing it changes no later read.
    const bytes = Uint8Array.from(Buffer.from("5e019f749b7b18453ef9b4c3307f7b70376ce3abb033e31ae8cac77d3ab42c82062c", "hex"));
    const d = reader.readOwnerCall(RUNTIME_ID, bytes) as { delegate: Uint8Array };
    d.delegate.fill(0);
    expect((reader.readOwnerCall(RUNTIME_ID, bytes) as { delegate: Uint8Array }).delegate[0]).toBe(0x9f);
  });

  it("HOLDS: no file outside src/chain and src/session imports owner-calls.ts or the encoder; src/chain imports no file, network, clock, process or randomness", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const src = join(PKG, "src");
    // P5b, C2: the session commands under src/session are the one importer allowed.
    const outside = walk(src).filter((f) => !f.startsWith(join(src, "chain") + "/") && !f.startsWith(join(src, "session") + "/"));
    for (const f of outside) expect(`${f}: ${/from\s+["'][^"']*chain\/(owner-calls|extrinsic|reader|describe|shape|table|fields|calls|runtimes|scale|payload|era|errors)(\.js)?["']/.test(readFileSync(f, "utf8"))}`).toBe(`${f}: false`);
    for (const f of walk(join(src, "chain"))) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const i of imports) expect(`${f}: ${i}`).toMatch(/: (\.\/[a-z-]+\.js|\.\.\/(freeze|plain-input|errors)\.js|@noble\/(curves\/ed25519|hashes\/(blake2|utils))\.js)$/);
      expect(`${f}: ${/\b(Date|performance|Math\.random|process|globalThis|require|fetch|WebSocket|setTimeout|setInterval)\b|import\(/.test(code)}`).toBe(`${f}: false`);
    }
  });
});
