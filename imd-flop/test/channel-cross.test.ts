/**
 * P4, rules D2, D7 and T4: cross vectors between the lab's channel key (@scure/sr25519) and the reference
 * (@polkadot/wasm-crypto, Rust schnorrkel in WASM, test/lib/sr25519-reference.ts). sr25519 signatures are
 * randomized, so the vectors compare public keys and verdicts, never signature bytes.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { channelKeyFromSeed, verifyChannelSignature, type ChannelKey } from "../src/channel/key.js";
import { referencePair, referenceReady, referenceSign, referenceVerify } from "./lib/sr25519-reference.js";

beforeAll(async () => {
  await referenceReady();
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** splitmix64, seeded here, so the seeds are the same on every run and every machine. */
function seeds(count: number, start: bigint): Uint8Array[] {
  let state = start;
  const next = (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  };
  return Array.from({ length: count }, () => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
      const w = next();
      for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((w >> BigInt(8 * j)) & 0xffn);
    }
    return out;
  });
}

const SEEDS = [...seeds(32, 0x50345f6368616e6en), new Uint8Array(32), new Uint8Array(32).fill(0xff)];

const flip = (b: Uint8Array, byte: number, bit: number) => {
  const c = Uint8Array.from(b);
  c[byte] ^= 1 << bit;
  return c;
};

const CHANNEL = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const CHALLENGE = "ab".repeat(32);

/** One of each of the three kinds of signature the key makes. */
function signAll(key: ChannelKey): [string, { message: Uint8Array; signature: Uint8Array }][] {
  return [
    ["receipt", key.signReceipt({ channelId: CHANNEL, finalRoot: new Uint8Array(32).fill(7), aggregateGn: 38n, payable: 114000000000000002n })],
    ["turn ack", key.signTurnAck({ channelId: CHANNEL, turnIndex: 0, leafHash: new Uint8Array(32).fill(9), agentSendMs: 1731550000000n, agentRecvMs: 1731550000123n })],
    ["request", key.signRequest({ channelId: CHANNEL, method: "POST", path: "/session/open", body: '{"a":1}', timestampMs: 1731550000123n, nonce: new Uint8Array(16).fill(5), challenge: CHALLENGE })],
  ];
}

describe("T4: the public key from a seed equals the reference's", () => {
  it(`over ${SEEDS.length} seeds: 32 from a seeded generator, all zero and all 0xff`, () => {
    expect(SEEDS.length).toBe(34);
    expect(new Set(SEEDS.map(hex)).size).toBe(34);
    for (const seed of SEEDS) expect(hex(channelKeyFromSeed({ seed }).publicKey()), hex(seed)).toBe(hex(referencePair(seed).publicKey));
  });
});

describe("T4: the lab's three kinds of signature verify under the reference, and stop after one flipped bit", () => {
  for (const seed of SEEDS.slice(0, 4)) {
    it(`seed ${hex(seed).slice(0, 8)}`, () => {
      const key = channelKeyFromSeed({ seed });
      const pub = key.publicKey();
      for (const [kind, s] of signAll(key)) {
        expect(referenceVerify(pub, s.message, s.signature), kind).toBe(true);
        expect(referenceVerify(pub, flip(s.message, 0, 0), s.signature), `${kind}: message`).toBe(false);
        expect(referenceVerify(pub, flip(s.message, s.message.length - 1, 7), s.signature), `${kind}: last message bit`).toBe(false);
        expect(referenceVerify(pub, s.message, flip(s.signature, 0, 0)), `${kind}: signature R`).toBe(false);
        expect(referenceVerify(pub, s.message, flip(s.signature, 40, 3)), `${kind}: signature s`).toBe(false);
        expect(referenceVerify(flip(pub, 0, 1), s.message, s.signature), `${kind}: key`).toBe(false);
      }
    });
  }
});

describe("T4: the reference's signatures over the lab's messages verify under verifyChannelSignature, and stop after a flip", () => {
  for (const seed of SEEDS.slice(4, 8)) {
    it(`seed ${hex(seed).slice(0, 8)}`, () => {
      const key = channelKeyFromSeed({ seed });
      const pair = referencePair(seed);
      for (const [kind, s] of signAll(key)) {
        const sig = referenceSign(pair, s.message);
        expect(sig.length).toBe(64);
        expect(verifyChannelSignature({ publicKey: key.publicKey(), message: s.message, signature: sig }), kind).toBe(true);
        expect(verifyChannelSignature({ publicKey: key.publicKey(), message: flip(s.message, 3, 2), signature: sig }), `${kind}: message`).toBe(false);
        expect(verifyChannelSignature({ publicKey: key.publicKey(), message: s.message, signature: flip(sig, 1, 0) }), `${kind}: signature`).toBe(false);
        expect(verifyChannelSignature({ publicKey: flip(key.publicKey(), 2, 4), message: s.message, signature: sig }), `${kind}: key`).toBe(false);
      }
    });
  }
});

describe("D7, T4: verifyChannelSignature never throws on bytes", () => {
  const seed = SEEDS[8] as Uint8Array;
  const key = channelKeyFromSeed({ seed });
  const [, s] = signAll(key)[0] as [string, { message: Uint8Array; signature: Uint8Array }];

  it("a reference signature with the marker bit cleared: false, no throw", () => {
    const sig = referenceSign(referencePair(seed), s.message);
    expect(sig[63]! & 0x80).toBe(0x80);
    const cleared = Uint8Array.from(sig);
    cleared[63] = cleared[63]! & 0x7f;
    expect(verifyChannelSignature({ publicKey: key.publicKey(), message: s.message, signature: cleared })).toBe(false);
  });

  it("a lab signature with the marker bit cleared: false, no throw", () => {
    const cleared = Uint8Array.from(s.signature);
    cleared[63] = cleared[63]! & 0x7f;
    expect(verifyChannelSignature({ publicKey: key.publicKey(), message: s.message, signature: cleared })).toBe(false);
  });

  it("a public key not 32 bytes, a signature not 64 bytes: false", () => {
    expect(verifyChannelSignature({ publicKey: key.publicKey().subarray(0, 31), message: s.message, signature: s.signature })).toBe(false);
    expect(verifyChannelSignature({ publicKey: new Uint8Array(33), message: s.message, signature: s.signature })).toBe(false);
    expect(verifyChannelSignature({ publicKey: key.publicKey(), message: s.message, signature: s.signature.subarray(0, 63) })).toBe(false);
    expect(verifyChannelSignature({ publicKey: key.publicKey(), message: s.message, signature: new Uint8Array(65) })).toBe(false);
  });

  it("a public key that is not a point, the zero key, an all 0xff signature: false", () => {
    expect(verifyChannelSignature({ publicKey: new Uint8Array(32).fill(0xff), message: s.message, signature: s.signature })).toBe(false);
    expect(verifyChannelSignature({ publicKey: new Uint8Array(32), message: s.message, signature: s.signature })).toBe(false);
    expect(verifyChannelSignature({ publicKey: key.publicKey(), message: s.message, signature: new Uint8Array(64).fill(0xff) })).toBe(false);
    expect(verifyChannelSignature({ publicKey: key.publicKey(), message: new Uint8Array(0), signature: s.signature })).toBe(false);
  });

  it("a Node Buffer of each field is read as its bytes", () => {
    expect(verifyChannelSignature({ publicKey: Buffer.from(key.publicKey()), message: Buffer.from(s.message), signature: Buffer.from(s.signature) })).toBe(true);
  });
});

describe("T4: two signatures of one message differ and both verify", () => {
  it("under the lab and under the reference", () => {
    const key = channelKeyFromSeed({ seed: SEEDS[9] as Uint8Array });
    const fields = { channelId: CHANNEL, finalRoot: new Uint8Array(32), aggregateGn: 1n, payable: 2n };
    const a = key.signReceipt(fields);
    const b = key.signReceipt(fields);
    expect(hex(a.message)).toBe(hex(b.message));
    expect(hex(a.signature)).not.toBe(hex(b.signature));
    for (const s of [a, b]) {
      expect(verifyChannelSignature({ publicKey: key.publicKey(), message: s.message, signature: s.signature })).toBe(true);
      expect(referenceVerify(key.publicKey(), s.message, s.signature)).toBe(true);
    }
  });

  it("two keys from newChannelKey are different keys", async () => {
    const { newChannelKey } = await import("../src/channel/key.js");
    const a = newChannelKey();
    const b = newChannelKey();
    expect(hex(a.publicKey())).not.toBe(hex(b.publicKey()));
    const [, s] = signAll(a)[2] as [string, { message: Uint8Array; signature: Uint8Array }];
    expect(referenceVerify(a.publicKey(), s.message, s.signature)).toBe(true);
    expect(referenceVerify(b.publicKey(), s.message, s.signature)).toBe(false);
  });
});
