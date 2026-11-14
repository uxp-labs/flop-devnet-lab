/**
 * HOLDS, for P6 to take over: the verified turns of the two real cooperative settles of the observatory's sixth
 * recording (piece R, rule B3). No module of src is written for it: the leaf and the fold are written here, and P6
 * replaces them with its own function, which must then pass this vector.
 *
 * The layout is FLOP's SDK 0.6.0, `dist/compute-channel/transcript.js`, read and not imported (source only):
 *  - the version 3 leaf: blake2b 256 of `channel_id ‖ turn_index u32 LE ‖ h_in ‖ h_out ‖ g_n u128 LE ‖
 *    decode_policy_hash ‖ h_ids ‖ toploc_commitment_hash ‖ miner_recv_ms u64 LE ‖ miner_done_ms u64 LE ‖
 *    latency_ms u64 LE` (`transcriptLeafV3`);
 *  - the fold to the root through a turn's merkle_path: for each `(sibling, sibling_is_left)`, the node becomes
 *    blake2b 256 of `sibling ‖ node` when the sibling is on the left, else of `node ‖ sibling` (`merkleRootFromPath`).
 * The turns are read through the reference decoder's verified_turns, not by offsets. Nothing here reads the network.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { describe, expect, it } from "vitest";
import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { verifyChannelSignature } from "../src/channel/key.js";
import { SETTLE_CHANNELS, refBytes, refDecodeOf, settleByShape, settleOf } from "./lib/settle-recording.js";

type Rec = Record<string, any>;
const le = (n: bigint, w: number) => Uint8Array.from({ length: w }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const blake = (b: Uint8Array) => blake2b(b, { dkLen: 32 });

/** The version 3 leaf of a turn, as the SDK describes it. P6 replaces this with its own function. */
function leafV3(channelId: Uint8Array, t: Rec): Uint8Array {
  return blake(
    concat(
      channelId,
      le(BigInt(t.turn_index), 4),
      refBytes(t.h_in),
      refBytes(t.h_out),
      le(t.g_n, 16),
      refBytes(t.decode_policy_hash),
      refBytes(t.h_ids),
      refBytes(t.toploc_commitment_hash),
      le(t.miner_recv_ms, 8),
      le(t.miner_done_ms, 8),
      le(t.latency_ms, 8),
    ),
  );
}
/** A leaf folded through its merkle_path, as the SDK describes it. */
const fold = (leaf: Uint8Array, path: [unknown, boolean][]) => path.reduce((node, [sibling, left]) => blake(left ? concat(refBytes(sibling), node) : concat(node, refBytes(sibling))), leaf);

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

      it("each turn's version 3 leaf, folded through its merkle_path, gives the call's final_root; with one turn and no path the leaf is the root", () => {
        for (const t of turns) expect(hexOf(fold(leafV3(channelId, t), t.merkle_path))).toBe(hexOf(refBytes(args.final_root)));
        expect(turns.map((t) => t.merkle_path)).toEqual([[]]);
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
