/**
 * HOLDS, for P6 to take over: the verified turns of the two real cooperative settles of the observatory's sixth
 * recording (piece R, rule B3). No module of src is written for it: the leaf and the fold are written here, and P6
 * replaces them with its own function, which must then pass this vector.
 *
 * The layout is FLOP's SDK 0.6.0, `dist/compute-channel/transcript.js`, read and not imported (source only):
 *  - the version 3 leaf: blake2b 256 of `channel_id ‖ turn_index u32 LE ‖ h_in ‖ h_out ‖ g_n u128 LE ‖
 *    decode_policy_hash ‖ h_ids ‖ toploc_commitment_hash ‖ miner_recv_ms u64 LE ‖ miner_done_ms u64 LE ‖
 *    latency_ms u64 LE` (`transcriptLeafV3`).
 * The turns are read through the reference decoder's verified_turns, not by offsets. Nothing here reads the network.
 *
 * This test does not exercise the fold through merkle_path: both paths are empty. P6 writes the fold and its tests.
 * These two settles do not hold the turn index's byte order or the upper half of `g_n`; P6 holds those by its own tests.
 */
import { describe, expect, it } from "vitest";
import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { verifyChannelSignature } from "../src/channel/key.js";
import { leafV3 as minerLeafV3 } from "../src/miner/leaf.js";
import { SETTLE_CHANNELS, refBytes, refDecodeOf, settleByShape, settleOf } from "./lib/settle-recording.js";

type Rec = Record<string, any>;

/** The version 3 leaf of a turn, through P6's own function (src/miner/leaf.ts). */
function leafV3(channelId: Uint8Array, t: Rec): Uint8Array {
  return minerLeafV3({
    channelId,
    turnIndex: t.turn_index,
    hIn: refBytes(t.h_in),
    hOut: refBytes(t.h_out),
    gN: t.g_n,
    decodePolicyHash: refBytes(t.decode_policy_hash),
    hIds: refBytes(t.h_ids),
    toplocCommitmentHash: refBytes(t.toploc_commitment_hash),
    minerRecvMs: t.miner_recv_ms,
    minerDoneMs: t.miner_done_ms,
    latencyMs: t.latency_ms,
  });
}

const SETTLES = SETTLE_CHANNELS.map((c) => {
  const s = settleOf(c);
  const d = refDecodeOf(s.settled.pin.metadata)(bytesOf(settleByShape(s).extrinsic));
  return { s, args: d.call.value.value as Rec };
});

describe("HOLDS, for P6 to replace with its own leaf function: the verified turns of the two real settles", () => {
  it("the gateway's settle and the other channel's are both read", () => {
    expect(SETTLES.map((x) => x.s.channel)).toEqual(["gateway", "second"]);
  });

  for (const { s, args } of SETTLES) {
    describe(`the ${s.channel} channel's settle at block ${s.settled.height}`, () => {
      const turns = args.verified_turns as Rec[];
      const channelId = refBytes(args.channel_id);

      it("carries one turn and no transcript reference; the turn is version 3, turn 0", () => {
        expect(args.transcript_ref).toBeUndefined();
        expect(turns).toHaveLength(1);
        expect(turns.map((t) => [t.leaf_version.type, t.turn_index])).toEqual([["V3", 0]]);
      });

      it("each turn's merkle_path, read through the reference decoder, is empty, so its version 3 leaf itself equals the call's final_root", () => {
        expect(turns.map((t) => t.merkle_path)).toEqual([[]]);
        for (const t of turns) expect(hexOf(leafV3(channelId, t))).toBe(hexOf(refBytes(args.final_root)));
      });

      it("each turn's enclave_sig over its leaf verifies under the record's enclave_key, and not under the agent_key nor over the leaf with one bit flipped", () => {
        const enclave = bytesOf(s.parent.record.enclave_key);
        for (const t of turns) {
          const leaf = leafV3(channelId, t);
          const sig = refBytes(t.enclave_sig);
          expect(verifyChannelSignature({ publicKey: enclave, message: leaf, signature: sig })).toBe(true);
          expect(verifyChannelSignature({ publicKey: bytesOf(s.parent.record.agent_key), message: leaf, signature: sig })).toBe(false);
          const flipped = Uint8Array.from(leaf);
          flipped[0] = (flipped[0] as number) ^ 1;
          expect(verifyChannelSignature({ publicKey: enclave, message: flipped, signature: sig })).toBe(false);
        }
      });
    });
  }
});
