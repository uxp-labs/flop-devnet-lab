/**
 * P3 fix round, rule H3: a byte value is taken by the typed array's own internal state. The length that is
 * checked and the bytes that are copied come from the array itself, not from a length, a slice or an
 * iterator a caller can define.
 */
import { describe, expect, it } from "vitest";
import { ChainEncodeError } from "../src/chain/errors.js";
import { encodeSessionCall, signSessionCall } from "../src/chain/extrinsic.js";
import { bytesOf } from "../src/chain/fields.js";
import { readCall } from "../src/chain/reader.js";
import { hex, OWNER, RT, RUNTIME_ID, testDevice, unhex } from "./lib/chain-fixtures.js";

const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof ChainEncodeError ? e.refusal : `not a ChainEncodeError: ${String(e)}`;
  }
  return null;
};
const timeout = (channel_id: unknown) => () => encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: { call: "timeout", channel_id } as never, sessionNonce: 1n });
const channelOf = (bytes: Uint8Array) => (readCall(RT, bytes).inner as { channel_id: Uint8Array }).channel_id;

class LyingLength extends Uint8Array {
  override get length() {
    return 32;
  }
}
class LyingSlice extends Uint8Array {
  override slice() {
    return new Uint8Array(32).fill(0xaa);
  }
  override *[Symbol.iterator]() {
    for (let i = 0; i < 32; i++) yield 0xbb;
  }
}

describe("H3: the bytes of a 32 byte field, by the array's internal state", () => {
  it("a subclass whose length getter says 32 but which holds 33 bytes is refused", () => {
    expect(codeOf(timeout(new LyingLength(33).fill(1)))).toBe("WRONG_LENGTH");
  });

  it("a subclass that holds 31 bytes and says 32 is refused", () => {
    expect(codeOf(timeout(new LyingLength(31).fill(1)))).toBe("WRONG_LENGTH");
  });

  it("a subclass whose slice and iterator lie is copied by its own bytes", () => {
    const v = new LyingSlice(32).fill(0x33);
    expect(hex(channelOf(timeout(v)() as Uint8Array))).toBe("0x" + "33".repeat(32));
  });

  it("a plain array with an own length of 32 is refused", () => {
    const a = Object.assign([1, 2, 3], { length: 32 });
    expect(codeOf(timeout(a))).toBe("BAD_INPUT");
    expect(codeOf(timeout(Array.from({ length: 32 }, () => 7)))).toBe("BAD_INPUT");
  });

  it("an object that claims to be a Uint8Array of 32 is refused", () => {
    const fake = { length: 32, [Symbol.toStringTag]: "Uint8Array", buffer: new ArrayBuffer(32), byteLength: 32, byteOffset: 0 };
    expect(codeOf(timeout(fake))).toBe("BAD_INPUT");
    expect(codeOf(timeout(new Proxy(new Uint8Array(32), {})))).toBe("BAD_INPUT");
  });

  it("a Buffer of 32 bytes is accepted and copied", () => {
    const b = Buffer.alloc(32, 0x44);
    const bytes = timeout(b)() as Uint8Array;
    b.fill(0);
    expect(hex(channelOf(bytes))).toBe("0x" + "44".repeat(32));
  });

  it("a view with an offset into a larger buffer is accepted, only its own 32 bytes", () => {
    const big = new Uint8Array(100).fill(0x99);
    big.fill(0x55, 10, 42);
    expect(hex(channelOf(timeout(new Uint8Array(big.buffer, 10, 32))() as Uint8Array))).toBe("0x" + "55".repeat(32));
    expect(hex(channelOf(timeout(Buffer.from(big.buffer, 10, 32))() as Uint8Array))).toBe("0x" + "55".repeat(32));
  });

  it("a typed array of another width, a DataView, an ArrayBuffer and a string are refused", () => {
    expect(codeOf(timeout(new Uint16Array(16)))).toBe("BAD_INPUT");
    expect(codeOf(timeout(new Int8Array(32)))).toBe("BAD_INPUT");
    expect(codeOf(timeout(new Uint8ClampedArray(32)))).toBe("BAD_INPUT");
    expect(codeOf(timeout(new DataView(new ArrayBuffer(32))))).toBe("BAD_INPUT");
    expect(codeOf(timeout(new ArrayBuffer(32)))).toBe("BAD_INPUT");
    expect(codeOf(timeout("0x" + "11".repeat(32)))).toBe("BAD_INPUT");
  });

  it("the owner, the birth hash and the public key are taken the same way", () => {
    const device = testDevice();
    const birth = { number: 9, hash: unhex("0x" + "07".repeat(32)) };
    const base = { runtime: RUNTIME_ID, owner: OWNER, inner: { call: "timeout", channel_id: new Uint8Array(32) }, sessionNonce: 0n, accountNonce: 0, birth, signer: device } as const;
    expect(codeOf(() => signSessionCall({ ...base, owner: new LyingLength(33) } as never))).toBe("WRONG_LENGTH");
    expect(codeOf(() => signSessionCall({ ...base, birth: { number: 9, hash: new LyingLength(33) } } as never))).toBe("WRONG_LENGTH");
    expect(codeOf(() => signSessionCall({ ...base, signer: { publicKey: new LyingLength(33), sign: device.sign } } as never))).toBe("WRONG_LENGTH");
    expect(device.calls).toHaveLength(0);
  });

  it("bytesOf returns a fresh array, never the caller's", () => {
    const v = new Uint8Array(32).fill(1);
    const c = bytesOf(v, 32, "x");
    expect(c).not.toBe(v);
    expect(c.buffer).not.toBe(v.buffer);
    v[0] = 9;
    expect(c[0]).toBe(1);
  });
});
