// The record of a run, read the same way by every tool of this folder: sign-device.mjs,
// record-step.mjs, plan.mjs next and judge.mjs. A record is one of two kinds (results.json
// "record"): "run-time", written by record-step.mjs from what the pane relayed, or "final", filled
// later from an observatory recording. This file only reads; it writes nothing. No network, no key.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HASH, RAW, readJson, stepOf } from "./lib.mjs";

export const KINDS = ["run-time", "final"];
/** The attempts of a step that S5 allows: a cleanup step may be attempted twice more. */
export const MAX_ATTEMPTS = 3;

/** The step id of an id: T6 for T6, T6.2 and T6.3. */
export const baseOf = (id) => String(id).split(".")[0];
/** The attempt number of an id: 1 for T6, 2 for T6.2. */
export const attemptOf = (id) => { const p = String(id).split("."); return p.length === 1 ? 1 : Number(p[1]); };
/** The ids a step may be recorded under, in order: T6, T6.2, T6.3 for a cleanup step, T3 alone otherwise. */
export const idsOf = (step) => (step.cleanup ? [step.id, ...Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => `${step.id}.${i + 2}`)] : [step.id]);

/** Whether an id is a step of the plan or an attempt S5 allows of one; the step, or null. */
export function planStepOf(plan, id) {
  const step = plan.steps.find((s) => s.id === baseOf(id));
  if (!step || !idsOf(step).includes(String(id))) return null;
  return step;
}

/** The words the record carries for a stop by the lead of case d (F3). */
export const NEVER_SENT = "the lead says this copy was never sent";
/** The lead's stop at an id the record holds (F3), or null. */
export const leadStopOf = (results, id) => entryOf(results, id)?.lead_stop ?? null;
/**
 * What a stop by the lead leaves, in words (H4): after case c or d the copy, by its files, its
 * extrinsic hash, its signer and its nonce. It stays valid until that signer's nonce is used, it must
 * never be sent, and the next transaction this signer sends ends it. Nothing for cases a and b.
 */
export function unsentLeft(id, stop) {
  if (stop?.case !== "c" && stop?.case !== "d") return [];
  const ev = stop.evidence ?? {};
  const files = Array.isArray(stop.unsent) && stop.unsent.length ? stop.unsent : [ev.copy ?? `signed/${id}.json`];
  const why = stop.case === "d" ? NEVER_SENT : "refused at submission with node code 1010 at a first send";
  const signer = ev.signer ?? "not known", nonce = ev.nonce ?? "not known";
  return [`${files.join(" and ")} of ${id}: ${why}; they must never be sent. The copy (extrinsic hash ${ev.extrinsic_hash ?? "not known"}, signer ${signer}, nonce ${nonce}) stays valid until the nonce ${nonce} of ${signer} is used: the next transaction this signer sends ends it`];
}

/** Every runner reading the record holds of an id, earlier ones first, the current one last. */
export function readingsOf(view) {
  const rt = view?.entry?.run_time;
  if (!rt) return [];
  return [...(rt.earlier_readings ?? []).map((x) => x?.sent), rt.sent].filter((x) => x && typeof x === "object");
}

/** The run folder's files. */
export const runFiles = (run) => ({ results: join(run, "results.json"), signed: join(run, "signed") });
export const signedFile = (run, id) => join(run, "signed", `${id}.json`);
export const sendFile = (run, id) => join(run, "signed", `${id}.send.json`);

/** The send file's text of a signed record: exactly {"step","extrinsic"} on one line, no line end (S3). */
export const sendText = (id, extrinsic) => JSON.stringify({ step: id, extrinsic });

/** The record of a run folder, or null when there is none. */
export const loadRecord = (run) => (existsSync(runFiles(run).results) ? readJson(runFiles(run).results) : null);

/** The entry of an id in the record, or null. */
export const entryOf = (results, id) => (results?.steps ?? []).find((s) => s.step === id) ?? null;

/**
 * What a record holds of one id, the same for both kinds:
 *   final         included in a block the node reported finalized (with its hash and number)
 *   block_number, block_hash, extrinsic_index, extrinsic_hash
 *   success       true, false, or null when no outcome is read yet
 *   error         { pallet_index, error_index, name } of a failed one, name null when the 1014020 table has none
 *   events        [{ pallet, name, fields }]: all of them in a final record; at run time only those
 *                 of ComputeChannel and FlopSessionKeys, as the explorer gave them
 *   names         every event as Pallet.Name, in order
 *   sent_status   the runner's word at run time (finalized, deadline, ...), or null
 */
export function viewOf(results, id) {
  const e = entryOf(results, id);
  if (!e) return null;
  if (results.record === "final") {
    const events = Array.isArray(e.events) ? e.events : [];
    const ok = events.some((x) => x.pallet === "System" && x.name === "ExtrinsicSuccess");
    const failed = events.find((x) => x.pallet === "System" && x.name === "ExtrinsicFailed");
    const final = HASH.test(e.block_hash ?? "") && Number.isInteger(e.finalized_in_block);
    return {
      id, final, block_number: final ? e.finalized_in_block : null, block_hash: final ? e.block_hash : null, extrinsic_index: e.extrinsic_index ?? null,
      extrinsic_hash: e.extrinsic_hash ?? null, success: !final || events.length === 0 ? null : ok ? true : failed ? false : null,
      error: null, failed_event: failed ?? null, events, names: events.map((x) => `${x.pallet}.${x.name}`), sent_status: null, entry: e,
    };
  }
  const rt = e.run_time ?? null;
  const sent = rt?.sent ?? null;
  const final = sent?.status === "finalized" && HASH.test(sent.block_hash ?? "") && Number.isInteger(sent.block_number);
  const ex = final ? rt.explorer ?? null : null;
  return {
    id, final, block_number: final ? sent.block_number : null, block_hash: final ? sent.block_hash : null, extrinsic_index: final ? sent.extrinsic_index : null,
    extrinsic_hash: rt?.extrinsic_hash ?? null, success: ex ? ex.success : null, error: ex ? ex.error : null, failed_event: null,
    events: ex ? ex.events : [], names: ex ? ex.names : [], sent_status: sent?.status ?? null, entry: e,
  };
}

/** Every id of the record that is a step of the plan or an attempt of one, in the order recorded. */
export const recordedIds = (plan, results) => (results?.steps ?? []).map((s) => s.step).filter((id) => planStepOf(plan, id));

/** A field of an event the record holds for an id, as a decimal or hex string; null when it is not held. */
export function eventField(results, id, pallet, name, field) {
  const v = viewOf(results, id);
  const ev = v?.events.find((x) => x.pallet === pallet && x.name === name);
  const f = ev?.fields?.[field];
  return f === undefined || f === null ? null : String(f);
}

/** The device transactions the record holds as included in a finalized block (S2e): device steps and their attempts. */
export function deviceIncluded(plan, results) {
  return recordedIds(plan, results).filter((id) => planStepOf(plan, id).signer === "device" && viewOf(results, id).final).length;
}

/** The device's session calls the record holds as succeeded (S2f): encoder steps whose outcome is success. */
export function sessionSucceeded(plan, results) {
  return recordedIds(plan, results).filter((id) => planStepOf(plan, id).tool === "encoder" && viewOf(results, id).success === true).length;
}

/**
 * The block a step must follow, as a number, or { unknown } naming what is missing (S7). An
 * after_block is { step, plus } (that step's block plus a value), { event: "$Tn.Pallet.Event.field" }
 * (a field of that step's recorded event), or { greatest_of: [ ... ] }.
 */
export function afterBlockOf(plan, step, results) {
  const a = step.after_block;
  if (!a) return null;
  const one = (x) => {
    if (x.greatest_of) {
      const parts = x.greatest_of.map(one);
      const unknown = parts.find((p) => typeof p === "object");
      return unknown ?? Math.max(...parts);
    }
    if (x.event) {
      const [s, pallet, name, field] = x.event.replace(/^\$/, "").split(".");
      const v = eventField(results, s, pallet, name, field);
      return v !== null && RAW.test(v) ? Number(v) : { unknown: `${x.event} in the record` };
    }
    const base = viewOf(results, x.step);
    const plus = plan.values[x.plus.replace(/^\$/, "")]?.value ?? x.plus;
    if (!RAW.test(String(plus))) throw new Error(`${step.id}: after_block plus ${x.plus} is not a number`);
    return base?.final ? base.block_number + Number(plus) : { unknown: `the block of ${x.step} in the record` };
  };
  return one(a);
}

export { stepOf };
