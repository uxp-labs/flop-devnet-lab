/**
 * The reviewer's own synthetic miner answers for the P6a review: an info proof, a signed info and a turn receipt,
 * each as JSON text, built from the reviewer's third writing (review-p6a-third.ts) and signed by a test enclave key
 * from the reference sr25519 (fixed seeds). It shares no code with test/lib/miner-answers.ts.
 */
import { minerExpected, type Expected } from "../../src/miner/expected.js";
import { ss58Encode } from "../../src/ss58.js";
import { referencePair, referenceReady, referenceSign, type ReferencePair } from "./sr25519-reference.js";
import { thirdChatInput, thirdHIn, thirdLeafV3, thirdSessionInfoMessage, thirdTurnEvidenceHash, type ThirdIdentity, type ThirdMessage } from "./review-p6a-third.js";

export const filled = (n: number, b: number): Uint8Array => new Uint8Array(n).fill(b);
export const counting = (n: number, start: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (start + i * 37) & 0xff);
export const hx = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const hx0 = (b: Uint8Array): string => `0x${hx(b)}`;
export const MAX64 = (1n << 64n) - 1n;
export const MAX128 = (1n << 128n) - 1n;

await referenceReady();
export const ENCLAVE: ReferencePair = referencePair(filled(32, 0x11));
export const OTHER: ReferencePair = referencePair(filled(32, 0x22));

export const ID: ThirdIdentity = Object.freeze({
  requestedSlug: "qwen-review-slug",
  registryModel: "Qwen/ReviewModel",
  registryVersion: "1.0.0",
  modelHash: counting(32, 1),
  precision: 2,
  decodePolicyHash: counting(32, 2),
  measuredRoot: counting(32, 3),
  backendModelName: "qwen-review-backend",
}) as ThirdIdentity;
export const GENESIS = counting(32, 4);
export const ACCOUNT = counting(32, 5);
export const CHALLENGE = counting(32, 6);
export const CHANNEL = counting(32, 7);

export const idCopy = (i: ThirdIdentity = ID): ThirdIdentity => ({ ...i, modelHash: Uint8Array.from(i.modelHash), decodePolicyHash: Uint8Array.from(i.decodePolicyHash), measuredRoot: Uint8Array.from(i.measuredRoot) });

export function expected(key: Uint8Array = ENCLAVE.publicKey, id: ThirdIdentity = ID): Expected {
  return minerExpected({ genesis: Uint8Array.from(GENESIS), account: Uint8Array.from(ACCOUNT), enclaveKey: Uint8Array.from(key), identity: idCopy(id) });
}

export interface ProofOpts {
  signer?: ReferencePair;
  statedKey?: Uint8Array;
  challenge?: Uint8Array;
  genesis?: Uint8Array;
  account?: Uint8Array;
  identity?: ThirdIdentity;
  signedIdentity?: ThirdIdentity;
  ready?: boolean;
  signedReady?: boolean;
  version?: string;
  revision?: string;
  signedVersion?: string;
  signedRevision?: string;
  signature?: Uint8Array;
}

export function proofObject(o: ProofOpts = {}): Record<string, unknown> {
  const signer = o.signer ?? ENCLAVE;
  const stated = o.statedKey ?? signer.publicKey;
  const id = o.identity ?? ID;
  const version = o.version ?? "flop-miner 0.9.1";
  const revision = o.revision ?? "abc123";
  const msg = thirdSessionInfoMessage({
    challenge: o.challenge ?? CHALLENGE,
    genesisHash: o.genesis ?? GENESIS,
    account: o.account ?? ACCOUNT,
    enclaveKey: stated,
    identity: o.signedIdentity ?? id,
    ready: o.signedReady ?? o.ready ?? true,
    version: o.signedVersion ?? version,
    revision: o.signedRevision ?? revision,
  });
  return {
    genesis_hash: hx(o.genesis ?? GENESIS),
    account_id: hx(o.account ?? ACCOUNT),
    enclave_key: hx(stated),
    model_identity: {
      requested_slug: id.requestedSlug,
      registry_model: id.registryModel,
      registry_version: id.registryVersion,
      model_hash: hx(id.modelHash),
      precision: id.precision,
      decode_policy_hash: hx(id.decodePolicyHash),
      measured_root: hx(id.measuredRoot),
      backend_model_name: id.backendModelName,
    },
    ready: o.ready ?? true,
    image: { version, revision },
    signature: hx(o.signature ?? referenceSign(signer, msg)),
  };
}

export const camel = (i: ThirdIdentity) => ({
  requestedSlug: i.requestedSlug,
  registryModel: i.registryModel,
  registryVersion: i.registryVersion,
  modelHash: hx0(i.modelHash),
  precision: i.precision,
  decodePolicyHash: hx0(i.decodePolicyHash),
  measuredRoot: hx0(i.measuredRoot),
  backendModelName: i.backendModelName,
});

export function infoObject(): Record<string, unknown> {
  return { minerAddress: ss58Encode(ACCOUNT, 42), enclaveKey: hx0(ENCLAVE.publicKey), modelHash: hx0(ID.modelHash), modelIdentity: camel(ID), is_ready: true, maxUnackedGn: "1000" };
}

export const MESSAGES: ThirdMessage[] = [
  { role: "system", content: "be brief" },
  { role: "user", content: "PROMPTZQ say hi" },
];
export const MAX_TOKENS = 64;
export const inputOf = (maxTokens = MAX_TOKENS, msgs = MESSAGES): Uint8Array => thirdChatInput(ID.requestedSlug, msgs, maxTokens);

export interface TurnOpts {
  signer?: ReferencePair;
  channelId?: Uint8Array;
  input?: Uint8Array;
  output?: Uint8Array;
  promptTokens?: bigint;
  completionTokens?: bigint;
  finishReason?: string;
  identity?: ThirdIdentity;
  gN?: bigint;
  recv?: bigint;
  done?: bigint;
  latency?: bigint;
  turnIndex?: number;
  hIds?: Uint8Array;
  toploc?: Uint8Array | null;
  policy?: Uint8Array;
  leafVersion?: string;
  hIn?: Uint8Array;
  hOut?: Uint8Array;
  root?: Uint8Array;
}

export function turnParts(o: TurnOpts = {}) {
  const input = o.input ?? inputOf();
  const output = o.output ?? new TextEncoder().encode("hi there MARKERZQ");
  const pt = o.promptTokens ?? 12n;
  const ct = o.completionTokens ?? 5n;
  const finish = o.finishReason ?? "stop";
  const id = o.identity ?? ID;
  const hIn = o.hIn ?? thirdHIn(input);
  const hOut = o.hOut ?? thirdTurnEvidenceHash(output, pt, ct, finish, id);
  const recv = o.recv ?? 1000n;
  const done = o.done ?? 1587n;
  const latency = o.latency ?? done - recv;
  const leafFields = {
    channelId: o.channelId ?? CHANNEL,
    turnIndex: o.turnIndex ?? 0,
    hIn,
    hOut,
    gN: o.gN ?? 38n,
    decodePolicyHash: o.policy ?? ID.decodePolicyHash,
    hIds: o.hIds ?? counting(32, 8),
    toplocCommitmentHash: o.toploc ?? filled(32, 0),
    minerRecvMs: recv,
    minerDoneMs: done,
    latencyMs: latency,
  };
  const leaf = thirdLeafV3(leafFields);
  const sig = referenceSign(o.signer ?? ENCLAVE, leaf);
  const wire: Record<string, unknown> = {
    leafVersion: o.leafVersion ?? "V3",
    turnIndex: leafFields.turnIndex,
    hIn: hx0(hIn),
    hOut: hx0(hOut),
    output: hx0(output),
    gN: leafFields.gN.toString(),
    minerRecvMs: recv.toString(),
    minerDoneMs: done.toString(),
    latencyMs: latency.toString(),
    enclaveSig: hx0(sig),
    runningRoot: hx0(o.root ?? leaf),
    decodePolicyHash: hx0(leafFields.decodePolicyHash),
    hIds: hx0(leafFields.hIds),
    promptTokens: pt.toString(),
    completionTokens: ct.toString(),
    finishReason: finish,
    modelIdentity: camel(id),
  };
  if (o.toploc !== null) wire.toplocCommitmentHash = hx0(leafFields.toplocCommitmentHash);
  return { wire, leaf, input, output };
}
