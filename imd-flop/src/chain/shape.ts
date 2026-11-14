/**
 * The shape of a runtime that the chain encoder can write and its reader can read. A table entry of any
 * other shape is refused as RUNTIME_UNKNOWN, before anything is written: an unknown signed extension, an
 * extension whose types changed, an outer call with other fields, an inner call missing or whose spend field
 * is not an amount, an extrinsic version other than 4.
 */
import { refuse } from "./errors.js";
import { deepFreeze, freezeFunction } from "../freeze.js";
import { INNER_CALLS, INNER_NAMES, INNER_PALLET, OUTER, OWNER_CONSTANTS, OWNER_NAMES, OWNER_PALLET, type InnerName, type OwnerName } from "./calls.js";
import { runtimeFor, type CallEntry, type Runtime, type RuntimeId, type Ty } from "./table.js";

export const EXTRINSIC_VERSION = 4;

const UNIT: Ty = deepFreeze({ kind: "unit" });
const U32: Ty = deepFreeze({ kind: "u32" });
const B32: Ty = deepFreeze({ kind: "bytes32" });

/** The signed extensions this encoder fills, with the types it fills them as. Their order is the table's. */
export const KNOWN_EXTENSIONS: Readonly<Record<string, { readonly extra: Ty; readonly additionalSigned: Ty }>> = deepFreeze({
  CheckNonZeroSender: { extra: UNIT, additionalSigned: UNIT },
  CheckSpecVersion: { extra: UNIT, additionalSigned: U32 },
  CheckTxVersion: { extra: UNIT, additionalSigned: U32 },
  CheckGenesis: { extra: UNIT, additionalSigned: B32 },
  CheckMortality: { extra: { kind: "era" }, additionalSigned: B32 },
  CheckNonce: { extra: { kind: "compact", of: "u32" }, additionalSigned: UNIT },
  CheckWeight: { extra: UNIT, additionalSigned: UNIT },
  ChargeTransactionPayment: { extra: { kind: "compact", of: "u128" }, additionalSigned: UNIT },
  CheckMetadataHash: {
    extra: {
      kind: "struct",
      fields: [{ name: "mode", type: { kind: "enum", variants: [{ name: "Disabled", index: 0 }, { name: "Enabled", index: 1 }] } }],
    },
    additionalSigned: { kind: "option", of: B32 },
  },
});

/**
 * The extensions a runtime must have: those that bind the transaction to this chain, this runtime, the
 * birth block and the signer's nonce, and those whose value the encoder states (no tip, no metadata hash).
 */
export const REQUIRED_EXTENSIONS = Object.freeze(["CheckSpecVersion", "CheckTxVersion", "CheckGenesis", "CheckMortality", "CheckNonce", "ChargeTransactionPayment", "CheckMetadataHash"] as const);

/** The fields of execute_via_session, by name, as the encoder fills them. */
const OUTER_FIELDS: Readonly<Record<string, Ty>> = deepFreeze({ owner: B32, call: { kind: "call" }, spend_amount: { kind: "u128" }, nonce: { kind: "u64" } });

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sameFieldSet(entry: CallEntry, want: Readonly<Record<string, Ty>>): boolean {
  const names = entry.fields.map((f) => f.name);
  return names.length === Object.keys(want).length && entry.fields.every((f) => Object.hasOwn(want, f.name) && same(f.type, want[f.name]));
}

function unknown(rt: Runtime, why: string): never {
  refuse("RUNTIME_UNKNOWN", `${rt.specName} ${rt.specVersion}: ${why}`);
}

/** A runtime of the table whose shape this encoder writes, with its outer call and its five inner calls. */
export interface Reviewed {
  readonly rt: Runtime;
  readonly outer: CallEntry;
  readonly inner: Readonly<Record<InnerName, CallEntry>>;
}

function entryOf(rt: Runtime, pallet: string, name: string): CallEntry {
  return rt.calls.find((c) => c.pallet === pallet && c.name === name) ?? unknown(rt, `no ${pallet}.${name} in the table`);
}

/** Whether a type holds this kind anywhere: itself, inside a struct's fields, inside an option. */
function holdsKind(ty: Ty, kind: Ty["kind"]): boolean {
  if (ty.kind === kind) return true;
  if (ty.kind === "struct") return ty.fields.some((f) => holdsKind(f.type, kind));
  if (ty.kind === "option") return holdsKind(ty.of, kind);
  return false;
}

/** Refuses a runtime this encoder cannot write. Not exported: only reviewedRuntime reaches it, with a table entry. */
function checkShape(rt: Runtime): Reviewed {
  if (rt.extrinsicVersion !== EXTRINSIC_VERSION) unknown(rt, `extrinsic version ${rt.extrinsicVersion}, not ${EXTRINSIC_VERSION}`);
  const ids = rt.signedExtensions.map((e) => e.identifier);
  if (new Set(ids).size !== ids.length) unknown(rt, "a signed extension listed twice");
  for (const e of rt.signedExtensions) {
    const want = Object.hasOwn(KNOWN_EXTENSIONS, e.identifier) ? KNOWN_EXTENSIONS[e.identifier] : undefined;
    if (!want) unknown(rt, `signed extension ${e.identifier} is not one this encoder fills`);
    if (!same(e.extra, want.extra) || !same(e.additionalSigned, want.additionalSigned)) unknown(rt, `signed extension ${e.identifier} has types this encoder does not write`);
  }
  for (const id of REQUIRED_EXTENSIONS) if (!ids.includes(id)) unknown(rt, `no signed extension ${id}`);
  const outer = entryOf(rt, OUTER.pallet, OUTER.name);
  if (!sameFieldSet(outer, OUTER_FIELDS)) unknown(rt, `${OUTER.pallet}.${OUTER.name} has fields this encoder does not fill`);
  const inner = {} as Record<InnerName, CallEntry>;
  for (const name of INNER_NAMES) {
    const entry = entryOf(rt, INNER_PALLET, name);
    const spendField = INNER_CALLS[name];
    if (spendField !== null && !entry.fields.some((f) => f.name === spendField && f.type.kind === "u128")) {
      unknown(rt, `${INNER_PALLET}.${name} has no amount ${spendField}`);
    }
    if (entry.fields.some((f) => f.type.kind === "call")) unknown(rt, `${INNER_PALLET}.${name} carries a call`);
    if (entry.fields.some((f) => holdsKind(f.type, "bytesList"))) unknown(rt, `${INNER_PALLET}.${name} carries a list of byte strings`);
    inner[name] = entry;
  }
  const keys = [outer, ...Object.values(inner)].map((e) => `${e.palletIndex}/${e.callIndex}`);
  if (new Set(keys).size !== keys.length) unknown(rt, "two calls share one index");
  return deepFreeze({ rt, outer, inner });
}

/**
 * The reviewed runtime with these four names, found in the frozen table, with its shape checked (rule H6).
 * A caller gives names, never a runtime: a forged one has no way in.
 */
export function reviewedRuntime(id: RuntimeId): Reviewed {
  return checkShape(runtimeFor(id));
}
freezeFunction(reviewedRuntime);

/** The fields of the owner's two calls, by name, as the encoder fills them (P5a, O6). */
const OWNER_FIELDS: Readonly<Record<OwnerName, Readonly<Record<string, Ty>>>> = deepFreeze({
  create_session: { delegate: B32, spending_cap: { kind: "u128" }, per_tx_limit: { kind: "u128" }, daily_cap: { kind: "u128" }, duration_blocks: U32, allowed_pallets: { kind: "bytesList" } },
  revoke_session: { delegate: B32 },
});

const U32_MAX = 0xffffffff;

/** A runtime of the table fit for the owner's two calls, with their entries and the two constants of the pallet. */
export interface ReviewedOwner {
  readonly rt: Runtime;
  readonly calls: Readonly<Record<OwnerName, CallEntry>>;
  /** MaxSessionDuration: the longest grant, in blocks. */
  readonly maxSessionDuration: number;
  /** SessionEpochLength: the blocks of one daily cap's epoch. */
  readonly sessionEpochLength: number;
}

function constantOf(rt: Runtime, name: string): number {
  const found = rt.constants.filter((c) => c.pallet === OWNER_PALLET && c.name === name);
  if (found.length !== 1) unknown(rt, `${found.length === 0 ? "no" : "more than one"} constant ${OWNER_PALLET}.${name} in the table`);
  const [c] = found;
  if (!same(c.type, U32)) unknown(rt, `${OWNER_PALLET}.${name} is not a u32`);
  if (!Number.isSafeInteger(c.value) || c.value < 1 || c.value > U32_MAX) unknown(rt, `${OWNER_PALLET}.${name} is ${String(c.value)}, not a whole number of blocks from 1 to ${U32_MAX}`);
  return c.value;
}

/**
 * Refuses a runtime the owner's calls cannot be written for (P5a, O5): a check of its own, apart from checkShape, so
 * the session path is not changed by it. Both calls present with exactly their fields and types, the two constants
 * present, whole and in order (the epoch not above the longest duration), and no index of an owner call shared with
 * another call of the table. Not exported: only reviewedOwnerRuntime reaches it, with a table entry.
 */
function checkOwnerShape(rt: Runtime): ReviewedOwner {
  const calls = {} as Record<OwnerName, CallEntry>;
  for (const name of OWNER_NAMES) {
    const entry = entryOf(rt, OWNER_PALLET, name);
    const entries = rt.calls.filter((c) => c.pallet === OWNER_PALLET && c.name === name);
    if (entries.length !== 1) unknown(rt, `${entries.length} entries of ${OWNER_PALLET}.${name} in the table, not exactly one`);
    const elsewhere = rt.calls.find((c) => c.pallet === OWNER_PALLET && c.palletIndex !== entry.palletIndex);
    if (elsewhere !== undefined) unknown(rt, `${OWNER_PALLET}.${elsewhere.name} has pallet index ${elsewhere.palletIndex}, not ${entry.palletIndex} as ${OWNER_PALLET}.${name}`);
    const names = entry.fields.map((f) => f.name);
    if (new Set(names).size !== names.length || !sameFieldSet(entry, OWNER_FIELDS[name])) unknown(rt, `${OWNER_PALLET}.${name} has fields this encoder does not fill`);
    const sharing = rt.calls.filter((c) => c.palletIndex === entry.palletIndex && c.callIndex === entry.callIndex);
    if (sharing.length !== 1) unknown(rt, `${OWNER_PALLET}.${name} shares its index ${entry.palletIndex}/${entry.callIndex} with another call`);
    calls[name] = entry;
  }
  if (!Array.isArray(rt.constants)) unknown(rt, "the table holds no constants");
  const maxSessionDuration = constantOf(rt, OWNER_CONSTANTS.maxSessionDuration);
  const sessionEpochLength = constantOf(rt, OWNER_CONSTANTS.sessionEpochLength);
  if (sessionEpochLength > maxSessionDuration) unknown(rt, `the epoch of ${sessionEpochLength} blocks is above the longest session of ${maxSessionDuration} blocks`);
  return deepFreeze({ rt, calls, maxSessionDuration, sessionEpochLength });
}

/**
 * The reviewed runtime with these four names, found in the frozen table, fit for the owner's two calls (P5a, O5).
 * A caller gives names, never a runtime, as reviewedRuntime.
 */
export function reviewedOwnerRuntime(id: RuntimeId): ReviewedOwner {
  return checkOwnerShape(runtimeFor(id));
}
freezeFunction(reviewedOwnerRuntime);
