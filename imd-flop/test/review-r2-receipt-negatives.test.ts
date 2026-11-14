/**
 * Review of piece R, second branch (reviewer, not the builder): attacks 3 and 4 on
 * test/channel-receipt-vector.test.ts.
 *  - Attack 4: each negative of the vector differs from the positive in the one thing its title names, and is false
 *    because the signature does not match, not because a library threw on the bytes.
 *  - Attack 3: a receipt whose u128 fields are written wrongly above their low 64 bits is not told apart by the two
 *    real settles: every number they carry is below 2^64, so the upper half of each u128 is zero either way.
 * Values come from the fixture through test/lib/settle-recording.ts. Nothing here reads the network.
 */
import { verify as scureVerify } from "@scure/sr25519";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyChannelSignature } from "../src/channel/key.js";
import { RECEIPT_DOMAIN, RECEIPT_VERSION, receiptMessage } from "../src/channel/transcript.js";
import { bytesOf } from "../src/chain-read/bytes.js";
import { SETTLE_CHANNELS, channelEvents, refBytes, refDecodeOf, settleByShape, settleOf } from "./lib/settle-recording.js";
import { referenceReady, referenceVerify } from "./lib/sr25519-reference.js";

type Rec = Record<string, any>;
const le = (n: bigint, w: number) => Uint8Array.from({ length: w }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const flip = (b: Uint8Array, bit: number) => {
  const c = Uint8Array.from(b);
  c[bit >> 3] = (c[bit >> 3] as number) ^ (1 << (bit & 7));
  return c;
};
const diffBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return null;
  return Array.from(a.keys()).filter((i) => a[i] !== b[i]);
};
/** What scure's verify does with the bytes: true, false, or it throws. */
const scureOutcome = (key: Uint8Array, m: Uint8Array, sig: Uint8Array): string => {
  try {
    return String(scureVerify(m, sig, key));
  } catch {
    return "throws";
  }
};

const SETTLES = SETTLE_CHANNELS.map((c) => {
  const s = settleOf(c);
  const args = refDecodeOf(s.settled.pin.metadata)(bytesOf(settleByShape(s).extrinsic)).call.value.value as Rec;
  const r = { channelId: refBytes(args.channel_id), finalRoot: refBytes(args.final_root), aggregateGn: args.aggregate_gn as bigint };
  const escrow = BigInt(s.parent.record.escrow);
  return { s, r, escrow, sig: refBytes(args.agent_receipt_sig), key: bytesOf(s.parent.record.agent_key), m: receiptMessage({ ...r, payable: escrow }) };
});

beforeAll(referenceReady);

/** The byte offsets of the receipt's two u128 fields. */
const GN_AT = RECEIPT_DOMAIN.length + 1 + 32 + 32;
const PAYABLE_AT = GN_AT + 16;

describe("attack 4: each negative of the vector differs from the positive in the one thing named", () => {
  for (const x of SETTLES) {
    const other = SETTLES.find((y) => y !== x) as (typeof SETTLES)[number];
    describe(`the ${x.s.channel} channel's settle`, () => {
      it("HOLDS: each wrong payable changes only the payable's 16 bytes of the message, and is refused by both verifies, scure returning false and not throwing", () => {
        const minerPaid = BigInt((channelEvents(x.s, "Settled")[0]?.fields as Rec).miner_paid);
        for (const payable of [0n, x.r.aggregateGn, x.escrow + 1n, x.escrow - 1n, minerPaid]) {
          const m = receiptMessage({ ...x.r, payable });
          const d = diffBytes(m, x.m) as number[];
          expect(d.length, String(payable)).toBeGreaterThan(0);
          expect(d.every((i) => i >= PAYABLE_AT && i < PAYABLE_AT + 16), String(payable)).toBe(true);
          expect(scureOutcome(x.key, m, x.sig), String(payable)).toBe("false");
          expect(referenceVerify(x.key, m, x.sig), String(payable)).toBe(false);
        }
      });

      it("HOLDS: the older form is the positive without its first 29 bytes, and scure returns false on it without throwing", () => {
        const legacy = Uint8Array.from([...x.r.channelId, ...x.r.finalRoot, ...le(x.r.aggregateGn, 16), ...le(x.escrow, 16)]);
        expect(Buffer.from(x.m.slice(RECEIPT_DOMAIN.length + 1)).equals(Buffer.from(legacy))).toBe(true);
        expect(x.m[RECEIPT_DOMAIN.length]).toBe(RECEIPT_VERSION);
        expect(scureOutcome(x.key, legacy, x.sig)).toBe("false");
        expect(referenceVerify(x.key, legacy, x.sig)).toBe(false);
      });

      it("HOLDS: the other settle's signature is a valid signature by its own key over its own receipt, so refusing it here is a mismatch and not a malformed signature", () => {
        expect(referenceVerify(other.key, other.m, other.sig)).toBe(true);
        expect(scureOutcome(x.key, x.m, other.sig)).toBe("false");
        expect(referenceVerify(x.key, x.m, other.sig)).toBe(false);
      });

      it("HOLDS: how each flipped signature bit of the vector is refused: bit 256 (the low bit of s) is a mismatch; the reference refuses all three", () => {
        const outcomes = [0, 8 * 32, 8 * 64 - 2].map((bit) => [bit, scureOutcome(x.key, x.m, flip(x.sig, bit)), referenceVerify(x.key, x.m, flip(x.sig, bit))]);
        expect(outcomes.find(([b]) => b === 256)?.[1]).toBe("false");
        for (const o of outcomes) expect(o[2], String(o[0])).toBe(false);
      });
    });
  }
});

describe("attack 3: the vector against the layout of the upper half of each u128", () => {
  it("HOLDS (was DEFECT RR2-1): every u128 in the two real settles is below 2^64, so a receipt whose u128 fields keep only their low 64 bits, or write the upper half in another byte order, still verifies; the data does not hold the upper half and the README says so", () => {
    for (const x of SETTLES) {
      // A receipt layout that differs from receiptMessage only above bit 64 of each u128: low 64 bits LE, then the
      // high 64 bits in the other byte order.
      const u128Odd = (n: bigint) => [...le(BigInt.asUintN(64, n), 8), ...le(n >> 64n, 8).reverse()];
      const wrongHigh = Uint8Array.from([...x.m.slice(0, GN_AT), ...u128Odd(x.r.aggregateGn), ...u128Odd(x.escrow)]);
      expect(wrongHigh).toHaveLength(x.m.length);
      expect(verifyChannelSignature({ publicKey: x.key, message: wrongHigh, signature: x.sig }), x.s.channel).toBe(true);
    }
    // The measured cause: every u128 the two settles carry is below 2^64.
    expect(SETTLES.flatMap((x) => [x.r.aggregateGn, x.escrow]).every((n) => n < 1n << 64n)).toBe(true);
  });
});
