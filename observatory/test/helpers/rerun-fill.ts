// The fill of the session rerun's results.json (research/2026-11-12-session-rerun-1014020) from the
// fourth recording, through the lab's decoder's one door (src/scale/block.ts) and the reader of a
// batch answer. Pure but for reading the committed files it names. The one place both the tests and
// the script (scripts/fill-rerun-results.mjs) get it from.
//
// It writes only the fields the recording gives, and keeps every other field as the lead wrote it:
// per step last_runtime_upgrade_spec, events, result, fee_raw, the values of reads_after (its keys are
// the lead's), and reads_not_decoded where a value was answered but the decoder does not state its
// entry; at the top filled_from. Run again on 2026-11-13 with decoder-shape@3 (round 29), which
// states FailedAcks and DelegateSessions, so both reads are decoded through the door. Unknown stays null, never 0. A value is filled only from a block
// whose batch answer was read, whose LastRuntimeUpgrade names a reviewed runtime, and whose events
// decoded; otherwise that step's fill fields stay null.
import { readFileSync } from "node:fs";
import { decodeBlockEvents, decodeStorageValue, runtimeOfBlock } from "../../src/scale/block.js";
import { SHAPE_SCHEMA } from "../../src/scale/shape.js";
import { RERUN_RECORDING, RERUN_RESULTS, type RerunBlock, recordedRerun } from "./recorded-rerun.js";
import { keyBytes } from "./requests/core.js";
import type { Inputs, ReadField } from "./requests/list-4.js";
import { ENTRY_OF } from "./requests/list-4.js";

const REPO = new URL("../../../", import.meta.url);
const repoText = (path: string) => readFileSync(new URL(path, REPO), "utf8");
export const ERRORS_FILE = "research/2026-11-12-session-rerun-1014020/errors-1014020.json";

type Value = null | boolean | number | string | Value[] | { [name: string]: Value };
type Rec = Record<string, unknown>;
interface ErrorRow {
  pallet: string;
  pallet_index: number;
  error_index: number;
  name: string;
}

/** Where each filled value came from: the one line results.json carries for all of them (M3). */
export const FILLED_FROM = {
  recording: `observatory/fixtures/${RERUN_RECORDING}`,
  by: "observatory/scripts/fill-rerun-results.mjs (test/helpers/rerun-fill.ts)",
  how: "last_runtime_upgrade_spec, events, result, fee_raw and the values of reads_after are decoded from the recording through the lab's decoder's one door, observatory/src/scale/block.ts, at the spec each block's System.LastRuntimeUpgrade names, with the reviewed shape the door pinned; failed_acks_of_named \"absent\" is the batch answer listing its key with null, which the door answers as no value stored; reads_not_decoded holds bytes the node answered for an entry the reviewed shape does not state, and the read they answer stays null in reads_after. Every other field is the lead's, as read at run time.",
  /** The format of the reviewed shape the door pinned when this fill ran: decoder-shape@3 since round 29. */
  shape: SHAPE_SCHEMA,
};

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

/** A decoded value in the results form: every enum value { variant, fields } written { type, value }, as events_form gives dispatch_error. */
function resultsForm(v: Value): Value {
  if (Array.isArray(v)) return v.map(resultsForm);
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 2 && keys.includes("variant") && keys.includes("fields") && typeof v.variant === "string") return { type: v.variant, value: resultsForm(v.fields as Value) };
    return Object.fromEntries(keys.map((k) => [k, resultsForm(v[k] as Value)]));
  }
  return v;
}

/** The result of an extrinsic from its events: success, or the error by the 1014020 table; null when it cannot be named. */
function resultOf(events: Rec[], errors: readonly ErrorRow[]): string | null {
  const ok = events.filter((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess");
  const failed = events.filter((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
  if (ok.length + failed.length !== 1) return null;
  if (ok.length === 1) return "success";
  const d = (failed[0]?.fields as Rec | undefined)?.dispatch_error as Rec | undefined;
  const v = d?.value as Rec | undefined;
  if (d?.type !== "Module" || !isRec(v) || !Number.isInteger(v.index) || typeof v.error !== "string" || !/^0x[0-9a-f]{8}$/.test(v.error)) return null;
  const index = Number.parseInt(v.error.slice(2, 4), 16);
  const row = errors.find((e) => e.pallet_index === v.index && e.error_index === index);
  return row === undefined ? null : `failed: ${row.pallet}.${row.name} (pallet ${row.pallet_index}, error ${row.error_index})`;
}

/** What the fill gives for one step, every field null when the block could not be read. */
export interface StepFill {
  last_runtime_upgrade_spec: number | null;
  events: Rec[];
  result: string | null;
  fee_raw: string | null;
  reads_after: Partial<Record<ReadField, string | null>>;
  reads_not_decoded: Partial<Record<ReadField, { entry: string; bytes: string; why: string }>>;
}

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
/** A decoded number, string or bool as text; anything else null. */
const text = (x: unknown) => (typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x) : null);
/** The bytes of a key the list asked, as 0x hex (the list writes only whole bytes, lower case). */
const keyOf = (h: string) => new Uint8Array(Buffer.from(h.slice(2), "hex"));

/** The fill of one step's block: its extrinsic at extrinsicIndex, and the reads its fields name. */
export function fillStep(b: RerunBlock, inputs: Inputs, metadata: Uint8Array, extrinsicIndex: number, fields: readonly ReadField[], errors: readonly ErrorRow[]): StepFill {
  const empty: StepFill = { last_runtime_upgrade_spec: null, events: [], result: null, fee_raw: null, reads_after: Object.fromEntries(fields.map((f) => [f, null])), reads_not_decoded: {} };
  if (!b.answer.read) return empty;
  const values = b.answer.values;
  const lru = values.get(b.keys[1] as string);
  const events = values.get(b.keys[0] as string);
  if (!(lru instanceof Uint8Array) || !(events instanceof Uint8Array)) return empty;
  const rt = runtimeOfBlock(lru);
  if (!rt.found) return empty;
  const pin = { specName: rt.reviewed.specName, specVersion: rt.reviewed.specVersion, metadata, lastRuntimeUpgrade: lru, shapeText: readFileSync(new URL(`../../${rt.reviewed.shapeFile}`, import.meta.url), "utf8") };
  const decoded = decodeBlockEvents({ ...pin, events });
  if (!decoded.decoded) return { ...empty, last_runtime_upgrade_spec: rt.reviewed.specVersion };
  const mine: Rec[] = decoded.events
    .filter((e) => isRec(e.phase) && e.phase.variant === "ApplyExtrinsic" && e.phase.fields === extrinsicIndex)
    .map((e) => ({ pallet: e.pallet, name: e.event, fields: resultsForm(e.fields as Value) }));
  const fees = mine.filter((e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid");
  const fee = fees.length === 1 ? (fees[0]?.fields as Rec).actual_fee : null;
  const out: StepFill = { last_runtime_upgrade_spec: rt.reviewed.specVersion, events: mine, result: resultOf(mine, errors), fee_raw: typeof fee === "string" ? fee : null, reads_after: { ...empty.reads_after }, reads_not_decoded: {} };
  for (const f of fields) {
    const j = b.reads.findIndex((r) => r.entry === ENTRY_OF[f]);
    const r = b.reads[j];
    const key = b.keys[j];
    if (r === undefined || key === undefined || !values.has(key)) continue;
    const answer = values.get(key) ?? null;
    const v = decodeStorageValue({ ...pin, pallet: r.pallet, entry: r.entry, keys: keyBytes(inputs, r), key: keyOf(key), answer });
    if (!v.decoded) {
      // M2: the decoder refuses an entry its reviewed shape does not state; the bytes are kept, the value stays unknown.
      if (answer !== null && v.refused.includes("is not a storage entry the reviewed shape states")) out.reads_not_decoded[f] = { entry: `${r.pallet}.${r.entry}`, bytes: hex(answer), why: "the reviewed shape does not state this entry" };
      continue;
    }
    const value = v.value as Value;
    // M1, decoded through the door since decoder-shape@3 (round 29): the node holding nothing under the key is "absent".
    if (f === "failed_acks_of_named") {
      out.reads_after[f] = v.stored ? text(value) : "absent";
      continue;
    }
    // A list of (owner, delegate) pairs. The record's form (reads_form) gives "empty" or the stored value; a read the
    // node holds nothing for is neither, so it is written "absent", the form's word for FailedAcks. The fourth
    // recording holds no such read. A stored list with no pair is "empty", with pairs the pairs' JSON text.
    if (f === "delegate_sessions_of_device") {
      if (!v.stored) out.reads_after[f] = "absent";
      else if (Array.isArray(value)) out.reads_after[f] = value.length === 0 ? "empty" : JSON.stringify(value);
      continue;
    }
    if (!v.stored && r.entry === "Sessions") continue;
    const field = (name: string) => (isRec(value) ? value[name] : undefined);
    if (f === "session_active") out.reads_after[f] = text(field("active"));
    else if (f === "spent_raw") out.reads_after[f] = text(field("spent"));
    else if (f === "epoch_spent_raw") out.reads_after[f] = text(field("epoch_spent"));
    else if (f === "session_nonce") out.reads_after[f] = text(value);
    else if (f === "breaker_tx_count") out.reads_after[f] = text(field("tx_count"));
  }
  return out;
}

/** The fill fields of results.json cleared to what the template holds, every other field kept: what the fill must give back whole. */
export function clearFill(results: Rec): Rec {
  const steps = (results.steps as Rec[]).map((s) => {
    const { reads_not_decoded: _, ...rest } = s;
    return { ...rest, last_runtime_upgrade_spec: null, events: [], result: null, fee_raw: null, reads_after: Object.fromEntries(Object.keys(s.reads_after as Rec).map((k) => [k, null])) };
  });
  const { filled_from: _, ...top } = results;
  return { ...top, steps };
}

/** results.json filled from the recording: each step's fill fields replaced, in their place, reads_not_decoded after reads_after where there is one, and filled_from at the end. */
export function fillResults(results: Rec): Rec {
  const R = recordedRerun();
  const errors = (JSON.parse(repoText(ERRORS_FILE)) as { errors: ErrorRow[] }).errors;
  const steps = (results.steps as Rec[]).map((s) => {
    const b = R.blocks.find((x) => x.step.id === s.step);
    if (b === undefined) throw new Error(`the recording holds no block for step ${String(s.step)}`);
    const fields = Object.keys(s.reads_after as Rec) as ReadField[];
    const f = fillStep(b, R.inputs, R.metadata, s.extrinsic_index as number, fields, errors);
    const out: Rec = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "reads_not_decoded") continue;
      if (k === "last_runtime_upgrade_spec" || k === "events" || k === "result" || k === "fee_raw") out[k] = f[k];
      else if (k === "reads_after") {
        out[k] = f.reads_after;
        if (Object.keys(f.reads_not_decoded).length > 0) out.reads_not_decoded = f.reads_not_decoded;
      } else out[k] = v;
    }
    return out;
  });
  const { filled_from: _, ...top } = results;
  return { ...top, steps, filled_from: FILLED_FROM };
}

/** results.json as the committed file must hold it: the committed file filled again from the recording. */
export function rerunResultsText(): string {
  return `${JSON.stringify(fillResults(JSON.parse(repoText(RERUN_RESULTS)) as Rec), null, 2)}\n`;
}
