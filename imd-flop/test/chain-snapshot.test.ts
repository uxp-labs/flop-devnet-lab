/**
 * P3 fix round, rules H1 and H8: the encoder reads the whole input once into a snapshot and derives
 * everything from it; the result holds nothing of the caller's.
 */
import { describe, expect, it } from "vitest";
import type { InnerCall } from "../src/chain/calls.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import { encodeSessionCall, signSessionCall } from "../src/chain/extrinsic.js";
import { hex, OWNER, RT, RUNTIME_ID, sampleInner, testDevice, unhex } from "./lib/chain-fixtures.js";

const S = sampleInner();
const BIRTH_HASH = "0xa85d1dcb67ae73c8c910634c75c043e62f83cf06dd4a90bbb5abe19c8674d08e";

const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof ChainEncodeError ? e.refusal : `not a ChainEncodeError: ${String(e)}`;
  }
  return null;
};

/** A proxy that counts each read of each field: a get, or a read of its own descriptor. */
function counted<T extends object>(target: T, name: string, reads: Map<string, number>): T {
  const bump = (k: PropertyKey) => typeof k === "string" && reads.set(`${name}.${k}`, (reads.get(`${name}.${k}`) ?? 0) + 1);
  return new Proxy(target, {
    get: (t, k, r) => (bump(k), Reflect.get(t, k, r)),
    getOwnPropertyDescriptor: (t, k) => (bump(k), Reflect.getOwnPropertyDescriptor(t, k)),
  });
}

describe("H1: one snapshot, every field read exactly once", () => {
  for (const name of ["open_channel", "force_open", "top_up_escrow"] as const) {
    it(`${name}: each field of the input, the inner call, the sla, the birth and the signer is read once`, () => {
      const reads = new Map<string, number>();
      const base = S[name] as unknown as Record<string, unknown>;
      const inner = counted({ ...base, ...("sla" in base ? { sla: counted({ ...(base.sla as object) }, "sla", reads) } : {}) }, "inner", reads);
      const device = testDevice();
      const signer = counted({ publicKey: device.publicKey, sign: device.sign }, "signer", reads);
      const birth = counted({ number: 3552594, hash: unhex(BIRTH_HASH) }, "birth", reads);
      const input = counted({ runtime: RUNTIME_ID, owner: OWNER, inner, sessionNonce: 1n, accountNonce: 2, birth, signer }, "input", reads);
      signSessionCall(input as never);
      const want = [
        ...["runtime", "owner", "inner", "sessionNonce", "accountNonce", "birth", "signer"].map((k) => `input.${k}`),
        ...Object.keys(base).map((k) => `inner.${k}`),
        ...("sla" in base ? Object.keys(base.sla as object).map((k) => `sla.${k}`) : []),
        "birth.number",
        "birth.hash",
        "signer.publicKey",
        "signer.sign",
      ];
      expect(Object.fromEntries([...reads].sort())).toEqual(Object.fromEntries(want.map((k) => [k, 1]).sort()));
    });
  }

  it("encodeSessionCall reads each field of its input and the inner call once", () => {
    const reads = new Map<string, number>();
    const inner = counted({ ...S.timeout }, "inner", reads);
    encodeSessionCall(counted({ runtime: RUNTIME_ID, owner: OWNER, inner, sessionNonce: 1n }, "input", reads) as never);
    expect(Object.fromEntries([...reads].sort())).toEqual({ "inner.call": 1, "inner.channel_id": 1, "input.inner": 1, "input.owner": 1, "input.runtime": 1, "input.sessionNonce": 1 });
  });

  it("a field that is an accessor is refused, before sign, wherever it is", () => {
    const device = testDevice();
    const getter = <T extends object>(o: T, k: string, v: unknown) => {
      const c = { ...o } as Record<string, unknown>;
      delete c[k];
      Object.defineProperty(c, k, { enumerable: true, get: () => v });
      return c;
    };
    const base = { runtime: RUNTIME_ID, owner: OWNER, inner: S.force_open, sessionNonce: 1n, accountNonce: 0, birth: { number: 9, hash: unhex(BIRTH_HASH) }, signer: device };
    const cases = [
      getter(base, "owner", OWNER),
      getter(base, "sessionNonce", 1n),
      { ...base, inner: getter(S.force_open, "escrow", 1n) },
      { ...base, inner: getter(S.force_open, "call", "force_open") },
      { ...base, inner: { ...S.force_open, sla: getter((S.force_open as { sla: object }).sla, "max_turns", 1) } },
      { ...base, birth: getter(base.birth, "hash", unhex(BIRTH_HASH)) },
    ];
    for (const c of cases) expect(codeOf(() => signSessionCall(c as never))).toBe("BAD_INPUT");
    expect(device.calls).toHaveLength(0);
  });

  it("the spend is the snapshot's own amount: a field changed inside sign changes nothing that was signed", () => {
    const device = testDevice();
    const inner = { ...S.force_open } as Record<string, unknown>;
    const owner = Uint8Array.from(OWNER);
    const miner = (inner.miner as Uint8Array).slice();
    inner.miner = miner;
    const sla = { ...(inner.sla as object) } as Record<string, number>;
    inner.sla = sla;
    const signer = {
      publicKey: device.publicKey,
      sign: (m: Uint8Array) => {
        inner.escrow = 1n;
        inner.call = "timeout";
        sla.max_turns = 0;
        miner.fill(0);
        owner.fill(0);
        return device.sign(m);
      },
    };
    const out = signSessionCall({ runtime: RUNTIME_ID, owner, inner: inner as unknown as InnerCall, sessionNonce: 1n, accountNonce: 0, birth: { number: 9, hash: unhex(BIRTH_HASH) }, signer });
    expect(out.fields.spend).toBe((S.force_open as { escrow: bigint }).escrow);
    expect(out.fields.inner).toEqual(S.force_open);
    expect(hex(out.fields.owner)).toBe(hex(OWNER));
  });
});

describe("H8: the result holds nothing of the caller's", () => {
  it("every byte array of the result is fresh, and changing every input after the call changes nothing", () => {
    const device = testDevice();
    const owner = Uint8Array.from(OWNER);
    const inner = { ...S.open_channel } as Record<string, unknown>;
    for (const k of Object.keys(inner)) if (inner[k] instanceof Uint8Array) inner[k] = (inner[k] as Uint8Array).slice();
    inner.sla = { ...(inner.sla as object) };
    const birth = { number: 77, hash: unhex(BIRTH_HASH) };
    const publicKey = Uint8Array.from(device.publicKey);
    const out = signSessionCall({ runtime: RUNTIME_ID, owner, inner: inner as unknown as InnerCall, sessionNonce: 3n, accountNonce: 4, birth, signer: { publicKey, sign: device.sign } });
    const snap = JSON.stringify(out, (_k, v) => (v instanceof Uint8Array ? hex(v) : typeof v === "bigint" ? `${v}n` : v));
    const inputs = [owner, birth.hash, publicKey, ...Object.values(inner).filter((v): v is Uint8Array => v instanceof Uint8Array)];
    const outputs = [out.extrinsic, out.hash, out.call, out.fields.owner, out.fields.signer, out.fields.birth.hash, ...Object.values(out.fields.inner).filter((v): v is Uint8Array => v instanceof Uint8Array)];
    for (const o of outputs) for (const i of inputs) expect(o.buffer).not.toBe(i.buffer);
    for (const i of inputs) i.fill(0xee);
    (inner.sla as Record<string, number>).max_turns = 0;
    inner.escrow = 0n;
    birth.number = 0;
    expect(JSON.stringify(out, (_k, v) => (v instanceof Uint8Array ? hex(v) : typeof v === "bigint" ? `${v}n` : v))).toBe(snap);
  });

  it("the result's arrays do not share a buffer with each other", () => {
    const device = testDevice();
    const out = signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n, accountNonce: 0, birth: { number: 1, hash: unhex(BIRTH_HASH) }, signer: device });
    const arrays = [out.extrinsic, out.hash, out.call, out.fields.owner, out.fields.signer, out.fields.birth.hash, (out.fields.inner as { channel_id: Uint8Array }).channel_id];
    expect(new Set(arrays.map((a) => a.buffer)).size).toBe(arrays.length);
  });
});

/**
 * Piece A1 part 5 (audit finding 2): the signer's two fields and the runtime id's four names are each read once as
 * an own value. An accessor on one is refused (BAD_INPUT) and a Proxy's get trap is not used. Other fields of the
 * signer and of the id are allowed and never read.
 */
describe("H1: the signer and the runtime id are read by their named own fields", () => {
  const base = () => ({ owner: OWNER, inner: S.timeout, sessionNonce: 1n, accountNonce: 0, birth: { number: 9, hash: unhex(BIRTH_HASH) } });
  const messageOf = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof ChainEncodeError ? e.message : `not a ChainEncodeError: ${String(e)}`;
    }
    return null;
  };

  it("a getter on signer.publicKey and on signer.sign is refused before the sign function is called", () => {
    const device = testDevice();
    let read = 0;
    const onKey = {
      get publicKey() {
        read++;
        return device.publicKey;
      },
      sign: device.sign,
    };
    const onSign = {
      publicKey: device.publicKey,
      get sign() {
        read++;
        return device.sign;
      },
    };
    expect(messageOf(() => signSessionCall({ ...base(), runtime: RUNTIME_ID, signer: onKey }))).toBe("chain encoder refused (BAD_INPUT): the signer.publicKey is an accessor, not a value");
    expect(messageOf(() => signSessionCall({ ...base(), runtime: RUNTIME_ID, signer: onSign as never }))).toBe("chain encoder refused (BAD_INPUT): the signer.sign is an accessor, not a value");
    expect(read).toBe(0);
    expect(device.calls).toHaveLength(0);
  });

  it("a Proxy signer and a Proxy runtime id: the get trap is never called, and the call signs", () => {
    const device = testDevice();
    let gets = 0;
    const trap = <T extends object>(): ProxyHandler<T> => ({ get: (t, k, r) => (gets++, Reflect.get(t, k, r)) });
    const signer = new Proxy({ publicKey: device.publicKey, sign: device.sign }, trap());
    const runtime = new Proxy({ ...RUNTIME_ID }, trap());
    const out = signSessionCall({ ...base(), runtime, signer });
    expect(gets).toBe(0);
    expect(device.calls).toHaveLength(1);
    expect(hex(out.extrinsic)).toBe(hex(signSessionCall({ ...base(), runtime: RUNTIME_ID, signer: device }).extrinsic));
    expect(hex(encodeSessionCall({ runtime, owner: OWNER, inner: S.timeout, sessionNonce: 1n }))).toBe(hex(out.call));
    expect(gets).toBe(0);
  });

  it("a getter on each of the four names of the runtime id is refused, in encode and in sign", () => {
    const device = testDevice();
    for (const name of ["specName", "specVersion", "transactionVersion", "genesisHash"] as const) {
      let read = 0;
      const id = { ...RUNTIME_ID } as Record<string, unknown>;
      const value = id[name];
      delete id[name];
      Object.defineProperty(id, name, { enumerable: true, get: () => (read++, value) });
      const want = `chain encoder refused (BAD_INPUT): the runtime id.${name} is an accessor, not a value`;
      expect(messageOf(() => encodeSessionCall({ runtime: id as never, owner: OWNER, inner: S.timeout, sessionNonce: 1n })), name).toBe(want);
      expect(messageOf(() => signSessionCall({ ...base(), runtime: id as never, signer: device })), name).toBe(want);
      expect(read, name).toBe(0);
    }
    expect(device.calls).toHaveLength(0);
  });

  it("a runtime id that lacks a name, or is not an object, finds no runtime: RUNTIME_UNKNOWN, as before", () => {
    const { genesisHash: _g, ...lacking } = RUNTIME_ID;
    const inherited = Object.create(RUNTIME_ID) as object;
    for (const id of [lacking, inherited, null, undefined, 7, "tzkv-runtime"]) expect(codeOf(() => encodeSessionCall({ runtime: id as never, owner: OWNER, inner: S.timeout, sessionNonce: 1n })), String(id)).toBe("RUNTIME_UNKNOWN");
  });

  it("a signer with an extra field signs, and the extra field is never read", () => {
    const device = testDevice();
    let read = 0;
    const signer = { publicKey: device.publicKey, sign: device.sign } as Record<string, unknown>;
    Object.defineProperty(signer, "state", { enumerable: true, get: () => (read++, 1) });
    const out = signSessionCall({ ...base(), runtime: RUNTIME_ID, signer: signer as never });
    expect(read).toBe(0);
    expect(device.calls).toHaveLength(1);
    expect(out.extrinsic.length).toBeGreaterThan(0);
  });

  it("sign is called with the caller's signer as this", () => {
    const device = testDevice();
    let self: unknown = null;
    const signer = {
      publicKey: device.publicKey,
      sign(this: unknown, m: Uint8Array) {
        self = this;
        return device.sign(m);
      },
    };
    signSessionCall({ ...base(), runtime: RUNTIME_ID, signer });
    expect(self).toBe(signer);
  });

  it("a whole RUNTIMES entry still works as a runtime id, and an extra field of an id is never read", () => {
    const device = testDevice();
    const want = hex(signSessionCall({ ...base(), runtime: RUNTIME_ID, signer: device }).extrinsic);
    expect(hex(signSessionCall({ ...base(), runtime: RT, signer: device }).extrinsic)).toBe(want);
    let read = 0;
    const id = { ...RUNTIME_ID } as Record<string, unknown>;
    Object.defineProperty(id, "note", { enumerable: true, get: () => (read++, "x") });
    expect(hex(signSessionCall({ ...base(), runtime: id as never, signer: device }).extrinsic)).toBe(want);
    expect(read).toBe(0);
  });
});
