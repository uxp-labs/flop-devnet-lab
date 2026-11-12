/**
 * P3, rules E6, E7 and E9: the payload rule and which path was taken; the result's fields, last valid block
 * and hash; and the description, made by reading the final bytes back, which names every value the bytes
 * hold. A changed byte changes the description or is refused.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { describe, expect, it } from "vitest";
import type { InnerCall } from "../src/chain/calls.js";
import { amountText, describeExtrinsic, FLOP_DECIMALS } from "../src/chain/describe.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import { PAYLOAD_HASH_ABOVE, signSessionCall, toSign } from "../src/chain/extrinsic.js";
import { readExtrinsic } from "../src/chain/reader.js";
import { callEntry, type Field } from "../src/chain/table.js";
import { boundaryInner, hex, OWNER, readJson, RT, RUNTIME_ID, sampleInner, testDevice, U128_MAX, U32_MAX, U64_MAX, unhex } from "./lib/chain-fixtures.js";

const BIRTH = { number: 3552594, hash: unhex("0xa85d1dcb67ae73c8c910634c75c043e62f83cf06dd4a90bbb5abe19c8674d08e") };
const cases: { inner: InnerCall; sessionNonce: bigint; accountNonce: number; birth: { number: number; hash: Uint8Array } }[] = [
  ...Object.values(sampleInner()).map((inner, i) => ({ inner, sessionNonce: BigInt(i), accountNonce: i * 1000, birth: BIRTH })),
  ...boundaryInner().map((inner, i) => ({ inner, sessionNonce: i % 2 ? 0n : U64_MAX, accountNonce: i % 2 ? 0 : U32_MAX, birth: { number: i % 2 ? 0 : U32_MAX - 63, hash: new Uint8Array(32).fill(i) } })),
];

const sign = (c: (typeof cases)[number], device = testDevice()) => ({ device, out: signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, ...c, signer: device }) });

describe("E6: the payload rule", () => {
  it("toSign: 255 and 256 bytes are signed as they are, 257 as their blake2b 256", () => {
    expect(PAYLOAD_HASH_ABOVE).toBe(256);
    for (const n of [0, 255, 256]) {
      const p = new Uint8Array(n).fill(7);
      expect(toSign(p)).toEqual({ message: p, signed: "payload" });
    }
    for (const n of [257, 1000]) {
      const p = new Uint8Array(n).fill(7);
      expect(toSign(p)).toEqual({ message: blake2b(p, { dkLen: 32 }), signed: "payload-blake2b-256" });
    }
  });

  it("below 256: a timeout's payload is signed as it is; the device got exactly the payload's length", () => {
    const { device, out } = sign(cases[2]);
    expect(out.payloadLength).toBeLessThan(256);
    expect(out.signed).toBe("payload");
    expect(device.calls).toHaveLength(1);
    expect(device.calls[0].length).toBe(out.payloadLength);
    expect(hex(device.calls[0].slice(0, out.call.length))).toBe(hex(out.call));
  });

  it("above 256: a force_open's payload is hashed; the device got 32 bytes", () => {
    const { device, out } = sign(cases[3]);
    expect(out.payloadLength).toBeGreaterThan(256);
    expect(out.signed).toBe("payload-blake2b-256");
    expect(device.calls[0].length).toBe(32);
  });

  it("the extrinsic's hash is blake2b 256 of its bytes", () => {
    const { out } = sign(cases[0]);
    expect(hex(out.hash)).toBe(hex(blake2b(out.extrinsic, { dkLen: 32 })));
  });
});

describe("E7 and E9: the result's fields", () => {
  for (const c of cases) {
    it(`${c.inner.call}, born at ${c.birth.number}: the fields are the input, read back; the last valid block is birth + 63`, () => {
      const { device, out } = sign(c);
      expect(out.fields.inner).toEqual(c.inner);
      expect(out.fields.owner).toEqual(OWNER);
      expect(out.fields.sessionNonce).toBe(c.sessionNonce);
      expect(out.fields.accountNonce).toBe(c.accountNonce);
      expect(out.fields.signer).toEqual(device.publicKey);
      expect(out.fields.birth).toEqual(c.birth);
      expect(out.fields.lastValidBlock).toBe(c.birth.number + 63);
    });
  }
});

/** What the words must say for each field of the inner call, written here from the input, not from src. */
function expectedFieldWords(fields: readonly Field[], value: Record<string, unknown>): string[] {
  return fields.flatMap((f) => {
    const v = value[f.name];
    if (f.type.kind === "struct") return expectedFieldWords(f.type.fields, v as Record<string, unknown>);
    if (v instanceof Uint8Array) return [`${f.name} ${hex(v)}`];
    if (f.type.kind === "u128") return [`${f.name} ${v} raw (`];
    return [`${f.name} ${String(v)}`];
  });
}

describe("E9: the description names every value the bytes hold", () => {
  for (const c of cases) {
    it(`${c.inner.call}, session nonce ${c.sessionNonce}: every value is named`, () => {
      const { device, out } = sign(c);
      const x = readExtrinsic(RT, out.extrinsic);
      const words = out.description;
      const want = [
        `signed by device ${hex(device.publicKey)}`,
        `Ed25519 signature ${hex(x.signature)}`,
        `account nonce ${c.accountNonce},`,
        "tip 0 raw (0 FLOP)",
        "metadata hash check Disabled",
        `mortal era of 64 blocks (phase ${c.birth.number % 64})`,
        `born at block ${c.birth.number}, hash ${hex(c.birth.hash)}`,
        `valid through block ${c.birth.number + 63}`,
        `runtime ${RT.specName} ${RT.specVersion}, transaction version ${RT.transactionVersion}, genesis ${RT.genesisHash}`,
        `FlopSessionKeys.execute_via_session as owner ${hex(OWNER)}`,
        `session nonce ${c.sessionNonce};`,
        `declared spend ${amountText(out.fields.spend)}`,
        `inner call ComputeChannel.${c.inner.call}:`,
        ...expectedFieldWords(callEntry(RT, "ComputeChannel", c.inner.call).fields, c.inner as unknown as Record<string, unknown>),
      ];
      for (const w of want) expect(words).toContain(w);
    });
  }

  it("the description is the words of the bytes read back: describeExtrinsic of readExtrinsic", () => {
    const { out } = sign(cases[3]);
    expect(out.description).toBe(describeExtrinsic(RT, readExtrinsic(RT, out.extrinsic), BIRTH, BIRTH.number + 63));
  });

  for (const at of [2, 3]) {
    it(`a changed byte anywhere in a signed ${cases[at].inner.call} changes the description or is refused`, () => {
      const { out } = sign(cases[at]);
      const base = describeExtrinsic(RT, readExtrinsic(RT, out.extrinsic), BIRTH, BIRTH.number + 63);
      const same: number[] = [];
      for (let i = 0; i < out.extrinsic.length; i++) {
        for (const bit of [0x01, 0x80]) {
          const b = Uint8Array.from(out.extrinsic);
          b[i] ^= bit;
          try {
            if (describeExtrinsic(RT, readExtrinsic(RT, b), BIRTH, BIRTH.number + 63) === base) same.push(i);
          } catch (e) {
            expect(e).toBeInstanceOf(ChainEncodeError);
          }
        }
      }
      expect(same).toEqual([]);
    });
  }
});

describe("amounts in raw units and in FLOP", () => {
  it("FLOP_DECIMALS is contract/rules.json FLOP_DECIMALS", () => {
    expect(FLOP_DECIMALS).toBe(readJson("contract/rules.json").constants.FLOP_DECIMALS.value);
  });

  it("amountText is exact, from 0 to 2^128 - 1", () => {
    expect(amountText(0n)).toBe("0 raw (0 FLOP)");
    expect(amountText(1n)).toBe("1 raw (0.000000000000000001 FLOP)");
    expect(amountText(12000000000000000n)).toBe("12000000000000000 raw (0.012 FLOP)");
    expect(amountText(10n ** 18n)).toBe("1000000000000000000 raw (1 FLOP)");
    expect(amountText(U128_MAX)).toBe("340282366920938463463374607431768211455 raw (340282366920938463463.374607431768211455 FLOP)");
  });
});
