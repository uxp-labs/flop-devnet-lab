/**
 * The plain words of a session call and of a signed session call (rules E9 and H5). Each exported function
 * takes bytes and the four names of a runtime, reads the bytes with the strict reader, and words only what
 * it read, field by field in the table's order. No exported function takes a caller's data to word, so the
 * words cannot differ from the bytes. Every amount is given in raw units and in FLOP.
 *
 * describeOwnerCall words the owner's two calls (P5a, O10) the same way, from their bytes alone.
 */
import { INNER_PALLET, OUTER, OWNER_PALLET } from "./calls.js";
import type { FieldValue } from "./fields.js";
import { readCall, readExtrinsic, readOwnerCall, type ExtrinsicData, type OwnerCallData, type SessionCallData } from "./reader.js";
import { toHex } from "./scale.js";
import { reviewedOwnerRuntime, reviewedRuntime, type Reviewed, type ReviewedOwner } from "./shape.js";
import type { Field, RuntimeId } from "./table.js";
import { freezeFunction } from "../freeze.js";

/** Base units per FLOP are 10^18. contract/rules.json FLOP_DECIMALS (test/chain-words.test.ts holds it). */
export const FLOP_DECIMALS = 18;
const UNIT = 10n ** BigInt(FLOP_DECIMALS);

/** An amount in raw units and in FLOP, exactly: "12000000000000000 raw (0.012 FLOP)". */
export function amountText(raw: bigint): string {
  const whole = raw / UNIT;
  const frac = (raw % UNIT).toString().padStart(FLOP_DECIMALS, "0").replace(/0+$/, "");
  return `${raw} raw (${whole}${frac ? "." + frac : ""} FLOP)`;
}
freezeFunction(amountText);

function valueText(field: Field, value: FieldValue): string {
  const t = field.type;
  if (t.kind === "bytes32") return toHex(value as Uint8Array);
  if (t.kind === "u128") return amountText(value as bigint);
  if (t.kind === "struct") {
    const v = value as Record<string, FieldValue>;
    return `(${t.fields.map((f) => `${f.name} ${valueText(f, v[f.name])}`).join(", ")})`;
  }
  return String(value);
}

/** Words of what the strict reader read. Not exported: it is reached only from bytes. */
function callWords({ inner: entries }: Reviewed, data: SessionCallData): string {
  const entry = entries[data.inner.call];
  const inner = data.inner as unknown as Record<string, FieldValue>;
  const fields = entry.fields.map((f) => `${f.name} ${valueText(f, inner[f.name])}`).join(", ");
  return [
    `${OUTER.pallet}.${OUTER.name} as owner ${toHex(data.owner)}`,
    `session nonce ${data.sessionNonce}`,
    `declared spend ${amountText(data.spend)}`,
    `inner call ${INNER_PALLET}.${data.inner.call}: ${fields}`,
  ].join("; ");
}

/**
 * The era line, made here only. The bytes hold the era's phase. The signature binds the birth block's hash.
 * The birth block's number is what the caller gave: only its remainder by the period is checked.
 */
function eraWords(x: ExtrinsicData): string {
  return `mortal era of ${x.era.period} blocks (phase ${x.era.phase}): the signature binds the birth block hash ${toHex(x.birth.hash)}; the birth block number ${x.birth.number} is as given, the bytes hold only the phase; the last valid block ${x.lastValidBlock} follows from that number`;
}

function extrinsicWords(reviewed: Reviewed, x: ExtrinsicData): string {
  const rt = reviewed.rt;
  return [
    `signed by device ${toHex(x.signer)} (MultiAddress ${rt.address.variant}), ${rt.signature.variant} signature ${toHex(x.signature)}`,
    `account nonce ${x.accountNonce}, tip ${amountText(x.tip)}, metadata hash check ${x.metadataHashMode}`,
    eraWords(x),
    `runtime ${rt.specName} ${rt.specVersion}, transaction version ${rt.transactionVersion}, genesis ${rt.genesisHash}`,
    callWords(reviewed, x.call),
  ].join("\n");
}

/** The words of call bytes: the outer call, the declared spend, the session nonce and the inner call. */
export function describeCall(runtime: RuntimeId, callBytes: Uint8Array): string {
  const data = readCall(runtime, callBytes);
  return callWords(reviewedRuntime(runtime), data);
}
freezeFunction(describeCall);

/**
 * The words of a signed extrinsic. The birth block is checked against the bytes: its phase against the era
 * and its hash by the signature, which verifies only over the payload that holds it.
 */
export function describeExtrinsic(runtime: RuntimeId, extrinsic: Uint8Array, birth: { readonly number: number; readonly hash: Uint8Array }): string {
  const x = readExtrinsic(runtime, extrinsic, birth);
  return extrinsicWords(reviewedRuntime(runtime), x);
}
freezeFunction(describeExtrinsic);

/** The names of an allow list, from its bytes: each read as UTF-8, a string that is not UTF-8 refused by the decoder. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Words of what the strict reader read of an owner's call. Not exported: it is reached only from bytes. */
function ownerWords({ calls }: ReviewedOwner, data: OwnerCallData): string {
  const entry = calls[data.call];
  const values = data as unknown as Record<string, FieldValue | readonly Uint8Array[]>;
  const fields = entry.fields.map((f) => {
    const v = values[f.name];
    if (f.type.kind === "bytesList") return `${f.name} [${(v as readonly Uint8Array[]).map((b) => UTF8.decode(b)).join(", ")}]`;
    if (f.type.kind === "u32") return `${f.name} ${String(v)} blocks`;
    return `${f.name} ${valueText(f, v as FieldValue)}`;
  });
  return `${OWNER_PALLET}.${data.call}, a call of the session's owner, call bytes only and not signed here: ${fields.join(", ")}`;
}

/** The words of an owner's call bytes (P5a, O10): the call, the delegate, each cap in raw and FLOP, the duration in blocks, the allow list. */
export function describeOwnerCall(runtime: RuntimeId, callBytes: Uint8Array): string {
  const data = readOwnerCall(runtime, callBytes);
  return ownerWords(reviewedOwnerRuntime(runtime), data);
}
freezeFunction(describeOwnerCall);
