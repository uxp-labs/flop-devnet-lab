/**
 * The version 3 transcript leaf (W9), the 32 bytes the enclave signs for one turn. With one turn per run (M-4) the
 * running root is this leaf: no fold is written.
 *
 * Layout: FLOP's SDK 0.6.0, `dist/compute-channel/transcript.js`, `transcriptLeafV3`, read and not imported:
 * `blake2b-256( channel_id[32] ‖ turn_index u32 LE ‖ h_in[32] ‖ h_out[32] ‖ g_n u128 LE ‖ decode_policy_hash[32] ‖
 * h_ids[32] ‖ toploc_commitment_hash[32] ‖ miner_recv_ms u64 LE ‖ miner_done_ms u64 LE ‖ latency_ms u64 LE )`.
 *
 * Shown by a committed file: the observatory's sixth recording holds two real cooperative settles at spec 1014014,
 * each with one version 3 turn whose leaf by this layout equals the call's final root and whose enclave signature
 * verifies over it under the record's enclave key (test/channel-verified-turn-vector.test.ts,
 * test/miner-real-turns.test.ts). Not shown: the byte order of the turn index and the upper bytes of g_n (zero in
 * both), any fold past one leaf, anything at spec 1014020.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { concat, uintLE } from "../channel/bytes.js";
import { freezeFunction } from "../freeze.js";
import { bigIn, bytesIn, fieldsOf, wholeIn } from "./check.js";
import { U32_MAX } from "./forms.js";

export interface LeafV3Input {
  readonly channelId: Uint8Array;
  /** u32. */
  readonly turnIndex: number;
  readonly hIn: Uint8Array;
  readonly hOut: Uint8Array;
  /** u128. */
  readonly gN: bigint;
  readonly decodePolicyHash: Uint8Array;
  readonly hIds: Uint8Array;
  /** 32 bytes. A receipt that states none takes 32 zero bytes here, as the SDK's leaf does (M-18); that is verifyTurn's choice, not this function's. */
  readonly toplocCommitmentHash: Uint8Array;
  /** u64, milliseconds of the miner's clock. */
  readonly minerRecvMs: bigint;
  readonly minerDoneMs: bigint;
  readonly latencyMs: bigint;
}

export const LEAF_V3_FIELDS = Object.freeze(["channelId", "turnIndex", "hIn", "hOut", "gN", "decodePolicyHash", "hIds", "toplocCommitmentHash", "minerRecvMs", "minerDoneMs", "latencyMs"] as const);

/** The version 3 leaf from its named fields, each of its exact width. */
export function leafV3(input: LeafV3Input): Uint8Array {
  const f = fieldsOf(input, LEAF_V3_FIELDS, "leaf");
  const parts = [
    bytesIn(f.channelId, 32, "leaf.channelId"),
    uintLE(BigInt(wholeIn(f.turnIndex, 0, U32_MAX, "leaf.turnIndex")), 4),
    bytesIn(f.hIn, 32, "leaf.hIn"),
    bytesIn(f.hOut, 32, "leaf.hOut"),
    uintLE(bigIn("u128", f.gN, "leaf.gN"), 16),
    bytesIn(f.decodePolicyHash, 32, "leaf.decodePolicyHash"),
    bytesIn(f.hIds, 32, "leaf.hIds"),
    bytesIn(f.toplocCommitmentHash, 32, "leaf.toplocCommitmentHash"),
    uintLE(bigIn("u64", f.minerRecvMs, "leaf.minerRecvMs"), 8),
    uintLE(bigIn("u64", f.minerDoneMs, "leaf.minerDoneMs"), 8),
    uintLE(bigIn("u64", f.latencyMs, "leaf.latencyMs"), 8),
  ];
  return blake2b(concat(...parts), { dkLen: 32 });
}
freezeFunction(leafV3);
