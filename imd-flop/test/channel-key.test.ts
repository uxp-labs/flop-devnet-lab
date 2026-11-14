/**
 * P4, rules D3 to D6, D9, D10, A5, A6, T5 and T9: what the channel key is and shows. Four functions and nothing
 * else, frozen; nothing of the seed, the secret or its halves in any view of it; one reading of each input; a fresh
 * copy of everything it returns; each signature checked under its own public key (SELF_CHECK), and a library that
 * throws named by its class only (SIGN_FAILED).
 */
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHeaders, sessionRequestMessage } from "../src/channel/auth.js";
import { ChannelError } from "../src/channel/errors.js";
import * as keyModule from "../src/channel/key.js";
import { channelKeyFromSeed, verifyChannelSignature } from "../src/channel/key.js";
import { receiptMessage, turnAckMessage } from "../src/channel/transcript.js";
import { forbiddenForms } from "./lib/channel-secret-forms.js";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const CHANNEL = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
const RECEIPT = () => ({ channelId: Uint8Array.from(CHANNEL), finalRoot: new Uint8Array(32).fill(2), aggregateGn: 3n, payable: 4n });
const ACK = () => ({ channelId: Uint8Array.from(CHANNEL), turnIndex: 5, leafHash: new Uint8Array(32).fill(6), agentSendMs: 7n, agentRecvMs: 8n });
const REQUEST = () => ({ channelId: Uint8Array.from(CHANNEL), method: "POST" as const, path: "/session/turn", body: '{"t":1}', timestampMs: 9n, nonce: new Uint8Array(16).fill(10), challenge: "e".repeat(64) });

/** A Proxy over `target` that counts the reads of each own property descriptor and forbids get. */
function counted<T extends object>(target: T): { proxy: T; reads: Map<string, number> } {
  const reads = new Map<string, number>();
  const proxy = new Proxy(target, {
    getOwnPropertyDescriptor: (t, k) => {
      reads.set(String(k), (reads.get(String(k)) ?? 0) + 1);
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
    get: (t, k) => {
      if (k === Symbol.toStringTag || k === "constructor") return Reflect.get(t, k);
      throw new Error(`get ${String(k)}`);
    },
  });
  return { proxy, reads };
}

describe("D3, D9: the key and the module's exports", () => {
  it("key.ts exports exactly newChannelKey, channelKeyFromSeed and verifyChannelSignature", () => {
    expect(Object.keys(keyModule).sort()).toEqual(["channelKeyFromSeed", "newChannelKey", "verifyChannelSignature"]);
  });

  it("the key is a frozen object of exactly four functions and no other own property", () => {
    for (const key of [channelKeyFromSeed({ seed: SEED }), keyModule.newChannelKey()]) {
      expect(Reflect.ownKeys(key).sort()).toEqual(["publicKey", "signReceipt", "signRequest", "signTurnAck"]);
      for (const k of Reflect.ownKeys(key)) expect(typeof (key as unknown as Record<string | symbol, unknown>)[k]).toBe("function");
      expect(Object.isFrozen(key)).toBe(true);
      expect(JSON.stringify(key)).toBe("{}");
    }
  });

  it("D6: no function of the key signs bytes it is handed: a Uint8Array as input is refused", () => {
    const key = channelKeyFromSeed({ seed: SEED });
    for (const f of [key.signReceipt, key.signTurnAck, key.signRequest]) expect(() => f(new Uint8Array(84) as never)).toThrow(ChannelError);
  });
});

describe("T5: the key shows nothing of the seed, the secret or its halves", () => {
  const forms = forbiddenForms(SEED);
  const key = channelKeyFromSeed({ seed: SEED });

  it("the forbidden forms are 24 and each is long enough to be found (control)", () => {
    expect(forms.length).toBe(24);
    for (const f of forms) expect(f.length).toBeGreaterThanOrEqual(43);
    expect(inspect({ x: hex(SEED) })).toContain(forms[0]);
  });

  it("Object.keys, JSON.stringify, a spread and util.inspect, deep and with hidden shown", () => {
    const views = [
      JSON.stringify(Object.keys(key)),
      JSON.stringify(key),
      inspect({ ...key }, { depth: Infinity, showHidden: true }),
      inspect(key, { depth: Infinity, showHidden: true, getters: true }),
      inspect(Object.getOwnPropertyDescriptors(key), { depth: Infinity, showHidden: true }),
      ...Object.values(key).map((f) => String(f)),
    ];
    for (const v of views) for (const f of forms) expect(v.includes(f)).toBe(false);
  });

  it("what the key returns holds none of them", () => {
    const out = [key.publicKey(), key.signReceipt(RECEIPT()), key.signTurnAck(ACK()), key.signRequest(REQUEST())];
    const text = inspect(out, { depth: Infinity, showHidden: true, maxArrayLength: Infinity }) + JSON.stringify(out.map((o) => (o instanceof Uint8Array ? hex(o) : { ...o, message: hex(o.message), signature: hex(o.signature) })));
    for (const f of forms) expect(text.includes(f)).toBe(false);
  });

  it("publicKey() is a fresh copy at each call", () => {
    const a = key.publicKey();
    const b = key.publicKey();
    expect(a).not.toBe(b);
    expect(hex(a)).toBe(hex(b));
    a.fill(0);
    expect(hex(key.publicKey())).toBe(hex(b));
    expect(a.length).toBe(32);
  });
});

describe("D4, D5, A6, T9: each signing function", () => {
  const key = channelKeyFromSeed({ seed: SEED });
  const pub = key.publicKey();

  it("signReceipt and signTurnAck give a frozen { message, signature } of the transcript's bytes, and the signature verifies", () => {
    for (const [s, message] of [
      [key.signReceipt(RECEIPT()), receiptMessage(RECEIPT())],
      [key.signTurnAck(ACK()), turnAckMessage(ACK())],
    ] as const) {
      expect(Object.keys(s).sort()).toEqual(["message", "signature"]);
      expect(Object.isFrozen(s)).toBe(true);
      expect(hex(s.message)).toBe(hex(message));
      expect(s.signature.length).toBe(64);
      expect(verifyChannelSignature({ publicKey: pub, message, signature: s.signature })).toBe(true);
    }
  });

  it("signRequest gives a frozen { message, signature, headers }, the headers from the same reading", () => {
    const s = key.signRequest(REQUEST());
    expect(Object.keys(s).sort()).toEqual(["headers", "message", "signature"]);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.headers)).toBe(true);
    expect(hex(s.message)).toBe(hex(sessionRequestMessage(REQUEST())));
    const r = REQUEST();
    expect({ ...s.headers }).toEqual({ ...requestHeaders({ channelId: r.channelId, timestampMs: r.timestampMs, nonce: r.nonce, challenge: r.challenge, signature: s.signature }) });
    expect(s.headers["x-flop-signature"]).toBe(`0x${hex(s.signature)}`);
    expect(verifyChannelSignature({ publicKey: pub, message: s.message, signature: s.signature })).toBe(true);
  });

  for (const [name, call, input] of [
    ["signReceipt", (i: unknown) => key.signReceipt(i as never), RECEIPT],
    ["signTurnAck", (i: unknown) => key.signTurnAck(i as never), ACK],
    ["signRequest", (i: unknown) => key.signRequest(i as never), REQUEST],
  ] as const) {
    it(`${name} reads each field of its input exactly once`, () => {
      const target = input();
      const { proxy, reads } = counted(target);
      call(proxy);
      expect(Object.fromEntries(reads)).toEqual(Object.fromEntries(Object.keys(target).map((k) => [k, 1])));
    });

    it(`${name}: changing the input after the call, or what it returned, changes nothing later`, () => {
      const i = input();
      const a = call(i) as { message: Uint8Array; signature: Uint8Array; headers?: Record<string, string> };
      const message = hex(a.message);
      const sig = hex(a.signature);
      (i.channelId as Uint8Array).fill(0);
      expect(hex(a.message)).toBe(message);
      a.message.fill(0);
      a.signature.fill(0);
      if (a.headers) expect(a.headers["x-flop-signature"]).toBe(`0x${sig}`);
      const b = call(input()) as { message: Uint8Array };
      expect(hex(b.message)).toBe(message);
    });
  }

  it("signRequest: bytes changed by the caller between the reading and the headers cannot reach them", () => {
    const r = REQUEST();
    const s = key.signRequest(r);
    r.nonce.fill(0xff);
    expect(s.headers["x-flop-nonce"]).toBe(`0x${"0a".repeat(16)}`);
    expect(JSON.parse(Buffer.from(s.message).toString("utf8"))[6]).toBe(`0x${"0a".repeat(16)}`);
  });

  it("D10: one key signs for two channels, each named by its call", () => {
    const other = new Uint8Array(32).fill(0x33);
    const a = key.signReceipt(RECEIPT());
    const b = key.signReceipt({ ...RECEIPT(), channelId: other });
    expect(hex(a.message.subarray(29, 61))).toBe(hex(CHANNEL));
    expect(hex(b.message.subarray(29, 61))).toBe(hex(other));
    expect(verifyChannelSignature({ publicKey: pub, message: b.message, signature: b.signature })).toBe(true);
  });

  it("a refusal of the input comes before any signing, and the seed input is copied", () => {
    const seed = Uint8Array.from(SEED);
    const k = channelKeyFromSeed({ seed });
    seed.fill(0);
    expect(hex(k.publicKey())).toBe(hex(pub));
  });
});

describe("D5: the library's own failures", () => {
  afterEach(() => {
    vi.doUnmock("@scure/sr25519");
    vi.resetModules();
  });

  async function keyWith(sign: (...a: unknown[]) => unknown) {
    vi.resetModules();
    vi.doMock("@scure/sr25519", async (orig) => ({ ...(await orig<typeof import("@scure/sr25519")>()), sign }));
    const k = await import("../src/channel/key.js");
    const e = await import("../src/channel/errors.js");
    return { key: k.channelKeyFromSeed({ seed: SEED }), ChannelErrorOf: e.ChannelError };
  }

  function refusal(f: () => unknown, C: typeof ChannelError) {
    try {
      f();
    } catch (e) {
      if (e instanceof C) return e;
      throw e;
    }
    throw new Error("did not refuse");
  }

  it("a signature that does not verify under the key's own public key: SELF_CHECK, nothing returned", async () => {
    const { key, ChannelErrorOf } = await keyWith(() => new Uint8Array(64).fill(0x80));
    for (const f of [() => key.signReceipt(RECEIPT()), () => key.signTurnAck(ACK()), () => key.signRequest(REQUEST())]) {
      const e = refusal(f, ChannelErrorOf);
      expect(e.refusal).toBe("SELF_CHECK");
      expect(e.message).toBe("channel key refused (SELF_CHECK): the signature does not verify under the key's own public key");
    }
  });

  it("a valid signature over another message: SELF_CHECK", async () => {
    const real = await vi.importActual<typeof import("@scure/sr25519")>("@scure/sr25519");
    const { key, ChannelErrorOf } = await keyWith((secret) => real.sign(secret as Uint8Array, new Uint8Array([1, 2, 3])));
    expect(refusal(() => key.signReceipt(RECEIPT()), ChannelErrorOf).refusal).toBe("SELF_CHECK");
  });

  it("a signature that is not 64 bytes, or not a Uint8Array: SELF_CHECK", async () => {
    for (const bad of [new Uint8Array(63), new Uint8Array(65), Array.from(new Uint8Array(64)), "x"]) {
      const { key, ChannelErrorOf } = await keyWith(() => bad);
      const e = refusal(() => key.signTurnAck(ACK()), ChannelErrorOf);
      expect(e.refusal).toBe("SELF_CHECK");
      expect(e.message).toBe("channel key refused (SELF_CHECK): the sr25519 library did not give a Uint8Array of 64 bytes");
    }
  });

  it("a library that throws: SIGN_FAILED, naming only the class, the thrown value kept as a cause that is not enumerable", async () => {
    const thrown = new RangeError(`secret ${"ab".repeat(32)} leaked`);
    const { key, ChannelErrorOf } = await keyWith(() => {
      throw thrown;
    });
    const e = refusal(() => key.signReceipt(RECEIPT()), ChannelErrorOf);
    expect(e.refusal).toBe("SIGN_FAILED");
    expect(e.message).toBe("channel key refused (SIGN_FAILED): the sr25519 library threw (RangeError) while signing");
    expect(e.cause).toBe(thrown);
    expect(Object.keys(e)).not.toContain("cause");
    expect(JSON.stringify(e)).not.toContain("leaked");
  });

  it("D7: a library whose verify says true to anything still gives false for a key not 32 bytes or a signature not 64 bytes", async () => {
    vi.resetModules();
    vi.doMock("@scure/sr25519", async (orig) => ({ ...(await orig<typeof import("@scure/sr25519")>()), verify: () => true }));
    const k = await import("../src/channel/key.js");
    const pub = new Uint8Array(32).fill(1);
    expect(k.verifyChannelSignature({ publicKey: pub, message: new Uint8Array(1), signature: new Uint8Array(64) })).toBe(true);
    expect(k.verifyChannelSignature({ publicKey: pub.subarray(0, 31), message: new Uint8Array(1), signature: new Uint8Array(64) })).toBe(false);
    expect(k.verifyChannelSignature({ publicKey: new Uint8Array(33), message: new Uint8Array(1), signature: new Uint8Array(64) })).toBe(false);
    expect(k.verifyChannelSignature({ publicKey: pub, message: new Uint8Array(1), signature: new Uint8Array(63) })).toBe(false);
    expect(k.verifyChannelSignature({ publicKey: pub, message: new Uint8Array(1), signature: new Uint8Array(65) })).toBe(false);
  });

  it("a library that throws a value that is not an Error: SIGN_FAILED, naming its kind", async () => {
    const { key, ChannelErrorOf } = await keyWith(() => {
      throw "a text with ab".repeat(4);
    });
    const e = refusal(() => key.signRequest(REQUEST()), ChannelErrorOf);
    expect(e.refusal).toBe("SIGN_FAILED");
    expect(e.message).toBe("channel key refused (SIGN_FAILED): the sr25519 library threw (string) while signing");
  });
});
