/**
 * The two calls of the session's owner (P5a): FlopSessionKeys.create_session, the grant of a session to the
 * device key, and FlopSessionKeys.revoke_session, its end. They are written as call bytes only: the pallet index,
 * the call index and the arguments, for the owner to sign with his own tool. The encoder never signs one and takes
 * no signer, nonce, era or tip for it (O2).
 *
 * They come from the same frozen table as the session calls (table.ts), found by a check of their own
 * (shape.ts reviewedOwnerRuntime), read back by the strict reader (reader.ts readOwnerCall) and worded from their
 * bytes (describe.ts describeOwnerCall). The allow list is not an input: a grant allows exactly ComputeChannel (O7).
 *
 * Pure: no network, no clock, no file read. No command uses it yet.
 */
import { allowedPallets, isOwnerName, OWNER_ALLOWED_PALLET, OWNER_NAMES, type Bytes32, type OwnerName } from "./calls.js";
import { refuse } from "./errors.js";
import { ownKeys, ownValue, takeValue, writeBytesList, writeValue, type FieldValue } from "./fields.js";
import { readOwnerCall, type OwnerCallData } from "./reader.js";
import { concat } from "./scale.js";
import { reviewedOwnerRuntime, type ReviewedOwner } from "./shape.js";
import type { RuntimeId } from "./table.js";
import { freezeFunction } from "../freeze.js";

/** The grant, with the field names of the metadata (O6). The allow list is not a field: it is always ComputeChannel. */
export interface CreateSessionInput {
  /** The runtime the call is for, by the four names read from the chain. */
  readonly runtime: RuntimeId;
  readonly call: "create_session";
  /** The device key's account, 32 bytes. */
  readonly delegate: Bytes32;
  /** The lifetime cap, raw, a u128. */
  readonly spending_cap: bigint;
  /** The cap of one execute_via_session, raw, a u128. */
  readonly per_tx_limit: bigint;
  /** The cap of one epoch, raw, a u128. */
  readonly daily_cap: bigint;
  /** The session's life in blocks: a whole number from 1 to the runtime's MaxSessionDuration. */
  readonly duration_blocks: number;
}

/** The revoke (O6): the delegate alone. */
export interface RevokeSessionInput {
  readonly runtime: RuntimeId;
  readonly call: "revoke_session";
  readonly delegate: Bytes32;
}

export type OwnerCallInput = CreateSessionInput | RevokeSessionInput;

/** The input of an owner's call, read once and copied. Nothing in it is the caller's. */
interface OwnerSnapshot {
  readonly reviewed: ReviewedOwner;
  readonly call: OwnerName;
  readonly fields: Readonly<Record<string, FieldValue | readonly Uint8Array[]>>;
}

/**
 * The input, read once (O6): an object whose own fields are exactly the runtime, the call's name and the call's
 * fields of the table but the allow list, each read once as an own value. An accessor is refused and a Proxy's get
 * trap is not used. A field missing or extra is refused, the allow list and a signer, nonce, era or tip with it.
 */
function takeOwner(input: unknown): OwnerSnapshot {
  if (input === null || typeof input !== "object" || ArrayBuffer.isView(input) || Array.isArray(input)) refuse("BAD_INPUT", "the owner call input must be an object");
  const keys = ownKeys(input);
  if (!keys.includes("call")) refuse("CALL_NOT_ALLOWED", `an owner call without a name is not one of ${OWNER_NAMES.join(", ")}`);
  const name: unknown = ownValue(input, "call", "the owner call input");
  if (!isOwnerName(name)) refuse("CALL_NOT_ALLOWED", `${String(name)} is not one of ${OWNER_NAMES.join(", ")}`);
  if (!keys.includes("runtime")) refuse("BAD_INPUT", "the owner call input lacks the field runtime");
  const reviewed = reviewedOwnerRuntime(ownValue(input, "runtime", "the owner call input") as RuntimeId);
  const entry = reviewed.calls[name];
  const given = entry.fields.filter((f) => f.type.kind !== "bytesList");
  const list = entry.fields.find((f) => f.type.kind === "bytesList");
  const names = ["runtime", "call", ...given.map((f) => f.name)];
  for (const k of keys) {
    if (list !== undefined && k === list.name) refuse("BAD_INPUT", `${name}.${k} is not an input: a grant allows exactly ${OWNER_ALLOWED_PALLET}`);
    if (!names.includes(k)) refuse("BAD_INPUT", `${name} has a field ${k} the table does not have: an owner call is call bytes only, with no signer, nonce, era or tip`);
  }
  for (const n of names) if (!keys.includes(n)) refuse("BAD_INPUT", `${name} lacks the field ${n}`);
  const fields: Record<string, FieldValue | readonly Uint8Array[]> = {};
  for (const f of given) fields[f.name] = takeValue(f.type, ownValue(input, f.name, name), `${name}.${f.name}`);
  if (list !== undefined) fields[list.name] = allowedPallets();
  return { reviewed, call: name, fields };
}

/** The call bytes, from the snapshot alone, in the table's field order. */
function ownerBytes(s: OwnerSnapshot): Uint8Array {
  const entry = s.reviewed.calls[s.call];
  return concat(
    Uint8Array.of(entry.palletIndex, entry.callIndex),
    ...entry.fields.map((f) => (f.type.kind === "bytesList" ? writeBytesList(s.fields[f.name] as readonly Uint8Array[]) : writeValue(f.type, s.fields[f.name] as FieldValue, `${s.call}.${f.name}`))),
  );
}

/** Equal values of an owner's call: bytes by value, a list of byte strings string by string, numbers and bigints by value. */
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  return a === b;
}

/**
 * The call bytes, read back with the strict reader and compared with the snapshot field by field (O11). The reader
 * refuses a grant the rules do not allow (O8, O9), so nothing is returned that it would not read.
 */
function checkedOwnerBytes(s: OwnerSnapshot): Uint8Array {
  const bytes = ownerBytes(s);
  const back = readOwnerCall(s.reviewed.rt, bytes) as unknown as Record<string, unknown> & OwnerCallData;
  if (back.call !== s.call) refuse("READ_BACK", "the owner call does not read back as it was given");
  for (const f of s.reviewed.calls[s.call].fields) if (!same(back[f.name], s.fields[f.name])) refuse("READ_BACK", `${s.call}.${f.name} does not read back as it was given`);
  return bytes;
}

/**
 * The call bytes of create_session or revoke_session (O1), read back before they are returned. Nothing is signed:
 * the owner signs them with his own tool.
 */
export function encodeOwnerCall(input: OwnerCallInput): Uint8Array {
  return checkedOwnerBytes(takeOwner(input));
}
freezeFunction(encodeOwnerCall);

/** The two constants of the owner's pallet at a runtime, in blocks (O13). */
export interface SessionConstants {
  /** MaxSessionDuration: the longest grant. */
  readonly maxSessionDuration: number;
  /** SessionEpochLength: the blocks of one epoch of the daily cap. */
  readonly sessionEpochLength: number;
}

/** The longest grant and the epoch length of the runtime with these four names, from the frozen table (O13). */
export function sessionConstants(runtime: RuntimeId): SessionConstants {
  const { maxSessionDuration, sessionEpochLength } = reviewedOwnerRuntime(runtime);
  return Object.freeze({ maxSessionDuration, sessionEpochLength });
}
freezeFunction(sessionConstants);
