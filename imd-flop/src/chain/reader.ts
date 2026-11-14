/**
 * The strict reader of the chain encoder (rule E9). It reads call bytes and signed extrinsic bytes back
 * into data, by the frozen table, and refuses what it does not know: a call other than execute_via_session
 * around one of the five inner calls, an enum index the table does not have, a declared spend other than
 * what the inner call moves, an immortal era or another period, a phase that is not the birth block's, a
 * tip, the metadata hash check on, a signature that does not verify over the payload with the birth hash,
 * bytes that end early and bytes left over. Pure: no network, no clock, no file.
 *
 * It takes the four names of a runtime, never a runtime (rule H6), and copies the bytes it is given by
 * their internal state before it reads them (rule H3).
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { INNER_PALLET, spendOf, type Bytes32, type InnerCall, type InnerName } from "./calls.js";
import { refuse } from "./errors.js";
import { lastValidBlock, readEra } from "./era.js";
import { bytesOf, readValue } from "./fields.js";
import { signingPayload, type SignedPath } from "./payload.js";
import { ByteReader } from "./scale.js";
import { reviewedRuntime, type Reviewed } from "./shape.js";
import type { CallEntry, RuntimeId } from "./table.js";
import { freezeFunction } from "../freeze.js";

/** What a session call holds. */
export interface SessionCallData {
  readonly owner: Bytes32;
  readonly inner: InnerCall;
  /** The declared spend, equal to what the inner call moves. */
  readonly spend: bigint;
  readonly sessionNonce: bigint;
}

/** What a signed extrinsic holds, with the birth block its signature was verified against. */
export interface ExtrinsicData {
  readonly signer: Bytes32;
  readonly signature: Uint8Array;
  readonly accountNonce: number;
  readonly era: { readonly period: number; readonly phase: number };
  readonly tip: bigint;
  readonly metadataHashMode: string;
  readonly birth: { readonly number: number; readonly hash: Bytes32 };
  readonly lastValidBlock: number;
  readonly signed: SignedPath;
  readonly payloadLength: number;
  readonly call: SessionCallData;
  readonly callBytes: Uint8Array;
}

function readFields(r: ByteReader, entry: CallEntry, readCallField: () => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of entry.fields) {
    out[f.name] = f.type.kind === "call" ? readCallField() : readValue(r, f.type, `${entry.name}.${f.name}`);
  }
  return out;
}

function readInner(r: ByteReader, inner: Reviewed["inner"]): InnerCall {
  const pallet = r.byte();
  const index = r.byte();
  const entry = Object.values(inner).find((e) => e.palletIndex === pallet && e.callIndex === index);
  if (!entry || entry.pallet !== INNER_PALLET) refuse("CALL_NOT_ALLOWED", `inner call ${pallet}/${index} is not one of the five`);
  const fields = readFields(r, entry, () => refuse("CALL_NOT_ALLOWED", "an inner call carries no call"));
  return { call: entry.name as InnerName, ...fields } as unknown as InnerCall;
}

function readSessionCall(r: ByteReader, { outer, inner }: Reviewed): SessionCallData {
  const pallet = r.byte();
  const index = r.byte();
  if (pallet !== outer.palletIndex || index !== outer.callIndex) refuse("CALL_NOT_ALLOWED", `call ${pallet}/${index} is not ${outer.pallet}.${outer.name}`);
  const f = readFields(r, outer, () => readInner(r, inner));
  const data: SessionCallData = { owner: f.owner as Bytes32, inner: f.call as InnerCall, spend: f.spend_amount as bigint, sessionNonce: f.nonce as bigint };
  const moves = spendOf(data.inner);
  if (data.spend !== moves) refuse("SPEND_MISMATCH", `declared spend ${data.spend} raw, but ${data.inner.call} moves ${moves} raw`);
  return data;
}

/** Reads call bytes: execute_via_session around one of the five inner calls, and nothing left over. */
export function readCall(runtime: RuntimeId, bytes: Uint8Array): SessionCallData {
  const reviewed = reviewedRuntime(runtime);
  const r = new ByteReader(bytesOf(bytes, null, "the call bytes"));
  const data = readSessionCall(r, reviewed);
  r.done("the call");
  return data;
}
freezeFunction(readCall);

/** Reads the birth block a caller names: its number once, its hash once and by its internal state. */
function birthOf(value: unknown): { number: number; hash: Bytes32 } {
  if (value === null || typeof value !== "object") refuse("BAD_INPUT", "the birth block must be an object with a number and a hash");
  const v = value as { number?: unknown; hash?: unknown };
  const number = v.number;
  const hash = bytesOf(v.hash, 32, "the birth block hash");
  if (typeof number !== "number") refuse("BAD_INPUT", "the birth block number must be a whole number (u32)");
  lastValidBlock(number);
  return { number, hash };
}

/**
 * Reads a signed extrinsic of this runtime, its extensions in the table's order, and verifies its
 * signature over the payload it rebuilds with the birth block's hash. The era's phase must be the birth
 * block's. So the birth the data names is the one that was signed.
 */
export function readExtrinsic(runtime: RuntimeId, input: Uint8Array, birthBlock: { readonly number: number; readonly hash: Bytes32 }): ExtrinsicData {
  const reviewed = reviewedRuntime(runtime);
  const rt = reviewed.rt;
  const bytes = bytesOf(input, null, "the extrinsic bytes");
  const birth = birthOf(birthBlock);
  const r = new ByteReader(bytes);
  const length = r.compact();
  if (length !== BigInt(bytes.length - r.position)) refuse("BAD_BYTES", `the length prefix says ${length}, the body has ${bytes.length - r.position} bytes`);
  const version = r.byte();
  if (version !== (0x80 | rt.extrinsicVersion)) refuse("BAD_BYTES", `version byte 0x${version.toString(16)} is not a signed version ${rt.extrinsicVersion}`);
  if (r.byte() !== rt.address.index) refuse("BAD_BYTES", `the address is not a MultiAddress ${rt.address.variant}`);
  const signer = r.take(32);
  if (r.byte() !== rt.signature.index) refuse("BAD_BYTES", `the signature is not a MultiSignature ${rt.signature.variant}`);
  const signature = r.take(64);
  const extraStart = r.position;
  let accountNonce: number | null = null;
  let era: { period: number; phase: number } | null = null;
  let tip: bigint | null = null;
  let metadataHashMode: string | null = null;
  for (const e of rt.signedExtensions) {
    if (e.identifier === "CheckMortality") era = readEra(r);
    else if (e.identifier === "CheckNonce") {
      const n = r.compact();
      if (n > 0xffffffffn) refuse("BAD_BYTES", `an account nonce ${n} is not a u32`);
      accountNonce = Number(n);
    } else if (e.identifier === "ChargeTransactionPayment") {
      tip = r.compact();
      if (tip !== 0n) refuse("BAD_BYTES", `a tip of ${tip} raw: the encoder writes a tip of 0`);
    } else if (e.identifier === "CheckMetadataHash" && e.extra.kind === "struct") {
      metadataHashMode = readValue(r, e.extra.fields[0].type, "CheckMetadataHash.mode") as string;
      if (metadataHashMode !== "Disabled") refuse("BAD_BYTES", "the metadata hash check is on: the encoder writes it off");
    }
  }
  if (accountNonce === null || era === null || tip === null || metadataHashMode === null) refuse("RUNTIME_UNKNOWN", "the table lacks an extension the reader needs");
  if (era.phase !== birth.number % era.period) refuse("BAD_BYTES", `the era phase ${era.phase} is not that of block ${birth.number}`);
  const extra = bytes.slice(extraStart, r.position);
  const start = r.position;
  const call = readSessionCall(r, reviewed);
  const callBytes = bytes.slice(start, r.position);
  r.done("the extrinsic");

  const { payload, message, signed } = signingPayload(rt, callBytes, extra, birth.hash);
  let verifies = false;
  try {
    verifies = ed25519.verify(signature, message, signer);
  } catch {
    verifies = false;
  }
  if (!verifies) refuse("SIGNATURE_INVALID", "the signature does not verify against the signer and the payload with this birth hash");
  return { signer, signature, accountNonce, era, tip, metadataHashMode, birth, lastValidBlock: lastValidBlock(birth.number), signed, payloadLength: payload.length, call, callBytes };
}
freezeFunction(readExtrinsic);
