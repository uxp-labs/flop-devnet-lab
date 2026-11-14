/**
 * The parsers of the miner's answers (W10 to W13): the info proof, the signed info, the turn receipt and the close
 * answer, each from the answer's body text. Each goes through readOutsideJson, then reads only the fields the lab
 * needs, each in its exact form, and returns frozen typed values: bytes as Uint8Array, counts as bigint. A field
 * that is needed and missing, of another type or out of its form is refused (WIRE; exit 5 for the proof). Extra
 * keys are ignored and never echoed. A value absent where absence is allowed is null, never 0 and never empty.
 *
 * Each wire form is read from FLOP's SDK 0.6.0, not imported: `dist/miner-admission.js` (the proof: snake case,
 * bare hex), `dist/compute-channel/transport-http.js` (the info, `fetchMinerSessionInfo`; the receipt,
 * `encodeTurnReceipt` and `decodeTurnReceipt`; the close, `notifyMinerClose`) and FLOP's CLI 0.5.0 for the fields
 * of `settled`. No real answer of any of them is recorded anywhere: every form here is the SDK's source only.
 *
 * The verify functions take only a value a parser here made (`parsedOf`), and use the copy held here.
 */
import { freezeFunction } from "../freeze.js";
import { readOutsideJson } from "../outside-json.js";
import { ss58Decode } from "../ss58.js";
import { refuseMiner, refuseWire, type MinerAnswer } from "./errors.js";
import type { ModelIdentity } from "./expected.js";
import { decimalOf, hexBytes, imageTextProblem, LIMITS, textProblem, u128Max, u64Max, U32_MAX, U8_MAX, wholeOf } from "./forms.js";

export interface InfoProof {
  readonly genesis: Uint8Array;
  readonly account: Uint8Array;
  readonly enclaveKey: Uint8Array;
  readonly identity: ModelIdentity;
  readonly ready: boolean;
  /**
   * The image version and revision: the miner's own text, 0 to 256 bytes, control characters allowed. Shown only
   * through `src/server-text.ts`, never printed or logged as they are.
   */
  readonly version: string;
  readonly revision: string;
  /** 64 bytes. */
  readonly signature: Uint8Array;
}

export interface SignedInfo {
  /** The 32 bytes of the miner's SS58 address, any prefix. */
  readonly minerAccount: Uint8Array;
  readonly enclaveKey: Uint8Array;
  readonly modelHash: Uint8Array;
  readonly identity: ModelIdentity;
  readonly isReady: boolean;
}

export type LeafVersion = "V0" | "V1" | "V2" | "V3";

export interface TurnReceipt {
  readonly leafVersion: LeafVersion;
  readonly turnIndex: number;
  readonly hIn: Uint8Array;
  readonly hOut: Uint8Array;
  readonly output: Uint8Array;
  /** u128 as on the wire; verifyTurn holds it to a u64. */
  readonly gN: bigint;
  readonly minerRecvMs: bigint;
  readonly minerDoneMs: bigint;
  readonly latencyMs: bigint;
  readonly enclaveSig: Uint8Array;
  readonly runningRoot: Uint8Array;
  readonly decodePolicyHash: Uint8Array;
  readonly hIds: Uint8Array;
  /** 32 bytes as stated, or null when the miner stated none (absent or JSON null on the wire). Never 32 zero bytes for none. */
  readonly toplocCommitmentHash: Uint8Array | null;
  readonly promptTokens: bigint;
  readonly completionTokens: bigint;
  readonly finishReason: string;
  readonly identity: ModelIdentity;
}

export interface CloseAnswer {
  /** Absent or null on the wire: null. A hint only: P7 reads the chain. */
  readonly settled: { readonly channelId: Uint8Array; readonly txHash: Uint8Array } | null;
}

type Kind = "proof" | "info" | "turn" | "close";
const HELD = new WeakMap<object, { kind: Kind; value: unknown }>();

/** The held copy of a value the parser of `kind` made; anything else is refused (BAD_INPUT). */
export function parsedOf(kind: "proof", value: unknown): InfoProof;
export function parsedOf(kind: "info", value: unknown): SignedInfo;
export function parsedOf(kind: "turn", value: unknown): TurnReceipt;
export function parsedOf(kind: "close", value: unknown): CloseAnswer;
export function parsedOf(kind: Kind, value: unknown): unknown {
  const held = typeof value === "object" && value !== null ? HELD.get(value) : undefined;
  if (held === undefined || held.kind !== kind) return refuseMiner("BAD_INPUT", kind, `the ${kind} must be a value made by its parser`);
  return held.value;
}
freezeFunction(parsedOf);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A reader of one answer's fields: each refusal names the answer and the field, never a value or an extra key. */
function reader(answer: MinerAnswer) {
  const fail = (name: string, wanted: string): never => refuseWire(answer, `${answer}.${name}`, `the ${answer} field ${name} ${wanted}`);
  const get = (o: Obj, path: string, key: string): unknown => {
    const v = Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
    if (v === undefined) fail(path, "is missing");
    return v;
  };
  return {
    fail,
    obj(o: Obj, path: string, key: string): Obj {
      const v = get(o, path, key);
      if (!isObj(v)) fail(path, "must be an object");
      return v as Obj;
    },
    hex(o: Obj, path: string, key: string, n: number, prefixed: boolean): Uint8Array {
      const b = hexBytes(get(o, path, key), n, prefixed);
      if (b === null) fail(path, `must be ${prefixed ? "0x and " : "bare "}lower case hex of ${n} bytes`);
      return b as Uint8Array;
    },
    /** Like `hex`, but a key that is absent or JSON null is null: the field is optional. Present, it is held to its form. */
    hexOrNull(o: Obj, path: string, key: string, n: number, prefixed: boolean): Uint8Array | null {
      const v = Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
      if (v === undefined || v === null) return null;
      const b = hexBytes(v, n, prefixed);
      if (b === null) fail(path, `must be ${prefixed ? "0x and " : "bare "}lower case hex of ${n} bytes`);
      return b as Uint8Array;
    },
    /** A text that is one of `names`, read as an own field. */
    oneOf(o: Obj, path: string, key: string, names: readonly string[]): string {
      const v = get(o, path, key);
      if (typeof v !== "string" || !names.includes(v)) fail(path, `must be one of ${names.join(", ")}`);
      return v as string;
    },
    decimal(o: Obj, path: string, key: string, kind: "u64" | "u128"): bigint {
      const n = decimalOf(get(o, path, key), kind === "u64" ? u64Max() : u128Max());
      if (n === null) fail(path, `must be a plain decimal text inside a ${kind}`);
      return n as bigint;
    },
    whole(o: Obj, path: string, key: string, max: number): number {
      const n = wholeOf(get(o, path, key), max);
      if (n === null) fail(path, `must be a safe integer from 0 to ${max}`);
      return n as number;
    },
    bool(o: Obj, path: string, key: string): boolean {
      const v = get(o, path, key);
      if (typeof v !== "boolean") fail(path, "must be a boolean");
      return v as boolean;
    },
    /** The image version or revision of the proof (M-19): 0 to 256 bytes, well formed, control characters allowed. */
    imageText(o: Obj, path: string, key: string): string {
      const v = get(o, path, key);
      const problem = imageTextProblem(v);
      if (problem !== null) fail(path, problem);
      return v as string;
    },
    text(o: Obj, path: string, key: string, maxBytes?: number): string {
      const v = get(o, path, key);
      const problem = textProblem(v, maxBytes);
      if (problem !== null) fail(path, problem);
      return v as string;
    },
  };
}

/** The body as one JSON object. Its text is never quoted: JSON.parse's own error quotes it, so that error is dropped. */
function bodyOf(answer: MinerAnswer, text: unknown): Obj {
  if (typeof text !== "string") return refuseMiner("BAD_INPUT", answer, `the ${answer} body must be a string`);
  let value: unknown;
  try {
    value = readOutsideJson(text);
  } catch {
    return refuseWire(answer, `${answer}.body`, `the ${answer} body is not JSON this tool reads`);
  }
  if (!isObj(value)) refuseWire(answer, `${answer}.body`, `the ${answer} body must be a JSON object`);
  return value as Obj;
}

/** Hands out a frozen value, with fresh arrays, and holds the parsed one for the verify functions. */
function handOut<T extends object>(kind: Kind, held: T, out: T): T {
  HELD.set(out, { kind, value: held });
  return out;
}

const copyId = (i: ModelIdentity): ModelIdentity => Object.freeze({ ...i, modelHash: Uint8Array.from(i.modelHash), decodePolicyHash: Uint8Array.from(i.decodePolicyHash), measuredRoot: Uint8Array.from(i.measuredRoot) });
const deepCopy = <T extends object>(v: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = x instanceof Uint8Array ? Uint8Array.from(x) : k === "identity" ? copyId(x as ModelIdentity) : isObj(x) ? deepCopy(x) : x;
  return Object.freeze(out) as T;
};

/**
 * The info proof (`POST /session/info-proof`), as `verifySessionInfoProof` reads it: `genesis_hash`, `account_id`,
 * `enclave_key` (bare hex of 32 bytes), `model_identity` in snake case with bare hex, `ready` (a boolean),
 * `image.version` and `image.revision` (image texts: 0 to 256 bytes, control characters allowed, M-19), `signature` (bare hex of 64 bytes).
 */
export function parseInfoProof(text: string): InfoProof {
  const r = reader("proof");
  const b = bodyOf("proof", text);
  const m = r.obj(b, "model_identity", "model_identity");
  const identity: ModelIdentity = Object.freeze({
    requestedSlug: r.text(m, "model_identity.requested_slug", "requested_slug"),
    registryModel: r.text(m, "model_identity.registry_model", "registry_model"),
    registryVersion: r.text(m, "model_identity.registry_version", "registry_version"),
    modelHash: r.hex(m, "model_identity.model_hash", "model_hash", 32, false),
    precision: r.whole(m, "model_identity.precision", "precision", U8_MAX),
    decodePolicyHash: r.hex(m, "model_identity.decode_policy_hash", "decode_policy_hash", 32, false),
    measuredRoot: r.hex(m, "model_identity.measured_root", "measured_root", 32, false),
    backendModelName: r.text(m, "model_identity.backend_model_name", "backend_model_name"),
  });
  const image = r.obj(b, "image", "image");
  const held: InfoProof = Object.freeze({
    genesis: r.hex(b, "genesis_hash", "genesis_hash", 32, false),
    account: r.hex(b, "account_id", "account_id", 32, false),
    enclaveKey: r.hex(b, "enclave_key", "enclave_key", 32, false),
    identity,
    ready: r.bool(b, "ready", "ready"),
    version: r.imageText(image, "image.version", "version"),
    revision: r.imageText(image, "image.revision", "revision"),
    signature: r.hex(b, "signature", "signature", 64, false),
  });
  return handOut("proof", held, deepCopy(held));
}
freezeFunction(parseInfoProof);

/** A model identity in camel case with 0x hex, as `encodeIdentity` writes it in the info and the receipt. */
function camelIdentity(r: ReturnType<typeof reader>, o: Obj, key: string): ModelIdentity {
  const m = r.obj(o, key, key);
  return Object.freeze({
    requestedSlug: r.text(m, `${key}.requestedSlug`, "requestedSlug"),
    registryModel: r.text(m, `${key}.registryModel`, "registryModel"),
    registryVersion: r.text(m, `${key}.registryVersion`, "registryVersion"),
    modelHash: r.hex(m, `${key}.modelHash`, "modelHash", 32, true),
    precision: r.whole(m, `${key}.precision`, "precision", U8_MAX),
    decodePolicyHash: r.hex(m, `${key}.decodePolicyHash`, "decodePolicyHash", 32, true),
    measuredRoot: r.hex(m, `${key}.measuredRoot`, "measuredRoot", 32, true),
    backendModelName: r.text(m, `${key}.backendModelName`, "backendModelName"),
  });
}

/**
 * The signed info (`GET /session/info`), as `fetchMinerSessionInfo` reads it: `minerAddress` (SS58 text, decoded
 * here to its 32 bytes; a text that is not an SS58 account address is refused), `enclaveKey` and `modelHash` (0x
 * hex of 32 bytes), `modelIdentity` (camel case, 0x hex) and `is_ready` (a boolean). `maxUnackedGn` is not read, in
 * any form or when absent (M-20): the lab makes no use of it with one turn and one ack.
 */
export function parseInfo(text: string): SignedInfo {
  const r = reader("info");
  const b = bodyOf("info", text);
  const address = r.text(b, "minerAddress", "minerAddress", LIMITS.ADDRESS_MAX_BYTES);
  let minerAccount: Uint8Array;
  try {
    minerAccount = ss58Decode(address).pub;
  } catch {
    return r.fail("minerAddress", "must be an SS58 address of a 32 byte account with a good checksum");
  }
  const held: SignedInfo = Object.freeze({
    minerAccount: Uint8Array.from(minerAccount),
    enclaveKey: r.hex(b, "enclaveKey", "enclaveKey", 32, true),
    modelHash: r.hex(b, "modelHash", "modelHash", 32, true),
    identity: camelIdentity(r, b, "modelIdentity"),
    isReady: r.bool(b, "is_ready", "is_ready"),
  });
  return handOut("info", held, deepCopy(held));
}
freezeFunction(parseInfo);

const LEAF_VERSIONS: readonly string[] = Object.freeze(["V0", "V1", "V2", "V3"]);

/**
 * The turn receipt (`POST /session/turn`, one JSON body), as `encodeTurnReceipt` writes it. Read: `leafVersion` (one
 * of V0 to V3; verifyTurn takes V3 alone), `turnIndex` (a safe integer inside a u32); `hIn`, `hOut`, `runningRoot`,
 * `decodePolicyHash`, `hIds` (0x hex of 32 bytes); `toplocCommitmentHash` (0x hex of 32 bytes, or absent or null, which is null, M-18); `enclaveSig` (0x hex of 64 bytes);
 * `output` (0x hex of at most OUTPUT_MAX_BYTES bytes); `gN` (plain decimal inside a u128); `minerRecvMs`,
 * `minerDoneMs`, `latencyMs`, `promptTokens`, `completionTokens` (plain decimal inside a u64); `finishReason` (a
 * bounded text); `modelIdentity` (camel case, 0x hex). The provider fields and the version 3 fields must all be
 * present (W13, M-6): a receipt without them says nothing of the model or the tokens. The one exception is the
 * sampling commitment hash, which FLOP's client leaves out when the miner has none (M-18).
 */
export function parseTurnReceipt(text: string): TurnReceipt {
  const r = reader("turn");
  const b = bodyOf("turn", text);
  const leafVersion = r.oneOf(b, "leafVersion", "leafVersion", LEAF_VERSIONS);
  const outputRaw = Object.prototype.hasOwnProperty.call(b, "output") ? b.output : undefined;
  if (typeof outputRaw === "string" && outputRaw.length > 2 + 2 * LIMITS.OUTPUT_MAX_BYTES) r.fail("output", `must be at most ${LIMITS.OUTPUT_MAX_BYTES} bytes`);
  const output = hexBytes(outputRaw, null, true, LIMITS.OUTPUT_MAX_BYTES);
  if (output === null) r.fail("output", outputRaw === undefined ? "is missing" : "must be 0x and lower case hex of whole bytes");
  const held: TurnReceipt = Object.freeze({
    leafVersion: leafVersion as LeafVersion,
    turnIndex: r.whole(b, "turnIndex", "turnIndex", U32_MAX),
    hIn: r.hex(b, "hIn", "hIn", 32, true),
    hOut: r.hex(b, "hOut", "hOut", 32, true),
    output: output as Uint8Array,
    gN: r.decimal(b, "gN", "gN", "u128"),
    minerRecvMs: r.decimal(b, "minerRecvMs", "minerRecvMs", "u64"),
    minerDoneMs: r.decimal(b, "minerDoneMs", "minerDoneMs", "u64"),
    latencyMs: r.decimal(b, "latencyMs", "latencyMs", "u64"),
    enclaveSig: r.hex(b, "enclaveSig", "enclaveSig", 64, true),
    runningRoot: r.hex(b, "runningRoot", "runningRoot", 32, true),
    decodePolicyHash: r.hex(b, "decodePolicyHash", "decodePolicyHash", 32, true),
    hIds: r.hex(b, "hIds", "hIds", 32, true),
    toplocCommitmentHash: r.hexOrNull(b, "toplocCommitmentHash", "toplocCommitmentHash", 32, true),
    promptTokens: r.decimal(b, "promptTokens", "promptTokens", "u64"),
    completionTokens: r.decimal(b, "completionTokens", "completionTokens", "u64"),
    finishReason: r.text(b, "finishReason", "finishReason"),
    identity: camelIdentity(r, b, "modelIdentity"),
  });
  return handOut("turn", held, deepCopy(held));
}
freezeFunction(parseTurnReceipt);

/**
 * The close answer (`POST /session/close`): `settled` absent or null is null (the SDK then falls back to a forced
 * settle; the lab does not, S16). Otherwise `settled.channelId` and `settled.txHash` (0x hex of 32 bytes) are read,
 * as a hint for P7, which books nothing from it. Its other fields (minerPaid, burned, aggregateGn, cooperative) are
 * the miner's word on what only the chain decides, and are not read.
 */
export function parseCloseAnswer(text: string): CloseAnswer {
  const r = reader("close");
  const b = bodyOf("close", text);
  const raw = Object.prototype.hasOwnProperty.call(b, "settled") ? b.settled : undefined;
  let settled: CloseAnswer["settled"] = null;
  if (raw !== undefined && raw !== null) {
    const s = r.obj(b, "settled", "settled");
    settled = Object.freeze({ channelId: r.hex(s, "settled.channelId", "channelId", 32, true), txHash: r.hex(s, "settled.txHash", "txHash", 32, true) });
  }
  const held: CloseAnswer = Object.freeze({ settled });
  return handOut("close", held, deepCopy(held));
}
freezeFunction(parseCloseAnswer);
