/**
 * P6a, T4 and T7 (messages): verifyInfoProof, verifyInfo and verifyTurn accept a whole synthetic answer built by the
 * second writing (test/lib/miner-answers.ts) and signed by a test enclave key of the reference library, and refuse
 * each single change of it, by a table: one row per field and per check, each naming the refusal and the check.
 * No refusal message holds a run of 16 or more hex digits or any text of the answer.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { channelKeyFromSeed } from "../src/channel/key.js";
import { EXIT } from "../src/errors.js";
import { MinerError } from "../src/miner/errors.js";
import { minerExpected } from "../src/miner/expected.js";
import { verifyInfo, verifyInfoProof, verifyTurn } from "../src/miner/verify.js";
import { parseInfo, parseInfoProof, parseTurnReceipt } from "../src/miner/wire.js";
import { referenceReady, referenceSign } from "./lib/sr25519-reference.js";
import { b256, enclavePair, expectedInputOf, filled, hex0x, HEX_RUN, infoObject, leafOf, proofObject, refLeafV3, refSs58, scenario, turnObject, type Scenario } from "./lib/miner-answers.js";

beforeAll(referenceReady);

type Obj = Record<string, unknown>;

/** Every string value of an answer, at any depth, of 3 or more characters. */
function textsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string" && v.length >= 3) out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v)) textsOf(x, out);
  return out;
}

/** The refusal of `run`, held to T7: no hex run of 16, no text of the answer. */
function refusal(run: () => unknown, answer: Obj): MinerError {
  let caught: unknown;
  try {
    run();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MinerError);
  const e = caught as MinerError;
  expect(e.message).not.toMatch(HEX_RUN);
  for (const t of textsOf(answer)) expect(e.message.includes(t), `the message quotes ${t.slice(0, 20)}`).toBe(false);
  return e;
}

const IDENTITY_CHANGES: [string, (s: Scenario) => Partial<Scenario["identity"]>][] = [
  ["requestedSlug", () => ({ requestedSlug: "qwen-other" })],
  ["registryModel", () => ({ registryModel: "Qwen Other" })],
  ["registryVersion", () => ({ registryVersion: "1.1" })],
  ["modelHash", () => ({ modelHash: filled(32, 0x12) })],
  ["precision", () => ({ precision: 3 })],
  ["decodePolicyHash", () => ({ decodePolicyHash: filled(32, 0x23) })],
  ["measuredRoot", () => ({ measuredRoot: filled(32, 0x34) })],
  ["backendModelName", () => ({ backendModelName: "qwen-backend-2" })],
];

describe("T4: verifyInfoProof", () => {
  const base = () => scenario();
  const run = (s: Scenario, proof: Obj, challenge = s.challenge) => {
    const expected = minerExpected(expectedInputOf(s));
    return verifyInfoProof({ expected, challenge, proof: parseInfoProof(JSON.stringify(proof)) });
  };

  it("accepts a whole proof and returns the image version and revision", () => {
    const s = base();
    expect(run(s, proofObject(s))).toEqual({ version: s.version, revision: s.revision });
  });

  const other = () => enclavePair(9);
  const rows: [string, (s: Scenario) => { proof: Obj; challenge?: Uint8Array }][] = [
    ["genesis", (s) => ({ proof: proofObject({ ...s, genesis: filled(32, 0x45) }) })],
    ["account", (s) => ({ proof: proofObject({ ...s, account: filled(32, 0x56) }) })],
    ["enclaveKey", (s) => ({ proof: proofObject(s, { signer: other() }) })],
    ...IDENTITY_CHANGES.map(([name, change]) => [`identity.${name}`, (s: Scenario) => ({ proof: proofObject({ ...s, identity: { ...s.identity, ...change(s) } }) })] as [string, (s: Scenario) => { proof: Obj }]),
    ["ready", (s) => ({ proof: proofObject(s, { ready: false }) })],
    ["signature", (s) => ({ proof: proofObject(s), challenge: Uint8Array.from(s.challenge, (x, i) => (i === 0 ? x ^ 1 : x)) })],
    ["signature", (s) => ({ proof: proofObject(s, { challenge: filled(32, 0x67) }) })],
    ["signature", (s) => ({ proof: { ...proofObject(s), signature: ((t) => (t[0] === "0" ? "1" : "0") + t.slice(1))(proofObject(s).signature as string) } })],
    ["signature", (s) => ({ proof: proofObject(s, { signer: other(), stated: s.pair.publicKey }) })],
    ["signature", (s) => ({ proof: { ...proofObject(s), image: { version: "0.6.1", revision: s.revision } } })],
    ["signature", (s) => ({ proof: { ...proofObject(s), image: { version: s.version, revision: "abc124" } } })],
  ];
  for (const [check, make] of rows) {
    it(`refuses a change of ${check} with PROOF, exit 5`, () => {
      const s = base();
      const { proof, challenge } = make(s);
      const e = refusal(() => run(s, proof, challenge), proof);
      expect([e.refusal, e.check, e.code]).toEqual(["PROOF", `proof.${check}`, EXIT.REFUSED_RULE]);
    });
  }

  it("refuses a signature by C, the channel key, that states C's key, at the enclave key check", () => {
    const s = base();
    const c = channelKeyFromSeed({ seed: filled(32, 0x5c) });
    const proof = { ...proofObject(s), enclave_key: Buffer.from(c.publicKey()).toString("hex") };
    const e = refusal(() => run(s, proof), proof);
    expect([e.refusal, e.check]).toEqual(["PROOF", "proof.enclaveKey"]);
  });

  it("the identity point as the pinned key is refused before any verify (BAD_INPUT)", () => {
    const s = base();
    const e = refusal(() => minerExpected({ ...expectedInputOf(s), enclaveKey: filled(32, 0) }), {});
    expect([e.refusal, e.check]).toEqual(["BAD_INPUT", "expected.enclaveKey"]);
  });

  it("a decode policy of all zero is refused as a pin (BAD_INPUT)", () => {
    const s = base();
    const e = refusal(() => minerExpected({ ...expectedInputOf(s), identity: { ...s.identity, decodePolicyHash: filled(32, 0) } }), {});
    expect([e.refusal, e.check]).toEqual(["BAD_INPUT", "expected.identity.decodePolicyHash"]);
  });

  it("an expected value not made by minerExpected is refused, and so is a proof not made by the parser", () => {
    const s = base();
    const proof = parseInfoProof(JSON.stringify(proofObject(s)));
    expect(refusal(() => verifyInfoProof({ expected: { ...expectedInputOf(s) } as never, challenge: s.challenge, proof }), {}).check).toBe("expected");
    const expected = minerExpected(expectedInputOf(s));
    expect(refusal(() => verifyInfoProof({ expected, challenge: s.challenge, proof: { ...proof } }), {}).check).toBe("proof");
  });

  it("a parsed answer of another kind is refused where a receipt, an info or a proof is wanted (BAD_INPUT)", () => {
    const s = base();
    const expected = minerExpected(expectedInputOf(s));
    const proof = parseInfoProof(JSON.stringify(proofObject(s)));
    const info = parseInfo(JSON.stringify(infoObject(s)));
    const turn = parseTurnReceipt(JSON.stringify(turnObject(s)));
    const asTurn = refusal(() => verifyTurn({ expected, channelId: s.channelId, input: s.input, maxTokens: s.maxTokens, receipt: proof as never }), {});
    expect([asTurn.refusal, asTurn.check]).toEqual(["BAD_INPUT", "turn"]);
    const asInfo = refusal(() => verifyInfo({ expected, info: turn as never }), {});
    expect([asInfo.refusal, asInfo.check]).toEqual(["BAD_INPUT", "info"]);
    const asProof = refusal(() => verifyInfoProof({ expected, challenge: s.challenge, proof: info as never }), {});
    expect([asProof.refusal, asProof.check]).toEqual(["BAD_INPUT", "proof"]);
  });

  it("a change to the arrays of the values handed out changes nothing that is checked", () => {
    const s = base();
    const expected = minerExpected(expectedInputOf(s));
    const proof = parseInfoProof(JSON.stringify(proofObject(s)));
    expected.enclaveKey.fill(1);
    proof.signature.fill(0);
    expect(verifyInfoProof({ expected, challenge: s.challenge, proof })).toEqual({ version: s.version, revision: s.revision });
  });
});

describe("T4: verifyInfo", () => {
  const run = (s: Scenario, info: Obj) => verifyInfo({ expected: minerExpected(expectedInputOf(s)), info: parseInfo(JSON.stringify(info)) });

  it("accepts a whole info and returns maxUnackedGn", () => {
    const s = scenario();
    expect(run(s, infoObject(s))).toEqual({ maxUnackedGn: 0n });
    expect(run(s, { ...infoObject(s), minerAddress: refSs58(s.account, 7) })).toEqual({ maxUnackedGn: 0n });
  });

  const rows: [string, (s: Scenario) => Obj][] = [
    ["minerAddress", (s) => ({ ...infoObject(s), minerAddress: refSs58(filled(32, 0x56)) })],
    ["enclaveKey", (s) => ({ ...infoObject(s), enclaveKey: hex0x(enclavePair(9).publicKey) })],
    ["modelHash", (s) => ({ ...infoObject(s), modelHash: hex0x(filled(32, 0x12)) })],
    ...IDENTITY_CHANGES.map(([name, change]) => [`identity.${name}`, (s: Scenario) => infoObject({ ...s, identity: { ...s.identity, ...change(s) }, pair: s.pair })] as [string, (s: Scenario) => Obj]),
    ["is_ready", (s) => ({ ...infoObject(s), is_ready: false })],
  ];
  for (const [check, make] of rows) {
    it(`refuses a change of ${check} with INFO, exit 1`, () => {
      const s = scenario();
      const info = make(s);
      if (check === "identity.modelHash") (info as Obj).modelHash = hex0x(s.identity.modelHash);
      const e = refusal(() => run(s, info), info);
      expect([e.refusal, e.check, e.code]).toEqual(["INFO", `info.${check}`, EXIT.ERROR]);
    });
  }
});

describe("T4: verifyTurn", () => {
  const run = (s: Scenario, turn: Obj, o: { input?: Uint8Array; maxTokens?: number } = {}) =>
    verifyTurn({ expected: minerExpected(expectedInputOf(s)), channelId: s.channelId, input: o.input ?? s.input, maxTokens: o.maxTokens ?? s.maxTokens, receipt: parseTurnReceipt(JSON.stringify(turn)) });

  it("accepts a whole turn and returns the verified turn", () => {
    const s = scenario();
    const v = run(s, turnObject(s));
    expect(v.text).toBe("Hello.");
    expect(Buffer.from(v.leaf).toString("hex")).toBe(Buffer.from(refLeafV3(leafOf(s))).toString("hex"));
    expect([v.gN, v.promptTokens, v.completionTokens, v.finishReason, v.minerRecvMs, v.minerDoneMs, v.latencyMs]).toEqual([s.gN, s.promptTokens, s.completionTokens, s.finishReason, s.minerRecvMs, s.minerDoneMs, s.latencyMs]);
    expect(Object.isFrozen(v)).toBe(true);
  });

  it("accepts completion tokens equal to max_tokens, finish reason length, a zero TOPLOC hash, an empty output, and G_n of 2^64 minus 1", () => {
    for (const over of [{ completionTokens: 64n }, { finishReason: "length" }, { toploc: filled(32, 0) }, { output: new Uint8Array(0) }, { gN: (1n << 64n) - 1n }] as Partial<Scenario>[]) {
      const s = scenario(over);
      expect(run(s, turnObject(s)).gN).toBe(s.gN);
    }
  });

  const enc = new TextEncoder();
  const flipFirst = (h: string) => `0x${h[2] === "0" ? "1" : "0"}${h.slice(3)}`;
  type Row = [check: string, make: (s: Scenario) => { turn: Obj; input?: Uint8Array; maxTokens?: number }];
  const rows: Row[] = [
    ["leafVersion", (s) => ({ turn: turnObject(s, { leafVersion: "V2" }) })],
    ["turnIndex", (s) => ({ turn: turnObject(s, { leaf: leafOf(s, { turnIndex: 1 }) }) })],
    ["hIn", (s) => ({ turn: turnObject(s, { leaf: leafOf(s, { hIn: b256(enc.encode("another input")) }) }) })],
    ["hIn", (s) => ({ turn: turnObject(s), input: enc.encode("another input") })],
    ["decodePolicyHash", (s) => ({ turn: turnObject(s, { leaf: { ...leafOf(s), decodePolicyHash: filled(32, 0x23) } }) })],
    ["hIds", (s) => ({ turn: turnObject({ ...s, hIds: filled(32, 0) }) })],
    ...IDENTITY_CHANGES.map(([name, change]): Row => [`identity.${name}`, (s) => {
      const t = turnObject({ ...s, identity: { ...s.identity, ...change(s) } }, { leaf: leafOf(s) });
      return { turn: t };
    }]),
    ["finishReason", (s) => ({ turn: turnObject({ ...s, finishReason: "tool_calls" }) })],
    ["finishReason", (s) => ({ turn: turnObject({ ...s, finishReason: "Stop" }) })],
    ["completionTokens", (s) => ({ turn: turnObject({ ...s, completionTokens: 65n }) })],
    ["completionTokens", (s) => ({ turn: turnObject(s), maxTokens: 2 })],
    ["output", (s) => ({ turn: turnObject({ ...s, output: Uint8Array.of(0x48, 0xff, 0x49) }) })],
    ["output", (s) => ({ turn: turnObject({ ...s, output: Uint8Array.of(0xed, 0xa0, 0x80) }) })],
    ["output", (s) => ({ turn: turnObject({ ...s, output: enc.encode("FLOP-TURN-FRAMES-V1\u0000\u0000\u0000\u0000\u0000\u0002hi") }) })],
    ["output", (s) => ({ turn: turnObject({ ...s, output: enc.encode("FLOP-TURN-FRAMES-V9 anything") }) })],
    ["hOut", (s) => ({ turn: { ...turnObject(s), output: hex0x(enc.encode("Hellp.")) } })],
    ["hOut", (s) => ({ turn: turnObject(s, { leaf: leafOf(s, { hOut: b256(s.output) }) }) })],
    ["hOut", (s) => ({ turn: { ...turnObject(s), promptTokens: "13" } })],
    ["timing.order", (s) => ({ turn: turnObject({ ...s, minerRecvMs: s.minerDoneMs + 1n, latencyMs: 0n }) })],
    ["timing.latency", (s) => ({ turn: turnObject({ ...s, latencyMs: s.latencyMs + 1n }) })],
    ["timing.latency", (s) => ({ turn: turnObject({ ...s, latencyMs: s.latencyMs - 1n }) })],
    ["gN", (s) => ({ turn: turnObject({ ...s, gN: 1n << 64n }) })],
    ["runningRoot", (s) => ({ turn: turnObject(s, { root: refLeafV3({ ...leafOf(s), gN: s.gN + 1n }) }) })],
    ["runningRoot", (s) => ({ turn: { ...turnObject(s), gN: String(s.gN + 1n) } })],
    ["enclaveSig", (s) => ({ turn: { ...turnObject(s), enclaveSig: flipFirst(turnObject(s).enclaveSig as string) } })],
    ["enclaveSig", (s) => ({ turn: turnObject(s, { signer: enclavePair(9) }) })],
    ["enclaveSig", (s) => {
      const c = channelKeyFromSeed({ seed: filled(32, 0x5c) });
      const leaf = refLeafV3(leafOf(s));
      return { turn: { ...turnObject(s), enclaveSig: hex0x(c.signReceipt({ channelId: s.channelId, finalRoot: leaf, aggregateGn: s.gN, payable: 1n }).signature) } };
    }],
    ["enclaveSig", (s) => ({ turn: { ...turnObject(s), enclaveSig: hex0x(referenceSign(s.pair, filled(32, 0))) } })],
  ];
  rows.forEach(([check, make], i) => {
    it(`row ${i}: refuses a change of ${check} with TURN, exit 1`, () => {
      const s = scenario();
      const { turn, input, maxTokens } = make(s);
      const e = refusal(() => run(s, turn, { input, maxTokens }), turn);
      expect([e.refusal, e.check, e.code]).toEqual(["TURN", `turn.${check}`, EXIT.ERROR]);
    });
  });

  it("the TURN rows cover every check of W16", () => {
    const checks = new Set(rows.map(([c]) => c.replace(/^identity\..*/, "identity")));
    expect([...checks].sort()).toEqual(["completionTokens", "decodePolicyHash", "enclaveSig", "finishReason", "gN", "hIds", "hIn", "hOut", "identity", "leafVersion", "output", "runningRoot", "timing.latency", "timing.order", "turnIndex"]);
  });

  it("the checks come in the order of W16: a turn wrong in two places is refused at the earlier check", () => {
    const s = scenario();
    const both = { ...turnObject(s, { leafVersion: "V2", leaf: leafOf(s, { turnIndex: 1 }) }) };
    expect(refusal(() => run(s, both), both).check).toBe("turn.leafVersion");
    const late = turnObject({ ...s, latencyMs: s.latencyMs + 1n, gN: 1n << 64n });
    expect(refusal(() => run(s, late), late).check).toBe("turn.timing.latency");
  });
});
