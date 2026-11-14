/**
 * The receipt held to two real cooperative settles (piece R, rules B1 and S41). The observatory's sixth recording
 * holds the two blocks where a compute channel settled at spec 1014014, with the channel's record at the block and at
 * its parent (test/lib/settle-recording.ts). For each settle:
 *  - the settle call's arguments are read two ways that must agree: the reference decoder over the recorded metadata
 *    of the block's runtime, and the call found by its indices from the shape file, its fixed width fields in the
 *    shape's order;
 *  - the record at the parent and at the block, and the block's Settled event, are read through the lab's door;
 *  - THE RULE UNDER TEST: receiptMessage with payable the escrow stored before the settle, and the call's
 *    agent_receipt_sig, verify under the record's agent_key; every other payable and form does not.
 * Only committed files are read. Nothing here reads the network.
 */
import { describe, expect, it } from "vitest";
import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { verifyChannelSignature } from "../src/channel/key.js";
import { RECEIPT_DOMAIN, RECEIPT_VERSION, receiptMessage } from "../src/channel/transcript.js";
import { SETTLE_CHANNELS, type Settle, channelEvents, refBytes, refDecodeOf, settleByShape, settleCallOf, settleOf, widthOf } from "./lib/settle-recording.js";

type Rec = Record<string, any>;
const le = (n: bigint, w: number) => Uint8Array.from({ length: w }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const fromLe = (b: Uint8Array) => b.reduceRight((a, x) => (a << 8n) | BigInt(x), 0n);
const flip = (b: Uint8Array, bit: number) => {
  const c = Uint8Array.from(b);
  c[bit >> 3] = (c[bit >> 3] as number) ^ (1 << (bit & 7));
  return c;
};

/** A settle's arguments, read both ways, and what the record and the event say. */
function readSettle(s: Settle) {
  const byShape = settleByShape(s);
  const d = refDecodeOf(s.settled.pin.metadata)(bytesOf(byShape.extrinsic));
  const args = d.call.value.value as Rec;
  return { byShape, d, args };
}
const SETTLES = SETTLE_CHANNELS.map((c) => {
  const s = settleOf(c);
  return { s, ...readSettle(s) };
});
/** The call's fields as the receipt takes them, from the reference decoder. */
const receiptOf = (x: (typeof SETTLES)[number]) => ({ channelId: refBytes(x.args.channel_id), finalRoot: refBytes(x.args.final_root), aggregateGn: x.args.aggregate_gn as bigint });
const sigOf = (x: (typeof SETTLES)[number]) => refBytes(x.args.agent_receipt_sig);
const agentKeyOf = (x: (typeof SETTLES)[number]) => bytesOf(x.s.parent.record.agent_key);
const escrowBefore = (x: (typeof SETTLES)[number]) => BigInt(x.s.parent.record.escrow);
const verifies = (x: (typeof SETTLES)[number], message: Uint8Array, signature = sigOf(x)) => verifyChannelSignature({ publicKey: agentKeyOf(x), message, signature });

describe("the recording holds two settles, on two channels", () => {
  it("the inputs name the gateway's channel and the other one, and each settle is on its own channel", () => {
    expect(SETTLE_CHANNELS).toEqual(["gateway", "second"]);
    expect(new Set(SETTLES.map((x) => x.s.channelId)).size).toBe(2);
  });
});

for (const x of SETTLES) {
  const { s, byShape, d, args } = x;
  const other = SETTLES.find((y) => y !== x) as (typeof SETTLES)[number];
  describe(`the ${s.channel} channel's settle at block ${s.settled.height}`, () => {
    describe("the settle's arguments, read two ways (R-6)", () => {
      it("the reference decoder reads the extrinsic whole, a signed extrinsic of ComputeChannel.settle, and writes it back byte for byte", () => {
        expect(d.length).toBe(d.bodyLength);
        expect(d.format).toEqual({ version: 4, type: "signed" });
        expect(hexOf(d.reencoded)).toBe(hexOf(d.body.slice(1)));
        expect([d.call.type, d.call.value.type]).toEqual(["ComputeChannel", "settle"]);
      });

      it("the decoded field names are the shape's field order of settle", () => {
        const { fields } = settleCallOf(s.shape);
        expect(Object.keys(args)).toEqual(fields.map((f) => f.name));
      });

      it("the call found by the shape's indices and the channel id holds the five fixed width fields in the shape's order, each width from its type, and they equal the reference's", () => {
        expect([...byShape.fields.keys()]).toEqual(["channel_id", "final_root", "aggregate_gn", "claimed_measured_root", "agent_receipt_sig"]);
        expect(byShape.next).toBe("transcript_ref");
        const types = new Map(settleCallOf(s.shape).fields.map((f) => [f.name, f.type]));
        for (const [name, bytes] of byShape.fields) expect(bytes.length, name).toBe(widthOf(s.shape, types.get(name) as string));
        expect(hexOf(byShape.fields.get("channel_id") as Uint8Array)).toBe(s.channelId);
        expect(hexOf(byShape.fields.get("channel_id") as Uint8Array)).toBe(hexOf(refBytes(args.channel_id)));
        expect(hexOf(byShape.fields.get("final_root") as Uint8Array)).toBe(hexOf(refBytes(args.final_root)));
        expect(fromLe(byShape.fields.get("aggregate_gn") as Uint8Array)).toBe(args.aggregate_gn);
        expect(hexOf(byShape.fields.get("claimed_measured_root") as Uint8Array)).toBe(hexOf(refBytes(args.claimed_measured_root)));
        expect(hexOf(byShape.fields.get("agent_receipt_sig") as Uint8Array)).toBe(hexOf(refBytes(args.agent_receipt_sig)));
      });
    });

    describe("the channel's record and the block's event, through the lab's door", () => {
      it("the record at the parent and at the block are stored, of this channel's key; the agent key and the enclave key are the same in both", () => {
        expect([s.parent.recordStored, s.settled.recordStored]).toEqual([true, true]);
        expect(s.settled.record.agent_key).toBe(s.parent.record.agent_key);
        expect(s.settled.record.enclave_key).toBe(s.parent.record.enclave_key);
        expect(bytesOf(s.parent.record.agent_key)).toHaveLength(32);
      });

      it("the record at the block differs from the parent's in its state alone, Open before the settle and Closed after", () => {
        const differ = Object.keys(s.parent.record).filter((k) => JSON.stringify(s.parent.record[k]) !== JSON.stringify(s.settled.record[k]));
        expect(differ).toEqual(["state"]);
        expect([s.parent.record.state.variant, s.settled.record.state.variant]).toEqual(["Open", "Closed"]);
      });

      it("the call's claimed_measured_root is the record's measured_root", () => {
        expect(hexOf(refBytes(args.claimed_measured_root))).toBe(s.parent.record.measured_root);
        expect(hexOf(refBytes(args.claimed_measured_root))).toBe(s.settled.record.measured_root);
      });

      it("the block's one Settled event names the same channel and the same aggregate_gn as the call, and says cooperative", () => {
        const settled = channelEvents(s, "Settled");
        expect(settled).toHaveLength(1);
        const f = settled[0]?.fields as Rec;
        expect(f.channel_id).toBe(hexOf(refBytes(args.channel_id)));
        expect(BigInt(f.aggregate_gn)).toBe(args.aggregate_gn);
        expect(f.cooperative).toBe(true);
      });
    });

    describe("S41: the payable of a cooperative settle is the escrow stored before it", () => {
      it("receiptMessage with payable the parent's escrow is 125 bytes and verifies under the record's agent_key with the call's agent_receipt_sig", () => {
        const m = receiptMessage({ ...receiptOf(x), payable: escrowBefore(x) });
        expect(m).toHaveLength(125);
        expect(verifies(x, m)).toBe(true);
      });

      it("does not verify with payable 0, aggregate_gn, the escrow plus 1 or less 1, or the Settled event's miner_paid", () => {
        const minerPaid = BigInt((channelEvents(s, "Settled")[0]?.fields as Rec).miner_paid);
        expect(minerPaid).not.toBe(escrowBefore(x));
        for (const payable of [0n, receiptOf(x).aggregateGn, escrowBefore(x) + 1n, escrowBefore(x) - 1n, minerPaid]) {
          expect(verifies(x, receiptMessage({ ...receiptOf(x), payable })), String(payable)).toBe(false);
        }
      });

      it("does not verify for the same fields in the older form, without the domain and the version byte", () => {
        const r = receiptOf(x);
        const legacy = Uint8Array.from([...r.channelId, ...r.finalRoot, ...le(r.aggregateGn, 16), ...le(escrowBefore(x), 16)]);
        const m = receiptMessage({ ...r, payable: escrowBefore(x) });
        expect(Buffer.from(m.slice(0, RECEIPT_DOMAIN.length)).toString("ascii")).toBe(RECEIPT_DOMAIN);
        expect(m[RECEIPT_DOMAIN.length]).toBe(RECEIPT_VERSION);
        expect(hexOf(m.slice(RECEIPT_DOMAIN.length + 1))).toBe(hexOf(legacy));
        expect(verifies(x, legacy)).toBe(false);
      });

      it("does not verify for the right message with one bit flipped, the right signature with one bit flipped, or the other settle's signature", () => {
        const m = receiptMessage({ ...receiptOf(x), payable: escrowBefore(x) });
        for (const bit of [0, 8 * RECEIPT_DOMAIN.length, 8 * m.length - 1]) expect(verifies(x, flip(m, bit)), `message bit ${bit}`).toBe(false);
        for (const bit of [0, 8 * 32, 8 * 64 - 2]) expect(verifies(x, m, flip(sigOf(x), bit)), `signature bit ${bit}`).toBe(false);
        expect(hexOf(sigOf(other))).not.toBe(hexOf(sigOf(x)));
        expect(verifies(x, m, sigOf(other))).toBe(false);
      });
    });
  });
}
