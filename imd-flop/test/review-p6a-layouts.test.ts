/**
 * Review of P6a, attacks 1 and 2 (Q1, Q2). The reviewer's third writing (test/lib/review-p6a-third.ts, written from
 * FLOP's SDK source before src/miner's layout files were read) against src/miner, byte for byte, on a wide grid; and
 * the third writing's leaf on the two real turns of the observatory's sixth recording.
 * Every count of inputs compared is asserted, so the report's counts are the test's own.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { minerExpected } from "../src/miner/expected.js";
import { modelIdentityHash, sessionInfoMessage, turnEvidenceHash } from "../src/miner/identity.js";
import { turnInput } from "../src/miner/input.js";
import { leafV3 } from "../src/miner/leaf.js";
import { referenceReady, referenceVerify } from "./lib/sr25519-reference.js";
import { SETTLE_CHANNELS, refBytes, refDecodeOf, settleByShape, settleOf } from "./lib/settle-recording.js";
import { thirdChatInput, thirdHIn, thirdLeafV3, thirdModelIdentityHash, thirdSessionInfoMessage, thirdTurnEvidenceHash, type ThirdIdentity } from "./lib/review-p6a-third.js";

beforeAll(referenceReady);

const MAX64 = (1n << 64n) - 1n;
const MAX128 = (1n << 128n) - 1n;
const filled = (n: number, b: number): Uint8Array => new Uint8Array(n).fill(b);
const counting = (n: number, start: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (start + i * 37) & 0xff);

/** Bounded texts src/miner accepts (1 to 256 bytes, no Cc, well formed): smallest, largest of each width, the hard ones. */
const TEXTS: string[] = [
  "a",
  "x".repeat(256),
  "é".repeat(128),
  "日".repeat(85) + "a",
  "\u{1F600}".repeat(64),
  'he said "hi"',
  "back\\slash\\",
  " ",
  "  para",
  "﻿bom first",
  "mid﻿bom",
  "\u{10FFFF}",
  " nbsp ​ zwsp ‎ lrm",
  "</script>&'<>",
  "😀 pair by escapes",
  "Ω≈ç√∫",
];

/** Contents of a chat message: everything TEXTS has, plus empty, control escapes, DEL, C1 and long text. */
const CONTENTS: string[] = [
  ...TEXTS,
  "",
  "\n\r\t\b\f",
  "\u0000\u0001\u001f",
  "\u007f\u0080\u009f",
  "tab\there\nnew \"q\" \\ \u0007bell",
  "z".repeat(5000),
  "  ".repeat(10),
];

function identityGrid(): ThirdIdentity[] {
  const out: ThirdIdentity[] = [];
  for (const t of TEXTS) {
    out.push({ requestedSlug: t, registryModel: t, registryVersion: t, modelHash: filled(32, 0), precision: 0, decodePolicyHash: filled(32, 1), measuredRoot: filled(32, 0), backendModelName: t });
    out.push({ requestedSlug: "slug", registryModel: t, registryVersion: "1", modelHash: filled(32, 0xff), precision: 255, decodePolicyHash: filled(32, 0xff), measuredRoot: filled(32, 0xff), backendModelName: "b" });
    out.push({ requestedSlug: "s", registryModel: "m", registryVersion: t, modelHash: counting(32, 1), precision: 7, decodePolicyHash: counting(32, 2), measuredRoot: counting(32, 3), backendModelName: t });
  }
  return out;
}

const plainIdentity = (i: ThirdIdentity) => ({ ...i, modelHash: Uint8Array.from(i.modelHash), decodePolicyHash: Uint8Array.from(i.decodePolicyHash), measuredRoot: Uint8Array.from(i.measuredRoot) });

describe("Q1 by a third writing: the model identity hash", () => {
  it("HOLDS: src/miner's model identity hash equals the reviewer's reading of miner-admission.js modelIdentityHash on 48 identities", () => {
    const grid = identityGrid();
    let n = 0;
    for (const i of grid) {
      expect(hexOf(modelIdentityHash(plainIdentity(i)))).toBe(hexOf(thirdModelIdentityHash(i)));
      n++;
    }
    expect(n).toBe(48);
  });
});

describe("Q1 by a third writing: the info proof's signed message", () => {
  it("HOLDS: src/miner's session info message equals the reviewer's reading of miner-admission.js sessionInfoMessage on 1536 inputs", () => {
    const grid = identityGrid();
    let n = 0;
    for (const i of grid)
      for (const ready of [true, false])
        for (const t of TEXTS) {
          const m = { challenge: counting(32, 9), genesis: filled(32, 0), account: filled(32, 0xff), enclaveKey: counting(32, 5), identity: i, ready, version: t, revision: TEXTS[(n * 7) % TEXTS.length] as string };
          const mine = thirdSessionInfoMessage({ ...m, genesisHash: m.genesis });
          expect(hexOf(sessionInfoMessage({ ...m, identity: plainIdentity(i) }))).toBe(hexOf(mine));
          n++;
        }
    expect(n).toBe(1536);
  });
});

describe("Q1 by a third writing: the turn evidence hash", () => {
  it("HOLDS: src/miner's turn evidence hash equals the reviewer's reading of transcript.js turnEvidenceHash on 577 inputs", () => {
    const enc = new TextEncoder();
    const outputs = [new Uint8Array(0), Uint8Array.of(0), enc.encode("héllo   \"\\\" \u{1F600}"), counting(65537, 0), filled(2 * 1024 * 1024, 0x61)];
    const ids = identityGrid().slice(0, 12);
    let n = 0;
    for (const output of outputs.slice(0, 4))
      for (const [p, c] of [[0n, 0n], [MAX64, MAX64], [1n, MAX64], [MAX64, 0n]] as const)
        for (const finish of ["stop", "length", "x".repeat(256)])
          for (const i of ids.slice(0, 12)) {
            expect(hexOf(turnEvidenceHash({ output, promptTokens: p, completionTokens: c, finishReason: finish, identity: plainIdentity(i) }))).toBe(hexOf(thirdTurnEvidenceHash(output, p, c, finish, i)));
            n++;
          }
    const big = outputs[4] as Uint8Array;
    const i0 = ids[0] as ThirdIdentity;
    expect(hexOf(turnEvidenceHash({ output: big, promptTokens: 3n, completionTokens: 4n, finishReason: "stop", identity: plainIdentity(i0) }))).toBe(hexOf(thirdTurnEvidenceHash(big, 3n, 4n, "stop", i0)));
    n++;
    expect(n).toBe(4 * 4 * 3 * 12 + 1);
  });
});

describe("Q1 by a third writing: the canonical input of a chat turn and h_in", () => {
  const exp = (slug: string) =>
    minerExpected({
      genesis: filled(32, 1),
      account: filled(32, 2),
      enclaveKey: counting(32, 3),
      identity: { requestedSlug: slug, registryModel: "m", registryVersion: "1", modelHash: filled(32, 4), precision: 2, decodePolicyHash: filled(32, 5), measuredRoot: filled(32, 6), backendModelName: "b" },
    });

  it("HOLDS: src/miner's turn input bytes and h_in equal the reviewer's reading of protocol.js canonicalJson on 1502 inputs", () => {
    let n = 0;
    for (const slug of TEXTS) {
      const e = exp(slug);
      for (const content of CONTENTS)
        for (const role of ["system", "user"] as const)
          for (const maxTokens of [1, 131072]) {
            const t = turnInput({ expected: e, messages: [{ role, content }], maxTokens });
            const mine = thirdChatInput(slug, [{ role, content }], maxTokens);
            expect(hexOf(t.input)).toBe(hexOf(mine));
            expect(hexOf(t.hIn)).toBe(hexOf(thirdHIn(mine)));
            n++;
          }
    }
    // Many messages: 2 to 256, both roles mixed, every content.
    const e = exp("slug");
    for (const count of [2, 3, 17, 64, 255, 256]) {
      const msgs = Array.from({ length: count }, (_, k) => ({ role: (k % 3 === 0 ? "system" : "user") as "system" | "user", content: CONTENTS[k % CONTENTS.length] as string }));
      for (const maxTokens of [1, 2, 4096, 131071, 131072]) {
        const t = turnInput({ expected: e, messages: msgs, maxTokens });
        const mine = thirdChatInput("slug", msgs, maxTokens);
        expect(hexOf(t.input)).toBe(hexOf(mine));
        expect(hexOf(t.hIn)).toBe(hexOf(thirdHIn(mine)));
        n++;
      }
    }
    expect(n).toBe(TEXTS.length * CONTENTS.length * 2 * 2 + 30);
  });

  it("HOLDS: the reviewer's hand escaper equals JSON.stringify, the function the SDK's canonicalJson calls, on every content and on all 65536 single code units", async () => {
    const { thirdQuote } = await import("./lib/review-p6a-third.js");
    for (const s of CONTENTS) expect(thirdQuote(s)).toBe(JSON.stringify(s));
    for (let c = 0; c < 0x10000; c++) expect(thirdQuote(String.fromCharCode(c))).toBe(JSON.stringify(String.fromCharCode(c)));
  });
});

describe("Q1 by a third writing: the version 3 leaf", () => {
  it("HOLDS: src/miner's leaf equals the reviewer's reading of transcript.js transcriptLeafV3 on 420 inputs", () => {
    let n = 0;
    for (const turnIndex of [0, 1, 255, 256, 2 ** 32 - 1])
      for (const gN of [0n, 1n, 255n, 256n, MAX64, MAX64 + 1n, MAX128])
        for (const [recv, done, lat] of [[0n, 0n, 0n], [MAX64, MAX64, MAX64], [1n, 2n, 3n], [MAX64, 0n, 1n << 63n]] as const)
          for (const b of [0, 0xff, 0x5a]) {
            const f = { channelId: counting(32, b), turnIndex, hIn: counting(32, b + 1), hOut: counting(32, b + 2), gN, decodePolicyHash: filled(32, b), hIds: counting(32, b + 3), toplocCommitmentHash: b === 0 ? filled(32, 0) : counting(32, b + 4), minerRecvMs: recv, minerDoneMs: done, latencyMs: lat };
            expect(hexOf(leafV3(f))).toBe(hexOf(thirdLeafV3(f)));
            n++;
          }
    expect(n).toBe(5 * 7 * 4 * 3);
  });
});

describe("Q2 by the third writing: the two real turns", () => {
  type Rec = Record<string, any>;
  const turns = SETTLE_CHANNELS.map((c) => {
    const s = settleOf(c);
    const d = refDecodeOf(s.settled.pin.metadata)(bytesOf(settleByShape(s).extrinsic));
    const args = d.call.value.value as Rec;
    return { s, args, turn: (args.verified_turns as Rec[])[0] as Rec };
  });

  it("HOLDS: on both real settles the reviewer's V3 leaf equals final_root and src/miner's leaf, and the enclave signature verifies over it under the record's enclave key by the reference sr25519", () => {
    expect(turns.length).toBe(2);
    for (const { s, args, turn } of turns) {
      expect(turn.leaf_version.type).toBe("V3");
      expect(turn.merkle_path).toEqual([]);
      const f = {
        channelId: refBytes(args.channel_id),
        turnIndex: turn.turn_index as number,
        hIn: refBytes(turn.h_in),
        hOut: refBytes(turn.h_out),
        gN: turn.g_n as bigint,
        decodePolicyHash: refBytes(turn.decode_policy_hash),
        hIds: refBytes(turn.h_ids),
        toplocCommitmentHash: refBytes(turn.toploc_commitment_hash),
        minerRecvMs: turn.miner_recv_ms as bigint,
        minerDoneMs: turn.miner_done_ms as bigint,
        latencyMs: turn.latency_ms as bigint,
      };
      const mine = thirdLeafV3(f);
      expect(hexOf(mine)).toBe(hexOf(refBytes(args.final_root)));
      expect(hexOf(leafV3(f))).toBe(hexOf(mine));
      expect(referenceVerify(bytesOf(s.parent.record.enclave_key), mine, refBytes(turn.enclave_sig))).toBe(true);
      expect(referenceVerify(bytesOf(s.parent.record.enclave_key), thirdLeafV3({ ...f, latencyMs: f.latencyMs + 1n }), refBytes(turn.enclave_sig))).toBe(false);
    }
  });
});
