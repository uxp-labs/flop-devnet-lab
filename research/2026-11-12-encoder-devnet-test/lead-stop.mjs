// The lead's stop at a step that will not come on chain (F3): record-step.mjs stop writes it into
// the run time record. It is allowed only when the step's copy cannot land without being sent
// again, and only at the step nextOf names (as the next step, or as the one it waits on for
// inclusion), with no finalized reading of it in the record. One of:
//   a. no signed/<id>.json and no dead copy of it exists, and the record holds no runner reading of
//      the id, current or earlier (H3): nothing was signed;
//   b. an encoder step with a signed copy (signed/<id>.json, or the newest dead copy when there is
//      none), and the device's reads (lab.deviceReads, with their sha256) show a finalized head above
//      that copy's last valid block and a next nonce equal to the device transactions the record
//      holds as finalized: the copy is dead (the test of S4);
//   c. a research signer step with a signed copy, whose only runner reading in the record is
//      refused-at-submission with node code 1010 from a first send (sent_by "send", no earlier
//      readings). After a deadline, a lost connection or an ended watch, a 1010 to a sendSame can
//      mean the first copy is in a block: refused; the lead uses find;
//   d. a research signer step with a signed copy and no runner reading of it in the record: the
//      record says that the lead says this copy was never sent.
// For c and d the node's own count is needed as well (H1): the reads (lab.accountReads of the step's
// SIGNER, the owner for T1, T2, T8, the device for T9, with their sha256) of the plan's runtime,
// signed/<id>.json passing checkResearchSigned (so its nonce is the one nonceOf gives the id), and
// the next nonce of the reads equal to that nonce. system_accountNextIndex counts the chain and the
// node's pool, so an equal nonce shows that no transaction with it is in a block or in the pool. A
// next nonce above it refuses (the nonce is used, or a transaction with it is in the pool: find from
// the block before the first send, and sendSame); one below it refuses (the record and the chain
// disagree). When the record holds find readings that cover the finalized blocks from the record's
// start to the head without the copy, and the nonce is above, a transaction not of this batch used
// the signer's nonce: these tools go no further at that step and record no stop (the stop table's
// row "nonce" says what is left). A reading already-sent (H2) means the bytes went out before:
// neither c nor d holds.
// What is left after c or d names the copy, its extrinsic hash, its signer and its nonce (H4).
// Any other case is refused, naming the send_outcomes row to follow instead. After a stop no tool
// signs the id or writes a send file for it. No network, no key.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HASH, readJson, sha256Text, ss58, planRuntime } from "./lib.mjs";
import { planStepOf, entryOf, viewOf, signedFile, sendFile, deviceIncluded, readingsOf, NEVER_SENT } from "./record.mjs";
import { nextOf, stopRowOf } from "./judge.mjs";
import { checkResearchSigned, ResearchSignedError, nonceOf, signerOf } from "./research-signed.mjs";
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
 * The reads of a research signer step's SIGNER (H1): lab.accountReads relayed with its sha256, of
 * that signer and of the plan's runtime. Returns { account, runtime, finalized, account_nonce }.
 */
export function takeSignerReads(plan, signer, text, sha256) {
  if (typeof text !== "string") no("--reads is required");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) no("--reads-sha256 is required: the sha256 the pane gave beside the reads");
  if (sha256Text(text) !== sha256) no("the sha256 of --reads is not --reads-sha256: the text changed on its way");
  let reads;
  try { reads = JSON.parse(text); } catch { no("--reads is not JSON"); }
  if (reads === null || typeof reads !== "object" || Array.isArray(reads)) no("--reads must be a JSON object");
  const known = ["account", "runtime", "finalized", "account_nonce"];
  for (const k of Object.keys(reads)) if (!known.includes(k)) no(`--reads has a field ${k}: lab.accountReads gives ${known.join(", ")}`);
  if (reads.account !== signer && reads.account !== ss58(signer)) no(`the reads are of the account ${reads.account}, not the step's signer ${signer}`);
  const want = planRuntime(plan);
  for (const k of Object.keys(want)) if (reads.runtime?.[k] !== want[k]) no(`the runtime of the reads has ${k} ${reads.runtime?.[k]}, steps.json has ${want[k]}`);
  if (!Number.isSafeInteger(reads.finalized?.number) || reads.finalized.number < 0 || !HASH.test(reads.finalized?.hash ?? "")) no("the reads need the finalized head's number and hash");
  if (!Number.isSafeInteger(reads.account_nonce) || reads.account_nonce < 0) no("the reads need the signer's next nonce");
  return reads;
}

/**
 * Whether the record's find readings of an id cover the finalized blocks from a block to a head
 * without the copy: not-found (or find-deadline, H10) readings of find, joined end to end from that
 * block, up to one that read to its own head. Returns { from, to } or null.
 */
export function findCovers(readings, from) {
  if (!Number.isSafeInteger(from)) return null;
  const ranges = readings.filter((x) => x?.sent_by === "find" && (x.status === "not-found" || x.status === "find-deadline") && Number.isSafeInteger(x.from) && Number.isSafeInteger(x.to) && x.from <= x.to);
  let cur = from;
  for (;;) {
    const reach = ranges.filter((x) => x.from <= cur && x.to >= cur);
    if (!reach.length) return null;
    const whole = reach.find((x) => x.status === "not-found" && x.to === x.head);
    if (whole) return { from, to: whole.to };
    const best = reach.reduce((a, b) => (b.to > a.to ? b : a));
    cur = best.to + 1;
  }
}

/** Case c or d of a research signer step (F3, H1, H2), or a refusal. */
function researchStop({ plan, run, results, id, step, v, sent, readings, readsText, readsSha256, findFrom, hasSigned }) {
  const signer = signerOf(plan, results, step);
  const nonce = nonceOf(plan, results, id);
  const counted = () => {
    const reads = takeSignerReads(plan, signer, readsText, readsSha256);
    return { reads, next: BigInt(reads.account_nonce) };
  };
  // A transaction not of this batch used the signer's nonce: find covered the blocks without the copy.
  const covered = findCovers(readings, results.start?.finalized?.number);
  if (covered && readsText !== undefined) {
    const { next } = counted();
    if (next > nonce) no(`no stop at ${id}: find read the finalized blocks ${covered.from} to ${covered.to} and did not find the copy, and the signer's next nonce is ${next}, above the copy's ${nonce}: a transaction that is not of this batch used the signer's nonce. These tools go no further at ${id}, and no stop is recorded: ${stopRowOf(plan, step, null, "nonce")}`);
  }
  // H2: the pane's sent list held these bytes: they were written to a socket before
  if (readings.some((x) => x.status === "already-sent")) no(`no stop at ${id}: the record holds the pane's already-sent for it, so these bytes were sent before: neither case c nor case d holds. Instead use ${findFrom}, and record what it returns; if not found, lab.sendSame`);
  let kase;
  if (!sent) kase = "d";
  else if (sent.status === "refused-at-submission" && sent.node?.code === 1010) {
    // F3c: only when this refusal is the one runner reading of the id, and it answered a first send.
    const earlier = v.entry.run_time.earlier_readings ?? [];
    if (earlier.length || sent.sent_by !== "send") no(`no stop at ${id}: the refusal with 1010 ${sent.sent_by === "send" ? "" : `answered ${sent.sent_by ?? "a call the reading does not name"}, not a first send, and `}follows ${earlier.length} earlier runner reading(s) of it (${earlier.map((x) => x.sent?.status).join(", ") || "none"}): the first copy may be in a block, its nonce used. Instead use ${findFrom} and record what it returns`);
    kase = "c";
  } else refuse(plan, id, `the last runner reading of ${id} is ${sent.status}${sent.node?.code !== undefined && sent.node?.code !== null ? ` with node code ${sent.node.code}` : ""}: its copy may still land`, sent);
  // H1: the node's own count of the signer's nonce
  if (readsText === undefined) no(`no stop at ${id}: case ${kase} needs the node's count of the signer's nonce: --reads and --reads-sha256, lab.accountReads of the step's signer ${signer}`);
  if (!hasSigned) no(`no stop at ${id}: signed/${id}.json is not in the run folder`);
  const signed = readJson(signedFile(run, id));
  try { checkResearchSigned(plan, results, id, signed); } catch (e) {
    if (e instanceof ResearchSignedError) no(`no stop at ${id}: ${e.message}. The lead moves a wrong file aside by hand`);
    throw e;
  }
  const { reads, next } = counted();
  if (next > nonce) no(`no stop at ${id}: the signer's next nonce is ${next}, above the copy's ${nonce}: the nonce is used, or a transaction with it is in the pool, by this copy or another. Instead use ${findFrom} and record what it returns; then lab.sendSame`);
  if (next < nonce) no(`no stop at ${id}: the signer's next nonce is ${next}, below the copy's ${nonce}: the record and the chain disagree. The lead rules`);
  const unsent = [`signed/${id}.json`, ...(existsSync(sendFile(run, id)) ? [`signed/${id}.send.json`] : [])];
  const evidence = {
    copy: `signed/${id}.json`, extrinsic_hash: signed.extrinsic_hash, signer, nonce: String(nonce),
    finalized_head: { number: reads.finalized.number, hash: reads.finalized.hash }, signer_next_nonce: reads.account_nonce, reads_sha256: readsSha256,
  };
  if (kase === "d") return { case: "d", words: NEVER_SENT, evidence: { ...evidence, runner_readings: "none in the record" }, unsent };
  return { case: "c", evidence: { ...evidence, last_reading: { status: sent.status, node: sent.node }, sent_sha256: v.entry.run_time.sent_sha256 }, unsent };
}

/**
 * The record with the lead's stop at an id (F3), or a refusal. reads is a relay text and its sha256:
 * the device's lab.deviceReads for case b, the signer's lab.accountReads for c and d (H1). The input record is not changed.
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
  const readings = readingsOf(v);
  const from = results.start?.finalized?.number ?? null;
  const findFrom = `lab.find from the block before the first send (the record's start, finalized block ${from ?? "unknown"})`;
  let stop;
  if (!hasSigned && !dead.length) {
    if (existsSync(sendFile(run, id))) no(`signed/${id}.send.json exists without signed/${id}.json: the lead rules`);
    // H3: a reading in the record says something was sent; with no file the record and the folder disagree
    if (readings.length) no(`no stop at ${id}: the record holds ${readings.length} runner reading(s) of it (${readings.map((x) => x.status).join(", ")}), so something was sent, and signed/${id}.json is gone: case a (nothing was signed) does not hold. The lead rules`);
    stop = { case: "a", evidence: { signed: `no signed/${id}.json and no dead copy of it in signed/: nothing was signed`, runner_readings: "none in the record" } };
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
  } else {
    stop = researchStop({ plan, run, results, id, step, v, sent, readings, readsText, readsSha256, findFrom, hasSigned });
  }
  const r = structuredClone(results);
  let e = entryOf(r, id);
  if (!e) { e = { step: id, run_time: null }; r.steps.push(e); }
  e.lead_stop = { why, utc: nowIso, ...stop };
  return r;
}

export { NEVER_SENT };
