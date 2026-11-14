/**
 * P4 review F2 (R4, R5): a detached Uint8Array has 0 bytes, by its internal state. The encoder's strict reader takes
 * bytes of any length, and a detached array there was a raw TypeError. It is now read as an empty array, and refused
 * with a ChainEncodeError and a code, as an empty array is.
 */
import { describe, expect, it } from "vitest";
import { ChainEncodeError } from "../src/chain/errors.js";
import { readCall, readExtrinsic } from "../src/chain/reader.js";
import { RUNTIME_ID, unhex } from "./lib/chain-fixtures.js";

const BIRTH = { number: 3552594, hash: unhex("0xa85d1dcb67ae73c8c910634c75c043e62f83cf06dd4a90bbb5abe19c8674d08e") };

function detached(): Uint8Array {
  const a = new Uint8Array(8);
  structuredClone(a.buffer, { transfer: [a.buffer] });
  return a;
}

function refusalOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return e instanceof ChainEncodeError ? e.refusal : `not a ChainEncodeError: ${String(e)}`;
  }
  return "did not refuse";
}

describe("a detached array given to the strict reader", () => {
  it("control: the array is detached and reads as 0 bytes", () => {
    const a = detached();
    expect(a.byteLength).toBe(0);
    expect(a.buffer.byteLength).toBe(0);
  });

  it("readCall refuses it with BAD_BYTES, the code it gives an empty array", () => {
    const empty = refusalOf(() => readCall(RUNTIME_ID, new Uint8Array(0)));
    expect(empty).toBe("BAD_BYTES");
    expect(refusalOf(() => readCall(RUNTIME_ID, detached()))).toBe(empty);
  });

  it("readExtrinsic refuses it with BAD_BYTES, the code it gives an empty array", () => {
    const empty = refusalOf(() => readExtrinsic(RUNTIME_ID, new Uint8Array(0), BIRTH));
    expect(empty).toBe("BAD_BYTES");
    expect(refusalOf(() => readExtrinsic(RUNTIME_ID, detached(), BIRTH))).toBe(empty);
  });
});
