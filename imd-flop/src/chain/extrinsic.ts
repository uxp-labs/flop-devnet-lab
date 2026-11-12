/**
 * The chain encoder (P3). It encodes and signs FlopSessionKeys.execute_via_session around exactly one of
 * five inner calls of ComputeChannel (calls.ts), for a runtime of the reviewed table (table.ts), as a
 * signed version 4 extrinsic with a mortal era of 64 blocks (era.ts), a tip of 0 and the metadata hash
 * check off. The declared spend is what the inner call moves; the caller does not pass it.
 *
 * The device key signs through the given sign function; the encoder reads no key. It checks the signature
 * against the public key and the payload before it returns. The result's fields and words are read back
 * from the final bytes by the strict reader (reader.ts), so they cannot differ from the bytes.
 *
 * Pure: no network, no clock, no file read. No command uses it yet.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { INNER_PALLET, isInnerName, INNER_NAMES, spendOf, type Bytes32, type InnerCall } from "./calls.js";
import { describeExtrinsic } from "./describe.js";
import { refuse } from "./errors.js";
import { lastValidBlock, mortalEra } from "./era.js";
import { bytesOf, exactKeys, writeValue } from "./fields.js";
import { readExtrinsic, type SessionCallData } from "./reader.js";
import { compact, concat, toHex, uintLE } from "./scale.js";
import { checkRuntime } from "./shape.js";
import { callEntry, runtimeFor, type Runtime, type RuntimeId } from "./table.js";

/** A payload longer than this is hashed with blake2b 256 before it is signed. */
export const PAYLOAD_HASH_ABOVE = 256;

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
  readonly signed: "payload" | "payload-blake2b-256";
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

function innerBytes(rt: Runtime, inner: InnerCall): Uint8Array {
  const name: unknown = (inner as { call?: unknown } | null)?.call;
  if (!isInnerName(name)) refuse("CALL_NOT_ALLOWED", `${String(name)} is not one of ${INNER_NAMES.join(", ")}`);
  const entry = callEntry(rt, INNER_PALLET, name);
  const obj = exactKeys(inner, entry.fields, name, ["call"]);
  return concat(Uint8Array.of(entry.palletIndex, entry.callIndex), ...entry.fields.map((f) => writeValue(f.type, obj[f.name], `${name}.${f.name}`)));
}

function sessionCallBytes(rt: Runtime, input: SessionCallInput): Uint8Array {
  const { outer } = checkRuntime(rt);
  const inner = innerBytes(rt, input.inner);
  const values: Record<string, unknown> = { owner: input.owner, spend_amount: spendOf(input.inner), nonce: input.sessionNonce };
  return concat(
    Uint8Array.of(outer.palletIndex, outer.callIndex),
    ...outer.fields.map((f) => (f.type.kind === "call" ? inner : writeValue(f.type, values[f.name], `${outer.name}.${f.name}`))),
  );
}

const CALL_KEYS = ["runtime", "owner", "inner", "sessionNonce"] as const;
const EXTRINSIC_KEYS = [...CALL_KEYS, "accountNonce", "birth", "signer"] as const;

/**
 * Refuses an input with a key it does not name: there is no spend, era or tip to pass. The declared spend
 * is computed, the era is always mortal and the tip always 0.
 */
function onlyKeys(input: unknown, keys: readonly string[], what: string): void {
  exactKeys(input, keys.map((name) => ({ name, type: { kind: "unit" } as const })), what);
}

/** The call bytes of execute_via_session around one inner call. Nothing is signed. */
export function encodeSessionCall(input: SessionCallInput): Uint8Array {
  onlyKeys(input, CALL_KEYS, "the session call input");
  return sessionCallBytes(runtimeFor(input.runtime), input);
}

/** What is signed: the payload itself up to 256 bytes, its blake2b 256 hash above. */
export function toSign(payload: Uint8Array): { message: Uint8Array; signed: SignedSessionCall["signed"] } {
  return payload.length > PAYLOAD_HASH_ABOVE ? { message: blake2b(payload, { dkLen: 32 }), signed: "payload-blake2b-256" } : { message: payload, signed: "payload" };
}

const bytes32 = (value: unknown, what: string): Bytes32 => bytesOf(value, 32, what);

/** The extra and the additional signed data, in the table's order of signed extensions. */
function extensions(rt: Runtime, accountNonce: number, birth: { number: number; hash: Bytes32 }): { extra: Uint8Array; additional: Uint8Array } {
  const extra: Uint8Array[] = [];
  const additional: Uint8Array[] = [];
  for (const e of rt.signedExtensions) {
    switch (e.identifier) {
      case "CheckSpecVersion":
        additional.push(uintLE(BigInt(rt.specVersion), 4));
        break;
      case "CheckTxVersion":
        additional.push(uintLE(BigInt(rt.transactionVersion), 4));
        break;
      case "CheckGenesis":
        additional.push(hexBytes(rt.genesisHash));
        break;
      case "CheckMortality":
        extra.push(mortalEra(birth.number));
        additional.push(Uint8Array.from(birth.hash));
        break;
      case "CheckNonce":
        extra.push(compact(BigInt(accountNonce)));
        break;
      case "ChargeTransactionPayment":
        extra.push(compact(0n));
        break;
      case "CheckMetadataHash":
        extra.push(e.extra.kind === "struct" ? writeValue(e.extra.fields[0].type, "Disabled", "CheckMetadataHash.mode") : refuse("RUNTIME_UNKNOWN", "CheckMetadataHash"));
        additional.push(Uint8Array.of(0)); // None: no metadata hash
        break;
      case "CheckNonZeroSender":
      case "CheckWeight":
        break;
      default:
        refuse("RUNTIME_UNKNOWN", `signed extension ${e.identifier}`);
    }
  }
  return { extra: concat(...extra), additional: concat(...additional) };
}

function hexBytes(h: string): Uint8Array {
  if (!/^0x([0-9a-f]{2})*$/.test(h)) refuse("RUNTIME_UNKNOWN", `the table holds ${h}, not lower case hex`);
  return hexToBytes(h.slice(2));
}

/** Encodes and signs a session call. Every refusal but SIGNATURE_INVALID comes before the sign function is called. */
export function signSessionCall(input: ExtrinsicInput): SignedSessionCall {
  onlyKeys(input, EXTRINSIC_KEYS, "the extrinsic input");
  onlyKeys(input.birth, ["number", "hash"], "the birth block");
  const rt = runtimeFor(input.runtime);
  const call = sessionCallBytes(rt, input);
  const publicKey = bytes32(input.signer?.publicKey, "the device public key");
  const birthHash = bytes32(input.birth?.hash, "the birth block hash");
  const birth = { number: input.birth.number, hash: birthHash };
  const lastValid = lastValidBlock(birth.number);
  const nonce = input.accountNonce;
  if (typeof nonce !== "number" || !Number.isInteger(nonce)) refuse("BAD_INPUT", "the account nonce must be a whole number (u32)");
  if (nonce < 0 || nonce > 2 ** 32 - 1) refuse("OUT_OF_RANGE", `the account nonce ${nonce} is not a u32`);
  if (typeof input.signer.sign !== "function") refuse("BAD_INPUT", "the signer has no sign function");

  const { extra, additional } = extensions(rt, nonce, birth);
  const payload = concat(call, extra, additional);
  const { message, signed } = toSign(payload);
  const signature = input.signer.sign(Uint8Array.from(message));
  if (!(signature instanceof Uint8Array) || signature.length !== 64) refuse("SIGNATURE_INVALID", "the sign function did not give 64 bytes");
  let verifies = false;
  try {
    verifies = ed25519.verify(signature, message, publicKey);
  } catch {
    verifies = false;
  }
  if (!verifies) refuse("SIGNATURE_INVALID", `the signature does not verify against ${toHex(publicKey)} and the payload`);

  const body = concat(Uint8Array.of(0x80 | rt.extrinsicVersion, rt.address.index), publicKey, Uint8Array.of(rt.signature.index), signature, extra, call);
  const extrinsic = concat(compact(BigInt(body.length)), body);

  const read = readExtrinsic(rt, extrinsic);
  return {
    extrinsic,
    hash: blake2b(extrinsic, { dkLen: 32 }),
    call: read.callBytes,
    signed,
    payloadLength: payload.length,
    fields: { ...read.call, signer: read.signer, accountNonce: read.accountNonce, birth, lastValidBlock: lastValid },
    description: describeExtrinsic(rt, read, birth, lastValid),
  };
}
