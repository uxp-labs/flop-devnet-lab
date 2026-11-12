/**
 * P3 fix round, rule H4: a sign function that throws gives a typed refusal with its own code. Its text says
 * only that the signer threw and the name of the thrown value's class; no text of the thrown value is in it.
 * The thrown value is the refusal's cause. A sign that calls the encoder again gets its own result and does
 * not change the outer one.
 */
import { describe, expect, it } from "vitest";
import { ChainEncodeError } from "../src/chain/errors.js";
import { signSessionCall, type ExtrinsicInput } from "../src/chain/extrinsic.js";
import { hex, OWNER, RUNTIME_ID, sampleInner, testDevice, unhex } from "./lib/chain-fixtures.js";

const S = sampleInner();
const BIRTH = { number: 3552594, hash: unhex("0xa85d1dcb67ae73c8c910634c75c043e62f83cf06dd4a90bbb5abe19c8674d08e") };
const SECRET = "seed 0x3f2a9e0d said by the device";

function thrownBy(sign: () => unknown): ChainEncodeError {
  const device = testDevice();
  try {
    signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n, accountNonce: 0, birth: BIRTH, signer: { publicKey: device.publicKey, sign: sign as never } });
  } catch (e) {
    expect(e).toBeInstanceOf(ChainEncodeError);
    return e as ChainEncodeError;
  }
  throw new Error("not refused");
}

describe("H4: a signer that throws", () => {
  it("an Error: SIGNER_THREW, the class named, no text of the error, the error kept as cause", () => {
    const err = new TypeError(SECRET);
    const e = thrownBy(() => {
      throw err;
    });
    expect(e.refusal).toBe("SIGNER_THREW");
    expect(e.message).toBe("chain encoder refused (SIGNER_THREW): the signer threw (TypeError)");
    expect(e.message).not.toContain("seed");
    expect(e.cause).toBe(err);
  });

  it("a subclass of Error with a lying message getter and toString: its own class name only, none of its code run", () => {
    let ran = 0;
    class DeviceGone extends Error {
      override get message() {
        ran++;
        return SECRET;
      }
      override toString() {
        ran++;
        return SECRET;
      }
    }
    const e = thrownBy(() => {
      throw new DeviceGone();
    });
    expect(e.message).toBe("chain encoder refused (SIGNER_THREW): the signer threw (DeviceGone)");
    expect(ran).toBe(0);
  });

  it("a string, a number, null, undefined and a plain object: the type is named, never the value", () => {
    for (const [v, name] of [
      [SECRET, "string"],
      [42, "number"],
      [null, "null"],
      [undefined, "undefined"],
      [{ message: SECRET }, "Object"],
      [Object.create(null), "object"],
    ] as [unknown, string][]) {
      const e = thrownBy(() => {
        throw v;
      });
      expect(e.refusal).toBe("SIGNER_THREW");
      expect(e.message).toBe(`chain encoder refused (SIGNER_THREW): the signer threw (${name})`);
      expect(e.cause).toBe(v);
    }
  });

  it("a thrown proxy whose traps throw, and a class whose name is not an identifier: named object", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(SECRET);
        },
      },
    );
    expect(thrownBy(() => {
      throw hostile;
    }).message).toBe("chain encoder refused (SIGNER_THREW): the signer threw (object)");
    const Odd = class {};
    Object.defineProperty(Odd, "name", { value: SECRET });
    expect(thrownBy(() => {
      throw new Odd();
    }).message).toBe("chain encoder refused (SIGNER_THREW): the signer threw (object)");
  });

  it("a sign that calls the encoder again gets its own result and does not change the outer one", () => {
    const device = testDevice();
    const outerInput = (signer: ExtrinsicInput["signer"]) => ({ runtime: RUNTIME_ID, owner: OWNER, inner: S.force_open, sessionNonce: 5n, accountNonce: 6, birth: BIRTH, signer }) as ExtrinsicInput;
    const plainOut = signSessionCall(outerInput(device));
    let inner: ReturnType<typeof signSessionCall> | null = null;
    const reentrant = {
      publicKey: device.publicKey,
      sign(m: Uint8Array) {
        inner = signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.expire_force_open, sessionNonce: 9n, accountNonce: 10, birth: { number: 1, hash: new Uint8Array(32).fill(1) }, signer: device });
        return device.sign(m);
      },
    };
    const out = signSessionCall(outerInput(reentrant));
    expect(hex(out.extrinsic)).toBe(hex(plainOut.extrinsic));
    expect(out.description).toBe(plainOut.description);
    expect(inner!.fields.inner.call).toBe("expire_force_open");
    expect(inner!.fields.sessionNonce).toBe(9n);
    expect(hex(inner!.extrinsic)).not.toBe(hex(out.extrinsic));
  });
});
