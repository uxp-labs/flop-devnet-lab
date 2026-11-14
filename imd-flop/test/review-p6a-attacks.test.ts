/**
 * Review of P6a, attacks 3 to 7 and 8 (Q3, Q4, Q5, Q6, Q9, Q7). Every answer is the reviewer's own synthetic one
 * (test/lib/review-p6a-miner.ts), signed by a test enclave key from the reference sr25519. Offline.
 * Six tests were named DEFECT RP6A-1 to RP6A-4 and failed on the reviewed commit by design (RP6A-1 one, RP6A-2 two,
 * RP6A-3 two, RP6A-4 one). Each fix holds, so each is named HOLDS with its id, and its name says what holds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MinerError } from "../src/miner/errors.js";
import { minerExpected } from "../src/miner/expected.js";
import { sessionInfoMessage } from "../src/miner/identity.js";
import { turnInput } from "../src/miner/input.js";
import { chainTariff, receiptPayable, turnCost } from "../src/miner/money.js";
import { verifyInfo, verifyInfoProof, verifyTurn } from "../src/miner/verify.js";
import { parseCloseAnswer, parseInfo, parseInfoProof, parseTurnReceipt } from "../src/miner/wire.js";
import { referenceReady, referenceSign } from "./lib/sr25519-reference.js";
import { thirdLeafV3, thirdSessionInfoMessage } from "./lib/review-p6a-third.js";
import { CHALLENGE, CHANNEL, ENCLAVE, ID, MAX128, MAX64, MAX_TOKENS, MESSAGES, OTHER, counting, expected, filled, hx, hx0, idCopy, infoObject, inputOf, proofObject, turnParts, type TurnOpts } from "./lib/review-p6a-miner.js";

beforeAll(referenceReady);

/** Every refusal message any test here saw, for attack 8. */
const SEEN: string[] = [];

function refusal(f: () => unknown): { refusal: string; check: string; exit: number } {
  try {
    f();
  } catch (e) {
    if (!(e instanceof MinerError)) throw e;
    SEEN.push(e.message);
    return { refusal: e.refusal, check: e.check, exit: e.code };
  }
  throw new Error("expected a refusal, got none");
}

const J = (o: unknown): string => JSON.stringify(o);

/** The turn value of the input we sent: the reviewer's messages and max_tokens, made by turnInput for the pinned values. */
const turnOf = (maxTokens = MAX_TOKENS, messages = MESSAGES) => turnInput({ expected: expected(), messages, maxTokens });

// ---------------------------------------------------------------- Q3, the info proof
describe("Q3: the info proof", () => {
  const run = (o: Parameters<typeof proofObject>[0] = {}, challenge = CHALLENGE, exp = expected()) => verifyInfoProof({ expected: exp, challenge, proof: parseInfoProof(J(proofObject(o))) });

  it("HOLDS: a whole synthetic proof by the pinned key over our challenge verifies and gives its image", () => {
    expect(run()).toEqual({ version: "flop-miner 0.9.1", revision: "abc123" });
  });

  const rows: [string, () => unknown, string][] = [
    ["another key that states itself", () => run({ signer: OTHER }), "proof.enclaveKey"],
    ["the pinned key stated, another key signs", () => run({ signer: OTHER, statedKey: ENCLAVE.publicKey }), "proof.signature"],
    ["a proof for another challenge", () => run({ challenge: counting(32, 99) }), "proof.signature"],
    ["our challenge with one bit flipped, at verify", () => run({}, (() => { const c = Uint8Array.from(CHALLENGE); c[31] ^= 1; return c; })()), "proof.signature"],
    ["another genesis, signed", () => run({ genesis: counting(32, 50) }), "proof.genesis"],
    ["another account, signed", () => run({ account: counting(32, 51) }), "proof.account"],
    ["version and revision swapped against what was signed", () => run({ version: "abc123", revision: "flop-miner 0.9.1", signedVersion: "flop-miner 0.9.1", signedRevision: "abc123" }), "proof.signature"],
    ["the same joined bytes split another way", () => run({ version: "flop-miner 0.9.1a", revision: "bc123", signedVersion: "flop-miner 0.9.1", signedRevision: "abc123" }), "proof.signature"],
    ["ready false, signed over ready false", () => run({ ready: false }), "proof.ready"],
    ["ready true stated, signed over ready false", () => run({ ready: true, signedReady: false }), "proof.signature"],
    ["the identity point stated with a zero signature", () => run({ statedKey: filled(32, 0), signature: filled(64, 0) }), "proof.enclaveKey"],
  ];
  const fields = ["requestedSlug", "registryModel", "registryVersion", "modelHash", "precision", "decodePolicyHash", "measuredRoot", "backendModelName"] as const;
  for (const k of fields) {
    const changed = idCopy();
    if (k === "precision") changed.precision = 3;
    else if (k === "modelHash" || k === "decodePolicyHash" || k === "measuredRoot") changed[k] = counting(32, 77);
    else (changed as Record<string, unknown>)[k] = `${ID[k]}x`;
    rows.push([`identity field ${k} changed, signed by the pinned key`, () => run({ identity: changed }), `proof.identity.${k}`]);
  }
  // Neighbouring length prefixed texts: the slug and the registry model, the same joined text, another split.
  const moved = idCopy();
  moved.requestedSlug = "qwen-review-slugQ";
  moved.registryModel = "wen/ReviewModel";
  rows.push(["identity bytes moved between neighbouring texts", () => run({ identity: moved }), "proof.identity.requestedSlug"]);

  for (const [name, f, check] of rows)
    it(`HOLDS: refused, ${name} (PROOF, exit 5, check ${check})`, () => {
      expect(refusal(f)).toEqual({ refusal: "PROOF", check, exit: 5 });
    });

  it("HOLDS: the identity point and a zero decode policy are refused as pinned values", () => {
    expect(refusal(() => expected(filled(32, 0))).check).toBe("expected.enclaveKey");
    expect(refusal(() => expected(ENCLAVE.publicKey, { ...idCopy(), decodePolicyHash: filled(32, 0) })).check).toBe("expected.identity.decodePolicyHash");
  });

  it("HOLDS: a pinned value changed after it was made changes nothing: OTHER's proof is still refused", () => {
    const e = expected();
    (e.enclaveKey as Uint8Array).set(OTHER.publicKey);
    (e.identity.modelHash as Uint8Array).fill(9);
    expect(refusal(() => run({ signer: OTHER }, CHALLENGE, e)).check).toBe("proof.enclaveKey");
    expect(run({}, CHALLENGE, e).version).toBe("flop-miner 0.9.1");
  });

  it("HOLDS: RP6A-3: an info proof whose image version or revision is empty parses and verifies, its empty texts carried in the signed bytes with their lengths (M-19)", () => {
    for (const [version, revision] of [["", "abc123"], ["1", ""], ["", ""]] as const) {
      expect(run({ version, revision })).toEqual({ version, revision });
    }
  });

  it("HOLDS: RP6A-3: sessionInfoMessage takes an empty version or revision and writes it as the SDK does, a zero u32 length", () => {
    const m = { challenge: CHALLENGE, genesis: counting(32, 4), account: counting(32, 5), enclaveKey: ENCLAVE.publicKey, identity: idCopy(), ready: true, version: "", revision: "" };
    expect(hx(sessionInfoMessage(m))).toBe(hx(thirdSessionInfoMessage({ ...m, genesisHash: m.genesis })));
  });
});

// ---------------------------------------------------------------- Q4, the turn
describe("Q4: the turn", () => {
  const run = (o: TurnOpts = {}, v: { maxTokens?: number; channelId?: Uint8Array; edit?: (w: Record<string, unknown>) => void } = {}) => {
    const p = turnParts(o);
    v.edit?.(p.wire);
    return verifyTurn({ expected: expected(), channelId: v.channelId ?? CHANNEL, turn: turnOf(v.maxTokens ?? MAX_TOKENS), receipt: parseTurnReceipt(J(p.wire)) });
  };
  const check = (f: () => unknown) => refusal(f).check;

  it("HOLDS: a whole synthetic receipt verifies and gives the leaf of the third writing", () => {
    const t = run();
    expect(hx(t.leaf)).toBe(hx(turnParts().leaf));
    expect(t.text).toBe("hi there MARKERZQ");
  });

  const other = idCopy();
  other.backendModelName = "other-backend";
  const rows: [string, () => unknown, string][] = [
    ["leaf version V2", () => run({ leafVersion: "V2" }), "turn.leafVersion"],
    ["turn index 1, signed", () => run({ turnIndex: 1 }), "turn.turnIndex"],
    ["h_in of another input of the same length", () => run({ input: inputOf(65) }, { maxTokens: 64 }), "turn.hIn"],
    ["another decode policy, signed", () => run({ policy: counting(32, 40) }), "turn.decodePolicyHash"],
    ["h_ids all zero, signed", () => run({ hIds: filled(32, 0) }), "turn.hIds"],
    ["another backend name in the identity, h_out over it, signed", () => run({ identity: other }), "turn.identity.backendModelName"],
    ["finish reason tool_calls", () => run({ finishReason: "tool_calls" }), "turn.finishReason"],
    ["finish reason Stop", () => run({ finishReason: "Stop" }), "turn.finishReason"],
    ["completion tokens one above max_tokens", () => run({ completionTokens: BigInt(MAX_TOKENS) + 1n }), "turn.completionTokens"],
    ["an output that is not UTF-8 (C3 28)", () => run({ output: Uint8Array.of(0x68, 0xc3, 0x28) }), "turn.output"],
    ["an overlong NUL (C0 80)", () => run({ output: Uint8Array.of(0xc0, 0x80) }), "turn.output"],
    ["an encoded surrogate (ED A0 80)", () => run({ output: Uint8Array.of(0xed, 0xa0, 0x80) }), "turn.output"],
    ["a truncated sequence at the end (E2 82)", () => run({ output: Uint8Array.of(0x61, 0xe2, 0x82) }), "turn.output"],
    ["a framed output (FLOP-TURN-FRAMES-V1 NUL)", () => run({ output: new TextEncoder().encode("FLOP-TURN-FRAMES-V1\0\u0000\u0000\u0000\u0000\u0001a") }), "turn.output"],
    ["the reserved family prefix alone", () => run({ output: new TextEncoder().encode("FLOP-TURN-FRAMES-") }), "turn.output"],
    ["h_out of another output", () => run({ hOut: counting(32, 41) }), "turn.hOut"],
    ["done before recv", () => run({ recv: 10n, done: 9n, latency: 0n }), "turn.timing.order"],
    ["latency off by one", () => run({ latency: 588n }), "turn.timing.latency"],
    ["G_n of 2^64, signed", () => run({ gN: 1n << 64n }), "turn.gN"],
    ["G_n of 2^128 minus 1, signed", () => run({ gN: MAX128 }), "turn.gN"],
    ["a running root of another leaf", () => run({ root: counting(32, 42) }), "turn.runningRoot"],
    ["a signature by another key", () => run({ signer: OTHER }), "turn.enclaveSig"],
    ["a signature with one bit flipped", () => run({}, { edit: (w) => { const s = String(w.enclaveSig); w.enclaveSig = s.slice(0, -1) + (s.endsWith("0") ? "1" : "0"); } }), "turn.enclaveSig"],
    ["a valid receipt replayed under another channel id", () => run({}, { channelId: counting(32, 43) }), "turn.runningRoot"],
    ["a valid receipt for another channel, its root its own, under ours", () => run({ channelId: counting(32, 44) }), "turn.runningRoot"],
  ];
  for (const [name, f, c] of rows)
    it(`HOLDS: refused, ${name} (TURN, check ${c})`, () => {
      const r = refusal(f);
      expect([r.refusal, r.check, r.exit]).toEqual(["TURN", c, 1]);
    });

  it("HOLDS: the order of the refusals: version before index before h_in before policy before identity before output before h_out before timing before G_n before root before signature", () => {
    const bad: TurnOpts = { leafVersion: "V2", turnIndex: 1, hIn: counting(32, 60), policy: counting(32, 61), identity: other, output: Uint8Array.of(0xff), hOut: counting(32, 62), recv: 5n, done: 4n, latency: 0n, gN: 1n << 64n, root: counting(32, 63), signer: OTHER };
    const order = ["turn.leafVersion", "turn.turnIndex", "turn.hIn", "turn.decodePolicyHash", "turn.identity.backendModelName", "turn.output", "turn.hOut", "turn.timing.order", "turn.gN", "turn.runningRoot", "turn.enclaveSig"];
    const keys: (keyof TurnOpts)[] = ["leafVersion", "turnIndex", "hIn", "policy", "identity", "output", "hOut", "recv", "gN", "root", "signer"];
    const o: TurnOpts = { ...bad };
    for (let k = 0; k < keys.length; k++) {
      expect(check(() => run(o))).toBe(order[k]);
      const key = keys[k] as keyof TurnOpts;
      delete o[key];
      if (key === "recv") {
        delete o.done;
        delete o.latency;
      }
    }
    expect(run(o).leaf.length).toBe(32);
  });

  it("HOLDS: G_n at 2^64 minus 1 and times at the edges of a u64 pass when signed and consistent", () => {
    expect(run({ gN: MAX64 }).gN).toBe(MAX64);
    expect(run({ recv: 0n, done: MAX64 }).latencyMs).toBe(MAX64);
    expect(run({ recv: MAX64, done: MAX64 }).latencyMs).toBe(0n);
    expect(run({ completionTokens: BigInt(MAX_TOKENS), promptTokens: MAX64 }).completionTokens).toBe(64n);
  });

  it("HOLDS: an output the SDK does not take as framed passes as the SDK hashes it: a BOM before the prefix, and the prefix in lower case (the lab is exactly as strict as hasReservedTurnOutputPrefix)", () => {
    expect(run({ output: new TextEncoder().encode("﻿FLOP-TURN-FRAMES-V1") }).text).toBe("﻿FLOP-TURN-FRAMES-V1");
    expect(run({ output: new TextEncoder().encode("flop-turn-frames-v1") }).text).toBe("flop-turn-frames-v1");
    expect(run({ output: new TextEncoder().encode("FLOP-TURN-FRAMES") }).text).toBe("FLOP-TURN-FRAMES");
    expect(run({ output: new Uint8Array(0) }).text).toBe("");
  });

  it("HOLDS: RP6A-1: verifyTurn holds completion tokens to the max_tokens inside the input we sent, and takes no other max_tokens", () => {
    // The input we sent asks for at most 10 tokens and the miner states 50, signed: refused. There is no second
    // number to hand: the turn value holds the max_tokens of 10, and a maxTokens field beside it is itself refused.
    const input = inputOf(10);
    expect(() => run({ input, completionTokens: 50n }, { maxTokens: 10 })).toThrow(MinerError);
    const p = turnParts({ input, completionTokens: 50n });
    const handed = { expected: expected(), channelId: CHANNEL, turn: turnOf(10), receipt: parseTurnReceipt(J(p.wire)) };
    expect(refusal(() => verifyTurn({ ...handed, maxTokens: 100 } as never)).refusal).toBe("BAD_INPUT");
    expect(refusal(() => verifyTurn(handed)).check).toBe("turn.completionTokens");
  });

  it("HOLDS: RP6A-2: a receipt with no toplocCommitmentHash parses, and verifies over a leaf with 32 zero bytes for it (M-18)", () => {
    const p = turnParts({ toploc: null });
    expect("toplocCommitmentHash" in p.wire).toBe(false);
    const t = verifyTurn({ expected: expected(), channelId: CHANNEL, turn: turnOf(), receipt: parseTurnReceipt(J(p.wire)) });
    expect(hx(t.leaf)).toBe(hx(p.leaf));
  });

  it("HOLDS: RP6A-2: the parsed receipt holds null for an absent toplocCommitmentHash, never 32 zero bytes", () => {
    const r = parseTurnReceipt(J(turnParts({ toploc: null }).wire)) as unknown as Record<string, unknown>;
    expect(r.toplocCommitmentHash).toBeNull();
  });

  it("HOLDS: a receipt that states 32 zero bytes for toplocCommitmentHash verifies, as the SDK's leaf takes them", () => {
    expect(run({ toploc: filled(32, 0) }).leaf.length).toBe(32);
    expect(run({ toploc: counting(32, 70) }).leaf.length).toBe(32);
  });
});

// ---------------------------------------------------------------- Q5, the parsers and the JSON
describe("Q5: the parsers", () => {
  const turnWire = () => turnParts({ toploc: counting(32, 70) }).wire;
  const parseTurn = (w: Record<string, unknown>) => parseTurnReceipt(J(w));

  const hex32Fields = ["hIn", "hOut", "runningRoot", "decodePolicyHash", "hIds", "toplocCommitmentHash"];
  const decimalFields = ["gN", "minerRecvMs", "minerDoneMs", "latencyMs", "promptTokens", "completionTokens"];
  const badHex = (good: string): unknown[] => [good.toUpperCase().replace("0X", "0x"), good.slice(0, -2), good + "00", good.slice(2), "0X" + good.slice(2), " " + good, good + "\n", 1, null, true, [], {}];
  const badDecimal = ["", " 1", "1 ", "+1", "-1", "01", "1e2", "1.0", "0x1", "1".repeat(40), "١٢", "１", 1, null, true, "-0"];

  it("HOLDS: every 32 byte hex field of the receipt refuses each bad form and a missing value (WIRE)", () => {
    let n = 0;
    for (const k of hex32Fields) {
      for (const v of badHex(String(turnWire()[k]))) {
        const w = turnWire();
        w[k] = v;
        if (k === "toplocCommitmentHash" && v === null) {
          // RP6A-2 (M-18): a JSON null is absence for this one field, and parses to null.
          expect(parseTurn(w).toplocCommitmentHash).toBeNull();
          n++;
          continue;
        }
        let c = "accepted";
        try { c = refusal(() => parseTurn(w)).check; } catch { c = `accepted ${k} ${JSON.stringify(v)}`; }
        expect(c).toBe(`turn.${k}`);
        n++;
      }
      const w = turnWire();
      delete w[k];
      if (k === "toplocCommitmentHash") continue; // RP6A-2: absence is allowed by M-18.
      expect(refusal(() => parseTurn(w)).check).toBe(`turn.${k}`);
    }
    expect(n).toBe(72);
  });

  it("HOLDS: every decimal field of the receipt refuses each bad form, and u64 fields refuse 2^64", () => {
    for (const k of decimalFields) {
      for (const v of badDecimal) {
        const w = turnWire();
        w[k] = v;
        expect(refusal(() => parseTurn(w)).check).toBe(`turn.${k}`);
      }
      const w = turnWire();
      w[k] = (k === "gN" ? 1n << 128n : 1n << 64n).toString();
      expect(refusal(() => parseTurn(w)).check).toBe(`turn.${k}`);
    }
  });

  it("HOLDS: the turn index, the precision and the bounded texts refuse their bad forms", () => {
    for (const v of [-1, 1.5, 2 ** 32, "0", null, true, 2 ** 53]) {
      const w = turnWire();
      w.turnIndex = v;
      expect(refusal(() => parseTurn(w)).check).toBe("turn.turnIndex");
    }
    for (const v of [-1, 256, 2.5, "2"]) {
      const w = turnWire();
      (w.modelIdentity as Record<string, unknown>).precision = v;
      expect(refusal(() => parseTurn(w)).check).toBe("turn.modelIdentity.precision");
    }
    for (const v of ["", "x".repeat(257), "é".repeat(129), "a\u0000", "a\u0085", "\ud800", "a\udc00b", 5, null]) {
      const w = turnWire();
      w.finishReason = v;
      expect(refusal(() => parseTurn(w)).check).toBe("turn.finishReason");
    }
  });

  it("HOLDS: the leaf version, the output and the body forms", () => {
    for (const v of ["v3", "V4", "", 3, null]) {
      const w = turnWire();
      w.leafVersion = v;
      expect(refusal(() => parseTurn(w)).check).toBe("turn.leafVersion");
    }
    for (const v of ["0x0", "0xABCD", "abcd", "0x" + "61".repeat(2 * 1024 * 1024 + 1), 5]) {
      const w = turnWire();
      w.output = v;
      expect(refusal(() => parseTurn(w)).check).toBe("turn.output");
    }
    for (const body of ["", "not json", "[]", "null", '"text"', "1", "{", '{"a":1E400}']) {
      expect(refusal(() => parseTurnReceipt(body)).check).toBe("turn.body");
    }
  });

  it("HOLDS: an 8 MiB body is refused by its output bound, and a body nested 10000 deep in an extra key parses", () => {
    const w = turnWire();
    w.output = "0x" + "61".repeat(4 * 1024 * 1024);
    expect(refusal(() => parseTurn(w)).check).toBe("turn.output");
    const deep = "[".repeat(10000) + "]".repeat(10000);
    const text = J(turnWire()).slice(0, -1) + `,"extra":${deep}}`;
    expect(parseTurnReceipt(text).gN).toBe(38n);
  });

  it("HOLDS: duplicate keys read the last, as JSON.parse in the SDK reads them; __proto__, constructor and toString as keys change nothing", () => {
    const text = J(turnWire());
    const dup = `{"gN":"999",${text.slice(1)}`;
    expect(parseTurnReceipt(dup).gN).toBe(38n);
    const dupLast = text.slice(0, -1) + ',"gN":"7"}';
    expect(parseTurnReceipt(dupLast).gN).toBe(7n);
    const w = turnWire();
    delete w.leafVersion;
    const proto = J(w).slice(0, -1) + ',"__proto__":{"leafVersion":"V3"},"constructor":1,"toString":2}';
    expect(refusal(() => parseTurnReceipt(proto)).check).toBe("turn.leafVersion");
  });

  it("HOLDS: RP6A-4: the leaf version is read only as an own field of the body, never from the object's prototype", () => {
    const w = turnWire();
    delete w.leafVersion;
    const proto = Object.prototype as Record<string, unknown>;
    proto.leafVersion = "V3";
    let parsed: unknown = null;
    let threw = false;
    try {
      parsed = parseTurnReceipt(J(w));
    } catch {
      threw = true;
    } finally {
      delete proto.leafVersion;
    }
    expect({ threw, parsed: parsed === null ? null : "parsed" }).toEqual({ threw: true, parsed: null });
  });

  it("HOLDS (note on L4): a turn index written -0, 0.0, 0e5 or 1e-400 is read as the number 0, as the SDK's JSON.parse and its !== check read it, and gives the same leaf", () => {
    const base = J(turnWire());
    for (const form of ["-0", "0.0", "0e5", "1e-400"]) {
      const t = parseTurnReceipt(base.replace('"turnIndex":0', `"turnIndex":${form}`));
      expect(Object.is(t.turnIndex, 0) || Object.is(t.turnIndex, -0)).toBe(true);
      expect(t.turnIndex !== 0).toBe(false);
    }
    const v = verifyTurn({ expected: expected(), channelId: CHANNEL, turn: turnOf(), receipt: parseTurnReceipt(base.replace('"turnIndex":0', '"turnIndex":-0')) });
    expect(hx(v.leaf)).toBe(hx(turnParts({ toploc: counting(32, 70) }).leaf));
  });

  it("HOLDS: a trailing newline and spaces around the body are taken; extra keys are ignored", () => {
    const w = turnWire();
    w.zzz = "MARKERZQ";
    expect(parseTurnReceipt(`  ${J(w)}\n`).gN).toBe(38n);
  });

  it("HOLDS: the proof's hex is bare, lower case and exact; 0x is refused there; its exit is 5", () => {
    for (const k of ["genesis_hash", "account_id", "enclave_key"]) {
      const good = String(proofObject()[k]);
      for (const v of ["0x" + good, good.toUpperCase(), good.slice(2), good + "0", 7]) {
        const p = proofObject();
        p[k] = v;
        expect(refusal(() => parseInfoProof(J(p)))).toEqual({ refusal: "WIRE", check: `proof.${k}`, exit: 5 });
      }
    }
    const p = proofObject();
    p.signature = String(p.signature).slice(2);
    expect(refusal(() => parseInfoProof(J(p))).check).toBe("proof.signature");
    const q = proofObject();
    q.ready = "true";
    expect(refusal(() => parseInfoProof(J(q))).check).toBe("proof.ready");
  });

  it("HOLDS: the info: maxUnackedGn is not read in any form (M-20); a bad address is refused; verifyInfo passes the whole answer", () => {
    const i = infoObject();
    expect(() => verifyInfo({ expected: expected(), info: parseInfo(J(i)) })).not.toThrow();
    delete i.maxUnackedGn;
    expect("maxUnackedGn" in parseInfo(J(i))).toBe(false);
    for (const form of [null, 5, "", "x", [], {}, "1000", -1])
      expect("maxUnackedGn" in parseInfo(J({ ...i, maxUnackedGn: form }))).toBe(false);
    for (const v of ["", "5abc", 5, "x".repeat(65)]) {
      const j = infoObject();
      j.minerAddress = v;
      expect(refusal(() => parseInfo(J(j))).check).toBe("info.minerAddress");
    }
  });

  it("HOLDS: the close answer: settled absent or null is null; present, its channel id and tx hash are exact", () => {
    expect(parseCloseAnswer("{}").settled).toBeNull();
    expect(parseCloseAnswer('{"settled":null}').settled).toBeNull();
    const s = parseCloseAnswer(J({ settled: { channelId: hx0(CHANNEL), txHash: hx0(counting(32, 9)), minerPaid: "1" } })).settled;
    expect(s === null ? null : hx(s.channelId)).toBe(hx(CHANNEL));
    expect(refusal(() => parseCloseAnswer(J({ settled: { channelId: hx(CHANNEL), txHash: hx0(CHANNEL) } }))).check).toBe("close.settled.channelId");
    expect(refusal(() => parseCloseAnswer(J({ settled: 0 }))).check).toBe("close.settled");
  });
});

// ---------------------------------------------------------------- Q6, the money
describe("Q6: the money", () => {
  const base = { gN: 38n, gnCeiling: 100n, pricePerGn: 3_000_000_000_000_000n, basePerTurn: 2n, floor: 10n, budget: 38n * 3_000_000_000_000_000n + 12n };
  const money = (o: Partial<typeof base> = {}) => turnCost({ ...base, ...o });

  it("HOLDS: each bound of the turn's cost at both sides", () => {
    expect(money()).toEqual({ cost: 38n * 3_000_000_000_000_000n + 2n, total: base.budget });
    expect(refusal(() => money({ budget: base.budget - 1n })).check).toBe("money.budget");
    expect(money({ gN: 100n, budget: MAX128 }).cost).toBe(100n * base.pricePerGn + 2n);
    expect(refusal(() => money({ gN: 101n, budget: MAX128 })).check).toBe("money.gnCeiling");
    expect(refusal(() => money({ gN: MAX64, gnCeiling: MAX128, pricePerGn: MAX64 * 2n, budget: MAX128 })).check).toBe("money.cost");
    expect(money({ gN: 1n, pricePerGn: MAX128 - 1n, basePerTurn: 1n, floor: 0n, budget: MAX128 }).total).toBe(MAX128);
    expect(refusal(() => money({ gN: 1n, pricePerGn: MAX128 - 1n, basePerTurn: 1n, floor: 1n, budget: MAX128 })).check).toBe("money.total");
    expect(refusal(() => money({ floor: 100n, budget: 99n, gN: 0n, basePerTurn: 0n })).check).toBe("money.budget");
    expect(money({ gN: 0n }).cost).toBe(2n);
    for (const k of Object.keys(base) as (keyof typeof base)[]) expect(() => money({ [k]: 0n })).not.toThrow(TypeError);
    for (const k of Object.keys(base) as (keyof typeof base)[]) expect(refusal(() => money({ [k]: MAX128 + 1n })).refusal).toBe("BAD_INPUT");
    for (const k of Object.keys(base) as (keyof typeof base)[]) expect(refusal(() => money({ [k]: -1n })).refusal).toBe("BAD_INPUT");
    for (const k of Object.keys(base) as (keyof typeof base)[]) expect(refusal(() => money({ [k]: 5 as unknown as bigint })).refusal).toBe("BAD_INPUT");
  });

  it("HOLDS: the receipt's payable: 0, above the budget, below the tariff are refused; equal to each is taken", () => {
    const r = (o: Partial<{ payable: bigint; budget: bigint; basePerTurn: bigint; turns: bigint; aggregateGn: bigint }> = {}) => receiptPayable({ payable: 100n, budget: 100n, basePerTurn: 2n, turns: 1n, aggregateGn: 98n, ...o });
    expect(r()).toEqual({ payable: 100n, tariff: 100n });
    expect(refusal(() => r({ payable: 0n, budget: 0n, aggregateGn: 0n, basePerTurn: 0n })).check).toBe("receipt.payable");
    expect(refusal(() => r({ budget: 99n })).check).toBe("receipt.budget");
    expect(refusal(() => r({ aggregateGn: 99n })).check).toBe("receipt.tariff");
    expect(refusal(() => r({ basePerTurn: MAX128, turns: 2n, budget: MAX128 })).check).toBe("receipt.tariff");
    expect(chainTariff({ basePerTurn: 2n, turns: 1n, aggregateGn: 38n })).toBe(40n);
    expect(refusal(() => chainTariff({ basePerTurn: MAX128, turns: 1n, aggregateGn: 1n })).check).toBe("money.tariff");
  });
});

// ---------------------------------------------------------------- Q9, forging
describe("Q9: a value handed to a verify function cannot be forged", () => {
  const p = turnParts();
  const vt = (receipt: unknown, exp: unknown = expected()) => verifyTurn({ expected: exp as never, channelId: CHANNEL, turn: turnOf(), receipt: receipt as never });

  it("HOLDS: a hand made object, a Proxy, a subclass instance, a frozen copy and a parsed value of another kind are refused (BAD_INPUT)", () => {
    const parsed = parseTurnReceipt(J(p.wire));
    const forged: unknown[] = [
      { ...parsed },
      Object.freeze({ ...parsed }),
      new Proxy(parsed, {}),
      Object.create(parsed),
      parseInfoProof(J(proofObject())),
      parseCloseAnswer("{}"),
    ];
    for (const f of forged) expect(refusal(() => vt(f))).toEqual({ refusal: "BAD_INPUT", check: "turn", exit: 1 });
    const e = expected();
    for (const f of [{ ...e }, new Proxy(e, {}), Object.create(e)]) expect(refusal(() => vt(parsed, f)).check).toBe("expected");
    expect(refusal(() => verifyInfoProof({ expected: expected(), challenge: CHALLENGE, proof: new Proxy(parseInfoProof(J(proofObject())), {}) })).check).toBe("proof");
  });

  it("HOLDS: changing the arrays of a parsed value after it was made changes nothing that is checked", () => {
    const bad = turnParts({ hIn: counting(32, 90) });
    const parsed = parseTurnReceipt(J(bad.wire));
    (parsed.hIn as Uint8Array).set(p.leaf.length === 32 ? turnPartsHIn() : new Uint8Array(32));
    expect(refusal(() => verifyTurn({ expected: expected(), channelId: CHANNEL, turn: turnOf(), receipt: parsed })).check).toBe("turn.hIn");
    const good = parseTurnReceipt(J(p.wire));
    (good.output as Uint8Array).fill(0x41);
    (good.enclaveSig as Uint8Array).fill(0);
    expect(vt(good).text).toBe("hi there MARKERZQ");
  });

  it("HOLDS: turnInput takes only a value minerExpected made", () => {
    expect(refusal(() => turnInput({ expected: { ...expected() } as never, messages: [{ role: "user", content: "x" }], maxTokens: 1 })).check).toBe("expected");
  });
});

function turnPartsHIn(): Uint8Array {
  const w = turnParts().wire;
  return Uint8Array.from(String(w.hIn).slice(2).match(/../g)!.map((x) => parseInt(x, 16)));
}

// ---------------------------------------------------------------- Q7, the messages
describe("Q7: no refusal message carries the answer's or the caller's bytes or text", () => {
  afterAll(() => undefined);
  it("HOLDS: across every refusal raised in this file, no message holds a run of 8 or more hex digits that is not a fixed bound of the package, nor a marker of the answer or the input", () => {
    // Add refusals whose answer carries markers in every text field.
    const w = turnParts().wire;
    w.finishReason = "MARKERZQ\u0000";
    refusal(() => parseTurnReceipt(J(w)));
    const id = idCopy();
    id.registryModel = "WRONGZQ";
    refusal(() => verifyTurn({ expected: expected(), channelId: CHANNEL, turn: turnOf(), receipt: parseTurnReceipt(J(turnParts({ identity: id }).wire)) }));
    refusal(() => turnInput({ expected: expected(), messages: [{ role: "assistant" as never, content: "PROMPTZQ" }], maxTokens: 1 }));
    refusal(() => turnInput({ expected: expected(), messages: [{ role: "user", content: "PROMPTZQ\ud800" }], maxTokens: 1 }));
    refusal(() => minerExpected({ genesis: counting(31, 1), account: counting(32, 1), enclaveKey: counting(32, 1), identity: { ...idCopy(), requestedSlug: "SLUGZQ\u0001" } }));
    expect(SEEN.length).toBeGreaterThan(150);
    const allowed = new Set(["4294967295", "2097152"]);
    const runs = new Set<string>();
    for (const m of SEEN) {
      for (const r of m.match(/[0-9a-fA-F]{8,}/g) ?? []) if (!allowed.has(r)) runs.add(r);
      expect(m).not.toMatch(/MARKERZQ|WRONGZQ|PROMPTZQ|SLUGZQ|qwen-review|Qwen\/Review|flop-miner 0\.9/);
    }
    expect([...runs]).toEqual([]);
  });
});
