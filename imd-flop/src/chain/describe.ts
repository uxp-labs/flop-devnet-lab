/**
 * The plain words of a signed session call (rule E9). They are made only from what the strict reader read
 * back from the final bytes, field by field in the table's order, so the words cannot differ from the
 * bytes. Every amount is given in raw units and in FLOP.
 */
import { INNER_PALLET, OUTER } from "./calls.js";
import type { FieldValue } from "./fields.js";
import type { ExtrinsicData, SessionCallData } from "./reader.js";
import { toHex } from "./scale.js";
import { reviewedRuntime } from "./shape.js";
import type { Field, RuntimeId } from "./table.js";

/** Base units per FLOP are 10^18. contract/rules.json FLOP_DECIMALS (test/chain-describe.test.ts holds it). */
export const FLOP_DECIMALS = 18;
const UNIT = 10n ** BigInt(FLOP_DECIMALS);

/** An amount in raw units and in FLOP, exactly: "12000000000000000 raw (0.012 FLOP)". */
export function amountText(raw: bigint): string {
  const whole = raw / UNIT;
  const frac = (raw % UNIT).toString().padStart(FLOP_DECIMALS, "0").replace(/0+$/, "");
  return `${raw} raw (${whole}${frac ? "." + frac : ""} FLOP)`;
}

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

/** The words of a session call: the outer call, the declared spend, the session nonce and the inner call. */
export function describeCall(runtime: RuntimeId, data: SessionCallData): string {
  const entry = reviewedRuntime(runtime).inner[data.inner.call];
  const inner = data.inner as unknown as Record<string, FieldValue>;
  const fields = entry.fields.map((f) => `${f.name} ${valueText(f, inner[f.name])}`).join(", ");
  return [
    `${OUTER.pallet}.${OUTER.name} as owner ${toHex(data.owner)}`,
    `session nonce ${data.sessionNonce}`,
    `declared spend ${amountText(data.spend)}`,
    `inner call ${INNER_PALLET}.${data.inner.call}: ${fields}`,
  ].join("; ");
}

/** The words of a signed session call. The birth block's number and hash are the caller's: the era bytes hold its phase, the signed payload its hash. */
export function describeExtrinsic(runtime: RuntimeId, x: ExtrinsicData, birth: { number: number; hash: Uint8Array }, lastValid: number): string {
  const rt = reviewedRuntime(runtime).rt;
  return [
    `signed by device ${toHex(x.signer)} (MultiAddress ${rt.address.variant}), ${rt.signature.variant} signature ${toHex(x.signature)}`,
    `account nonce ${x.accountNonce}, tip ${amountText(x.tip)}, metadata hash check ${x.metadataHashMode}`,
    `mortal era of ${x.era.period} blocks (phase ${x.era.phase}): born at block ${birth.number}, hash ${toHex(birth.hash)}; valid through block ${lastValid}`,
    `runtime ${rt.specName} ${rt.specVersion}, transaction version ${rt.transactionVersion}, genesis ${rt.genesisHash}`,
    describeCall(rt, x.call),
  ].join("\n");
}
