/**
 * P6a, W3, W4, W5, W6 and W8: the caller's own input to src/miner. Every public function takes plain fields of
 * exactly its names, bytes of their exact length as fresh copies, numbers inside their type, texts in their bound,
 * and refuses anything else with BAD_INPUT (exit 1), in a message that never quotes the input. Results are frozen.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/errors.js";
import { MinerError, MINER_REFUSAL } from "../src/miner/errors.js";
import { minerExpected } from "../src/miner/expected.js";
import { LIMITS } from "../src/miner/forms.js";
import { modelIdentityHash, sessionInfoMessage, turnEvidenceHash } from "../src/miner/identity.js";
import { turnInput } from "../src/miner/input.js";
import { leafV3 } from "../src/miner/leaf.js";
import { verifyTurn } from "../src/miner/verify.js";
import { parseTurnReceipt } from "../src/miner/wire.js";
import { referenceReady } from "./lib/sr25519-reference.js";
import { expectedInputOf, filled, hex, HEX_RUN, refTurnInput, scenario, turnObject } from "./lib/miner-answers.js";

beforeAll(referenceReady);

const SECRET = "a secret prompt text";

function badInput(run: () => unknown, quoted: string[] = []): MinerError {
  let caught: unknown;
  try {
    run();
  } catch (e) {
    caught = e;
  }
  expect(caught, "not refused").toBeInstanceOf(MinerError);
  const e = caught as MinerError;
  expect([e.refusal, e.code]).toEqual(["BAD_INPUT", EXIT.ERROR]);
  expect(e.message).not.toMatch(HEX_RUN);
  for (const q of [SECRET, ...quoted]) expect(e.message.includes(q), `quotes ${q.slice(0, 20)}`).toBe(false);
  return e;
}

describe("W4: the refusal table", () => {
  it("is frozen and holds exactly the seven codes", () => {
    expect(Object.isFrozen(MINER_REFUSAL)).toBe(true);
    expect(Object.keys(MINER_REFUSAL)).toEqual(["BAD_INPUT", "WIRE", "PROOF", "INFO", "TURN", "MONEY", "RECEIPT"]);
  });
});

describe("W5, W6: minerExpected", () => {
  const good = () => expectedInputOf(scenario());

  it("accepts the pins and hands out a frozen value of fresh copies", () => {
    const input = good();
    const e = minerExpected(input);
    expect(Object.isFrozen(e) && Object.isFrozen(e.identity)).toBe(true);
    expect(e.enclaveKey).not.toBe(input.enclaveKey);
    input.enclaveKey.fill(0);
    expect(hex(e.enclaveKey)).not.toBe(hex(input.enclaveKey));
  });

  it("refuses each byte field of another length, and an array in place of bytes", () => {
    for (const k of ["genesis", "account", "enclaveKey"] as const) {
      for (const v of [filled(31, 1), filled(33, 1), [1, 2], "0x00"]) badInput(() => minerExpected({ ...good(), [k]: v } as never));
    }
    for (const k of ["modelHash", "decodePolicyHash", "measuredRoot"] as const) badInput(() => minerExpected({ ...good(), identity: { ...good().identity, [k]: filled(31, 1) } }));
  });

  it("refuses each string field out of its bound: empty, 257 bytes, a control character, a lone surrogate, not a string", () => {
    for (const k of ["requestedSlug", "registryModel", "registryVersion", "backendModelName"] as const) {
      for (const v of ["", "x".repeat(257), "é".repeat(128) + "x", `${SECRET}\u0000`, `${SECRET}\u009f`, `${SECRET}\ud800`, 7]) {
        const e = badInput(() => minerExpected({ ...good(), identity: { ...good().identity, [k]: v } } as never));
        expect(e.check).toBe(`expected.identity.${k}`);
      }
      expect(minerExpected({ ...good(), identity: { ...good().identity, [k]: "é".repeat(128) } }).identity[k]).toBe("é".repeat(128));
      expect(minerExpected({ ...good(), identity: { ...good().identity, [k]: "a b" } }).identity[k]).toBe("a b");
    }
  });

  it("refuses a precision that is not a u8", () => {
    for (const v of [256, -1, 1.5, 2n, "2"]) badInput(() => minerExpected({ ...good(), identity: { ...good().identity, precision: v } } as never));
    expect(minerExpected({ ...good(), identity: { ...good().identity, precision: 255 } }).identity.precision).toBe(255);
  });

  it("refuses a field missing, an extra field (without naming it), an accessor, and a value that is not an object", () => {
    const { account: _a, ...short } = good();
    badInput(() => minerExpected(short as never));
    const e = badInput(() => minerExpected({ ...good(), [SECRET]: 1 } as never), [SECRET]);
    expect(e.message).toMatch(/not one of its fields/);
    badInput(() => minerExpected({ ...good(), identity: { ...good().identity, extra: 1 } } as never));
    const withGetter = good();
    Object.defineProperty(withGetter, "genesis", { get: () => filled(32, 1), enumerable: true });
    badInput(() => minerExpected(withGetter));
    for (const v of [null, [], "x", filled(32, 1)]) badInput(() => minerExpected(v as never));
  });
});

describe("W8: turnInput", () => {
  const exp = () => minerExpected(expectedInputOf(scenario()));
  const user = (content: string) => [{ role: "user" as const, content }];

  it("gives the canonical bytes and h_in, frozen, with the pinned slug as the model", () => {
    const s = scenario();
    const t = turnInput({ expected: minerExpected(expectedInputOf(s)), messages: s.messages, maxTokens: s.maxTokens });
    expect(new TextDecoder().decode(t.input)).toBe('{"max_tokens":64,"messages":[{"content":"Say hello.","role":"user"}],"model":"qwen-test","version":"flop.chat-turn.v1"}');
    expect(hex(t.input)).toBe(hex(refTurnInput(s.identity.requestedSlug, s.messages, s.maxTokens)));
    expect(t.maxTokens).toBe(s.maxTokens);
    expect(Object.isFrozen(t)).toBe(true);
  });

  it("refuses the messages: none, more than the most, another role, content not a string, a lone surrogate, an extra field, a hole", () => {
    badInput(() => turnInput({ expected: exp(), messages: [], maxTokens: 1 }));
    badInput(() => turnInput({ expected: exp(), messages: Array.from({ length: LIMITS.MESSAGES_MAX + 1 }, () => user("x")[0]!), maxTokens: 1 }));
    for (const role of ["assistant", "tool", "developer", "User", 1]) badInput(() => turnInput({ expected: exp(), messages: [{ role, content: SECRET }] as never, maxTokens: 1 }));
    for (const content of [null, 1, ["part"], { text: SECRET }]) badInput(() => turnInput({ expected: exp(), messages: [{ role: "user", content }] as never, maxTokens: 1 }));
    badInput(() => turnInput({ expected: exp(), messages: user(`${SECRET}\udc00`), maxTokens: 1 }));
    badInput(() => turnInput({ expected: exp(), messages: [{ role: "user", content: SECRET, name: "x" }] as never, maxTokens: 1 }));
    const holes = [user("x")[0]!, user("y")[0]!];
    delete (holes as unknown[])[0];
    badInput(() => turnInput({ expected: exp(), messages: holes, maxTokens: 1 }));
    const extra = user("x") as unknown as Record<string, unknown>;
    extra.more = 1;
    badInput(() => turnInput({ expected: exp(), messages: extra as never, maxTokens: 1 }));
    badInput(() => turnInput({ expected: exp(), messages: { 0: user("x")[0], length: 1 } as never, maxTokens: 1 }));
  });

  it("refuses max_tokens out of 1 to the most, or not a whole number", () => {
    for (const maxTokens of [0, -1, LIMITS.MAX_TOKENS_MAX + 1, 1.5, 64n, "64"]) badInput(() => turnInput({ expected: exp(), messages: user("x"), maxTokens } as never));
    expect(turnInput({ expected: exp(), messages: user("x"), maxTokens: LIMITS.MAX_TOKENS_MAX }).input.length).toBeGreaterThan(0);
  });

  it("refuses an input over the most bytes, and accepts one just under", () => {
    const pad = 200; // the envelope's own bytes around one message, more than enough
    badInput(() => turnInput({ expected: exp(), messages: user("x".repeat(LIMITS.INPUT_MAX_BYTES)), maxTokens: 1 }));
    expect(turnInput({ expected: exp(), messages: user("x".repeat(LIMITS.INPUT_MAX_BYTES - pad)), maxTokens: 1 }).input.length).toBeLessThanOrEqual(LIMITS.INPUT_MAX_BYTES);
  });

  it("refuses an expected value not made by minerExpected", () => {
    badInput(() => turnInput({ expected: expectedInputOf(scenario()) as never, messages: user("x"), maxTokens: 1 }));
  });
});

describe("W3: the layouts refuse a field of another width", () => {
  const leaf = { channelId: filled(32, 1), turnIndex: 0, hIn: filled(32, 2), hOut: filled(32, 3), gN: 1n, decodePolicyHash: filled(32, 4), hIds: filled(32, 5), toplocCommitmentHash: filled(32, 6), minerRecvMs: 1n, minerDoneMs: 2n, latencyMs: 1n };
  it("leafV3", () => {
    for (const k of ["channelId", "hIn", "hOut", "decodePolicyHash", "hIds", "toplocCommitmentHash"] as const) for (const n of [31, 33]) badInput(() => leafV3({ ...leaf, [k]: filled(n, 1) }));
    for (const v of [-1, 2 ** 32, 1.5, 0n]) badInput(() => leafV3({ ...leaf, turnIndex: v } as never));
    for (const v of [-1n, 1n << 128n, 1]) badInput(() => leafV3({ ...leaf, gN: v } as never));
    for (const k of ["minerRecvMs", "minerDoneMs", "latencyMs"] as const) for (const v of [-1n, 1n << 64n, 1]) badInput(() => leafV3({ ...leaf, [k]: v } as never));
    expect(leafV3({ ...leaf, turnIndex: 2 ** 32 - 1, gN: (1n << 128n) - 1n, latencyMs: (1n << 64n) - 1n }).length).toBe(32);
  });

  it("the identity hash, the info message and the evidence hash", () => {
    const s = scenario();
    badInput(() => modelIdentityHash({ ...s.identity, precision: 256 }));
    const info = { challenge: s.challenge, genesis: s.genesis, account: s.account, enclaveKey: s.pair.publicKey, identity: s.identity, ready: true, version: s.version, revision: s.revision };
    for (const k of ["challenge", "genesis", "account", "enclaveKey"] as const) badInput(() => sessionInfoMessage({ ...info, [k]: filled(31, 1) }));
    for (const v of [1, "true", null]) badInput(() => sessionInfoMessage({ ...info, ready: v } as never));
    for (const v of ["", "x".repeat(257), "a\u0007"]) badInput(() => sessionInfoMessage({ ...info, version: v }));
    const ev = { output: filled(3, 0x41), promptTokens: 1n, completionTokens: 1n, finishReason: "stop", identity: s.identity };
    badInput(() => turnEvidenceHash({ ...ev, output: filled(LIMITS.OUTPUT_MAX_BYTES + 1, 0x41) }));
    expect(turnEvidenceHash({ ...ev, output: filled(LIMITS.OUTPUT_MAX_BYTES, 0x41) }).length).toBe(32);
    for (const k of ["promptTokens", "completionTokens"] as const) badInput(() => turnEvidenceHash({ ...ev, [k]: 1n << 64n }));
    badInput(() => turnEvidenceHash({ ...ev, finishReason: "" }));
  });

  it("verifyTurn's own inputs", () => {
    const s = scenario();
    const expected = minerExpected(expectedInputOf(s));
    const base = { expected, channelId: s.channelId, turn: turnInput({ expected, messages: s.messages, maxTokens: s.maxTokens }), receipt: parseTurnReceipt(JSON.stringify(turnObject(s))) };
    expect(verifyTurn(base).gN).toBe(s.gN);
    badInput(() => verifyTurn({ ...base, channelId: filled(31, 1) }));
    for (const v of [0, LIMITS.MAX_TOKENS_MAX + 1, 1.5]) badInput(() => verifyTurn({ ...base, maxTokens: v }));
    badInput(() => verifyTurn({ ...base, input: "text" as never }));
    badInput(() => verifyTurn({ ...base, turn: "text" as never }));
  });
});
