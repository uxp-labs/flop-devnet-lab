/**
 * P3 fix round, rule H4, and piece A1 part 4 (review item 10): a sign function that throws gives a typed refusal
 * with its own code, SIGNER_THREW, and exactly one message: the sign function threw. Nothing of the thrown value
 * is kept: not its text, not its class name, not the value as the refusal's cause, and none of its code is run.
 * A sign that calls the encoder again gets its own result and does not change the outer one.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ChainEncodeError } from "../src/chain/errors.js";
import { signSessionCall, type ExtrinsicInput } from "../src/chain/extrinsic.js";
import { hex, OWNER, RUNTIME_ID, sampleInner, testDevice, unhex } from "./lib/chain-fixtures.js";

const S = sampleInner();
const BIRTH = { number: 3552594, hash: unhex("0xa85d1dcb67ae73c8c910634c75c043e62f83cf06dd4a90bbb5abe19c8674d08e") };
const SECRET = "seed 0x3f2a9e0d said by the device";
const MESSAGE = "chain encoder refused (SIGNER_THREW): the sign function threw";

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

/** The refusal holds the one message, no cause, and nothing of `words` in any form a caller could print. */
function holdsNothingOf(e: ChainEncodeError, words: string[]): void {
  expect(e.refusal).toBe("SIGNER_THREW");
  expect(e.message).toBe(MESSAGE);
  expect(e.cause).toBeUndefined();
  expect(Object.getOwnPropertyNames(e)).not.toContain("cause");
  for (const text of [inspect(e, { depth: 5, showHidden: true }), JSON.stringify(e), String(e.stack)]) for (const w of words) expect(text).not.toContain(w);
}

describe("H4: a signer that throws", () => {
  it("an Error: SIGNER_THREW, exactly the one message; no cause, no class name, nothing the thrown value chose", () => {
    const e = thrownBy(() => {
      throw new RangeError(SECRET);
    });
    holdsNothingOf(e, ["RangeError", "seed", "0x3f2a9e0d"]);
  });

  it("a subclass of Error with a lying message getter and toString: the one message, none of its code run", () => {
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
    holdsNothingOf(e, ["DeviceGone", "seed"]);
    expect(ran).toBe(0);
  });

  it("a string, a number, null, undefined and a plain object: the one message, never the type or the value", () => {
    for (const v of [SECRET, 42, null, undefined, { message: SECRET }, Object.create(null)] as unknown[]) {
      const e = thrownBy(() => {
        throw v;
      });
      holdsNothingOf(e, ["seed", "string", "number", "null)", "Object"]);
    }
  });

  it("a thrown proxy whose traps throw, and a class whose name is the secret: the one message, no trap run", () => {
    let trapped = 0;
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          trapped++;
          throw new Error(SECRET);
        },
        get() {
          trapped++;
          throw new Error(SECRET);
        },
      },
    );
    holdsNothingOf(
      thrownBy(() => {
        throw hostile;
      }),
      ["seed"],
    );
    expect(trapped).toBe(0);
    const Odd = class {};
    Object.defineProperty(Odd, "name", { value: SECRET });
    holdsNothingOf(
      thrownBy(() => {
        throw new Odd();
      }),
      ["seed"],
    );
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
