/**
 * The chain encoder (P3). It encodes and signs FlopSessionKeys.execute_via_session around exactly one of
 * five inner calls of ComputeChannel (calls.ts), for a runtime of the reviewed table (table.ts), as a
 * signed version 4 extrinsic with a mortal era of 64 blocks (era.ts), a tip of 0 and the metadata hash
 * check off. The declared spend is what the inner call moves; the caller does not pass it.
 *
 * It first reads the whole input into one snapshot: every field read once, checked, and copied into plain
 * data the caller cannot reach (rule H1). Everything after comes from the snapshot alone: the call bytes,
 * the declared spend, the payload and the result.
 *
 * The device key signs through the given sign function; the encoder reads no key. The strict reader
 * verifies the signature before the result is returned, and the result's fields and words are read back
 * from the final bytes (reader.ts, describe.ts), so they cannot differ from the bytes.
 *
 * Pure: no network, no clock, no file read. No command uses it yet.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { INNER_CALLS, INNER_NAMES, isInnerName, type Bytes32, type InnerCall, type InnerName } from "./calls.js";
import { describeExtrinsic } from "./describe.js";
import { refuse } from "./errors.js";
import { lastValidBlock, mortalEra } from "./era.js";
import { bytesOf, ownKeys, ownValue, takeFields, takeValue, writeValue, type FieldValue } from "./fields.js";
import { signingPayload, type SignedPath } from "./payload.js";
import { readCall, readExtrinsic, type SessionCallData } from "./reader.js";
import { compact, concat } from "./scale.js";
import { reviewedRuntime, type Reviewed } from "./shape.js";
import type { RuntimeId } from "./table.js";
import { freezeFunction } from "../freeze.js";

export interface SessionCallInput {
  /** The runtime the call is for, by the four names read from the chain. */
  readonly runtime: RuntimeId;
  /** The session owner's account. */
  readonly owner: Bytes32;
  readonly inner: InnerCall;
  /** The session's current nonce, FlopSessionKeys.SessionNonces of (owner, device): a u64. */
  readonly sessionNonce: bigint;
}

export interface DeviceSigner {
  /** The device's ed25519 public key, 32 bytes. Its account signs. */
  readonly publicKey: Bytes32;
  /** Signs a message with the device key. */
  sign(message: Uint8Array): Uint8Array;
}

export interface ExtrinsicInput extends SessionCallInput {
  /** The device account's nonce, System.Account of the device: a u32. */
  readonly accountNonce: number;
  /** The block the era is born at: its number and hash. */
  readonly birth: { readonly number: number; readonly hash: Bytes32 };
  readonly signer: DeviceSigner;
}

export interface SignedSessionCall {
  readonly extrinsic: Uint8Array;
  /** blake2b 256 of the extrinsic bytes. */
  readonly hash: Uint8Array;
  readonly call: Uint8Array;
  /** Whether the payload was signed as it is or as its blake2b 256 hash. */
  readonly signed: SignedPath;
  readonly payloadLength: number;
  /** The fields, as read back from the extrinsic bytes. */
  readonly fields: SessionCallData & {
    readonly signer: Bytes32;
    readonly accountNonce: number;
    readonly birth: { readonly number: number; readonly hash: Bytes32 };
    readonly lastValidBlock: number;
  };
  readonly description: string;
}

/** The input of a session call, read once and copied. Nothing in it is the caller's. */
interface CallSnapshot {
  readonly reviewed: Reviewed;
  readonly owner: Bytes32;
  readonly inner: { readonly call: InnerName; readonly fields: Readonly<Record<string, FieldValue>> };
  /** The snapshot's own amount of the inner call (rule E5), or 0 for a call that moves nothing out. */
  readonly spend: bigint;
  readonly sessionNonce: bigint;
}

interface SignSnapshot extends CallSnapshot {
  readonly accountNonce: number;
  readonly birth: { readonly number: number; readonly hash: Bytes32 };
  readonly publicKey: Bytes32;
  readonly signer: object;
  readonly sign: (message: Uint8Array) => unknown;
}

const CALL_KEYS = Object.freeze(["runtime", "owner", "inner", "sessionNonce"] as const);
const EXTRINSIC_KEYS = Object.freeze([...CALL_KEYS, "accountNonce", "birth", "signer"] as const);

/** The inner call, read once: its name, then each of its table fields. */
function takeInner(reviewed: Reviewed, value: unknown): CallSnapshot["inner"] {
  if (value === null || typeof value !== "object") refuse("CALL_NOT_ALLOWED", `${String(value)} is not one of ${INNER_NAMES.join(", ")}`);
  const keys = ownKeys(value);
  if (!keys.includes("call")) refuse("CALL_NOT_ALLOWED", `an inner call without a name is not one of ${INNER_NAMES.join(", ")}`);
  const name: unknown = ownValue(value, "call", "the inner call");
  if (!isInnerName(name)) refuse("CALL_NOT_ALLOWED", `${String(name)} is not one of ${INNER_NAMES.join(", ")}`);
  const entry = reviewed.inner[name];
  const names = entry.fields.map((f) => f.name);
  for (const k of keys) if (k !== "call" && !names.includes(k)) refuse("BAD_INPUT", `${name} has a field ${k} the table does not have`);
  for (const n of names) if (!keys.includes(n)) refuse("BAD_INPUT", `${name} lacks the field ${n}`);
  const fields: Record<string, FieldValue> = {};
  for (const f of entry.fields) fields[f.name] = takeValue(f.type, ownValue(value, f.name, name), `${name}.${f.name}`);
  return { call: name, fields };
}

function takeCall(raw: Record<string, unknown>): CallSnapshot {
  const reviewed = reviewedRuntime(raw.runtime as RuntimeId);
  const owner = bytesOf(raw.owner, 32, "the owner");
  const inner = takeInner(reviewed, raw.inner);
  const sessionNonce = takeValue({ kind: "u64" }, raw.sessionNonce, "the session nonce") as bigint;
  const spendField = INNER_CALLS[inner.call];
  const spend = spendField === null ? 0n : (inner.fields[spendField] as bigint);
  return { reviewed, owner, inner, spend, sessionNonce };
}

function takeSign(input: unknown): SignSnapshot {
  const raw = takeFields(input, EXTRINSIC_KEYS, "the extrinsic input");
  const call = takeCall(raw);
  const birthRaw = takeFields(raw.birth, ["number", "hash"], "the birth block");
  const number = birthRaw.number;
  if (typeof number !== "number") refuse("BAD_INPUT", "the birth block number must be a whole number (u32)");
  lastValidBlock(number);
  const birth = { number, hash: bytesOf(birthRaw.hash, 32, "the birth block hash") };
  const accountNonce = takeValue({ kind: "u32" }, raw.accountNonce, "the account nonce") as number;
  const signer = raw.signer;
  if (signer === null || (typeof signer !== "object" && typeof signer !== "function")) refuse("BAD_INPUT", "the signer must be an object with a public key and a sign function");
  // The signer's two fields are each read once as an own value (rule H1): an accessor on either is refused, and a
  // Proxy's get trap is not used. A field the signer does not have reads as undefined. Its other fields are the
  // caller's own state: allowed, and never read.
  const keys = ownKeys(signer);
  const field = (name: string): unknown => (keys.includes(name) ? ownValue(signer, name, "the signer") : undefined);
  const publicKey = bytesOf(field("publicKey"), 32, "the device public key");
  const sign = field("sign");
  if (typeof sign !== "function") refuse("BAD_INPUT", "the signer has no sign function");
  return { ...call, birth, accountNonce, publicKey, signer, sign: sign as SignSnapshot["sign"] };
}

/** The call bytes, from the snapshot alone. */
function callBytes(s: CallSnapshot): Uint8Array {
  const { outer, inner: entries } = s.reviewed;
  const entry = entries[s.inner.call];
  const inner = concat(Uint8Array.of(entry.palletIndex, entry.callIndex), ...entry.fields.map((f) => writeValue(f.type, s.inner.fields[f.name], `${s.inner.call}.${f.name}`)));
  const values: Record<string, FieldValue> = { owner: s.owner, spend_amount: s.spend, nonce: s.sessionNonce };
  return concat(
    Uint8Array.of(outer.palletIndex, outer.callIndex),
    ...outer.fields.map((f) => (f.type.kind === "call" ? inner : writeValue(f.type, values[f.name], `${outer.name}.${f.name}`))),
  );
}

/** Equal plain data: bytes by value, objects field by field. Both sides are the encoder's own data. */
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort().join(",");
    const kb = Object.keys(b).sort().join(",");
    return ka === kb && Object.keys(a).every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/**
 * The call bytes, read back with the strict reader and compared with the snapshot field by field (rule
 * H2). A difference is a refusal. So nothing is returned or signed that does not read back as the input.
 */
function checkedCallBytes(s: CallSnapshot): Uint8Array {
  const bytes = callBytes(s);
  const back = readCall(s.reviewed.rt, bytes);
  const { call: name, ...fields } = back.inner as unknown as Record<string, unknown> & { call: string };
  const checks: [string, unknown, unknown][] = [
    ["the owner", back.owner, s.owner],
    ["the inner call", name, s.inner.call],
    ["the declared spend", back.spend, s.spend],
    ["the session nonce", back.sessionNonce, s.sessionNonce],
    ...Object.keys({ ...fields, ...s.inner.fields }).map((k): [string, unknown, unknown] => [`${s.inner.call}.${k}`, fields[k], s.inner.fields[k]]),
  ];
  for (const [what, read, want] of checks) if (!same(read, want)) refuse("READ_BACK", `${what} does not read back as it was given`);
  return bytes;
}

/** The call bytes of execute_via_session around one inner call, read back before they are returned. Nothing is signed. */
export function encodeSessionCall(input: SessionCallInput): Uint8Array {
  const s = takeCall(takeFields(input, CALL_KEYS, "the session call input"));
  return checkedCallBytes(s);
}
freezeFunction(encodeSessionCall);

/** The extra of each signed extension, in the table's order. */
function extensionExtra(s: SignSnapshot): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of s.reviewed.rt.signedExtensions) {
    if (e.identifier === "CheckMortality") parts.push(mortalEra(s.birth.number));
    else if (e.identifier === "CheckNonce") parts.push(compact(BigInt(s.accountNonce)));
    else if (e.identifier === "ChargeTransactionPayment") parts.push(compact(0n));
    else if (e.identifier === "CheckMetadataHash" && e.extra.kind === "struct") parts.push(writeValue(e.extra.fields[0].type, "Disabled", "CheckMetadataHash.mode"));
  }
  return concat(...parts);
}

/**
 * Calls the signer. If it throws, the refusal says only that it threw (rule H4): nothing of the thrown value is
 * kept, not its text, not its class and not the value as a cause, and none of its code is run.
 */
function callSigner(s: SignSnapshot, message: Uint8Array): unknown {
  try {
    return Reflect.apply(s.sign, s.signer, [Uint8Array.from(message)]);
  } catch {
    return refuse("SIGNER_THREW", "the sign function threw");
  }
}

/** The signature the signer gave, by its internal state, or SIGNATURE_INVALID. */
function signatureOf(value: unknown): Uint8Array {
  try {
    return bytesOf(value, 64, "the signature");
  } catch {
    return refuse("SIGNATURE_INVALID", "the sign function did not give a Uint8Array of 64 bytes");
  }
}

/** Encodes and signs a session call. Every refusal but one of the signer comes before the sign function is called. */
export function signSessionCall(input: ExtrinsicInput): SignedSessionCall {
  const s = takeSign(input);
  const rt = s.reviewed.rt;
  const call = checkedCallBytes(s);
  const extra = extensionExtra(s);
  const { message } = signingPayload(rt, call, extra, s.birth.hash);
  const signature = signatureOf(callSigner(s, message));

  const body = concat(Uint8Array.of(0x80 | rt.extrinsicVersion, rt.address.index), s.publicKey, Uint8Array.of(rt.signature.index), signature, extra, call);
  const extrinsic = concat(compact(BigInt(body.length)), body);

  // The one check of the signature (E8): the strict reader verifies it over the payload it rebuilds.
  const read = readExtrinsic(rt, extrinsic, s.birth);
  return {
    extrinsic,
    hash: blake2b(extrinsic, { dkLen: 32 }),
    call: read.callBytes,
    signed: read.signed,
    payloadLength: read.payloadLength,
    fields: { ...read.call, signer: read.signer, accountNonce: read.accountNonce, birth: read.birth, lastValidBlock: read.lastValidBlock },
    description: describeExtrinsic(rt, extrinsic, s.birth),
  };
}
freezeFunction(signSessionCall);
