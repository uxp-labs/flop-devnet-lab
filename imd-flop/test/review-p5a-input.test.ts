/**
 * Review of P5a (the owner's two session calls), the reviewer's own tests: attacks 5 (P6, the input) and 6 (P5, the
 * edges and their codes) of the review brief, with P7 (no signer).
 *
 * The grant is the one of step A2 of research/2026-11-12-session-rerun-1014020/results.json: its delegate and caps
 * from the SessionCreated event, its duration as expires_at less finalized_in_block, its bytes in `call`. The longest
 * duration is FlopSessionKeys.MaxSessionDuration of facts-1014020.json in the same folder.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChainEncodeError } from "../src/chain/errors.js";
import { encodeOwnerCall, type CreateSessionInput } from "../src/chain/owner-calls.js";
import { hex, PKG, readJson, RERUN, results, RUNTIME_ID, unhex } from "./lib/chain-fixtures.js";

type Step = { step: string; call: string; finalized_in_block: number; events: { pallet: string; name: string; fields: Record<string, string | number> }[] };
const A2 = (results.steps as Step[]).find((s) => s.step === "A2")!;
const F = A2.events.find((e) => e.pallet === "FlopSessionKeys" && e.name === "SessionCreated")!.fields;
const MAX = Number(readJson(`${RERUN}/facts-1014020.json`).constants.FlopSessionKeys.MaxSessionDuration.value);
const U128 = (1n << 128n) - 1n;
const grant = (): Record<string, unknown> => ({
  runtime: RUNTIME_ID,
  call: "create_session",
  delegate: unhex(F.delegate as string),
  spending_cap: BigInt(F.spending_cap),
  per_tx_limit: BigInt(F.per_tx_limit),
  daily_cap: BigInt(F.daily_cap),
  duration_blocks: (F.expires_at as number) - A2.finalized_in_block,
});
const revoke = (): Record<string, unknown> => ({ runtime: RUNTIME_ID, call: "revoke_session", delegate: unhex(F.delegate as string) });
const enc = (x: unknown) => encodeOwnerCall(x as CreateSessionInput);

function refusal(f: () => unknown): { code: string; words: string } | null {
  try {
    f();
  } catch (e) {
    if (e instanceof ChainEncodeError) return { code: e.refusal, words: e.message };
    return { code: `not a ChainEncodeError: ${(e as Error)?.constructor?.name}`, words: String((e as Error)?.message) };
  }
  return null;
}
const codeOf = (f: () => unknown) => refusal(f)?.code ?? null;

describe("review P5a, attack 6 (P5): each edge, each refusal with its own code and words", () => {
  it("HOLDS: equal caps, caps of 1, caps at the largest u128, the duration at 1 and at MaxSessionDuration are written", () => {
    for (const c of [1n, BigInt(F.daily_cap), U128]) expect(codeOf(() => enc({ ...grant(), spending_cap: c, per_tx_limit: c, daily_cap: c }))).toBeNull();
    expect(codeOf(() => enc({ ...grant(), per_tx_limit: 1n, daily_cap: 1n, spending_cap: U128 }))).toBeNull();
    for (const d of [1, MAX]) expect(codeOf(() => enc({ ...grant(), duration_blocks: d }))).toBeNull();
  });

  it("HOLDS: each refusal comes out with its own code, never READ_BACK and never a raw error, and its words name the field", () => {
    const g = grant();
    const dc = g.daily_cap as bigint;
    const cases: [string, Record<string, unknown>, string, string][] = [
      ["spending_cap 0", { spending_cap: 0n }, "OUT_OF_RANGE", "spending_cap"],
      ["per_tx_limit 0", { per_tx_limit: 0n }, "OUT_OF_RANGE", "per_tx_limit"],
      ["daily_cap 0", { daily_cap: 0n, per_tx_limit: 0n }, "OUT_OF_RANGE", "0 raw"],
      ["per_tx above daily by 1", { per_tx_limit: dc + 1n }, "OUT_OF_RANGE", "per_tx_limit"],
      ["daily above spending by 1", { daily_cap: (g.spending_cap as bigint) + 1n }, "OUT_OF_RANGE", "daily_cap"],
      ["a cap of 2^128", { spending_cap: 1n << 128n }, "OUT_OF_RANGE", "spending_cap"],
      ["a cap of -1", { per_tx_limit: -1n }, "OUT_OF_RANGE", "per_tx_limit"],
      ["a cap as a number", { spending_cap: 5 }, "BAD_INPUT", "spending_cap"],
      ["a cap as text", { spending_cap: "50000000000000000" }, "BAD_INPUT", "spending_cap"],
      ["duration 0", { duration_blocks: 0 }, "OUT_OF_RANGE", "duration_blocks"],
      ["duration -0", { duration_blocks: -0 }, "OUT_OF_RANGE", "duration_blocks"],
      ["duration MAX + 1", { duration_blocks: MAX + 1 }, "OUT_OF_RANGE", "MaxSessionDuration"],
      ["duration 2^32 - 1", { duration_blocks: 2 ** 32 - 1 }, "OUT_OF_RANGE", "duration_blocks"],
      ["duration 2^32", { duration_blocks: 2 ** 32 }, "OUT_OF_RANGE", "duration_blocks"],
      ["duration 2^53", { duration_blocks: 2 ** 53 }, "OUT_OF_RANGE", "duration_blocks"],
      ["duration -1", { duration_blocks: -1 }, "OUT_OF_RANGE", "duration_blocks"],
      ["duration 1.5", { duration_blocks: 1.5 }, "BAD_INPUT", "duration_blocks"],
      ["duration NaN", { duration_blocks: NaN }, "BAD_INPUT", "duration_blocks"],
      ["duration Infinity", { duration_blocks: Infinity }, "BAD_INPUT", "duration_blocks"],
      ["duration a bigint", { duration_blocks: 7200n }, "BAD_INPUT", "duration_blocks"],
      ["duration as text", { duration_blocks: "7200" }, "BAD_INPUT", "duration_blocks"],
      ["delegate 31 bytes", { delegate: new Uint8Array(31) }, "WRONG_LENGTH", "delegate"],
      ["delegate 33 bytes", { delegate: new Uint8Array(33) }, "WRONG_LENGTH", "delegate"],
      ["delegate an array", { delegate: new Array(32).fill(0) }, "BAD_INPUT", "delegate"],
      ["delegate hex text", { delegate: F.delegate }, "BAD_INPUT", "delegate"],
      ["delegate a Uint16Array", { delegate: new Uint16Array(16) }, "BAD_INPUT", "delegate"],
      ["a call not one of the two", { call: "execute_via_session" }, "CALL_NOT_ALLOWED", "execute_via_session"],
      ["an inner call's name", { call: "open_channel" }, "CALL_NOT_ALLOWED", "open_channel"],
      ["the name in another case", { call: "Create_session" }, "CALL_NOT_ALLOWED", "Create_session"],
      ["a runtime not in the table", { runtime: { ...RUNTIME_ID, specVersion: RUNTIME_ID.specVersion + 1 } }, "RUNTIME_UNKNOWN", "runtime"],
      ["a runtime by three names", { runtime: { specName: RUNTIME_ID.specName, specVersion: RUNTIME_ID.specVersion, genesisHash: RUNTIME_ID.genesisHash } }, "RUNTIME_UNKNOWN", "runtime"],
    ];
    const out: string[] = [];
    for (const [what, patch, code, word] of cases) {
      const r = refusal(() => enc({ ...grant(), ...patch }));
      if (r === null || r.code !== code || !r.words.includes(word)) out.push(`${what}: ${JSON.stringify(r)}`);
    }
    expect(out).toEqual([]);
  });

  it("HOLDS: the revoke's refusals: a delegate not 32 bytes, a field of the grant, an unknown runtime", () => {
    expect(codeOf(() => enc({ ...revoke(), delegate: new Uint8Array(31) }))).toBe("WRONG_LENGTH");
    for (const k of ["spending_cap", "per_tx_limit", "daily_cap", "duration_blocks", "allowed_pallets"]) expect(codeOf(() => enc({ ...revoke(), [k]: grant()[k] ?? [] }))).toBe("BAD_INPUT");
    expect(codeOf(() => enc({ ...revoke(), runtime: { ...RUNTIME_ID, genesisHash: "0x" + "00".repeat(32) } }))).toBe("RUNTIME_UNKNOWN");
  });
});

describe("review P5a, attack 5 (P6, P7): the input is read once, as own fields", () => {
  it("HOLDS: an extra field is refused BAD_INPUT before anything is written: a signer, a nonce, an era, a tip and others", () => {
    const signer = { publicKey: new Uint8Array(32), sign: () => new Uint8Array(64) };
    for (const [k, v] of Object.entries({ signer, nonce: 0n, sessionNonce: 0n, accountNonce: 0, era: 64, tip: 0n, birth: { number: 1, hash: new Uint8Array(32) }, owner: new Uint8Array(32), inner: {}, metadataHash: null, extra: 1 })) {
      expect(codeOf(() => enc({ ...grant(), [k]: v }))).toBe("BAD_INPUT");
      expect(codeOf(() => enc({ ...revoke(), [k]: v }))).toBe("BAD_INPUT");
    }
  });

  it("HOLDS: a missing field is refused: BAD_INPUT, but CALL_NOT_ALLOWED without the call", () => {
    for (const k of Object.keys(grant())) {
      const g = grant();
      delete g[k];
      expect(codeOf(() => enc(g))).toBe(k === "call" ? "CALL_NOT_ALLOWED" : "BAD_INPUT");
    }
    for (const v of [null, undefined, 5, "create_session", [], new Uint8Array(4), () => 0]) expect(codeOf(() => enc(v))).toMatch(/^(BAD_INPUT)$/);
  });

  it("HOLDS: an accessor on any field is refused BAD_INPUT and is never called; an inherited field is not a field", () => {
    for (const k of Object.keys(grant())) {
      const g = grant();
      const v = g[k];
      let calls = 0;
      delete g[k];
      Object.defineProperty(g, k, { enumerable: true, get: () => (calls++, v) });
      expect(codeOf(() => enc(g))).toBe("BAD_INPUT");
      expect(calls).toBe(0);
      const inh = Object.create({ [k]: v });
      Object.assign(inh, grant());
      delete inh[k];
      expect(codeOf(() => enc(inh))).toBe(k === "call" ? "CALL_NOT_ALLOWED" : "BAD_INPUT");
    }
  });

  it("HOLDS: a Proxy with every trap: no get, has, set or other trap but ownKeys and getOwnPropertyDescriptor is used, each descriptor once", () => {
    const used: string[] = [];
    const handler: ProxyHandler<object> = {};
    for (const t of ["get", "set", "has", "deleteProperty", "defineProperty", "getPrototypeOf", "setPrototypeOf", "isExtensible", "preventExtensions", "ownKeys", "getOwnPropertyDescriptor", "apply", "construct"] as const) {
      (handler as Record<string, unknown>)[t] = (...a: unknown[]) => {
        used.push(t === "getOwnPropertyDescriptor" ? `gopd:${String(a[1])}` : t);
        return (Reflect as unknown as Record<string, (...x: unknown[]) => unknown>)[t](...a);
      };
    }
    const bytes = enc(new Proxy(grant(), handler));
    expect(hex(bytes)).toBe(A2.call);
    const other = used.filter((u) => u !== "ownKeys" && !u.startsWith("gopd:"));
    expect(other).toEqual([]);
    const gopd = used.filter((u) => u.startsWith("gopd:"));
    expect(new Set(gopd).size).toBe(gopd.length);
    expect(used.filter((u) => u === "ownKeys").length).toBe(1);
  });

  it("HOLDS: a Proxy whose descriptors change between reads, and an input changed during and after the call, change nothing returned", () => {
    const g = grant();
    const delegate = g.delegate as Uint8Array;
    let n = 0;
    const p = new Proxy(g, {
      getOwnPropertyDescriptor(t, k) {
        const d = Reflect.getOwnPropertyDescriptor(t, k);
        n++;
        // after the delegate is read, its bytes and the caps of the target are changed
        if (k === "spending_cap") delegate.fill(0xee);
        if (k === "daily_cap") (t as Record<string, unknown>).per_tx_limit = U128;
        return d;
      },
    });
    const bytes = enc(p);
    expect(hex(bytes)).toBe(A2.call);
    expect(n).toBeGreaterThan(0);
    const copy = Uint8Array.from(bytes);
    const g2 = grant();
    const b2 = enc(g2);
    (g2.delegate as Uint8Array).fill(1);
    g2.spending_cap = 0n;
    expect(hex(b2)).toBe(hex(copy));
    b2.fill(0);
    expect(hex(enc(grant()))).toBe(A2.call);
  });

  it("HOLDS: a Uint8Array that lies about its length, or a detached one, is read by its internal state", () => {
    const lying = unhex(F.delegate as string);
    Object.defineProperty(lying, "length", { value: 31 });
    Object.defineProperty(lying, "byteLength", { value: 33 });
    expect(hex(enc({ ...grant(), delegate: lying }))).toBe(A2.call);
    const d = new Uint8Array(32);
    structuredClone(d.buffer, { transfer: [d.buffer] });
    expect(codeOf(() => enc({ ...grant(), delegate: d }))).toBe("WRONG_LENGTH");
  });

  it("HOLDS (was DEFECT RP5A-2): a call name that is not a string is refused by its type: no method of the caller's value runs and no raw TypeError comes out", () => {
    let ran = 0;
    const cases: [string, unknown][] = [
      ["an object with a toString", { toString: () => (ran++, "create_session") }],
      ["an object with Symbol.toPrimitive", { [Symbol.toPrimitive]: () => (ran++, "create_session") }],
      ["an object without a prototype", Object.create(null)],
      ["an object whose toString throws", { toString: () => { ran++; throw new Error("caller's error"); } }],
    ];
    const got = cases.map(([what, call]) => `${what}: ${codeOf(() => enc({ ...grant(), call }))}`);
    // Expected: each refused CALL_NOT_ALLOWED, and none of the caller's code run.
    expect({ got, ran }).toEqual({ got: cases.map(([what]) => `${what}: CALL_NOT_ALLOWED`), ran: 0 });
  });

  it("HOLDS: a symbol or a number as the call is refused CALL_NOT_ALLOWED", () => {
    for (const call of [Symbol("create_session"), 0, 1, null, undefined, true, 0n]) expect(codeOf(() => enc({ ...grant(), call }))).toBe("CALL_NOT_ALLOWED");
  });

  it("HOLDS: P7, owner-calls.ts takes no signer and calls no sign function, and imports nothing that signs", () => {
    const src = readFileSync(join(PKG, "src", "chain", "owner-calls.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/`[^`]*`|"[^"\n]*"/g, "\"\"");
    expect(code).not.toMatch(/\bsign\w*\s*\(|signer|ed25519|extrinsic\.js|payload\.js/i);
    let signed = 0;
    const signer = { publicKey: new Uint8Array(32), sign: () => (signed++, new Uint8Array(64)) };
    expect(codeOf(() => enc({ ...grant(), signer }))).toBe("BAD_INPUT");
    expect(signed).toBe(0);
  });
});
