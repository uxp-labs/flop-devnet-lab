/**
 * P6a, T3: src/miner and the second writing (test/lib/miner-answers.ts) agree on a grid of inputs, for every layout:
 * the model identity hash, the info proof's message, the turn evidence hash, the version 3 leaf and the turn input.
 * Every field at its smallest and largest; strings with non ASCII text, quotes, backslashes, control characters
 * (in the content only) and U+2028. An agreement of two writings by one builder is weaker than a real vector.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { minerExpected } from "../src/miner/expected.js";
import { modelIdentityHash, sessionInfoMessage, turnEvidenceHash } from "../src/miner/identity.js";
import { turnInput } from "../src/miner/input.js";
import { leafV3 } from "../src/miner/leaf.js";
import { referenceReady } from "./lib/sr25519-reference.js";
import { b256, enclavePair, filled, hex, refEvidenceHash, refIdentityHash, refJsonString, refLeafV3, refSessionInfoMessage, refTurnInput, type Identity } from "./lib/miner-answers.js";

beforeAll(referenceReady);

const MAX64 = (1n << 64n) - 1n;
const MAX128 = (1n << 128n) - 1n;

/** Bounded texts: 1 byte, 256 bytes of several kinds, and the hard characters. */
const TEXTS = [
  "a",
  "x".repeat(256),
  "é".repeat(128),
  "\u{1F600}".repeat(64),
  "日本語のモデル",
  'quote " and \\ backslash',
  "line separator para",
  "</script> & 'single'",
  "~~",
];

const identities: Identity[] = [];
for (const t of TEXTS) {
  identities.push({ requestedSlug: t, registryModel: t, registryVersion: t, modelHash: filled(32, 0), precision: 0, decodePolicyHash: filled(32, 1), measuredRoot: filled(32, 0), backendModelName: t });
  identities.push({ requestedSlug: "s", registryModel: t, registryVersion: "v", modelHash: filled(32, 0xff), precision: 255, decodePolicyHash: filled(32, 0xff), measuredRoot: filled(32, 0xff), backendModelName: t });
}

describe("T3: the model identity hash and the info proof's message", () => {
  it("the identity hash agrees on every identity of the grid", () => {
    for (const i of identities) expect(hex(modelIdentityHash(i)), i.requestedSlug).toBe(hex(refIdentityHash(i)));
  });

  it("the info proof's message agrees, ready true and false, every version and revision of the grid", () => {
    for (const i of identities.slice(0, 6))
      for (const ready of [true, false])
        for (const t of TEXTS) {
          const m = { challenge: filled(32, 0xab), genesis: filled(32, 0), account: filled(32, 0xff), enclaveKey: filled(32, 3), identity: i, ready, version: t, revision: TEXTS[0] as string };
          expect(hex(sessionInfoMessage(m))).toBe(hex(refSessionInfoMessage(m)));
          expect(hex(sessionInfoMessage({ ...m, version: "1", revision: t }))).toBe(hex(refSessionInfoMessage({ ...m, version: "1", revision: t })));
        }
  });
});

describe("T3: the turn evidence hash", () => {
  const outputs = [new Uint8Array(0), new TextEncoder().encode("héllo   \"\\"), filled(2 * 1024 * 1024, 0x61)];
  it("agrees on outputs empty, plain and of the largest size, tokens 0 and 2^64 minus 1, every finish reason text of the grid", () => {
    for (const output of outputs)
      for (const [p, c] of [[0n, 0n], [MAX64, MAX64], [1n, MAX64]] as const)
        for (const finishReason of ["stop", "length", ...TEXTS.slice(0, 3)]) {
          const e = { output, promptTokens: p, completionTokens: c, finishReason, identity: identities[1] as Identity };
          expect(hex(turnEvidenceHash(e))).toBe(hex(refEvidenceHash(e)));
        }
  });
  it("agrees on every identity of the grid", () => {
    for (const identity of identities) {
      const e = { output: filled(5, 0x41), promptTokens: 7n, completionTokens: 9n, finishReason: "stop", identity };
      expect(hex(turnEvidenceHash(e))).toBe(hex(refEvidenceHash(e)));
    }
  });
});

describe("T3: the version 3 leaf", () => {
  it("agrees with every field at its smallest and its largest, one at a time and all at once", () => {
    const low = { channelId: filled(32, 0), turnIndex: 0, hIn: filled(32, 0), hOut: filled(32, 0), gN: 0n, decodePolicyHash: filled(32, 0), hIds: filled(32, 0), toplocCommitmentHash: filled(32, 0), minerRecvMs: 0n, minerDoneMs: 0n, latencyMs: 0n };
    const high = { channelId: filled(32, 0xff), turnIndex: 2 ** 32 - 1, hIn: filled(32, 0xff), hOut: filled(32, 0xff), gN: MAX128, decodePolicyHash: filled(32, 0xff), hIds: filled(32, 0xff), toplocCommitmentHash: filled(32, 0xff), minerRecvMs: MAX64, minerDoneMs: MAX64, latencyMs: MAX64 };
    const rows = [low, high];
    for (const k of Object.keys(low) as (keyof typeof low)[]) rows.push({ ...low, [k]: high[k] }, { ...high, [k]: low[k] });
    rows.push({ ...low, turnIndex: 0x01020304, gN: 0x0102030405060708090a0b0c0d0e0f10n, minerRecvMs: 0x0102030405060708n });
    const seen = new Set<string>();
    for (const r of rows) {
      const h = hex(leafV3(r));
      expect(h).toBe(hex(refLeafV3(r)));
      seen.add(h);
    }
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe("T3: the turn input and h_in", () => {
  const contents = ["", "Say hello.", ...TEXTS, "tab\there\nnew\rcr\bbs\ffeed\u0000nul\u001f\u007f", "  ", "\\\"\\", "emoji \u{1F600} end", "x".repeat(10000)];
  const slugs = ["a", "qwen/test-1", 'q"uo\\te', "é".repeat(128), "line sep"];

  it("the second writing's string escaper is JSON.stringify's on every content of the grid (control)", () => {
    for (const c of [...contents, ...slugs]) expect(refJsonString(c)).toBe(JSON.stringify(c));
  });

  for (const slug of slugs) {
    it(`agrees for the slug ${JSON.stringify(slug).slice(0, 24)}: every content, both roles, max_tokens 1 and the largest, 1 and 256 messages`, () => {
      const s = { genesis: filled(32, 1), account: filled(32, 2), enclaveKey: enclavePair().publicKey, identity: { ...identities[0], requestedSlug: slug } as Identity };
      const expected = minerExpected(s);
      for (const content of contents)
        for (const role of ["system", "user"] as const)
          for (const maxTokens of [1, 131072]) {
            const messages = [{ role, content }];
            const ours = turnInput({ expected, messages, maxTokens });
            const ref = refTurnInput(slug, messages, maxTokens);
            expect(hex(ours.input)).toBe(hex(ref));
            expect(hex(ours.hIn)).toBe(hex(b256(ref)));
          }
      const many = Array.from({ length: 256 }, (_, i) => ({ role: i % 2 === 0 ? ("system" as const) : ("user" as const), content: contents[i % contents.length]!.slice(0, 50) }));
      expect(hex(turnInput({ expected, messages: many, maxTokens: 77 }).input)).toBe(hex(refTurnInput(slug, many, 77)));
    });
  }
});
