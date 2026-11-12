/**
 * The shape of a runtime that the chain encoder can write and its reader can read. A table entry of any
 * other shape is refused as RUNTIME_UNKNOWN, before anything is written: an unknown signed extension, an
 * extension whose types changed, an outer call with other fields, an inner call missing or whose spend field
 * is not an amount, an extrinsic version other than 4.
 */
import { refuse } from "./errors.js";
import { deepFreeze } from "./freeze.js";
import { INNER_CALLS, INNER_NAMES, INNER_PALLET, OUTER } from "./calls.js";
import { callEntry, type CallEntry, type Runtime, type Ty } from "./table.js";

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

/** Refuses a runtime this encoder cannot write. Returns the outer call's entry and the five inner entries. */
export function checkRuntime(rt: Runtime): { outer: CallEntry; inner: readonly CallEntry[] } {
  if (rt.extrinsicVersion !== EXTRINSIC_VERSION) unknown(rt, `extrinsic version ${rt.extrinsicVersion}, not ${EXTRINSIC_VERSION}`);
  const ids = rt.signedExtensions.map((e) => e.identifier);
  if (new Set(ids).size !== ids.length) unknown(rt, "a signed extension listed twice");
  for (const e of rt.signedExtensions) {
    const want = Object.hasOwn(KNOWN_EXTENSIONS, e.identifier) ? KNOWN_EXTENSIONS[e.identifier] : undefined;
    if (!want) unknown(rt, `signed extension ${e.identifier} is not one this encoder fills`);
    if (!same(e.extra, want.extra) || !same(e.additionalSigned, want.additionalSigned)) unknown(rt, `signed extension ${e.identifier} has types this encoder does not write`);
  }
  for (const id of REQUIRED_EXTENSIONS) if (!ids.includes(id)) unknown(rt, `no signed extension ${id}`);
  const at = (pallet: string, name: string) => {
    try {
      return callEntry(rt, pallet, name);
    } catch {
      return unknown(rt, `no ${pallet}.${name} in the table`);
    }
  };
  const outer = at(OUTER.pallet, OUTER.name);
  if (!sameFieldSet(outer, OUTER_FIELDS)) unknown(rt, `${OUTER.pallet}.${OUTER.name} has fields this encoder does not fill`);
  const inner = INNER_NAMES.map((name) => {
    const entry = at(INNER_PALLET, name);
    const spendField = INNER_CALLS[name];
    if (spendField !== null && !entry.fields.some((f) => f.name === spendField && f.type.kind === "u128")) {
      unknown(rt, `${INNER_PALLET}.${name} has no amount ${spendField}`);
    }
    if (entry.fields.some((f) => f.type.kind === "call")) unknown(rt, `${INNER_PALLET}.${name} carries a call`);
    return entry;
  });
  const keys = [outer, ...inner].map((e) => `${e.palletIndex}/${e.callIndex}`);
  if (new Set(keys).size !== keys.length) unknown(rt, "two calls share one index");
  return { outer, inner };
}
