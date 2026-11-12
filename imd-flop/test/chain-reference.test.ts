/**
 * P3, rule E12, against the reference encoder (@polkadot-api, from the recorded 1014020 metadata).
 *  - The calls: for each of the five inner calls and the outer call, with ordinary and boundary values, the
 *    reference decodes the encoder's bytes to the input and encodes that back to the same bytes.
 *  - The era: the reference has no mortal era builder, only the metadata's Era enum. The era bytes are held
 *    by that enum and by an independent writing of Substrate's Era::mortal and Era::birth below.
 *  - The whole extrinsic: the reference decodes it to the same fields; its signature verifies against the
 *    public key and a payload built here from the reference's own codecs; its hash is blake2b 256 of it.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { Blake2256, compact as refCompact, extrinsicFormat, Tuple } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import type { InnerCall } from "../src/chain/calls.js";
import { lastValidBlock, mortalEra } from "../src/chain/era.js";
import { encodeSessionCall, signSessionCall } from "../src/chain/extrinsic.js";
import { boundaryInner, hex, metadata, OWNER, plain, plainInput, ref, refCall, RT, RUNTIME_ID, sampleInner, testDevice, U32_MAX, U64_MAX, unhex } from "./lib/chain-fixtures.js";

const spendOf = (i: InnerCall) => (i.call === "open_channel" || i.call === "force_open" ? i.escrow : i.call === "top_up_escrow" ? i.additional : 0n);

const cases: { label: string; inner: InnerCall; nonce: bigint }[] = [
  ...Object.values(sampleInner()).map((inner) => ({ label: `ordinary ${inner.call}`, inner, nonce: 7n })),
  ...boundaryInner().map((inner, i) => ({ label: `boundary ${i} ${inner.call}`, inner, nonce: i % 2 === 0 ? U64_MAX : 0n })),
];

describe("E12: the call bytes equal the reference encoder's", () => {
  it("the cases cover each of the five inner calls with ordinary and boundary values", () => {
    const names = new Set(cases.map((c) => c.inner.call));
    expect([...names].sort()).toEqual(["expire_force_open", "force_open", "open_channel", "timeout", "top_up_escrow"]);
    expect(cases.length).toBe(13);
  });

  for (const c of cases) {
    it(`${c.label}: the reference reads the bytes as the input and writes the same bytes`, () => {
      const bytes = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: c.inner, sessionNonce: c.nonce });
      const decoded = refCall.dec(bytes);
      expect(plain(decoded)).toEqual(plainInput(OWNER, c.inner, spendOf(c.inner), c.nonce));
      expect(hex(refCall.enc(decoded))).toBe(hex(bytes));
    });
  }

  it("the inner call alone equals the reference's ComputeChannel call", () => {
    for (const c of cases) {
      const bytes = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: c.inner, sessionNonce: c.nonce });
      const { call, ...fields } = c.inner as unknown as Record<string, unknown> & { call: string };
      const built = ref.buildCall("ComputeChannel", call);
      const innerRef = built.codec.enc(refCall.dec(bytes).value.value.call.value.value);
      const at = 2 + 32;
      expect(hex(bytes.slice(at + 2, at + 2 + innerRef.length))).toBe(hex(innerRef));
      expect([bytes[at], bytes[at + 1]]).toEqual(built.location);
      expect(Object.keys(fields).length).toBeGreaterThan(0);
    }
  });
});

/** Substrate's Era::mortal(period, current), written here independently of src/chain/era.ts. */
function substrateMortal(period: number, current: number): [number, number] {
  let p = 1;
  while (p < period) p *= 2;
  p = Math.min(Math.max(p, 4), 1 << 16);
  const phase = current % p;
  const quantize = Math.max(p >> 12, 1);
  const quantized = Math.floor(phase / quantize) * quantize;
  let tz = 0;
  while (((p >> tz) & 1) === 0) tz++;
  const encoded = Math.min(15, Math.max(1, tz - 1)) | ((quantized / quantize) << 4);
  return [encoded & 0xff, encoded >> 8];
}
/** Substrate's Era::birth(current) for a mortal era of this period and phase. */
const substrateBirth = (period: number, phase: number, current: number) => Math.floor((Math.max(current, phase) - phase) / period) * period + phase;

describe("E12: the era", () => {
  const eraTy = metadata.lookup.find((t) => t.path.join("::") === "sp_runtime::generic::era::Era")!;
  const eraCodec = ref.buildDefinition(eraTy.id);
  const births = [0, 1, 2, 62, 63, 64, 65, 127, 128, 129, 4095, 4096, 65535, 65536, 3552594, 3552721, 2 ** 31, U32_MAX - 64, U32_MAX - 63];

  for (const b of births) {
    it(`born at ${b}: the bytes are Substrate's mortal era of 64, read by the metadata's Era as Mortal with the phase`, () => {
      const bytes = mortalEra(b);
      expect([...bytes]).toEqual(substrateMortal(64, b));
      const dec = eraCodec.dec(bytes);
      expect(dec.type).toBe(`Mortal${bytes[0]}`);
      expect(dec.value).toBe(bytes[1]);
      expect(hex(eraCodec.enc(dec))).toBe(hex(bytes));
      expect((bytes[0] | (bytes[1] << 8)) >> 4).toBe(b % 64);
    });
  }

  it("the last valid block is the last block whose era birth is the birth block", () => {
    for (const b of births) {
      const last = lastValidBlock(b);
      expect(last).toBe(b + 63);
      const phase = b % 64;
      expect(substrateBirth(64, phase, b)).toBe(b);
      expect(substrateBirth(64, phase, last)).toBe(b);
      expect(substrateBirth(64, phase, last + 1)).not.toBe(b);
    }
  });
});

/** The reference's decoding of a signed extrinsic: length, version, address, signature, extensions, call. */
function refDecode(bytes: Uint8Array) {
  const params = metadata.lookup[metadata.extrinsic.type].params;
  const codec = (n: string) => ref.buildDefinition(params.find((p) => p.name === n)!.type!);
  const length = refCompact.dec(bytes);
  const prefix = refCompact.enc(length).length;
  const body = bytes.slice(prefix);
  const format = extrinsicFormat.dec(body.slice(0, 1));
  const rest = Tuple(codec("Address"), codec("Signature"), codec("Extra"), refCall);
  const [address, signature, extra, call] = rest.dec(body.slice(1));
  return { length: Number(length), bodyLength: body.length, format, address, signature, extra, call, reencoded: rest.enc([address, signature, extra, call]), body };
}

function refAdditional(birthHash: Uint8Array): Uint8Array {
  const exts = metadata.extrinsic.extensionsByVersion[0] ?? Object.values(metadata.extrinsic.extensions);
  const values: Record<string, unknown> = {
    CheckSpecVersion: RT.specVersion,
    CheckTxVersion: RT.transactionVersion,
    CheckGenesis: RT.genesisHash,
    CheckMortality: hex(birthHash),
    CheckMetadataHash: undefined,
  };
  return Tuple(...exts.map((e: { additionalSigned: number }) => ref.buildDefinition(e.additionalSigned))).enc(exts.map((e: { identifier: string }) => values[e.identifier]));
}

describe("E12: the whole extrinsic", () => {
  const device = testDevice();
  const birth = { number: Number(3552594), hash: unhex("0xa85d1dcb67ae73c8c910634c75c043e62f83cf06dd4a90bbb5abe19c8674d08e") };
  const accountNonces = [0, 63, 64, 16383, 16384, U32_MAX];

  for (const c of cases) {
    for (const accountNonce of [accountNonces[cases.indexOf(c) % accountNonces.length]]) {
      it(`${c.label}, account nonce ${accountNonce}: the reference reads the same fields; the signature and the hash hold`, () => {
        const out = signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: c.inner, sessionNonce: c.nonce, accountNonce, birth, signer: device });
        const d = refDecode(out.extrinsic);
        expect(d.length).toBe(d.bodyLength);
        expect(d.format).toEqual({ version: 4, type: "signed" });
        expect(hex(d.reencoded)).toBe(hex(d.body.slice(1)));
        expect(plain(d.address)).toEqual({ Id: hex(device.publicKey) });
        expect(d.signature.type).toBe("Ed25519");
        const [nonZero, spec, txv, genesis, mortality, nonce, weight, payment, metadataHash] = d.extra;
        expect([nonZero, spec, txv, genesis, weight]).toEqual([undefined, undefined, undefined, undefined, undefined]);
        expect(mortality).toEqual({ type: `Mortal${mortalEra(birth.number)[0]}`, value: mortalEra(birth.number)[1] });
        expect(nonce).toBe(accountNonce);
        expect(payment).toBe(0n);
        // The reference reads a struct of one field as that field: CheckMetadataHash { mode } is the mode.
        expect(metadataHash).toEqual({ type: "Disabled", value: undefined });
        expect(plain(d.call)).toEqual(plainInput(OWNER, c.inner, spendOf(c.inner), c.nonce));

        const callRef = refCall.enc(d.call);
        const extraRef = ref.buildDefinition(metadata.lookup[metadata.extrinsic.type].params.find((p) => p.name === "Extra")!.type!).enc(d.extra);
        const payload = new Uint8Array([...callRef, ...extraRef, ...refAdditional(birth.hash)]);
        expect(out.payloadLength).toBe(payload.length);
        const message = payload.length > 256 ? Blake2256(payload) : payload;
        expect(out.signed).toBe(payload.length > 256 ? "payload-blake2b-256" : "payload");
        expect(ed25519.verify(unhex(d.signature.value), message, device.publicKey)).toBe(true);
        expect(hex(out.hash)).toBe(hex(Blake2256(out.extrinsic)));
        expect(hex(out.call)).toBe(hex(callRef));
      });
    }
  }
});
