/**
 * Review of piece R, second branch (reviewer, not the builder): attack 8, on
 * test/channel-verified-turn-vector.test.ts (P8). The leaf layout written there was compared with FLOP's SDK 0.6.0
 * `dist/compute-channel/transcript.js` (`transcriptLeafV3`, `merkleRootFromPath`), read and not imported: it is the
 * same. Then the test's own leaf lines were changed one rule at a time in a copy: the turn index's byte order, the
 * upper half of g_n and both rules of the fold changed nothing the test sees. These tests hold that gap. Values come
 * from the fixture through test/lib/settle-recording.ts. Nothing here reads the network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2.js";
import { describe, expect, it } from "vitest";
import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { SETTLE_CHANNELS, refBytes, refDecodeOf, settleByShape, settleOf } from "./lib/settle-recording.js";

type Rec = Record<string, any>;
const le = (n: bigint, w: number) => Uint8Array.from({ length: w }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const blake = (b: Uint8Array) => blake2b(b, { dkLen: 32 });

/** The version 3 leaf with the turn index written big endian and the high half of g_n in the other byte order. */
function leafOdd(channelId: Uint8Array, t: Rec): Uint8Array {
  return blake(
    concat(
      channelId,
      le(BigInt(t.turn_index), 4).reverse(),
      refBytes(t.h_in),
      refBytes(t.h_out),
      le(BigInt.asUintN(64, t.g_n), 8),
      le(BigInt(t.g_n) >> 64n, 8).reverse(),
      refBytes(t.decode_policy_hash),
      refBytes(t.h_ids),
      refBytes(t.toploc_commitment_hash),
      le(t.miner_recv_ms, 8),
      le(t.miner_done_ms, 8),
      le(t.latency_ms, 8),
    ),
  );
}

const SETTLES = SETTLE_CHANNELS.map((c) => {
  const s = settleOf(c);
  const d = refDecodeOf(s.settled.pin.metadata)(bytesOf(settleByShape(s).extrinsic));
  return { s, args: d.call.value.value as Rec };
});

describe("attack 8: what the verified turn vector does not pin", () => {
  it("HOLDS (was DEFECT RR2-3): a leaf with the turn index big endian and the upper half of g_n in the other byte order still equals final_root for both settles, because both turn indices are 0 and both g_n are below 2^64", () => {
    for (const { s, args } of SETTLES) {
      for (const t of args.verified_turns as Rec[]) {
        expect(hexOf(leafOdd(refBytes(args.channel_id), t)), s.channel).toBe(hexOf(refBytes(args.final_root)));
      }
    }
  });

  it("HOLDS (was DEFECT RR2-4): the turn test says in words that its fold through merkle_path is not exercised (both paths are empty), so P6 does not take the fold as shown", () => {
    for (const { args } of SETTLES) expect((args.verified_turns as Rec[]).every((t) => (t.merkle_path as unknown[]).length === 0)).toBe(true);
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "channel-verified-turn-vector.test.ts"), "utf8");
    expect(text).toMatch(/fold[^.]*not (?:exercised|shown|held)|not (?:exercised|shown|held)[^.]*fold|does not exercise[^.]*(?:fold|path)/i);
  });
});
