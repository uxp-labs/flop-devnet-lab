/**
 * The bytes of the model identity, of the info proof's signed message and of the turn evidence (W7). Bytes only:
 * no hex, no signing, no verify. Every integer is little endian.
 *
 * Each layout is FLOP's SDK 0.6.0 as shipped, read and not imported: `dist/miner-admission.js`
 * (`modelIdentityHash`, `sessionInfoMessage`) and `dist/compute-channel/transcript.js` (`turnEvidenceHash`).
 * No committed record holds any of them. They are as the SDK's source describes them, and nothing more.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { concat, uintLE } from "../channel/bytes.js";
import { freezeFunction } from "../freeze.js";
import { bigIn, booleanIn, bytesIn, fieldsOf, imageTextIn, textIn } from "./check.js";
import { refuseMiner } from "./errors.js";
import { identityIn, type ModelIdentity } from "./expected.js";
import { LIMITS, utf8 } from "./forms.js";

/** The domain text of the model identity hash, 22 ASCII bytes. */
export const MODEL_IDENTITY_DOMAIN = "flop-model-identity-v1";
/** The domain text of the info proof's signed message, 20 ASCII bytes. */
export const SESSION_INFO_DOMAIN = "flop-session-info-v1";
/** The domain text of the turn evidence hash, 26 ASCII bytes. */
export const TURN_EVIDENCE_DOMAIN = "FLOP_CHAT_TURN_EVIDENCE_V1";

const blake = (b: Uint8Array): Uint8Array => blake2b(b, { dkLen: 32 });
/** u32 LE of the length, then the bytes. */
const lengthPrefixed = (b: Uint8Array): Uint8Array => concat(uintLE(BigInt(b.length), 4), b);
const text = (s: string): Uint8Array => lengthPrefixed(utf8(s));

/** The identity's fields in the order both the SDK's hashes write them, after their own domain and leading fields. */
function identityTail(i: ModelIdentity): Uint8Array {
  return concat(text(i.requestedSlug), text(i.registryModel), text(i.registryVersion), i.modelHash, Uint8Array.of(i.precision), i.decodePolicyHash, i.measuredRoot, text(i.backendModelName));
}

/**
 * The model identity hash, 32 bytes:
 * `blake2b-256( "flop-model-identity-v1" ‖ len‖slug ‖ len‖registry model ‖ len‖registry version ‖ model hash[32] ‖
 * precision u8 ‖ decode policy hash[32] ‖ measured root[32] ‖ len‖backend model name )`, each len a u32 LE of the
 * UTF-8 bytes. Source: `miner-admission.js`, `modelIdentityHash`.
 */
export function modelIdentityHash(identity: ModelIdentity): Uint8Array {
  const i = identityIn(identity, "identity");
  return blake(concat(utf8(MODEL_IDENTITY_DOMAIN), identityTail(i)));
}
freezeFunction(modelIdentityHash);

export interface SessionInfoInput {
  /** Our challenge, 32 bytes. */
  readonly challenge: Uint8Array;
  readonly genesis: Uint8Array;
  readonly account: Uint8Array;
  readonly enclaveKey: Uint8Array;
  readonly identity: ModelIdentity;
  readonly ready: boolean;
  /** The image's version and revision: image texts, 0 to 256 bytes, written with their lengths (an empty one is a zero length). */
  readonly version: string;
  readonly revision: string;
}
const SESSION_INFO_FIELDS = Object.freeze(["challenge", "genesis", "account", "enclaveKey", "identity", "ready", "version", "revision"] as const);

/**
 * The message the enclave key signs in the info proof, not hashed:
 * `"flop-session-info-v1" ‖ challenge[32] ‖ genesis[32] ‖ account[32] ‖ enclave key[32] ‖ model identity hash[32] ‖
 * ready u8 (1 or 0) ‖ len‖version ‖ len‖revision`. Source: `miner-admission.js`, `sessionInfoMessage`.
 */
export function sessionInfoMessage(input: SessionInfoInput): Uint8Array {
  const f = fieldsOf(input, SESSION_INFO_FIELDS, "session info");
  const challenge = bytesIn(f.challenge, 32, "session info.challenge");
  const genesis = bytesIn(f.genesis, 32, "session info.genesis");
  const account = bytesIn(f.account, 32, "session info.account");
  const enclaveKey = bytesIn(f.enclaveKey, 32, "session info.enclaveKey");
  const identityHash = modelIdentityHash(f.identity as ModelIdentity);
  const ready = booleanIn(f.ready, "session info.ready");
  const version = imageTextIn(f.version, "session info.version");
  const revision = imageTextIn(f.revision, "session info.revision");
  return concat(utf8(SESSION_INFO_DOMAIN), challenge, genesis, account, enclaveKey, identityHash, Uint8Array.of(ready ? 1 : 0), text(version), text(revision));
}
freezeFunction(sessionInfoMessage);

export interface TurnEvidenceInput {
  /** The turn's output bytes, at most LIMITS.OUTPUT_MAX_BYTES. */
  readonly output: Uint8Array;
  /** u64. */
  readonly promptTokens: bigint;
  /** u64. */
  readonly completionTokens: bigint;
  /** A bounded text. */
  readonly finishReason: string;
  readonly identity: ModelIdentity;
}
const TURN_EVIDENCE_FIELDS = Object.freeze(["output", "promptTokens", "completionTokens", "finishReason", "identity"] as const);

/**
 * The turn evidence hash, 32 bytes: h_out when the provider fields are present (they must be, M-6):
 * `blake2b-256( "FLOP_CHAT_TURN_EVIDENCE_V1" ‖ len‖output ‖ prompt tokens u64 ‖ completion tokens u64 ‖
 * len‖finish reason ‖ the identity as in the model identity hash )`. Source: `transcript.js`, `turnEvidenceHash`.
 */
export function turnEvidenceHash(input: TurnEvidenceInput): Uint8Array {
  const f = fieldsOf(input, TURN_EVIDENCE_FIELDS, "turn evidence");
  const output = bytesIn(f.output, null, "turn evidence.output");
  if (output.length > LIMITS.OUTPUT_MAX_BYTES) refuseMiner("BAD_INPUT", "turn evidence.output", `turn evidence.output must be at most ${LIMITS.OUTPUT_MAX_BYTES} bytes`);
  const prompt = bigIn("u64", f.promptTokens, "turn evidence.promptTokens");
  const completion = bigIn("u64", f.completionTokens, "turn evidence.completionTokens");
  const finish = textIn(f.finishReason, "turn evidence.finishReason");
  const identity = identityIn(f.identity, "turn evidence.identity");
  return blake(concat(utf8(TURN_EVIDENCE_DOMAIN), lengthPrefixed(output), uintLE(prompt, 8), uintLE(completion, 8), text(finish), identityTail(identity)));
}
freezeFunction(turnEvidenceHash);
