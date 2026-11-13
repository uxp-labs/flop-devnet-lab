// The lead's stop at a step that will not come on chain (F3): record-step.mjs stop writes it into
// the run time record. It is allowed only when the step's copy cannot land without being sent
// again, and only at the step nextOf names (as the next step, or as the one it waits on for
// inclusion), with no finalized reading of it in the record. One of:
//   a. no signed/<id>.json and no dead copy of it exists: nothing was signed;
//   b. an encoder step with a signed copy (signed/<id>.json, or the newest dead copy when there is
//      none), and the device's reads (lab.deviceReads, with their sha256) show a finalized head above
//      that copy's last valid block and a next nonce equal to the device transactions the record
//      holds as finalized: the copy is dead (the test of S4);
//   c. a research signer step with a signed copy, whose last runner reading in the record is
//      refused-at-submission with node code 1010 (the node judged it invalid: it is not in the pool);
//   d. a research signer step with a signed copy and no runner reading of it in the record: the
//      record says that the lead says this copy was never sent, and what is left names the unsent
//      files and says they must never be sent.
// Any other case is refused, naming the send_outcomes row to follow instead. After a stop no tool
// signs the id or writes a send file for it. No network, no key.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./lib.mjs";
import { planStepOf, entryOf, viewOf, signedFile, sendFile, deviceIncluded, NEVER_SENT } from "./record.mjs";
import { nextOf } from "./judge.mjs";
import { outcomeRow } from "./plan.mjs";
import { takeReads, deadCopies } from "./sign-device.mjs";

export class LeadStopError extends Error {}
const no = (m) => { throw new LeadStopError(m); };

/** The refusal of a stop that is not allowed, naming the row of send_outcomes to follow. */
function refuse(plan, id, why, sent) {
  const row = sent ? outcomeRow(plan, sent) : null;
  const follow = row ? `follow send_outcomes ${row.outcome}${row.node_word ? ` (${row.node_word})` : ""}${row.node_code !== undefined ? ` (node code ${row.node_code})` : ""}: ${row.lead}` : "follow send_outcomes for the copy that was signed: send it, or sign a second copy by S4 once its era is over";
  no(`no stop at ${id}: ${why}. Instead ${follow}`);
}

/**
 * The record with the lead's stop at an id (F3), or a refusal. reads is the device's relay text and
 * its sha256, needed for case b only. The input record is not changed.
 */
export function leadStop({ plan, run, results, id, why, readsText, readsSha256, nowIso = new Date().toISOString() }) {
  const step = planStepOf(plan, id) ?? no(`steps.json has no step ${id}, and ${id} is not an attempt S5 allows`);
  if (results.record !== "run-time") no(`results.json is a ${results.record ?? "unnamed"} record, not a run time record`);
  if (typeof why !== "string" || why.trim().length < 3) no("--why '<words>' is required: the lead's own words for the stop");
  if (entryOf(results, id)?.lead_stop) no(`the record holds a stop by the lead at ${id}: it is not replaced`);
  const v = viewOf(results, id);
  if (v?.final) no(`the record holds ${id} in finalized block ${v.block_number}: a step on chain is not stopped`);
  const n = nextOf(plan, results);
  if (n.step !== id || (n.word === "wait" && n.waiting !== "inclusion")) no(`${id} is not the step nextOf names: ${n.word}${n.step ? ` ${n.step}` : ""}: ${n.why}`);
  const sent = v?.entry?.run_time?.sent ?? null;
  const dead = deadCopies(run, id);
  const hasSigned = existsSync(signedFile(run, id));
  let stop;
  if (!hasSigned && !dead.length) {
    if (existsSync(sendFile(run, id))) no(`signed/${id}.send.json exists without signed/${id}.json: the lead rules`);
    stop = { case: "a", evidence: { signed: `no signed/${id}.json and no dead copy of it in signed/: nothing was signed` } };
  } else if (step.tool === "encoder") {
    if (readsText === undefined) refuse(plan, id, `a copy of ${id} was signed: case b needs the device's reads (--reads and --reads-sha256) to show its era is over`, sent);
    const copyFile = hasSigned ? `signed/${id}.json` : `signed/${dead[dead.length - 1].file}`;
    const copy = readJson(join(run, copyFile));
    const last = copy?.era?.last_valid_block;
    if (!Number.isSafeInteger(last)) no(`${copyFile} has no last valid block`);
    const reads = takeReads(readsText, readsSha256);
    const device = results.accounts?.device;
    if (reads.account !== device?.public_key && reads.account !== device?.ss58) no(`the reads are of the account ${reads.account}, not the device of results.json`);
    if (!(reads.birth.number > last)) refuse(plan, id, `the finalized head of the reads is ${reads.birth.number} and the copy is valid to block ${last}: its era is not over`, sent);
    const included = deviceIncluded(plan, results);
    if (reads.accountNonce !== included) refuse(plan, id, `the device's next nonce is ${reads.accountNonce} and the record holds ${included} device transactions as finalized: a device transaction the record does not hold is in the pool or on chain`, sent);
    stop = { case: "b", evidence: { copy: copyFile, extrinsic_hash: copy.extrinsic_hash ?? null, last_valid_block: last, finalized_head: { number: reads.birth.number, hash: "0x" + Buffer.from(reads.birth.hash).toString("hex") }, device_next_nonce: reads.accountNonce, device_included: included, reads_sha256: readsSha256 } };
  } else if (!sent) {
    stop = { case: "d", words: NEVER_SENT, evidence: { signed: `signed/${id}.json`, runner_readings: "none in the record" }, unsent: [`signed/${id}.json`, ...(existsSync(sendFile(run, id)) ? [`signed/${id}.send.json`] : [])] };
  } else if (sent.status === "refused-at-submission" && sent.node?.code === 1010) {
    stop = { case: "c", evidence: { last_reading: { status: sent.status, node: sent.node }, sent_sha256: v.entry.run_time.sent_sha256 } };
  } else {
    refuse(plan, id, `the last runner reading of ${id} is ${sent.status}${sent.node?.code !== undefined && sent.node?.code !== null ? ` with node code ${sent.node.code}` : ""}: its copy may still land`, sent);
  }
  const r = structuredClone(results);
  let e = entryOf(r, id);
  if (!e) { e = { step: id, run_time: null }; r.steps.push(e); }
  e.lead_stop = { why, utc: nowIso, ...stop };
  return r;
}

export { NEVER_SENT };
