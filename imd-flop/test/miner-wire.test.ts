/**
 * P6a, T5 and T7 (messages): the four parsers of src/miner/wire.ts. For each field each bad form refuses with WIRE,
 * naming the answer and the field (exit 5 for the proof, 1 for the others): upper case hex, a short or long value,
 * 0x where bare is wanted and the reverse, a decimal with a sign, a space, a leading zero, an exponent, 40 digits; a
 * number that is not a safe integer; a string of 257 bytes, with a control character, empty, or with a lone
 * surrogate; a missing field; a field of another type. A body that is not JSON, an array, null. An output above the
 * maximum. An extra key is ignored. An absent maxUnackedGn or settled is null. No message holds a run of 16 hex
 * digits or a text of the answer.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/errors.js";
import { MinerError } from "../src/miner/errors.js";
import { LIMITS } from "../src/miner/forms.js";
import { parseCloseAnswer, parseInfo, parseInfoProof, parseTurnReceipt } from "../src/miner/wire.js";
import { referenceReady } from "./lib/sr25519-reference.js";
import { closeObject, filled, hex, HEX_RUN, infoObject, proofObject, refSs58, scenario, turnObject } from "./lib/miner-answers.js";

beforeAll(referenceReady);

type Obj = Record<string, unknown>;
type Kind = "bare32" | "bare64" | "hex32" | "hex64" | "u64" | "u128" | "u8" | "u32" | "bool" | "text" | "obj";

const PARSERS = { proof: parseInfoProof, info: parseInfo, turn: parseTurnReceipt, close: parseCloseAnswer } as const;
type Answer = keyof typeof PARSERS;

const clone = (o: Obj): Obj => JSON.parse(JSON.stringify(o));
function setPath(o: Obj, path: string, v: unknown): Obj {
  const out = clone(o);
  const keys = path.split(".");
  let at: Obj = out;
  for (const k of keys.slice(0, -1)) at = at[k] as Obj;
  const last = keys[keys.length - 1] as string;
  if (v === DELETE) delete at[last];
  else at[last] = v;
  return out;
}
const DELETE = Symbol("delete");

/** A JSON text with one value put in raw (for forms JSON.stringify cannot write, as 1e3 and big numbers). */
const rawAt = (o: Obj, path: string, raw: string): string => JSON.stringify(setPath(o, path, "__RAW__")).replace('"__RAW__"', raw);

const big = (n: bigint) => n.toString();

/** Every bad form of a kind, given the good value. Each is a JSON value, or a raw text for a number JSON cannot hold exactly. */
function badForms(kind: Kind, good: unknown): { name: string; value?: unknown; raw?: string }[] {
  const g = good as string;
  const forms: { name: string; value?: unknown; raw?: string }[] = [{ name: "missing", value: DELETE }];
  const hexForms = (n: number, prefixed: boolean) => {
    const body = prefixed ? g.slice(2) : g;
    const pre = prefixed ? "0x" : "";
    forms.push(
      { name: "upper case", value: pre + "A" + body.slice(1).replace(/[a-f]/g, (c) => c.toUpperCase()) },
      { name: "upper case 0X", value: prefixed ? "0X" + body : "0X" + body.slice(2) },
      { name: "short", value: pre + body.slice(2) },
      { name: "long", value: pre + body + "00" },
      { name: "odd", value: pre + body.slice(1) },
      { name: "not hex", value: pre + "g" + body.slice(1) },
      { name: prefixed ? "bare" : "with 0x", value: prefixed ? body : "0x" + body.slice(2) },
      { name: "a number", value: 7 },
      { name: "null", value: null },
    );
    void n;
  };
  switch (kind) {
    case "bare32":
    case "bare64":
      hexForms(kind === "bare32" ? 32 : 64, false);
      break;
    case "hex32":
    case "hex64":
      hexForms(kind === "hex32" ? 32 : 64, true);
      break;
    case "u64":
    case "u128": {
      const width = kind === "u64" ? 64n : 128n;
      forms.push(
        { name: "a sign", value: "-1" },
        { name: "a plus", value: "+1" },
        { name: "a space", value: " 1" },
        { name: "a trailing space", value: "1 " },
        { name: "a leading zero", value: "01" },
        { name: "an exponent", value: "1e3" },
        { name: "a point", value: "1.0" },
        { name: "hex", value: "0x1" },
        { name: "empty", value: "" },
        { name: "40 digits", value: "1" + "0".repeat(39) },
        { name: "past its type", value: big(1n << width) },
        { name: "a JSON number", value: 1 },
        { name: "a JSON exponent", raw: "1e3" },
      );
      break;
    }
    case "u8":
    case "u32":
      forms.push(
        { name: "a fraction", value: 1.5 },
        { name: "negative", value: -1 },
        { name: "a string", value: "0" },
        { name: "past its type", value: kind === "u8" ? 256 : 2 ** 32 },
        { name: "not a safe integer", raw: "9007199254740993" },
        { name: "a boolean", value: true },
      );
      break;
    case "bool":
      forms.push({ name: "a string", value: "true" }, { name: "a number", value: 1 }, { name: "null", value: null });
      break;
    case "text":
      forms.push(
        { name: "257 bytes", value: "x".repeat(257) },
        { name: "257 bytes of two byte characters", value: "é".repeat(128) + "x" },
        { name: "a control character", value: "a\u0001b" },
        { name: "a DEL", value: "a\u007fb" },
        { name: "a C1 control", value: "a\u0085b" },
        { name: "a lone surrogate", value: "a\ud800b" },
        { name: "empty", value: "" },
        { name: "a number", value: 1 },
      );
      break;
    case "obj":
      forms.push({ name: "an array", value: [] }, { name: "a string", value: "x" }, { name: "null", value: null });
      break;
  }
  return forms;
}

const identitySnake: [string, Kind][] = [
  ["model_identity.requested_slug", "text"],
  ["model_identity.registry_model", "text"],
  ["model_identity.registry_version", "text"],
  ["model_identity.model_hash", "bare32"],
  ["model_identity.precision", "u8"],
  ["model_identity.decode_policy_hash", "bare32"],
  ["model_identity.measured_root", "bare32"],
  ["model_identity.backend_model_name", "text"],
];
const identityCamel = (key: string): [string, Kind][] => [
  [`${key}.requestedSlug`, "text"],
  [`${key}.registryModel`, "text"],
  [`${key}.registryVersion`, "text"],
  [`${key}.modelHash`, "hex32"],
  [`${key}.precision`, "u8"],
  [`${key}.decodePolicyHash`, "hex32"],
  [`${key}.measuredRoot`, "hex32"],
  [`${key}.backendModelName`, "text"],
];

const FIELDS: Record<Answer, [string, Kind][]> = {
  proof: [["genesis_hash", "bare32"], ["account_id", "bare32"], ["enclave_key", "bare32"], ["model_identity", "obj"], ...identitySnake, ["ready", "bool"], ["image", "obj"], ["image.version", "text"], ["image.revision", "text"], ["signature", "bare64"]],
  info: [["enclaveKey", "hex32"], ["modelHash", "hex32"], ["modelIdentity", "obj"], ...identityCamel("modelIdentity"), ["is_ready", "bool"]],
  turn: [
    ["turnIndex", "u32"], ["hIn", "hex32"], ["hOut", "hex32"], ["gN", "u128"], ["minerRecvMs", "u64"], ["minerDoneMs", "u64"], ["latencyMs", "u64"],
    ["enclaveSig", "hex64"], ["runningRoot", "hex32"], ["decodePolicyHash", "hex32"], ["hIds", "hex32"], ["toplocCommitmentHash", "hex32"],
    ["promptTokens", "u64"], ["completionTokens", "u64"], ["finishReason", "text"], ["modelIdentity", "obj"], ...identityCamel("modelIdentity"),
  ],
  close: [["settled", "obj"], ["settled.channelId", "hex32"], ["settled.txHash", "hex32"]],
};

function goodOf(answer: Answer): Obj {
  const s = scenario();
  if (answer === "proof") return proofObject(s);
  if (answer === "info") return infoObject(s);
  if (answer === "turn") return turnObject(s);
  return closeObject(filled(32, 0x77), filled(32, 0xaa));
}

function textsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string" && v.length >= 3) out.push(v);
  else if (v && typeof v === "object") for (const x of Object.values(v)) textsOf(x, out);
  return out;
}

function wireRefusal(answer: Answer, body: string, check: string): void {
  let caught: unknown;
  try {
    PARSERS[answer](body);
  } catch (e) {
    caught = e;
  }
  expect(caught, `${check} was not refused`).toBeInstanceOf(MinerError);
  const e = caught as MinerError;
  expect([e.refusal, e.check, e.code]).toEqual(["WIRE", check, answer === "proof" ? EXIT.REFUSED_RULE : EXIT.ERROR]);
  expect(e.message).not.toMatch(HEX_RUN);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* not JSON: the body itself is the text */
  }
  for (const t of parsed === null ? [body] : textsOf(parsed)) if (t.length >= 3) expect(e.message.includes(t), `quotes ${t.slice(0, 20)}`).toBe(false);
}

describe("T5: each parser accepts its whole answer", () => {
  it("the proof, the info, the turn and the close", () => {
    const s = scenario();
    const p = parseInfoProof(JSON.stringify(proofObject(s)));
    expect([hex(p.genesis), p.ready, p.version, p.identity.precision]).toEqual([hex(s.genesis), true, s.version, s.identity.precision]);
    const i = parseInfo(JSON.stringify(infoObject(s)));
    expect([hex(i.minerAccount), i.isReady, i.maxUnackedGn]).toEqual([hex(s.account), true, 0n]);
    const t = parseTurnReceipt(JSON.stringify(turnObject(s)));
    expect([t.leafVersion, t.turnIndex, t.gN, t.finishReason]).toEqual(["V3", 0, s.gN, "stop"]);
    const c = parseCloseAnswer(JSON.stringify(closeObject(filled(32, 1), filled(32, 2))));
    expect(c.settled && [hex(c.settled.channelId), hex(c.settled.txHash)]).toEqual([hex(filled(32, 1)), hex(filled(32, 2))]);
    for (const v of [p, i, t, c]) expect(Object.isFrozen(v)).toBe(true);
  });

  it("leaf versions V0 to V3 are read (verifyTurn takes V3 alone); any other word is refused", () => {
    const s = scenario();
    for (const v of ["V0", "V1", "V2", "V3"]) expect(parseTurnReceipt(JSON.stringify({ ...turnObject(s), leafVersion: v })).leafVersion).toBe(v);
    for (const v of ["V4", "v3", 3, null]) wireRefusal("turn", JSON.stringify({ ...turnObject(s), leafVersion: v }), "turn.leafVersion");
    wireRefusal("turn", JSON.stringify(setPath(turnObject(s), "leafVersion", DELETE)), "turn.leafVersion");
  });

  it("the widest values of each kind are read", () => {
    const s = scenario();
    const t = parseTurnReceipt(JSON.stringify({ ...turnObject(s), turnIndex: 2 ** 32 - 1, gN: big((1n << 128n) - 1n), latencyMs: big((1n << 64n) - 1n), promptTokens: "0" }));
    expect([t.turnIndex, t.gN, t.latencyMs, t.promptTokens]).toEqual([2 ** 32 - 1, (1n << 128n) - 1n, (1n << 64n) - 1n, 0n]);
    const p = parseInfoProof(JSON.stringify(setPath(proofObject(s), "model_identity.precision", 255)));
    expect(p.identity.precision).toBe(255);
    const longest = "\u{1F600}".repeat(64);
    expect(parseInfoProof(JSON.stringify(setPath(proofObject(s), "image.version", longest))).version).toBe(longest);
  });
});

for (const answer of Object.keys(FIELDS) as Answer[]) {
  describe(`T5: the ${answer} refuses each bad form of each field`, () => {
    for (const [path, kind] of FIELDS[answer]) {
      it(`${path} (${kind})`, () => {
        const good = goodOf(answer);
        const value = path.split(".").reduce<unknown>((o, k) => (o as Obj)[k], good);
        for (const f of badForms(kind, value)) {
          if (answer === "close" && path === "settled" && (f.value === DELETE || f.value === null)) continue;
          const body = f.raw !== undefined ? rawAt(good, path, f.raw) : JSON.stringify(setPath(good, path, f.value));
          wireRefusal(answer, body, `${answer}.${path}`);
        }
      });
    }
  });
}

describe("T5: the bodies", () => {
  for (const answer of Object.keys(PARSERS) as Answer[]) {
    it(`the ${answer}: not JSON, an array, null, a number, a string and a non finite number are refused as the body`, () => {
      for (const body of ["{", "not json at all", "[]", "null", "7", '"text"', '{"a":1e999}', ""]) wireRefusal(answer, body, `${answer}.body`);
    });
    it(`the ${answer}: a body that is not a string is the caller's error (BAD_INPUT)`, () => {
      expect(() => PARSERS[answer](7 as never)).toThrow(/BAD_INPUT/);
    });
    it(`the ${answer}: extra keys are ignored and never echoed`, () => {
      const good = goodOf(answer);
      const body = JSON.stringify({ ...good, extraKeyNotRead: "secretish", __proto__x: 1, ["0xdeadbeefdeadbeefdeadbeef"]: 1 });
      expect(() => PARSERS[answer](body)).not.toThrow();
      const withProto = JSON.stringify(good).replace(/^\{/, '{"__proto__":{"x":1},');
      expect(() => PARSERS[answer](withProto)).not.toThrow();
    });
  }
});

describe("T5: the info's address and absences", () => {
  const s = () => scenario();
  it("an absent or null maxUnackedGn is null, never 0", () => {
    expect(parseInfo(JSON.stringify(setPath(infoObject(s()), "maxUnackedGn", DELETE))).maxUnackedGn).toBeNull();
    expect(parseInfo(JSON.stringify(setPath(infoObject(s()), "maxUnackedGn", null))).maxUnackedGn).toBeNull();
    expect(parseInfo(JSON.stringify(setPath(infoObject(s()), "maxUnackedGn", "12"))).maxUnackedGn).toBe(12n);
  });
  it("a present maxUnackedGn of a bad form is refused", () => {
    for (const f of badForms("u128", "0").filter((f) => f.value !== DELETE && f.value !== null)) {
      const body = f.raw !== undefined ? rawAt(infoObject(s()), "maxUnackedGn", f.raw) : JSON.stringify(setPath(infoObject(s()), "maxUnackedGn", f.value));
      wireRefusal("info", body, "info.maxUnackedGn");
    }
  });
  it("the minerAddress: a bad checksum, not base58, too short, too long, empty, missing or a number are refused", () => {
    const good = refSs58(s().account);
    const flip = good.slice(0, -1) + (good.endsWith("1") ? "2" : "1");
    for (const v of [flip, "0OIl", "5F", good + good, "", 7, DELETE, refSs58(filled(32, 1)).slice(0, 20)]) {
      wireRefusal("info", JSON.stringify(setPath(infoObject(s()), "minerAddress", v)), "info.minerAddress");
    }
  });
  it("an absent or null settled is null", () => {
    expect(parseCloseAnswer("{}").settled).toBeNull();
    expect(parseCloseAnswer('{"settled":null}').settled).toBeNull();
  });
});

describe("T5: the turn's output", () => {
  const s = () => scenario();
  it("an output of exactly the maximum is read; one byte more is refused", () => {
    const at = "0x" + "61".repeat(LIMITS.OUTPUT_MAX_BYTES);
    expect(parseTurnReceipt(JSON.stringify({ ...turnObject(s()), output: at })).output.length).toBe(LIMITS.OUTPUT_MAX_BYTES);
    wireRefusal("turn", JSON.stringify({ ...turnObject(s()), output: at + "61" }), "turn.output");
  });
  it("the output's bad forms are refused: upper case, odd, bare, not hex, missing, a number", () => {
    for (const v of ["0x4A", "0x486", "4865", "0x4g", DELETE, 7, null, "0X48"]) wireRefusal("turn", JSON.stringify(setPath(turnObject(s()), "output", v)), "turn.output");
  });
  it("an empty output 0x is read as 0 bytes", () => {
    expect(parseTurnReceipt(JSON.stringify({ ...turnObject(s()), output: "0x" })).output.length).toBe(0);
  });
});
