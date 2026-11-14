/**
 * Review of piece R, second branch (reviewer, not the builder): attack 2, a third reading of each settle.
 *
 * Each extrinsic of each settled block is walked from its first byte with lines of this file alone: the compact
 * length, the version byte, the address, the signature, each extension of the metadata in its order, then the call,
 * every field by its type in the metadata's lookup, to the last byte. No byte search, no @polkadot-api codec: the
 * reference parses the metadata only (decAnyMetadata, unifyMetadata), and every byte of the extrinsic is read here.
 * What this walk reads is compared with both of the branch's readings, and the receipt is verified with the
 * reference sr25519 (test/lib/sr25519-reference.ts) beside the lab's verify. Nothing here reads the network.
 */
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { beforeAll, describe, expect, it } from "vitest";
import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { verifyChannelSignature } from "../src/channel/key.js";
import { receiptMessage } from "../src/channel/transcript.js";
import { SETTLE_CHANNELS, refBytes, refDecodeOf, settleByShape, settleCallOf, settleOf } from "./lib/settle-recording.js";
import { referenceReady, referenceVerify } from "./lib/sr25519-reference.js";

type Rec = Record<string, any>;
type Val = bigint | boolean | string | Uint8Array | Val[] | { [k: string]: Val } | { variant: string; index: number; value: Val } | null;

/** A cursor over bytes, every read checked against the end. */
class Cursor {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  take(n: number): Uint8Array {
    if (this.o + n > this.b.length) throw new Error(`read of ${n} bytes past the end at ${this.o}`);
    const r = this.b.slice(this.o, this.o + n);
    this.o += n;
    return r;
  }
  byte(): number {
    return this.take(1)[0] as number;
  }
  compact(): bigint {
    const first = this.b[this.o] as number;
    const mode = first & 3;
    if (mode === 0) return BigInt(this.byte() >> 2);
    if (mode === 1) return BigInt(leOf(this.take(2)) >> 2n);
    if (mode === 2) return BigInt(leOf(this.take(4)) >> 2n);
    this.byte();
    return leOf(this.take((first >> 2) + 4));
  }
}
const leOf = (b: Uint8Array) => b.reduceRight((a, x) => (a << 8n) | BigInt(x), 0n);

const PRIM_WIDTH: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, u256: 32, i8: 1, i16: 2, i32: 4, i64: 8, i128: 16, i256: 32 };

/** A walker of one type of the metadata's lookup, written here. */
function walker(lookup: Rec[]) {
  const byId = new Map(lookup.map((t) => [t.id as number, t]));
  const isU8 = (id: number) => {
    const d = byId.get(id)?.def;
    return d?.tag === "primitive" && (d.value?.tag ?? d.value) === "u8";
  };
  const walk = (c: Cursor, id: number): Val => {
    const t = byId.get(id);
    if (t === undefined) throw new Error(`no type ${id}`);
    const d = t.def;
    switch (d.tag) {
      case "primitive": {
        const p = String(d.value?.tag ?? d.value);
        if (p === "bool") {
          const v = c.byte();
          if (v > 1) throw new Error(`bool ${v}`);
          return v === 1;
        }
        if (p === "str") return new TextDecoder().decode(c.take(Number(c.compact())));
        if (p === "char") return String.fromCodePoint(Number(leOf(c.take(4))));
        const w = PRIM_WIDTH[p];
        if (w === undefined) throw new Error(`primitive ${p}`);
        return leOf(c.take(w));
      }
      case "compact":
        return c.compact();
      case "array":
        if (isU8(d.value.type)) return c.take(d.value.len);
        return Array.from({ length: d.value.len }, () => walk(c, d.value.type));
      case "sequence": {
        const n = Number(c.compact());
        if (isU8(d.value)) return c.take(n);
        return Array.from({ length: n }, () => walk(c, d.value));
      }
      case "tuple":
        return (d.value as number[]).map((x) => walk(c, x));
      case "composite": {
        const fs = d.value as Rec[];
        if (fs.length > 0 && fs.every((f) => f.name === undefined)) return fs.length === 1 ? walk(c, fs[0].type) : fs.map((f) => walk(c, f.type));
        return Object.fromEntries(fs.map((f) => [f.name, walk(c, f.type)]));
      }
      case "variant": {
        const index = c.byte();
        const v = (d.value as Rec[]).find((x) => x.index === index);
        if (v === undefined) throw new Error(`type ${id} (${(t.path as string[]).join("::")}) has no variant ${index}`);
        const fs = v.fields as Rec[];
        const value: Val = fs.length === 0 ? null : fs.every((f) => f.name === undefined) ? (fs.length === 1 ? walk(c, fs[0].type) : fs.map((f) => walk(c, f.type))) : Object.fromEntries(fs.map((f) => [f.name, walk(c, f.type)]));
        return { variant: v.name, index, value };
      }
      default:
        throw new Error(`type kind ${d.tag}`);
    }
  };
  return walk;
}

/** One extrinsic walked whole: its version and kind, the signer's part when signed, and the call. */
function walkExtrinsic(metadata: Uint8Array, hex: string) {
  const md = unifyMetadata(decAnyMetadata(metadata)) as Rec;
  const walk = walker(md.lookup);
  const params = md.lookup[md.extrinsic.type].params as { name: string; type: number }[];
  const typeOf = (n: string) => params.find((p) => p.name === n)?.type as number;
  const c = new Cursor(bytesOf(hex));
  const length = Number(c.compact());
  const start = c.o;
  const v = c.byte();
  const signed = (v & 0x80) !== 0;
  const version = v & 0x3f;
  let address: Val = null;
  let signature: Val = null;
  const extensions: [string, Val][] = [];
  if (signed) {
    address = walk(c, typeOf("Address"));
    signature = walk(c, typeOf("Signature"));
    for (const e of md.extrinsic.extensionsByVersion?.[0] ?? Object.values(md.extrinsic.extensions)) extensions.push([e.identifier, walk(c, e.type)]);
  }
  const callAt = c.o;
  const call = walk(c, typeOf("Call")) as { variant: string; index: number; value: { variant: string; index: number; value: Rec } };
  return { length, consumed: c.o - start, end: c.o, total: c.b.length, signed, version, address, signature, extensions, callAt, call, bytes: c.b };
}

const SETTLES = SETTLE_CHANNELS.map((ch) => {
  const s = settleOf(ch);
  const byShape = settleByShape(s);
  const ref = refDecodeOf(s.settled.pin.metadata)(bytesOf(byShape.extrinsic));
  const walked = s.extrinsics.map((x) => walkExtrinsic(s.settled.pin.metadata, x));
  return { s, byShape, ref, walked };
});

beforeAll(referenceReady);

describe("HOLDS: a third reading of each settle, walked from the first byte by this file's own lines", () => {
  for (const { s, byShape, ref, walked } of SETTLES) {
    describe(`the ${s.channel} channel's settle at block ${s.settled.height}`, () => {
      it("HOLDS: every extrinsic of the block is walked whole: its compact length is its body, and the walk ends at its last byte", () => {
        expect(walked.length).toBe(s.extrinsics.length);
        for (const w of walked) {
          expect(w.consumed).toBe(w.length);
          expect(w.end).toBe(w.total);
        }
      });

      it("HOLDS: exactly one extrinsic of the block is a ComputeChannel.settle, by its decoded call, and it is the one the byte search found, with the call where the search found it", () => {
        const { pallet, call } = settleCallOf(s.shape);
        const settles = walked.filter((w) => w.call.index === pallet && w.call.value.index === call);
        expect(settles).toHaveLength(1);
        const w = settles[0] as (typeof walked)[number];
        expect([w.call.variant, w.call.value.variant]).toEqual(["ComputeChannel", "settle"]);
        expect(hexOf(w.bytes)).toBe(byShape.extrinsic);
        const head = Uint8Array.of(pallet, call, ...bytesOf(s.channelId));
        expect(hexOf(w.bytes.slice(w.callAt, w.callAt + head.length))).toBe(hexOf(head));
        expect(w.signed).toBe(true);
        expect(w.version).toBe(4);
        expect(walked.flatMap((x) => (x.call.variant === "ComputeChannel" ? [x.call.value.variant] : []))).toEqual(["settle"]);
      });

      it("HOLDS: the walk's arguments equal the reference decoder's and the shape search's, field by field, and the call's fields are the shape's", () => {
        const w = walked.find((x) => x.call.variant === "ComputeChannel" && x.call.value.variant === "settle") as (typeof walked)[number];
        const a = w.call.value.value;
        expect(Object.keys(a)).toEqual(settleCallOf(s.shape).fields.map((f) => f.name));
        const r = ref.call.value.value as Rec;
        for (const k of ["channel_id", "final_root", "claimed_measured_root", "agent_receipt_sig"]) {
          expect(hexOf(a[k]), k).toBe(hexOf(refBytes(r[k])));
          expect(hexOf(a[k]), k).toBe(hexOf(byShape.fields.get(k) as Uint8Array));
        }
        expect(a.aggregate_gn).toBe(r.aggregate_gn);
        expect(a.aggregate_gn).toBe(leOf(byShape.fields.get("aggregate_gn") as Uint8Array));
        expect(a.transcript_ref).toEqual({ variant: "None", index: 0, value: null });
        expect((a.verified_turns as Rec[]).length).toBe((r.verified_turns as Rec[]).length);
        for (const [i, t] of (a.verified_turns as Rec[]).entries()) {
          const rt = (r.verified_turns as Rec[])[i] as Rec;
          expect(t.turn_index).toBe(BigInt(rt.turn_index));
          expect(t.g_n).toBe(rt.g_n);
          expect(hexOf(t.enclave_sig)).toBe(hexOf(refBytes(rt.enclave_sig)));
          expect(t.leaf_version.variant).toBe(rt.leaf_version.type);
        }
      });

      it("HOLDS: the walk's signer part: the address, the signature, the nine extensions in the metadata's order", () => {
        const w = walked.find((x) => x.call.variant === "ComputeChannel" && x.call.value.variant === "settle") as (typeof walked)[number];
        const md = unifyMetadata(decAnyMetadata(s.settled.pin.metadata)) as Rec;
        expect(w.extensions.map(([n]) => n)).toEqual((md.extrinsic.extensionsByVersion[0] as Rec[]).map((e) => e.identifier));
        expect((w.address as Rec).variant).toBe(ref.address.type);
        expect((w.signature as Rec).variant).toBe(ref.signature.type);
      });

      it("HOLDS: the receipt over the walk's fields, payable the parent's escrow, verifies with the reference sr25519 and with the lab's verify; the escrow plus 1 does not, by either", () => {
        const w = walked.find((x) => x.call.variant === "ComputeChannel" && x.call.value.variant === "settle") as (typeof walked)[number];
        const a = w.call.value.value;
        const key = bytesOf(s.parent.record.agent_key);
        const escrow = BigInt(s.parent.record.escrow);
        const m = receiptMessage({ channelId: a.channel_id, finalRoot: a.final_root, aggregateGn: a.aggregate_gn, payable: escrow });
        expect(referenceVerify(key, m, a.agent_receipt_sig)).toBe(true);
        expect(verifyChannelSignature({ publicKey: key, message: m, signature: a.agent_receipt_sig })).toBe(true);
        const off = receiptMessage({ channelId: a.channel_id, finalRoot: a.final_root, aggregateGn: a.aggregate_gn, payable: escrow + 1n });
        expect(referenceVerify(key, off, a.agent_receipt_sig)).toBe(false);
        expect(verifyChannelSignature({ publicKey: key, message: off, signature: a.agent_receipt_sig })).toBe(false);
      });
    });
  }
});
