/**
 * P6a, T1 and T2: the two real turns of the observatory's sixth recording (test/lib/settle-recording.ts), the only
 * real vectors of this piece. Through src/miner/leaf.ts:
 *  - the version 3 leaf of each turn equals the settle call's final_root (each merkle_path is empty);
 *  - the enclave signature verifies over that leaf under the record's enclave_key, and not over a leaf with the turn
 *    index, g_n or a time changed;
 *  - the timing rule of verifyTurn (done at or after recv, latency equal to done minus recv) holds on both, as
 *    measured before the rule was written (M-14). It holds: 1905558 - 1904971 = 587 and 1886800931 - 1886797067 = 3864,
 *    as the recording gives them (the numbers are read from it here, never typed).
 * Not shown by these: the byte order of the turn index, the upper bytes of g_n, any wire body, h_in's and h_out's
 * preimages.
 */
import { describe, expect, it } from "vitest";
import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { verifyChannelSignature } from "../src/channel/key.js";
import { leafV3 } from "../src/miner/leaf.js";
import { SETTLE_CHANNELS, refBytes, refDecodeOf, settleByShape, settleOf } from "./lib/settle-recording.js";
import { refLeafV3 } from "./lib/miner-answers.js";

type Rec = Record<string, any>;

const TURNS = SETTLE_CHANNELS.map((c) => {
  const s = settleOf(c);
  const d = refDecodeOf(s.settled.pin.metadata)(bytesOf(settleByShape(s).extrinsic));
  const args = d.call.value.value as Rec;
  return { s, args, turn: (args.verified_turns as Rec[])[0] as Rec };
});

const fieldsOf = (channelId: Uint8Array, t: Rec) => ({
  channelId,
  turnIndex: t.turn_index as number,
  hIn: refBytes(t.h_in),
  hOut: refBytes(t.h_out),
  gN: t.g_n as bigint,
  decodePolicyHash: refBytes(t.decode_policy_hash),
  hIds: refBytes(t.h_ids),
  toplocCommitmentHash: refBytes(t.toploc_commitment_hash),
  minerRecvMs: t.miner_recv_ms as bigint,
  minerDoneMs: t.miner_done_ms as bigint,
  latencyMs: t.latency_ms as bigint,
});

describe("T1: the version 3 leaf of src/miner on the two real turns", () => {
  it("reads both settles, each with one V3 turn 0 and an empty path", () => {
    expect(TURNS.map((x) => x.s.channel)).toEqual(["gateway", "second"]);
    for (const { args, turn } of TURNS) {
      expect((args.verified_turns as Rec[]).length).toBe(1);
      expect([turn.leaf_version.type, turn.turn_index, turn.merkle_path]).toEqual(["V3", 0, []]);
    }
  });

  for (const { s, args, turn } of TURNS) {
    describe(`the ${s.channel} channel`, () => {
      const channelId = refBytes(args.channel_id);
      const f = fieldsOf(channelId, turn);

      it("the leaf equals the call's final_root, and the second writing agrees", () => {
        expect(hexOf(leafV3(f))).toBe(hexOf(refBytes(args.final_root)));
        expect(hexOf(refLeafV3(f))).toBe(hexOf(leafV3(f)));
      });

      it("the enclave signature verifies over the leaf under the record's enclave key", () => {
        const key = bytesOf(s.parent.record.enclave_key);
        const sig = refBytes(turn.enclave_sig);
        expect(verifyChannelSignature({ publicKey: key, message: leafV3(f), signature: sig })).toBe(true);
        for (const changed of [{ ...f, turnIndex: 1 }, { ...f, gN: f.gN + 1n }, { ...f, gN: f.gN + (1n << 64n) }, { ...f, latencyMs: f.latencyMs + 1n }, { ...f, minerRecvMs: f.minerRecvMs + 1n }]) {
          expect(verifyChannelSignature({ publicKey: key, message: leafV3(changed), signature: sig })).toBe(false);
        }
      });
    });
  }
});

describe("T2: the timing rule, measured on the two real turns", () => {
  for (const { s, turn } of TURNS) {
    it(`the ${s.channel} turn: done is at or after recv, and latency is done minus recv`, () => {
      const recv = turn.miner_recv_ms as bigint;
      const done = turn.miner_done_ms as bigint;
      expect(done >= recv).toBe(true);
      expect(turn.latency_ms).toBe(done - recv);
    });
  }
});
