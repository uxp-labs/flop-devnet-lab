/**
 * Review of P4 (reviewer): every way to reach the secret from outside key.ts (attack 5) and the signing paths with
 * the library mocked (attack 6). The mocked sign is handed the real secret by key.ts, so a library that names its
 * input is modelled with the real bytes. Tests that patch a built in put it back before they assert.
 */
import { inspect } from "node:util";
import { getPublicKey, secretFromSeed } from "@scure/sr25519";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelKeyFromSeed, verifyChannelSignature } from "../src/channel/key.js";
import { clearSecretRegistry, scanForSecrets } from "../src/secrets.js";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const SECRET_HEX = hex(secretFromSeed(SEED));
const halves = [SECRET_HEX.slice(0, 64), SECRET_HEX.slice(64)];
const RECEIPT = () => ({ channelId: new Uint8Array(32).fill(1), finalRoot: new Uint8Array(32).fill(2), aggregateGn: 3n, payable: 4n });
const REQUEST = () => ({ channelId: new Uint8Array(32).fill(1), method: "GET", path: "/session/info", body: "", timestampMs: 1n, nonce: new Uint8Array(16), challenge: "c".repeat(64) });

/** True when the text holds the secret's hex, or either half, or 63 hex digits of either half. */
const holdsSecret = (t: string) => [SECRET_HEX, ...halves].some((h) => t.includes(h)) || halves.some((h) => t.includes(h.slice(0, 63)) || t.includes(h.slice(1)));

async function keyWith(sign: (secret: Uint8Array, message: Uint8Array) => unknown) {
  vi.resetModules();
  vi.doMock("@scure/sr25519", async (orig) => ({ ...(await orig<typeof import("@scure/sr25519")>()), sign }));
  const k = await import("../src/channel/key.js");
  return k.channelKeyFromSeed({ seed: SEED });
}
function caught(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("did not throw");
}

describe("attack 6: SIGN_FAILED with a library that names what it was handed", () => {
  afterEach(() => {
    vi.doUnmock("@scure/sr25519");
    vi.resetModules();
  });

  it("HOLDS: the message and the stack of the refusal hold no text of the thrown value", async () => {
    const key = await keyWith((secret) => {
      throw new RangeError(`bad secret ${hex(secret)}`);
    });
    const e = caught(() => key.signReceipt(RECEIPT()));
    expect(e.message).toContain("SIGN_FAILED");
    expect(holdsSecret(e.message)).toBe(false);
    expect(holdsSecret(String(e.stack))).toBe(false);
    expect(holdsSecret(JSON.stringify(e))).toBe(false);
  });

  it("DEFECT R6: util.inspect of the refusal, as Node prints an error it does not catch, holds none of the secret", async () => {
    const key = await keyWith((secret) => {
      throw new RangeError(`bad secret ${hex(secret)}`);
    });
    const e = caught(() => key.signReceipt(RECEIPT()));
    expect(holdsSecret(inspect(e))).toBe(false);
  });

  it("DEFECT R7: a thrown value whose class is named with 63 hex digits of the secret: the message holds none of them", async () => {
    const key = await keyWith((secret) => {
      const name = `_${hex(secret.subarray(0, 32)).slice(0, 63)}`;
      const C = { [name]: class {} }[name]!;
      throw new C();
    });
    const e = caught(() => key.signTurnAck({ channelId: new Uint8Array(32), turnIndex: 0, leafHash: new Uint8Array(32), agentSendMs: 0n, agentRecvMs: 0n }));
    expect(e.message).toContain("SIGN_FAILED"); // control: the refusal it is
    expect(holdsSecret(e.message)).toBe(false);
  });
});

describe("attack 5: the secret guard's registry", () => {
  it("HOLDS: code that only calls exported functions learns nothing from the guard as an oracle: no prefix of the secret's hex is flagged", () => {
    channelKeyFromSeed({ seed: SEED });
    expect(scanForSecrets({ note: SECRET_HEX }).length).toBeGreaterThan(0); // control: the whole is flagged
    for (const h of [SECRET_HEX, ...halves]) for (let n = 1; n < 43; n++) expect(scanForSecrets({ note: h.slice(0, n) }), `${n}`).toEqual([]);
  });

  it("DEFECT R8: once a key is made and dropped, a patched String.prototype.includes sees none of the secret through one call of scanForSecrets (needs code already in the process)", () => {
    clearSecretRegistry();
    channelKeyFromSeed({ seed: SEED }); // the key object is dropped here: no reference to it is kept
    const seen: string[] = [];
    const real = String.prototype.includes;
    try {
      String.prototype.includes = function (this: string, s: string, p?: number) {
        seen.push(String(s));
        return real.call(this, s, p);
      };
      scanForSecrets({ note: "anything" });
    } finally {
      String.prototype.includes = real;
      clearSecretRegistry();
    }
    expect(seen.some((s) => holdsSecret(s))).toBe(false);
  });
});

describe("attack 5: code already in the process, through a patched built in (no promise of the README covers this)", () => {
  it("HOLDS: a patched Uint8Array.prototype.subarray sees the secret at the next signing, also for a key made before the patch", () => {
    const key = channelKeyFromSeed({ seed: SEED });
    const seen: string[] = [];
    const real = Uint8Array.prototype.subarray;
    try {
      Uint8Array.prototype.subarray = function (this: Uint8Array, a?: number, b?: number) {
        if (this.length === 64) seen.push(hex(real.call(this, 0, 64)));
        return real.call(this, a, b);
      };
      key.signReceipt(RECEIPT());
    } finally {
      Uint8Array.prototype.subarray = real;
    }
    expect(seen).toContain(SECRET_HEX);
  });

  it("HOLDS: a patched JSON.stringify makes signRequest sign bytes that are none of the three layouts, and the signature verifies", () => {
    const key = channelKeyFromSeed({ seed: SEED });
    const real = JSON.stringify;
    let s: { message: Uint8Array; signature: Uint8Array };
    try {
      JSON.stringify = ((v: unknown) => (Array.isArray(v) ? "any bytes the patch wants" : real(v))) as typeof JSON.stringify;
      s = key.signRequest(REQUEST() as never);
    } finally {
      JSON.stringify = real;
    }
    expect(Buffer.from(s.message).toString("utf8")).toBe("any bytes the patch wants");
    expect(verifyChannelSignature({ publicKey: Uint8Array.from(getPublicKey(secretFromSeed(SEED))), message: s.message, signature: s.signature })).toBe(true);
  });
});
