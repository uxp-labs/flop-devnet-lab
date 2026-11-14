/**
 * A second writing of every layout of src/miner, for the tests alone (P6a, rule T3), and the miner's synthetic
 * answers built from it. It imports nothing from src/miner: each message and hash is built here by its own code,
 * from the facts file (`reviews/2026-11-14-p6-miner-client-facts.md`) and FLOP's SDK 0.6.0 source as read
 * (`miner-admission.js`, `compute-channel/transcript.js`, `protocol.js`, `transport-http.js`), not imported.
 *
 * WEAKER THAN A REAL VECTOR. This writing and src/miner are by one builder, who read the same source once. Where
 * both read it wrong the same way they agree and are both wrong. Only the version 3 leaf has a real vector (two real
 * turns in a committed recording, test/miner-real-turns.test.ts). The reviewer writes a third reading.
 *
 * The test enclave key is the reference sr25519 (`test/lib/sr25519-reference.ts`, Rust schnorrkel in WASM), from a
 * fixed test seed. It signs the leaf and the proof. Nothing here reads the network or a key file.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { base58 } from "@scure/base";
import { referencePair, referenceSign, type ReferencePair } from "./sr25519-reference.js";

type Bytes = Uint8Array;

const enc = new TextEncoder();
export const b256 = (b: Bytes): Bytes => blake2b(b, { dkLen: 32 });

/** Little endian of `width` bytes through a DataView, two u32 halves at a time. */
export function le(n: bigint, width: number): Bytes {
  const out = new Uint8Array(width);
  const view = new DataView(out.buffer);
  for (let off = 0; off < width; off += 4) view.setUint32(off, Number((n >> BigInt(8 * off)) & 0xffffffffn), true);
  return out;
}

export function join(...parts: Bytes[]): Bytes {
  const out: number[] = [];
  for (const p of parts) for (const x of p) out.push(x);
  return Uint8Array.from(out);
}

const withLength = (b: Bytes): Bytes => join(le(BigInt(b.length), 4), b);
const str = (s: string): Bytes => withLength(enc.encode(s));

export const hex = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const hex0x = (b: Bytes): string => `0x${hex(b)}`;
export const fromHex = (h: string): Bytes => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));

export interface Identity {
  requestedSlug: string;
  registryModel: string;
  registryVersion: string;
  modelHash: Bytes;
  precision: number;
  decodePolicyHash: Bytes;
  measuredRoot: Bytes;
  backendModelName: string;
}

function identityFields(i: Identity): Bytes {
  return join(str(i.requestedSlug), str(i.registryModel), str(i.registryVersion), i.modelHash, Uint8Array.of(i.precision), i.decodePolicyHash, i.measuredRoot, str(i.backendModelName));
}

/** `modelIdentityHash` of miner-admission.js. */
export const refIdentityHash = (i: Identity): Bytes => b256(join(enc.encode("flop-model-identity-v1"), identityFields(i)));

/** `sessionInfoMessage` of miner-admission.js. */
export function refSessionInfoMessage(m: { challenge: Bytes; genesis: Bytes; account: Bytes; enclaveKey: Bytes; identity: Identity; ready: boolean; version: string; revision: string }): Bytes {
  return join(enc.encode("flop-session-info-v1"), m.challenge, m.genesis, m.account, m.enclaveKey, refIdentityHash(m.identity), Uint8Array.of(m.ready ? 1 : 0), str(m.version), str(m.revision));
}

/** `turnEvidenceHash` of transcript.js. */
export function refEvidenceHash(e: { output: Bytes; promptTokens: bigint; completionTokens: bigint; finishReason: string; identity: Identity }): Bytes {
  return b256(join(enc.encode("FLOP_CHAT_TURN_EVIDENCE_V1"), withLength(e.output), le(e.promptTokens, 8), le(e.completionTokens, 8), str(e.finishReason), identityFields(e.identity)));
}

export interface Leaf {
  channelId: Bytes;
  turnIndex: number;
  hIn: Bytes;
  hOut: Bytes;
  gN: bigint;
  decodePolicyHash: Bytes;
  hIds: Bytes;
  toplocCommitmentHash: Bytes;
  minerRecvMs: bigint;
  minerDoneMs: bigint;
  latencyMs: bigint;
}

/** `transcriptLeafV3` of transcript.js. */
export function refLeafV3(l: Leaf): Bytes {
  return b256(join(l.channelId, le(BigInt(l.turnIndex), 4), l.hIn, l.hOut, le(l.gN, 16), l.decodePolicyHash, l.hIds, l.toplocCommitmentHash, le(l.minerRecvMs, 8), le(l.minerDoneMs, 8), le(l.latencyMs, 8)));
}

/** A JSON string as the ECMAScript JSON.stringify writes one, by hand, for a well formed string. */
export function refJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}

/** `canonicalJson` of protocol.js, by hand: keys sorted at each level, undefined dropped, no space. */
export function refCanonical(v: unknown): string {
  if (v === null || typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return refJsonString(v);
  if (Array.isArray(v)) return `[${v.map(refCanonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined);
  keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${refJsonString(k)}:${refCanonical(o[k])}`).join(",")}}`;
}

/** The input bytes of `encodeChatTurnEnvelope` for a plain chat turn. */
export function refTurnInput(model: string, messages: { role: string; content: string }[], maxTokens: number): Bytes {
  return enc.encode(refCanonical({ version: "flop.chat-turn.v1", model, messages, max_tokens: maxTokens }));
}

/** An SS58 address of 32 bytes under a one byte prefix, by hand. */
export function refSs58(pub: Bytes, prefix = 42): string {
  const body = join(Uint8Array.of(prefix), pub);
  const sum = blake2b(join(enc.encode("SS58PRE"), body), { dkLen: 64 }).slice(0, 2);
  return base58.encode(join(body, sum));
}

/** Fixed test bytes: `n` bytes each `fill`. */
export const filled = (n: number, fill: number): Bytes => new Uint8Array(n).fill(fill);

/** The test enclave key from a fixed test seed, through the reference library. */
export const enclavePair = (seedByte = 7): ReferencePair => referencePair(filled(32, seedByte));

/** A whole synthetic set of the owner's pins and the miner's answers, every value consistent with every other. */
export interface Scenario {
  pair: ReferencePair;
  genesis: Bytes;
  account: Bytes;
  identity: Identity;
  challenge: Bytes;
  version: string;
  revision: string;
  channelId: Bytes;
  messages: { role: "system" | "user"; content: string }[];
  maxTokens: number;
  input: Bytes;
  output: Bytes;
  promptTokens: bigint;
  completionTokens: bigint;
  finishReason: string;
  gN: bigint;
  minerRecvMs: bigint;
  minerDoneMs: bigint;
  latencyMs: bigint;
  hIds: Bytes;
  toploc: Bytes;
}

export function scenario(over: Partial<Scenario> = {}): Scenario {
  const identity: Identity = {
    requestedSlug: "qwen-test",
    registryModel: "Qwen Test",
    registryVersion: "1.0",
    modelHash: filled(32, 0x11),
    precision: 2,
    decodePolicyHash: filled(32, 0x22),
    measuredRoot: filled(32, 0x33),
    backendModelName: "qwen-backend",
  };
  const s: Scenario = {
    pair: enclavePair(),
    genesis: filled(32, 0x44),
    account: filled(32, 0x55),
    identity,
    challenge: filled(32, 0x66),
    version: "0.6.0",
    revision: "abc123",
    channelId: filled(32, 0x77),
    messages: [{ role: "user", content: "Say hello." }],
    maxTokens: 64,
    input: new Uint8Array(0),
    output: enc.encode("Hello."),
    promptTokens: 12n,
    completionTokens: 3n,
    finishReason: "stop",
    gN: 38n,
    minerRecvMs: 1904971n,
    minerDoneMs: 1905558n,
    latencyMs: 587n,
    hIds: filled(32, 0x88),
    toploc: filled(32, 0x99),
    ...over,
  };
  if (over.input === undefined) s.input = refTurnInput(s.identity.requestedSlug, s.messages, s.maxTokens);
  return s;
}

/** The input of `minerExpected` for a scenario. */
export const expectedInputOf = (s: Scenario) => ({ genesis: s.genesis, account: s.account, enclaveKey: s.pair.publicKey, identity: { ...s.identity } });

const snakeIdentity = (i: Identity) => ({
  requested_slug: i.requestedSlug,
  registry_model: i.registryModel,
  registry_version: i.registryVersion,
  model_hash: hex(i.modelHash),
  precision: i.precision,
  decode_policy_hash: hex(i.decodePolicyHash),
  measured_root: hex(i.measuredRoot),
  backend_model_name: i.backendModelName,
});

export const camelIdentity = (i: Identity) => ({ ...i, modelHash: hex0x(i.modelHash), decodePolicyHash: hex0x(i.decodePolicyHash), measuredRoot: hex0x(i.measuredRoot) });

/** The info proof's body as `signSessionInfo` writes it, signed by `signer` (the scenario's key by default) over `challenge`. */
export function proofObject(s: Scenario, o: { signer?: ReferencePair; stated?: Bytes; ready?: boolean; challenge?: Bytes } = {}): Record<string, unknown> {
  const signer = o.signer ?? s.pair;
  const enclaveKey = o.stated ?? signer.publicKey;
  const ready = o.ready ?? true;
  const message = refSessionInfoMessage({ challenge: o.challenge ?? s.challenge, genesis: s.genesis, account: s.account, enclaveKey, identity: s.identity, ready, version: s.version, revision: s.revision });
  return {
    genesis_hash: hex(s.genesis),
    account_id: hex(s.account),
    enclave_key: hex(enclaveKey),
    model_identity: snakeIdentity(s.identity),
    ready,
    image: { version: s.version, revision: s.revision },
    signature: hex(referenceSign(signer, message)),
  };
}

/** The signed info's body as `fetchMinerSessionInfo` reads it. */
export function infoObject(s: Scenario): Record<string, unknown> {
  return {
    image: { version: s.version, revision: s.revision },
    minerAddress: refSs58(s.account),
    enclaveKey: hex0x(s.pair.publicKey),
    model: s.identity.requestedSlug,
    modelHash: hex0x(s.identity.modelHash),
    modelIdentity: camelIdentity(s.identity),
    is_ready: true,
    maxUnackedGn: "0",
  };
}

/** The leaf fields of a scenario's turn. */
export function leafOf(s: Scenario, o: { hIn?: Bytes; hOut?: Bytes; turnIndex?: number } = {}): Leaf {
  const hOut = o.hOut ?? refEvidenceHash({ output: s.output, promptTokens: s.promptTokens, completionTokens: s.completionTokens, finishReason: s.finishReason, identity: s.identity });
  return { channelId: s.channelId, turnIndex: o.turnIndex ?? 0, hIn: o.hIn ?? b256(s.input), hOut, gN: s.gN, decodePolicyHash: s.identity.decodePolicyHash, hIds: s.hIds, toplocCommitmentHash: s.toploc, minerRecvMs: s.minerRecvMs, minerDoneMs: s.minerDoneMs, latencyMs: s.latencyMs };
}

/** The turn receipt's body as `encodeTurnReceipt` writes it, its leaf signed by `signer` (the scenario's key by default). */
export function turnObject(s: Scenario, o: { signer?: ReferencePair; leaf?: Leaf; root?: Bytes; leafVersion?: string } = {}): Record<string, unknown> {
  const leaf = o.leaf ?? leafOf(s);
  const leafHash = refLeafV3(leaf);
  return {
    leafVersion: o.leafVersion ?? "V3",
    turnIndex: leaf.turnIndex,
    hIn: hex0x(leaf.hIn),
    hOut: hex0x(leaf.hOut),
    output: hex0x(s.output),
    gN: leaf.gN.toString(),
    minerRecvMs: leaf.minerRecvMs.toString(),
    minerDoneMs: leaf.minerDoneMs.toString(),
    latencyMs: leaf.latencyMs.toString(),
    enclaveSig: hex0x(referenceSign(o.signer ?? s.pair, leafHash)),
    runningRoot: hex0x(o.root ?? leafHash),
    decodePolicyHash: hex0x(leaf.decodePolicyHash),
    promptTokens: s.promptTokens.toString(),
    completionTokens: s.completionTokens.toString(),
    finishReason: s.finishReason,
    modelIdentity: camelIdentity(s.identity),
    hIds: hex0x(leaf.hIds),
    toplocCommitmentHash: hex0x(leaf.toplocCommitmentHash),
  };
}

/** A close answer with a settled hint. */
export const closeObject = (channelId: Bytes, txHash: Bytes): Record<string, unknown> => ({
  settled: { channelId: hex0x(channelId), minerPaid: "1", burned: "0", aggregateGn: "38", cooperative: true, txHash: hex0x(txHash) },
});

/** A 16 or longer run of hex digits: no refusal message may hold one. */
export const HEX_RUN = /[0-9a-fA-F]{16,}/;
