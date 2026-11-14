/**
 * The checks of the miner's word against what the owner pinned and against hashes rebuilt here (W14 to W16). Each
 * takes a value `minerExpected` made and a value one of the parsers made, and nothing the miner says chooses a key:
 * every signature is verified under the pinned enclave key, through `verifyChannelSignature` of src/channel. The
 * first check that fails refuses, naming that check. Nothing here signs.
 */
import { bytesEqual } from "../ss58.js";
import { verifyChannelSignature } from "../channel/key.js";
import { freezeFunction } from "../freeze.js";
import { bytesIn, fieldsOf, wholeIn } from "./check.js";
import { refuseMiner } from "./errors.js";
import { IDENTITY_FIELDS, pinnedOf, type Expected, type ModelIdentity } from "./expected.js";
import { allZero, LIMITS, u64Max } from "./forms.js";
import { sessionInfoMessage, turnEvidenceHash } from "./identity.js";
import { inputHash } from "./input.js";
import { leafV3 } from "./leaf.js";
import { parsedOf, type InfoProof, type SignedInfo, type TurnReceipt } from "./wire.js";

/** The reserved prefix of a signed framed output (`transport-http.js`, `SIGNED_FRAMES_FAMILY`): framed and tool outputs start with it. */
export const FRAMED_OUTPUT_PREFIX = "FLOP-TURN-FRAMES-";
/** The finish reasons a plain chat turn may end with. `tool_calls` is a tool output and is refused. */
export const FINISH_REASONS = Object.freeze(["stop", "length"] as const);

/** The first identity field that differs, or null. */
function identityDiffers(a: ModelIdentity, b: ModelIdentity): string | null {
  for (const k of IDENTITY_FIELDS) {
    const x = a[k];
    const y = b[k];
    const same = x instanceof Uint8Array && y instanceof Uint8Array ? bytesEqual(x, y) : x === y;
    if (!same) return k;
  }
  return null;
}

/** A fresh plain copy of an identity, to hand to a function that checks its input. */
const identityCopy = (i: ModelIdentity): ModelIdentity => ({ ...i, modelHash: Uint8Array.from(i.modelHash), decodePolicyHash: Uint8Array.from(i.decodePolicyHash), measuredRoot: Uint8Array.from(i.measuredRoot) });

const signedBy = (key: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean =>
  verifyChannelSignature({ publicKey: Uint8Array.from(key), message, signature: Uint8Array.from(signature) });

export interface ProofVerified {
  readonly version: string;
  readonly revision: string;
}

/**
 * The info proof (W14). In this order: the proof's genesis, account, enclave key and each field of the model
 * identity equal the pinned ones; ready is true; then the signature verifies under the PINNED key over the message
 * built from OUR challenge. Any failure refuses with PROOF (exit 5). Returns the image version and revision.
 */
export function verifyInfoProof(input: { readonly expected: Expected; readonly challenge: Uint8Array; readonly proof: InfoProof }): ProofVerified {
  const f = fieldsOf(input, ["expected", "challenge", "proof"], "verifyInfoProof input");
  const e = pinnedOf(f.expected);
  const challenge = bytesIn(f.challenge, 32, "verifyInfoProof challenge");
  const p = parsedOf("proof", f.proof);
  const fail = (check: string, msg: string): never => refuseMiner("PROOF", `proof.${check}`, msg);
  if (!bytesEqual(p.genesis, e.genesis)) fail("genesis", "the proof's genesis is not the pinned genesis");
  if (!bytesEqual(p.account, e.account)) fail("account", "the proof's account is not the pinned miner account");
  if (!bytesEqual(p.enclaveKey, e.enclaveKey)) fail("enclaveKey", "the proof's enclave key is not the pinned enclave key");
  const d = identityDiffers(p.identity, e.identity);
  if (d !== null) fail(`identity.${d}`, `the proof's model identity field ${d} is not the pinned one`);
  if (p.ready !== true) fail("ready", "the proof does not say ready");
  const message = sessionInfoMessage({ challenge, genesis: Uint8Array.from(e.genesis), account: Uint8Array.from(e.account), enclaveKey: Uint8Array.from(e.enclaveKey), identity: identityCopy(e.identity), ready: true, version: p.version, revision: p.revision });
  if (!signedBy(e.enclaveKey, message, p.signature)) fail("signature", "the proof's signature does not verify under the pinned enclave key over our challenge");
  return Object.freeze({ version: p.version, revision: p.revision });
}
freezeFunction(verifyInfoProof);

export interface InfoVerified {
  /** The miner's stated fence, read only; null when the miner did not state one. */
  readonly maxUnackedGn: bigint | null;
}

/**
 * The signed info (W15): the miner address's 32 bytes equal the pinned account; the enclave key, the model hash
 * and each field of the model identity equal the pinned ones; is_ready is true. Failure refuses with INFO.
 */
export function verifyInfo(input: { readonly expected: Expected; readonly info: SignedInfo }): InfoVerified {
  const f = fieldsOf(input, ["expected", "info"], "verifyInfo input");
  const e = pinnedOf(f.expected);
  const i = parsedOf("info", f.info);
  const fail = (check: string, msg: string): never => refuseMiner("INFO", `info.${check}`, msg);
  if (!bytesEqual(i.minerAccount, e.account)) fail("minerAddress", "the info's miner address is not the pinned miner account");
  if (!bytesEqual(i.enclaveKey, e.enclaveKey)) fail("enclaveKey", "the info's enclave key is not the pinned enclave key");
  if (!bytesEqual(i.modelHash, e.identity.modelHash)) fail("modelHash", "the info's model hash is not the pinned one");
  const d = identityDiffers(i.identity, e.identity);
  if (d !== null) fail(`identity.${d}`, `the info's model identity field ${d} is not the pinned one`);
  if (i.isReady !== true) fail("is_ready", "the info does not say ready");
  return Object.freeze({ maxUnackedGn: i.maxUnackedGn });
}
freezeFunction(verifyInfo);

export interface VerifiedTurn {
  readonly leaf: Uint8Array;
  readonly gN: bigint;
  readonly promptTokens: bigint;
  readonly completionTokens: bigint;
  readonly finishReason: string;
  readonly output: Uint8Array;
  readonly text: string;
  readonly minerRecvMs: bigint;
  readonly minerDoneMs: bigint;
  readonly latencyMs: bigint;
  readonly enclaveSig: Uint8Array;
}

export interface VerifyTurnInput {
  readonly expected: Expected;
  readonly channelId: Uint8Array;
  /** The input bytes WE sent. */
  readonly input: Uint8Array;
  /** The request's max_tokens. */
  readonly maxTokens: number;
  readonly receipt: TurnReceipt;
}

const FRAMED = new TextEncoder().encode(FRAMED_OUTPUT_PREFIX);
const startsWith = (b: Uint8Array, p: Uint8Array): boolean => b.length >= p.length && p.every((x, i) => b[i] === x);

/**
 * One turn (W16), checked in this order, the first failure refusing with TURN and the name of the check:
 *  1. leafVersion: V3;
 *  2. turnIndex: 0 (one turn per run, M-4);
 *  3. hIn: the blake2b 256 of our input bytes;
 *  4. decodePolicyHash: the pinned one; hIds: not all zero (V3 in `leafFieldsConsistent`; the TOPLOC hash may be anything);
 *  5. identity: each field the pinned one; finishReason: stop or length; completionTokens: at most maxTokens;
 *  6. output: UTF-8, decoded fatally, and not starting with the reserved framed prefix;
 *  7. hOut: the evidence hash rebuilt from the output, the tokens, the finish reason and the PINNED identity;
 *  8. timing: done at or after recv, and latency equal to done minus recv;
 *  9. gN: at most 2^64 minus 1;
 * 10. runningRoot: the leaf rebuilt from the fields (one turn: the root is the leaf);
 * 11. enclaveSig: verifies under the pinned key over that leaf.
 */
export function verifyTurn(value: VerifyTurnInput): VerifiedTurn {
  const f = fieldsOf(value, ["expected", "channelId", "input", "maxTokens", "receipt"], "verifyTurn input");
  const e = pinnedOf(f.expected);
  const channelId = bytesIn(f.channelId, 32, "verifyTurn channelId");
  const input = bytesIn(f.input, null, "verifyTurn input");
  const maxTokens = wholeIn(f.maxTokens, 1, LIMITS.MAX_TOKENS_MAX, "verifyTurn maxTokens");
  const r = parsedOf("turn", f.receipt);
  const fail = (check: string, msg: string): never => refuseMiner("TURN", `turn.${check}`, msg);

  if (r.leafVersion !== "V3") fail("leafVersion", "the leaf version must be V3");
  if (r.turnIndex !== 0) fail("turnIndex", "the turn index must be 0: one turn per run");
  const hIn = inputHash({ input });
  if (!bytesEqual(r.hIn, hIn)) fail("hIn", "h_in is not the hash of the input we sent");
  if (!bytesEqual(r.decodePolicyHash, e.identity.decodePolicyHash)) fail("decodePolicyHash", "the decode policy is not the pinned one");
  if (allZero(r.hIds)) fail("hIds", "h_ids must not be all zero in a version 3 leaf");
  const d = identityDiffers(r.identity, e.identity);
  if (d !== null) fail(`identity.${d}`, `the receipt's model identity field ${d} is not the pinned one`);
  if (!(FINISH_REASONS as readonly string[]).includes(r.finishReason)) fail("finishReason", `the finish reason must be one of ${FINISH_REASONS.join(", ")}`);
  if (r.completionTokens > BigInt(maxTokens)) fail("completionTokens", "the completion tokens are more than max_tokens");
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(r.output);
  } catch {
    fail("output", "the output is not UTF-8");
  }
  if (startsWith(r.output, FRAMED)) fail("output", "the output is framed (it starts with the reserved prefix): framed and tool outputs are refused");
  const hOut = turnEvidenceHash({ output: Uint8Array.from(r.output), promptTokens: r.promptTokens, completionTokens: r.completionTokens, finishReason: r.finishReason, identity: identityCopy(e.identity) });
  if (!bytesEqual(r.hOut, hOut)) fail("hOut", "h_out is not the evidence hash rebuilt from the output, the tokens, the finish reason and the pinned identity");
  if (r.minerDoneMs < r.minerRecvMs) fail("timing.order", "the miner's done time is before its receive time");
  if (r.latencyMs !== r.minerDoneMs - r.minerRecvMs) fail("timing.latency", "the latency is not done minus receive");
  if (r.gN > u64Max()) fail("gN", "G_n must be at most 2^64 minus 1");
  const leaf = leafV3({
    channelId,
    turnIndex: r.turnIndex,
    hIn,
    hOut: Uint8Array.from(r.hOut),
    gN: r.gN,
    decodePolicyHash: Uint8Array.from(r.decodePolicyHash),
    hIds: Uint8Array.from(r.hIds),
    toplocCommitmentHash: Uint8Array.from(r.toplocCommitmentHash),
    minerRecvMs: r.minerRecvMs,
    minerDoneMs: r.minerDoneMs,
    latencyMs: r.latencyMs,
  });
  if (!bytesEqual(r.runningRoot, leaf)) fail("runningRoot", "the running root is not the leaf rebuilt from the fields");
  if (!signedBy(e.enclaveKey, leaf, r.enclaveSig)) fail("enclaveSig", "the enclave signature does not verify under the pinned key over the leaf");
  return Object.freeze({
    leaf: Uint8Array.from(leaf),
    gN: r.gN,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    finishReason: r.finishReason,
    output: Uint8Array.from(r.output),
    text,
    minerRecvMs: r.minerRecvMs,
    minerDoneMs: r.minerDoneMs,
    latencyMs: r.latencyMs,
    enclaveSig: Uint8Array.from(r.enclaveSig),
  });
}
freezeFunction(verifyTurn);
