/**
 * Review of P3, the reviewer's property tests: what held. These pass on 165432c and are kept so a fix
 * cannot break them unseen. Two oracles independent of src/chain:
 *  - bytes written here by hand from the pallet and call indices that the lab's own metadata reader
 *    (research/2026-11-12-session-rerun-1014020/metadata-v14.mjs) reads from the recorded 1014020 metadata;
 *  - the reference decoder (@polkadot-api) reading the same bytes back.
 * Random inputs come from a fixed seed, so a run is the same everywhere. Test keys are made in memory.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { Blake2256 } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import type { InnerCall } from "../src/chain/calls.js";
import { amountText } from "../src/chain/describe.js";
import { lastValidBlock, mortalEra } from "../src/chain/era.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import { encodeSessionCall, signSessionCall } from "../src/chain/extrinsic.js";
import { hex, OWNER, plain, plainInput, REPO, refCall, RUNTIME_ID, sampleInner, testDevice, unhex } from "./lib/chain-fixtures.js";
import { withoutKnown } from "./helpers.js";

const RERUN = join(REPO, "research/2026-11-12-session-rerun-1014020");
const { parseMetadataV14 } = await import(join(RERUN, "metadata-v14.mjs"));
const facts = JSON.parse(readFileSync(join(RERUN, "facts-1014020.json"), "utf8"));
const tape = readFileSync(join(REPO, "observatory/fixtures/recording-20261112080132-05842a6db1e9c890/tape.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const metaBytes = tape
  .filter((o) => o.request?.method === "state_getMetadata" && typeof o.answer?.result === "string")
  .map((o) => Buffer.from(o.answer.result.slice(2), "hex"))
  .find((b) => createHash("sha256").update(b).digest("hex") === facts.metadata_sha256)!;
const md = parseMetadataV14(metaBytes.subarray(metaBytes.indexOf(Buffer.from("meta"))));

/** Pallet index, call index and the metadata's field names and types, by the lab's reader. */
function second(pallet: string, call: string) {
  const p = md.pallets.find((x: { name: string }) => x.name === pallet);
  const v = md.types[p.calls].def.variants.find((x: { name: string }) => x.name === call);
  return { pallet: p.index as number, call: v.index as number, fields: v.fields.map((f: { name: string; type: number }) => ({ name: f.name, type: md.types[f.type] })) };
}
const enumIndex = (t: { def: { variants: { name: string; index: number }[] } }, name: string) => t.def.variants.find((v) => v.name === name)!.index;
const enumNames = (t: { def: { variants: { name: string }[] } }) => t.def.variants.map((v) => v.name);

/** A seeded generator (xorshift32): the same cases on every run. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}
const R = rng(0x5eed_1014);
const pick = <T>(xs: readonly T[]): T => xs[R() % xs.length];
function b32(): Uint8Array {
  const k = R() % 4;
  if (k === 0) return new Uint8Array(32);
  if (k === 1) return new Uint8Array(32).fill(0xff);
  return Uint8Array.from({ length: 32 }, () => R() & 0xff);
}
function uint(bits: number): bigint {
  const k = R() % 4;
  const max = (1n << BigInt(bits)) - 1n;
  if (k === 0) return pick([0n, 1n, max, max - 1n]);
  if (k === 1) {
    const at = BigInt(8 * (1 + (R() % (bits / 8 - 1))));
    return pick([(1n << at) - 1n, 1n << at, (1n << at) + 1n]);
  }
  let v = 0n;
  for (let i = 0; i < bits / 32; i++) v = (v << 32n) | BigInt(R());
  return v & max;
}
const u32 = () => Number(uint(32));

const OC = second("ComputeChannel", "open_channel");
const FO = second("ComputeChannel", "force_open");
const sla = () => ({ max_turns: u32(), max_duration: u32(), reattest_every: u32() });
function randomInner(name: InnerCall["call"]): InnerCall {
  const precision = pick(enumNames(OC.fields.find((f: { name: string }) => f.name === "precision").type));
  switch (name) {
    case "open_channel":
      return { call: name, miner: b32(), model_hash: b32(), measured_root: b32(), decode_policy_hash: b32(), precision, enclave_key: b32(), agent_key: b32(), sla: sla(), escrow: uint(128), nonce: uint(64), settlement_class: pick(enumNames(OC.fields.find((f: { name: string }) => f.name === "settlement_class").type)) };
    case "force_open":
      return { call: name, miner: b32(), model_hash: b32(), measured_root: b32(), decode_policy_hash: b32(), precision, agent_key: b32(), sla: sla(), escrow: uint(128), nonce: uint(64) };
    case "top_up_escrow":
      return { call: name, channel_id: b32(), additional: uint(128) };
    default:
      return { call: name, channel_id: b32() };
  }
}

const le = (v: bigint, n: number) => Uint8Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
/** The call bytes written by hand: indices from the lab reader, fields in the metadata's order. */
function handBytes(owner: Uint8Array, inner: InnerCall, nonce: bigint): Uint8Array {
  const o = second("FlopSessionKeys", "execute_via_session");
  const c = second("ComputeChannel", inner.call);
  const v = inner as unknown as Record<string, unknown>;
  const out: number[] = [c.pallet, c.call];
  for (const f of c.fields) {
    const x = v[f.name];
    const path = f.type.path.join("::");
    if (x instanceof Uint8Array) out.push(...x);
    else if (path.endsWith("ModelPrecision") || path.endsWith("SettlementClass")) out.push(enumIndex(f.type, x as string));
    else if (path.endsWith("::Sla")) for (const k of ["max_turns", "max_duration", "reattest_every"]) out.push(...le(BigInt((x as Record<string, number>)[k]), 4));
    else if (f.name === "nonce") out.push(...le(x as bigint, 8));
    else out.push(...le(x as bigint, 16));
  }
  const spend = inner.call === "open_channel" || inner.call === "force_open" ? inner.escrow : inner.call === "top_up_escrow" ? inner.additional : 0n;
  expect(o.fields.map((f: { name: string }) => f.name)).toEqual(["owner", "call", "spend_amount", "nonce"]);
  return Uint8Array.from([o.pallet, o.call, ...owner, ...out, ...le(spend, 16), ...le(nonce, 8)]);
}

const NAMES = ["open_channel", "top_up_escrow", "timeout", "force_open", "expire_force_open"] as const;
const PER_CALL = 2000;

describe("A (P1): the call bytes, random and boundary inputs, against two independent oracles", () => {
  for (const name of NAMES) {
    it(`${name}: ${PER_CALL} cases equal the hand written bytes and decode with the reference to the input`, () => {
      let diffs = 0;
      for (let i = 0; i < PER_CALL; i++) {
        const inner = randomInner(name);
        const owner = b32();
        const nonce = uint(64);
        const bytes = encodeSessionCall({ runtime: RUNTIME_ID, owner, inner, sessionNonce: nonce });
        if (hex(bytes) !== hex(handBytes(owner, inner, nonce))) diffs++;
        const dec = refCall.dec(bytes);
        const spend = handBytes(owner, inner, nonce).slice(-24, -8);
        expect(plain(dec)).toEqual(plainInput(owner, inner, BigInt("0x" + Buffer.from(spend).reverse().toString("hex")), nonce));
        expect(hex(refCall.enc(dec))).toBe(hex(bytes));
      }
      expect(diffs).toBe(0);
    });
  }
});

describe("F (P6): the era for every birth asked for, against a formula written here", () => {
  const births: number[] = [];
  for (let b = 0; b <= 300; b++) births.push(b);
  for (let k = 64; k <= 2 ** 16; k += 64) births.push(k - 1, k, k + 1);
  births.push(2 ** 31, 2 ** 32 - 65, 2 ** 32 - 64);
  it(`${births.length} births: two bytes, low nibble 5 (period 64), phase birth mod 64, last valid birth + 63`, () => {
    for (const b of births) {
      const want = 5 + 16 * (b % 64);
      expect([...mortalEra(b)]).toEqual([want % 256, Math.floor(want / 256)]);
      expect(lastValidBlock(b)).toBe(b + 63);
    }
  });
  it("refuses a birth no u32 chain can have, and one whose era would outlive the u32", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 32, 2 ** 32 - 63, 2 ** 32 - 1]) {
      expect(() => mortalEra(bad)).toThrow(ChainEncodeError);
    }
  });
  it("refuses a birth hash of 31 or 33 bytes and a birth given as a bigint; the era byte is never 0 (immortal)", () => {
    const device = testDevice();
    for (const birth of [{ number: 5, hash: new Uint8Array(31) }, { number: 5, hash: new Uint8Array(33) }, { number: 5n, hash: new Uint8Array(32) }]) {
      expect(() => signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: sampleInner().timeout, sessionNonce: 0n, accountNonce: 0, birth: birth as never, signer: device })).toThrow(ChainEncodeError);
    }
    expect(device.calls).toHaveLength(0);
  });
});

describe("E (P5): the payload rule and the length prefix on real calls", () => {
  it("no real call has a payload between 191 and 334 bytes, so the 256 boundary is never met by a real input", () => {
    const device = testDevice();
    const lengths = new Map<string, Set<number>>();
    for (const name of NAMES)
      for (const accountNonce of [0, 63, 64, 16383, 16384, 2 ** 30 - 1, 2 ** 30, 2 ** 32 - 1]) {
        const out = signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: sampleInner()[name], sessionNonce: 0n, accountNonce, birth: { number: 1, hash: new Uint8Array(32) }, signer: device });
        if (!lengths.has(name)) lengths.set(name, new Set());
        lengths.get(name)!.add(out.payloadLength);
        expect(out.signed).toBe(out.payloadLength > 256 ? "payload-blake2b-256" : "payload");
        const signedMsg = device.calls.at(-1)!;
        expect(hex(signedMsg)).toBe(out.payloadLength > 256 ? hex(blake2b(rebuild(out), { dkLen: 32 })) : hex(rebuild(out)));
        // The length prefix: every body is 64 to 16383 bytes, a compact of two bytes.
        const body = out.extrinsic.length - 2;
        expect(out.extrinsic[0] & 3).toBe(1);
        expect((out.extrinsic[0] | (out.extrinsic[1] << 8)) >> 2).toBe(body);
      }
    const all = [...lengths.values()].flatMap((s) => [...s]);
    expect(all.every((n) => n <= 190 || n >= 335)).toBe(true);
    expect(Math.max(...[...lengths.get("timeout")!])).toBeLessThan(256);
    expect(Math.min(...[...lengths.get("force_open")!])).toBeGreaterThan(256);
  });
});

/** The payload rebuilt here from the extrinsic's own parts: call, extra, then the additional data written by hand. */
function rebuild(out: ReturnType<typeof signSessionCall>): Uint8Array {
  const rt = RUNTIME_ID;
  const callLen = out.call.length;
  const extra = out.extrinsic.slice(2 + 1 + 1 + 32 + 1 + 64, out.extrinsic.length - callLen);
  const additional = [...le(BigInt(rt.specVersion), 4), ...le(BigInt(rt.transactionVersion), 4), ...unhex(rt.genesisHash), ...out.fields.birth.hash, 0];
  return Uint8Array.from([...out.call, ...extra, ...additional]);
}

describe("G (P7): the signer", () => {
  const S = sampleInner();
  const base = (signer: unknown) => ({ runtime: RUNTIME_ID, owner: OWNER, inner: S.force_open, sessionNonce: 0n, accountNonce: 0, birth: { number: 9, hash: new Uint8Array(32).fill(3) }, signer }) as never;
  const device = testDevice();
  const otherSeed = ed25519.utils.randomSecretKey();
  const bad: [string, (m: Uint8Array) => unknown][] = [
    ["63 bytes", (m) => ed25519.sign(m, otherSeed).slice(0, 63)],
    ["65 bytes", (m) => Uint8Array.from([...device.sign(m), 0])],
    ["another key's signature", (m) => ed25519.sign(m, otherSeed)],
    ["a signature over another payload", (m) => device.sign(Uint8Array.from([...m, 1]))],
    ["the public key", () => device.publicKey],
    ["a promise", async (m) => device.sign(m)],
    ["undefined", () => undefined],
    ["an array of numbers", (m) => [...device.sign(m)]],
  ];
  for (const [label, sign] of bad) {
    it(`a sign that returns ${label} gets SIGNATURE_INVALID, called once, and no signature or payload in the message`, () => {
      let calls = 0;
      let seen: Uint8Array | null = null;
      try {
        signSessionCall(base({ publicKey: device.publicKey, sign: (m: Uint8Array) => ((calls++, (seen = m)), sign(m)) }));
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ChainEncodeError);
        expect((e as ChainEncodeError).refusal).toBe("SIGNATURE_INVALID");
        expect((e as Error).message).not.toContain(hex(seen!).slice(2, 40));
      }
      expect(calls).toBe(1);
    });
  }
  it("an input buffer shared by every 32 byte call field and changed inside sign does not change what was signed or described", () => {
    const buf = new ArrayBuffer(64);
    const view = new Uint8Array(buf, 0, 32).fill(0x42);
    const inner = { ...S.force_open, miner: view, model_hash: view, measured_root: view, decode_policy_hash: view, agent_key: view };
    const d = testDevice();
    const out = signSessionCall({ ...(base(d) as object), inner, owner: view, signer: { publicKey: d.publicKey, sign: (m: Uint8Array) => (view.fill(0x99), d.sign(m)) } } as never);
    // The words also hold the device key and the signature, which are random here and can hold 9999 by chance
    // (it failed that way once in the lead's run). They are removed by their known values first (rule T2).
    const sig = out.extrinsic.slice(2 + 1 + 1 + 32 + 1, 2 + 1 + 1 + 32 + 1 + 64);
    const words = withoutKnown(out.description, [hex(d.publicKey), hex(sig)]);
    expect(words).not.toContain("9999");
    expect(words).toContain(`as owner 0x${"42".repeat(32)}`);
    expect(ed25519.verify(out.extrinsic.slice(2 + 1 + 1 + 32 + 1, 2 + 1 + 1 + 32 + 1 + 64), Blake2256(rebuild(out)), d.publicKey)).toBe(true);
  });
});

describe("H (P8): the words", () => {
  it("amounts are exact in raw units and in FLOP at the edges", () => {
    expect(amountText(0n)).toBe("0 raw (0 FLOP)");
    expect(amountText(1n)).toBe("1 raw (0.000000000000000001 FLOP)");
    expect(amountText(10n ** 18n - 1n)).toBe("999999999999999999 raw (0.999999999999999999 FLOP)");
    expect(amountText(10n ** 18n)).toBe("1000000000000000000 raw (1 FLOP)");
    const max = (1n << 128n) - 1n;
    expect(amountText(max)).toBe(`${max} raw (340282366920938463463.374607431768211455 FLOP)`);
  });
  it("2000 random signed calls: no two different extrinsics share one description", () => {
    const device = testDevice();
    const seen = new Map<string, string>();
    for (let i = 0; i < 2000; i++) {
      const out = signSessionCall({ runtime: RUNTIME_ID, owner: b32(), inner: randomInner(pick(NAMES)), sessionNonce: uint(64), accountNonce: u32(), birth: { number: u32() % (2 ** 32 - 64), hash: b32() }, signer: device });
      // The signature line differs for any two payloads; compare the words without it.
      const words = out.description.replace(/signature 0x[0-9a-f]+/, "");
      const prev = seen.get(words);
      if (prev !== undefined) expect(prev).toBe(hex(out.call) + "/" + out.fields.accountNonce);
      seen.set(words, hex(out.call) + "/" + out.fields.accountNonce);
    }
  });
});
