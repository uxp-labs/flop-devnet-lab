/**
 * Review of piece A1 (reviewer, not the builder), promises P3, P4 and P5: the signer, the runtime id and the
 * SIGNER_THREW refusal. The birth hash is research/2026-11-12-session-rerun-1014020/results.json steps[A6].block_hash.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ChainEncodeError } from "../src/chain/errors.js";
import { encodeSessionCall, signSessionCall } from "../src/chain/extrinsic.js";
import { OWNER, RT, RUNTIME_ID, sampleInner, testDevice, unhex } from "./lib/chain-fixtures.js";
import { RERUN_RESULTS, repoJson } from "./lib/recorded-node.js";

const A6 = repoJson(RERUN_RESULTS).steps.find((s: any) => s.step === "A6");
const BIRTH = { number: 9, hash: unhex(A6.block_hash) };
const S = sampleInner();
const base = () => ({ owner: OWNER, inner: S.timeout, sessionNonce: 1n, accountNonce: 0, birth: BIRTH });

const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
};

/** A Proxy that logs every trap by name and key, and forwards it. */
function logged<T extends object>(target: T, log: string[]): T {
  return new Proxy(target, {
    get: (t, k, r) => (log.push(`get ${String(k)}`), Reflect.get(t, k, r)),
    getOwnPropertyDescriptor: (t, k) => (log.push(`desc ${String(k)}`), Reflect.getOwnPropertyDescriptor(t, k)),
    ownKeys: (t) => (log.push("ownKeys"), Reflect.ownKeys(t)),
    has: (t, k) => (log.push(`has ${String(k)}`), Reflect.has(t, k)),
    getPrototypeOf: (t) => (log.push("getPrototypeOf"), Reflect.getPrototypeOf(t)),
  });
}

describe("review A1, P4: the signer", () => {
  it("HOLDS: publicKey and sign are each read once through their descriptor; no get, no other field, no prototype", () => {
    const device = testDevice();
    const log: string[] = [];
    const signer = logged({ publicKey: device.publicKey, sign: device.sign, other: 1, [Symbol("s")]: 2 }, log);
    signSessionCall({ ...base(), runtime: RUNTIME_ID, signer });
    expect(log.filter((l) => l !== "ownKeys").sort()).toEqual(["desc publicKey", "desc sign"]);
    expect(device.calls).toHaveLength(1);
  });

  it("HOLDS: a signer that is a function with the two own fields signs; a frozen one signs", () => {
    const device = testDevice();
    const fn = Object.assign(function signerFn() {}, { publicKey: device.publicKey, sign: device.sign });
    expect(signSessionCall({ ...base(), runtime: RUNTIME_ID, signer: fn as never }).extrinsic.length).toBeGreaterThan(0);
    expect(signSessionCall({ ...base(), runtime: RUNTIME_ID, signer: Object.freeze({ publicKey: device.publicKey, sign: device.sign }) }).extrinsic.length).toBeGreaterThan(0);
  });

  it("HOLDS (what happens, for the lead): a class instance whose sign is on its prototype is refused BAD_INPUT, with the words 'the signer has no own sign function: one inherited from a class or a prototype is not read'; main signed it", () => {
    const device = testDevice();
    class Device {
      readonly publicKey = device.publicKey;
      sign(m: Uint8Array) {
        return device.sign(m);
      }
    }
    const e = thrown(() => signSessionCall({ ...base(), runtime: RUNTIME_ID, signer: new Device() }));
    expect(e).toBeInstanceOf(ChainEncodeError);
    expect((e as Error).message).toBe("chain encoder refused (BAD_INPUT): the signer has no own sign function: one inherited from a class or a prototype is not read");
    expect(device.calls).toHaveLength(0);
  });
});

describe("review A1, P5: the runtime id", () => {
  it("HOLDS: each of the four names is read once through its descriptor, in encode and in sign; no get, no other field", () => {
    for (const run of ["encode", "sign"] as const) {
      const log: string[] = [];
      const id = logged({ ...RUNTIME_ID, note: "x" }, log);
      if (run === "encode") encodeSessionCall({ runtime: id, owner: OWNER, inner: S.timeout, sessionNonce: 1n });
      else signSessionCall({ ...base(), runtime: id, signer: testDevice() });
      expect(log.filter((l) => l !== "ownKeys").sort(), run).toEqual(["desc genesisHash", "desc specName", "desc specVersion", "desc transactionVersion"]);
      expect(log.filter((l) => l === "ownKeys"), run).toHaveLength(1);
    }
  });

  it("HOLDS: a symbol key, a non enumerable name, a frozen and a sealed id, a whole table entry all find the runtime", () => {
    const hidden = Object.defineProperty({ specVersion: RT.specVersion, transactionVersion: RT.transactionVersion, genesisHash: RT.genesisHash }, "specName", { value: RT.specName, enumerable: false });
    for (const id of [{ ...RUNTIME_ID, [Symbol("x")]: 1 }, hidden, Object.freeze({ ...RUNTIME_ID }), Object.seal({ ...RUNTIME_ID }), RT]) {
      expect(encodeSessionCall({ runtime: id as never, owner: OWNER, inner: S.timeout, sessionNonce: 1n }).length).toBeGreaterThan(0);
    }
  });

  it("HOLDS: an id that inherits its names, a function and a text are RUNTIME_UNKNOWN", () => {
    for (const id of [Object.create(RUNTIME_ID), Object.assign(() => 0, RUNTIME_ID), "x", 1n]) {
      const e = thrown(() => encodeSessionCall({ runtime: id as never, owner: OWNER, inner: S.timeout, sessionNonce: 1n }));
      expect((e as ChainEncodeError).refusal).toBe("RUNTIME_UNKNOWN");
    }
  });
});

describe("review A1, P3: SIGNER_THREW keeps nothing of what was thrown", () => {
  class DEADBEEF01 extends Error {}
  const ran = { n: 0 };
  const values: [string, () => unknown][] = [
    ["an Error", () => new Error("secret words 0xfeed")],
    ["a text", () => "secret words 0xfeed"],
    ["null", () => null],
    ["undefined", () => undefined],
    ["an object with throwing getters", () => ({ get message() { ran.n++; throw new Error("g"); }, get name() { ran.n++; return "secret"; }, toString() { ran.n++; return "secret"; } })],
    ["a Proxy that logs every trap", () => new Proxy({}, { get: () => (ran.n++, "secret"), getPrototypeOf: () => (ran.n++, null), ownKeys: () => (ran.n++, []), has: () => (ran.n++, false), getOwnPropertyDescriptor: () => (ran.n++, undefined) })],
    ["a class named with hex digits", () => new DEADBEEF01("secret words 0xfeed")],
    ["a function", () => function secret() {}],
  ];
  for (const [what, make] of values) {
    it(`HOLDS: ${what}: the exact message, no cause, and nothing of it in stack, JSON or inspect; none of its code run`, () => {
      ran.n = 0;
      const device = testDevice();
      const signer = {
        publicKey: device.publicKey,
        sign() {
          throw make();
        },
      };
      const e = thrown(() => signSessionCall({ ...base(), runtime: RUNTIME_ID, signer })) as ChainEncodeError;
      expect(e).toBeInstanceOf(ChainEncodeError);
      expect(e.message).toBe("chain encoder refused (SIGNER_THREW): the sign function threw");
      expect(e.refusal).toBe("SIGNER_THREW");
      expect("cause" in e).toBe(false);
      const all = [e.stack, JSON.stringify(e), inspect(e, { showHidden: true, depth: 10 }), Object.getOwnPropertyNames(e).join(" ")].join("\n");
      expect(all).not.toMatch(/secret|feed|DEADBEEF/i);
      expect(ran.n).toBe(0);
    });
  }
});
