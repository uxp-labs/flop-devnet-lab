// The two hashes storage keys are built with, written here with no dependency: xxHash64
// (src/hash/xxhash64.ts) and BLAKE2b (src/hash/blake2b.ts). Each is held to published test values,
// to Node's own BLAKE2b-512 and to the reference decoder's hashes on random inputs.
import { createHash } from "node:crypto";
import { Blake2128, Blake2256, Twox128, Twox256, h64 } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import { blake2b } from "../src/hash/blake2b.js";
import { xxhash64 } from "../src/hash/xxhash64.js";
import { toHex } from "../src/scale/reader.js";
import { seeded } from "./helpers/random.js";

const text = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const PRIME = 2654435761n;

/** The sanity buffer of xxhsum's self test: byteGen starts at PRIME32 and is squared, mod 2^32, after each byte. */
function sanityBuffer(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let gen = PRIME;
  for (let i = 0; i < n; i++) {
    out[i] = Number(gen >> 24n) & 0xff;
    gen = (gen * gen) & 0xffffffffn;
  }
  return out;
}

describe("xxHash64", () => {
  it.each([
    ["", 0n, 0xef46db3751d8e999n],
    ["a", 0n, 0xd24ec4f1a98c6e5bn],
    ["abc", 0n, 0x44bc2cf5ad770999n],
    ["message digest", 0n, 0x066ed728fceeb3ben],
    ["abcdefghijklmnopqrstuvwxyz", 0n, 0xcfe1f278fa89835cn],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", 0n, 0xe04a477f19ee145dn],
    ["", PRIME, 0xac75fda2929b17efn],
  ])("gives the published value for %j with seed %s", (s, seed, want) => {
    expect(xxhash64(text(s), seed)).toBe(want);
  });

  it.each([
    [1, 0n, 0x4fce394cc88952d8n],
    [1, PRIME, 0x739840cb819fa723n],
    [14, 0n, 0xcffa8db881bc3a3dn],
    [14, PRIME, 0x5b9611585efcc9cbn],
    [101, 0n, 0x0eab543384f878adn],
    [101, PRIME, 0xcaa65939306f1e21n],
  ])("gives xxhsum's self test value for %s bytes of its sanity buffer with seed %s", (n, seed, want) => {
    expect(xxhash64(sanityBuffer(n), seed)).toBe(want);
  });

  it("agrees with the reference's xxHash64 on 300 random inputs of 0 to 99 bytes, both seeds Substrate uses", () => {
    const rand = seeded(64);
    for (let n = 0; n < 300; n++) {
      const b = rand.bytes(rand.int(100));
      for (const seed of [0n, 1n, 2n, 3n]) expect(xxhash64(b, seed), `${hex(b)} seed ${seed}`).toBe(h64(b, seed));
    }
  });

  it("refuses a seed that is no 64 bit unsigned integer", () => {
    expect(() => xxhash64(text(""), -1n)).toThrow(RangeError);
    expect(() => xxhash64(text(""), 1n << 64n)).toThrow(RangeError);
  });
});

describe("BLAKE2b", () => {
  it("gives RFC 7693's value for abc, and the published values of the empty input", () => {
    expect(hex(blake2b(text("abc"), 64))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
    expect(hex(blake2b(text(""), 64))).toBe(
      "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
    );
    expect(hex(blake2b(text(""), 32))).toBe("0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
  });

  it("agrees with Node's BLAKE2b-512 on random inputs across the 128 byte block edges", () => {
    const rand = seeded(7693);
    for (const n of [0, 1, 127, 128, 129, 255, 256, 257, 1000]) {
      const b = rand.bytes(n);
      expect(hex(blake2b(b, 64)), `${n} bytes`).toBe(createHash("blake2b512").update(b).digest("hex"));
    }
  });

  it("agrees with the reference's 128 and 256 bit BLAKE2b on 200 random inputs", () => {
    const rand = seeded(128);
    for (let n = 0; n < 200; n++) {
      const b = rand.bytes(rand.int(300));
      expect(toHex(blake2b(b, 16))).toBe(toHex(Blake2128(b)));
      expect(toHex(blake2b(b, 32))).toBe(toHex(Blake2256(b)));
    }
  });

  it("refuses an output length outside 1 to 64 bytes", () => {
    for (const n of [0, 65, 1.5]) expect(() => blake2b(text(""), n), String(n)).toThrow(RangeError);
  });
});

describe("the reference's twox hashes are built from the same xxHash64", () => {
  it("twox128 and twox256 of a pallet name are xxHash64 with seeds 0 to 3, each little endian", () => {
    const le = (v: bigint) => Buffer.from(Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn))).toString("hex");
    const name = text("System");
    expect(le(xxhash64(name, 0n)) + le(xxhash64(name, 1n))).toBe("26aa394eea5630e07c48ae0c9558cef7");
    expect(toHex(Twox128(name))).toBe("0x26aa394eea5630e07c48ae0c9558cef7");
    expect(`0x${[0n, 1n, 2n, 3n].map((s) => le(xxhash64(name, s))).join("")}`).toBe(toHex(Twox256(name)));
  });
});
