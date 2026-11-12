/**
 * The signed payload of the chain encoder (rule E6): the call, the extra of each signed extension and the
 * additional signed data, in the table's order; signed as it is up to 256 bytes and as its blake2b 256
 * hash above. The encoder builds the payload to sign it; the strict reader builds it again to verify.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { refuse } from "./errors.js";
import { concat, uintLE } from "./scale.js";
import { reviewedRuntime } from "./shape.js";
import type { RuntimeId } from "./table.js";

/** A payload longer than this is hashed with blake2b 256 before it is signed. */
export const PAYLOAD_HASH_ABOVE = 256;

export type SignedPath = "payload" | "payload-blake2b-256";

/** What is signed: the payload itself up to 256 bytes, its blake2b 256 hash above. */
export function toSign(payload: Uint8Array): { message: Uint8Array; signed: SignedPath } {
  return payload.length > PAYLOAD_HASH_ABOVE ? { message: blake2b(payload, { dkLen: 32 }), signed: "payload-blake2b-256" } : { message: payload, signed: "payload" };
}

function hexBytes(h: string): Uint8Array {
  if (!/^0x([0-9a-f]{2})*$/.test(h)) refuse("RUNTIME_UNKNOWN", `the table holds ${h}, not lower case hex`);
  return hexToBytes(h.slice(2));
}

/** The additional signed data of a reviewed runtime for a transaction born at the block of `birthHash`. */
export function additionalSigned(runtime: RuntimeId, birthHash: Uint8Array): Uint8Array {
  const { rt } = reviewedRuntime(runtime);
  const parts: Uint8Array[] = [];
  for (const e of rt.signedExtensions) {
    if (e.identifier === "CheckSpecVersion") parts.push(uintLE(BigInt(rt.specVersion), 4));
    else if (e.identifier === "CheckTxVersion") parts.push(uintLE(BigInt(rt.transactionVersion), 4));
    else if (e.identifier === "CheckGenesis") parts.push(hexBytes(rt.genesisHash));
    else if (e.identifier === "CheckMortality") parts.push(Uint8Array.from(birthHash));
    else if (e.identifier === "CheckMetadataHash") parts.push(Uint8Array.of(0)); // None: no metadata hash
  }
  return concat(...parts);
}

/** The payload of a call and the extras that go with it, and how it is signed. */
export function signingPayload(runtime: RuntimeId, call: Uint8Array, extra: Uint8Array, birthHash: Uint8Array): { payload: Uint8Array; message: Uint8Array; signed: SignedPath } {
  const payload = concat(call, extra, additionalSigned(runtime, birthHash));
  return { payload, ...toSign(payload) };
}
