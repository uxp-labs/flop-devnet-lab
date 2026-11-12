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
import { blake2b } from "@noble/hashes/blake2.js";
import { isInnerName, INNER_NAMES, spendOf, type Bytes32, type InnerCall } from "./calls.js";
import { describeExtrinsic } from "./describe.js";
import { refuse } from "./errors.js";
import { lastValidBlock, mortalEra } from "./era.js";
import { bytesOf, exactKeys, writeValue } from "./fields.js";
import { signingPayload, type SignedPath } from "./payload.js";
import { readExtrinsic, type SessionCallData } from "./reader.js";
import { compact, concat } from "./scale.js";
import { reviewedRuntime, type Reviewed } from "./shape.js";
import type { Runtime, RuntimeId } from "./table.js";


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

function innerBytes({ inner: entries }: Reviewed, inner: InnerCall): Uint8Array {
  const name: unknown = (inner as { call?: unknown } | null)?.call;
  if (!isInnerName(name)) refuse("CALL_NOT_ALLOWED", `${String(name)} is not one of ${INNER_NAMES.join(", ")}`);
  const entry = entries[name];
  const obj = exactKeys(inner, entry.fields, name, ["call"]);
  return concat(Uint8Array.of(entry.palletIndex, entry.callIndex), ...entry.fields.map((f) => writeValue(f.type, obj[f.name], `${name}.${f.name}`)));
}

function sessionCallBytes(reviewed: Reviewed, input: SessionCallInput): Uint8Array {
  const { outer } = reviewed;
  const inner = innerBytes(reviewed, input.inner);
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
  return sessionCallBytes(reviewedRuntime(input.runtime), input);
}


const bytes32 = (value: unknown, what: string): Bytes32 => bytesOf(value, 32, what);

/** The extra and the additional signed data, in the table's order of signed extensions. */
function extensions(rt: Runtime, accountNonce: number, birth: { number: number; hash: Bytes32 }): { extra: Uint8Array } {
  const extra: Uint8Array[] = [];
  for (const e of rt.signedExtensions) {
    switch (e.identifier) {
      case "CheckMortality":
        extra.push(mortalEra(birth.number));
        break;
      case "CheckNonce":
        extra.push(compact(BigInt(accountNonce)));
        break;
      case "ChargeTransactionPayment":
        extra.push(compact(0n));
        break;
      case "CheckMetadataHash":
        extra.push(e.extra.kind === "struct" ? writeValue(e.extra.fields[0].type, "Disabled", "CheckMetadataHash.mode") : refuse("RUNTIME_UNKNOWN", "CheckMetadataHash"));
        break;
      case "CheckSpecVersion":
      case "CheckTxVersion":
      case "CheckGenesis":
      case "CheckNonZeroSender":
      case "CheckWeight":
        break;
      default:
        refuse("RUNTIME_UNKNOWN", `signed extension ${e.identifier}`);
    }
  }
  return { extra: concat(...extra) };
}

/** Encodes and signs a session call. Every refusal but SIGNATURE_INVALID comes before the sign function is called. */
export function signSessionCall(input: ExtrinsicInput): SignedSessionCall {
  onlyKeys(input, EXTRINSIC_KEYS, "the extrinsic input");
  onlyKeys(input.birth, ["number", "hash"], "the birth block");
  const reviewed = reviewedRuntime(input.runtime);
  const rt = reviewed.rt;
  const call = sessionCallBytes(reviewed, input);
  const publicKey = bytes32(input.signer?.publicKey, "the device public key");
  const birthHash = bytes32(input.birth?.hash, "the birth block hash");
  const birth = { number: input.birth.number, hash: birthHash };
  lastValidBlock(birth.number);
  const nonce = input.accountNonce;
  if (typeof nonce !== "number" || !Number.isInteger(nonce)) refuse("BAD_INPUT", "the account nonce must be a whole number (u32)");
  if (nonce < 0 || nonce > 2 ** 32 - 1) refuse("OUT_OF_RANGE", `the account nonce ${nonce} is not a u32`);
  if (typeof input.signer.sign !== "function") refuse("BAD_INPUT", "the signer has no sign function");

  const { extra } = extensions(rt, nonce, birth);
  const { message } = signingPayload(rt, call, extra, birth.hash);
  const signature = input.signer.sign(Uint8Array.from(message));
  if (!(signature instanceof Uint8Array) || signature.length !== 64) refuse("SIGNATURE_INVALID", "the sign function did not give 64 bytes");

  const body = concat(Uint8Array.of(0x80 | rt.extrinsicVersion, rt.address.index), publicKey, Uint8Array.of(rt.signature.index), signature, extra, call);
  const extrinsic = concat(compact(BigInt(body.length)), body);

  // The one check of the signature (E8): the strict reader verifies it over the payload it rebuilds.
  const read = readExtrinsic(rt, extrinsic, birth);
  return {
    extrinsic,
    hash: blake2b(extrinsic, { dkLen: 32 }),
    call: read.callBytes,
    signed: read.signed,
    payloadLength: read.payloadLength,
    fields: { ...read.call, signer: read.signer, accountNonce: read.accountNonce, birth: read.birth, lastValidBlock: read.lastValidBlock },
    description: describeExtrinsic(rt, extrinsic, birth),
  };
}
