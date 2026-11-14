#!/usr/bin/env node
// record-step: writes the run time record of the batch on the PC (H13, H14), from what the lead
// relays from the pane (each text with the sha256 the pane gave beside it) and from the files the
// lab's tools wrote in the run folder. No network. It signs nothing and reads no key file.
//
// Each relay is a file of the run folder (F14, relay.mjs): --<name>-file <path> and --<name>-sha256 <sha>.
//   start --run <folder> --reads-file <path> --reads-sha256 <sha> --probe-file <path> --probe-sha256 <sha>
//        makes results.json: lab.accountReads of the owner (the runtime, the genesis, the head, the
//        owner's next nonce), the free read of H7, the device from the seat's identity.json did, the
//        seat's caps from its config.json, and P0's session show (tool/P0.show.json) with SessionCount(S)
//        and RotationHistory(S) of its tape. It never writes over a results.json.
//   call <id> --run <folder>
//        holds the tool's printed call (tool/<id>.call.json) to the plan and to the second encoder
//        (H3). When both hold it writes calls/<id>.json, whose call the research signer signs. Either
//        way the record keeps what was found, so plan.mjs next stops on a difference.
//   send-file <id> --run <folder>
//        holds signed/<id>.json to the tool's call for the plan's owner, nonce, runtime and chain
//        (owner-call.mjs checkOwnerSigned). When it holds it writes signed/<id>.send.json, exactly
//        {"step","extrinsic"} on one line, and prints its sha256 and its text. The record keeps it.
//   step <id> --run <folder> [--sent-file <path> --sent-sha256 <sha>] [--explorer-file <path> --explorer-sha256 <sha>]
//        the runner's reading (lab.send, lab.sendSame or lab.find of pane-runner.js), and the
//        explorer's (explorer-reader.js), a second and weaker source, marked as such.
//   tool <id> <block|after> --run <folder>
//        the tool's reading of the step's block (readBlockEvents: the events, the outcome and the fee
//        of the extrinsic at its index, the lab's own decoder) or of the session after it (show).
//   stop <id> --run <folder> [--case <a|c|d>] --why '<words>' [--reads-file <path> --reads-sha256 <sha>]
//        the lead's stop at an owner step whose copy cannot land without being sent again (cases a,
//        c and d of the last batch's README, "The lead's stop"; lead-stop.mjs there).
// After each it prints plan.mjs next's word.
//
// The record says what it is: record "run-time"; one node, read by the lead through the pane,
// decoded by the lab's own decoder; nothing is called verified; a block is called finalized only
// where the node reported it so, with its hash beside it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HASH, REPO, deviceOfSeat, loadPlan, readJson, sha256Text, ss58, V } from "./lib.mjs";
import { callFile, entryOf, loadRecord, planStepOf, runFiles, sendFile, sendText, signedFile, toolFile, viewOf } from "./run.mjs";
import { checkOwnerSigned, OwnerCallError, secondEncoder, toolCall } from "./owner-call.mjs";
import { decoderReading } from "./events.mjs";
import { nextOf } from "./next.mjs";
import { explorerReading, NOTHING_SUBMITTED, RecordStepError as LastRecordStepError } from "../2026-11-12-encoder-devnet-test/record-step.mjs";
import { readRelay, RelayError } from "./relay.mjs";
import { takeSignerReads, LeadStopError } from "../2026-11-12-encoder-devnet-test/lead-stop.mjs";
import { NEVER_SENT, readingsOf } from "../2026-11-12-encoder-devnet-test/record.mjs";

export class RecordStepError extends Error {}
const no = (m) => { throw new RecordStepError(m); };
/** A relay from its file (F14): { value, text }, or a refusal. */
const relayed = (file, sha, what) => { try { return readRelay(file === undefined ? undefined : resolve(file), sha, what); } catch (e) { if (e instanceof RelayError) no(e.message); throw e; } };

export const SCHEMA = "g19-run-time-1";
export const RECORD_WORDS = "a run time record: one node, read by the lead through the browser pane; each step's events and fee decoded by the lab's own decoder (the tool's readBlockEvents over a block tape); the session after each step by the tool's session show over a tape; the explorer's reading beside them as a second, weaker source. A public recording of its blocks is not part of it.";

/** SessionCount(S) of a tape's owner reads: a u32, the metadata default 0 when no value is stored, unknown on a node error or another shape. */
export function sessionCountOf(read) {
  if (!read) return { raw: null, value: null, stored: null, reason: "not read" };
  if ("error" in read) return { raw: null, value: null, stored: null, reason: `the node said: ${read.error?.message ?? "an error"}` };
  if (read.result === null) return { raw: null, value: 0, stored: false, reason: "no value stored: the metadata default 0 (research/2026-11-11-onchain-spend-limit/report.md, FlopSessionKeys.SessionCount)" };
  if (typeof read.result !== "string" || !/^0x[0-9a-f]{8}$/.test(read.result)) return { raw: read.result ?? null, value: null, stored: null, reason: "not the 4 bytes of a u32" };
  return { raw: read.result, value: Buffer.from(read.result.slice(2), "hex").readUInt32LE(0), stored: true };
}

/** The tool's show output in the record's form: its exit, head, runtime and the stored values it printed. */
const showOf = (o, file) => ({ tool_file: file, tape_sha256: o.tape_sha256, exit: o.exit, head: o.json?.head ?? null, runtime: o.json?.runtime ?? null, session: o.json?.session ?? null, session_nonce: o.json?.session_nonce ?? null, circuit_breaker: o.json?.circuit_breaker ?? null, room: o.json?.room ?? null });

/** The run time record at the start (P0), from the relays and the run folder's files. */
export async function startRecord({ plan, run, reads, readsSha256, probe, probeSha256, nowIso = new Date().toISOString() }) {
  const owner = V(plan, "OWNER");
  if (reads.account !== owner && reads.account !== ss58(owner)) no(`the reads are of the account ${reads.account}, not the owner of steps.json`);
  if (!Number.isSafeInteger(reads.finalized?.number) || !HASH.test(reads.finalized?.hash ?? "")) no("the reads need the finalized head's number and hash");
  if (!Number.isSafeInteger(reads.account_nonce) || reads.account_nonce < 0) no("the reads need the owner's next nonce");
  if (probe.kind !== "probe") no("the probe relay is not session-reads.js probe");
  const seat = V(plan, "SEAT");
  const home = runFiles(run).seat;
  if (!existsSync(join(home, "seats", seat, "identity.json"))) no(`the seat home has no identity for seat ${seat}: run imd-flop init first`);
  const device = await deviceOfSeat(home, seat);
  if (device === owner) no("the device is the owner's key");
  const cfg = readJson(join(home, "config.json"));
  const caps = cfg.caps?.[seat];
  if (caps?.daily !== Number(V(plan, "A_DAILY_FLOP")) || caps?.perCall !== Number(V(plan, "A_PER_TX_FLOP"))) no(`the seat's caps are ${JSON.stringify(caps ?? null)}, not the plan's daily ${V(plan, "A_DAILY_FLOP")} and per call ${V(plan, "A_PER_TX_FLOP")}: run imd-flop cap set as plan.mjs prints it`);
  const f = toolFile(run, "P0", "show");
  if (!existsSync(f)) no("tool/P0.show.json is not in the run folder: run tool-run.mjs P0 show over the P0 tape first");
  const o = readJson(f);
  return {
    record: "run-time", schema: SCHEMA, what: RECORD_WORDS, plan: "research/2026-11-14-session-grant-devnet-test/steps.json",
    accounts: { owner: { public_key: owner, ss58: ss58(owner) }, device: { public_key: device, ss58: ss58(device), from: `seat/seats/${seat}/identity.json did` } },
    seat: { seat, caps, from: "seat/config.json, written by imd-flop cap set" },
    owner_account_nonce_at_start: String(reads.account_nonce),
    chain: { spec_name_at_start: reads.runtime?.specName ?? null, spec_version_at_start: reads.runtime?.specVersion ?? null, transaction_version_at_start: reads.runtime?.transactionVersion ?? null, genesis_at_start: reads.runtime?.genesisHash ?? null },
    start: { finalized: { number: reads.finalized.number, hash: reads.finalized.hash }, read_by: "lab.accountReads of the owner, relayed by the lead", reads_sha256: readsSha256, recorded_utc: nowIso },
    probe: { what: "H7: state_call Core_version 0x at an old block; nothing in the batch depends on it", head: probe.head ?? null, at: probe.at ?? null, answered: probe.answered === true, length: probe.length ?? null, refusal: probe.refusal ?? null, read_utc: probe.read_utc ?? null, relay_sha256: probeSha256 },
    p0: { ...showOf(o, "tool/P0.show.json"), session_count: sessionCountOf(o.owner_reads?.session_count), rotation_history_raw: o.owner_reads?.rotation_history ?? null },
    steps: [],
  };
}

const withEntry = (results, id) => {
  const r = structuredClone(results);
  let e = entryOf(r, id);
  if (!e) { e = { step: id, run_time: null }; r.steps.push(e); }
  return { r, e };
};
const mustBeNext = (plan, results, id, phases) => {
  const n = nextOf(plan, results);
  if (n.step !== id || !phases.includes(n.phase)) no(`${id} ${phases.join(" or ")} is not next by the record: ${n.word}${n.step ? ` ${n.step} ${n.phase}` : ""}: ${n.why}`);
};

/** The record with the tool's call of an id held to the plan and the second encoder (H3); and the call file's text when both hold. */
export function recordCall(plan, run, results, id) {
  mustBeNext(plan, results, id, ["call"]);
  const step = planStepOf(plan, id);
  const { r, e } = withEntry(results, id);
  let tool;
  try { tool = toolCall(plan, run, results, id); } catch (err) {
    if (!(err instanceof OwnerCallError)) throw err;
    e.call = { tool_file: `tool/${id}.call.json`, refused: err.message };
    return { results: r, callText: null };
  }
  const second = secondEncoder(plan, results, step);
  e.call = { tool_file: `tool/${id}.call.json`, tape_sha256: tool.output.tape_sha256, tape_head: tool.output.tape_head, call_hex: tool.call_hex, call_blake2b_256: tool.output.json.call_blake2b_256, stored_record: tool.output.json.stored_record ?? null, second_encoder: second, equal: second.call === tool.call_hex, refused: null };
  if (second.call !== tool.call_hex) { e.call.refused = `the tool's call ${tool.call_hex} is not the second encoder's ${second.call}`; return { results: r, callText: null }; }
  return { results: r, callText: JSON.stringify({ call: tool.call_hex, what: second.what, tool_file: `tool/${id}.call.json`, tape_sha256: tool.output.tape_sha256, second_encoder: "research/2026-11-11-session-deny-list/flop-sign.mjs call" }) + "\n" };
}

/**
 * The record with a signed file of an id checked (H3), and the send file's text when it holds. The
 * signed file is held to the call the record holds for the id (F2), and calls/<id>.json must still
 * hold that call.
 */
export function recordSigned(plan, run, results, id) {
  mustBeNext(plan, results, id, ["sign"]);
  if (!existsSync(signedFile(run, id))) no(`signed/${id}.json is not in the run folder`);
  const call = entryOf(results, id)?.call?.call_hex;
  if (typeof call !== "string" || entryOf(results, id).call.refused) no(`the record holds no call of ${id} that its tool printed and the second encoder gave`);
  const signed = readJson(signedFile(run, id));
  const { r, e } = withEntry(results, id);
  const inFile = existsSync(callFile(run, id)) ? readJson(callFile(run, id)).call : null;
  if (inFile !== call) { e.signed_check = { refused: `calls/${id}.json holds ${inFile ?? "no call"}, not the call the record holds, ${call}: nothing is sent` }; return { results: r, sendText: null }; }
  try {
    e.signed_check = { ...checkOwnerSigned(plan, results, id, signed, call), refused: null };
  } catch (err) {
    if (!(err instanceof OwnerCallError)) throw err;
    e.signed_check = { refused: err.message };
    return { results: r, sendText: null };
  }
  const text = sendText(id, signed.extrinsic);
  e.signed_check.send_sha256 = sha256Text(text);
  return { results: r, sendText: text };
}

/** The record with a runner reading or an explorer reading of an id (the last batch's form of run_time). */
export function recordReading({ plan, run, results, id, sent, sentSha256, explorer, explorerSha256, errors }) {
  const step = planStepOf(plan, id) ?? no(`steps.json has no step ${id}`);
  if (!sent && !explorer) no("give --sent, --explorer or both");
  if (entryOf(results, id)?.lead_stop) no(`the lead stopped ${id}: nothing of it is recorded after the stop`);
  const { r, e } = withEntry(results, id);
  if (sent) {
    mustBeNext(plan, results, id, ["send", "wait"]);
    if (typeof sent.status !== "string") no("the runner's reading has no status");
    if (NOTHING_SUBMITTED.includes(sent.status)) no(`the runner said ${sent.status}: nothing was submitted by that call, so there is nothing to record`);
    if (sent.step !== null && sent.step !== undefined && sent.step !== id) no(`the runner's reading is of ${sent.step}, not ${id}`);
    const signed = readJson(signedFile(run, id));
    if (!existsSync(sendFile(run, id))) no(`signed/${id}.send.json is not in the run folder`);
    const bundleSha = sha256Text(readFileSync(sendFile(run, id), "utf8"));
    if (sent.bundle_sha256 !== null && sent.bundle_sha256 !== undefined && sent.bundle_sha256 !== bundleSha) no(`the bundle the runner sent has sha256 ${sent.bundle_sha256}, the step's send file has ${bundleSha}`);
    if (sent.extrinsic_sha256 !== sha256Text(signed.extrinsic ?? "")) no(`the extrinsic the runner sent or found is not the one of signed/${id}.json`);
    if (sent.status === "finalized" && (!HASH.test(sent.block_hash ?? "") || !Number.isSafeInteger(sent.block_number) || !Number.isSafeInteger(sent.extrinsic_index))) no("a finalized reading needs the block hash, the block number and the extrinsic index");
    const earlier = e.run_time ? [...(e.run_time.earlier_readings ?? []), { sent: e.run_time.sent, sent_sha256: e.run_time.sent_sha256 }] : [];
    e.run_time = { extrinsic_hash: signed.extrinsic_hash, bundle_sha256: bundleSha, sent, sent_sha256: sentSha256, explorer: null, earlier_readings: earlier, earlier_copies: [] };
  }
  if (explorer) {
    const rt = e.run_time;
    if (!rt || rt.sent?.status !== "finalized") no(`the record holds no finalized block for ${id}: the explorer reading is added to a finalized step`);
    if (rt.explorer) no(`the record holds an explorer reading of ${id}: it is not replaced`);
    try { rt.explorer = { ...explorerReading(plan, step, rt, explorer, explorerSha256, errors, r), source_kind: "second, weaker: FLOP's explorer API" }; } catch (err) { if (err instanceof LastRecordStepError) no(err.message); throw err; }
    e.sources_differ = sourcesDiffer(e);
  }
  return r;
}

/**
 * Where the decoder's reading and the explorer's differ (H14): the outcome, the error's name, and the
 * fields of each FlopSessionKeys event the explorer kept. Empty when they agree or one is missing.
 */
export function sourcesDiffer(e) {
  const d = e.decoder, x = e.run_time?.explorer;
  if (!d || !x) return [];
  const out = [];
  if (d.success !== x.success) out.push(`success: the decoder says ${d.success}, the explorer ${x.success}`);
  if ((d.error?.name ?? null) !== (x.error?.name ?? null)) out.push(`error: the decoder says ${d.error?.name ?? null}, the explorer ${x.error?.name ?? null}`);
  const mine = d.events.filter((ev) => ev.pallet === "FlopSessionKeys" || ev.pallet === "ComputeChannel");
  if (mine.length !== x.events.length) out.push(`events: the decoder has ${mine.length} of FlopSessionKeys and ComputeChannel, the explorer ${x.events.length}`);
  mine.forEach((ev, i) => {
    const xe = x.events[i];
    if (!xe || xe.pallet !== ev.pallet || xe.name !== ev.name) { out.push(`event ${i}: the decoder has ${ev.pallet}.${ev.name}, the explorer ${xe ? `${xe.pallet}.${xe.name}` : "none"}`); return; }
    for (const k of new Set([...Object.keys(ev.fields), ...Object.keys(xe.fields)])) if (String(ev.fields[k]) !== String(xe.fields[k])) out.push(`${ev.pallet}.${ev.name} ${k}: the decoder says ${ev.fields[k]}, the explorer ${xe.fields[k]}`);
  });
  return out;
}

/** The record with the tool's reading of an id's block or of the session after it (H14). */
export function recordTool(plan, run, results, id, purpose, errors) {
  if (!["block", "after"].includes(purpose)) no("the tool reading is block or after");
  mustBeNext(plan, results, id, [purpose]);
  const f = toolFile(run, id, purpose);
  if (!existsSync(f)) no(`tool/${id}.${purpose}.json is not in the run folder: run tool-run.mjs ${id} ${purpose} over a fresh tape`);
  const o = readJson(f);
  const { r, e } = withEntry(results, id);
  if (purpose === "block") {
    const v = viewOf(results, id);
    const d = decoderReading(o, v.extrinsic_index, errors, V(plan, "OWNER"));
    e.decoder = d === null
      ? { tool_file: `tool/${id}.block.json`, tape_sha256: o.tape_sha256, exit: o.exit, unknown: o.json?.unknown ?? null, success: null }
      : { tool_file: `tool/${id}.block.json`, tape_sha256: o.tape_sha256, exit: o.exit, block: { number: v.block_number, hash: v.block_hash }, source: "the tool's readBlockEvents over the block tape: the lab's own decoder", ...d };
    e.sources_differ = sourcesDiffer(e);
  } else {
    const v = viewOf(results, id);
    if (!(o.tape_head?.number >= v.block_number)) no(`the after tape's head ${o.tape_head?.number} is below ${id}'s block ${v.block_number}`);
    e.after = showOf(o, `tool/${id}.after.json`);
  }
  return r;
}

/**
 * The lead's stop at an owner step (cases a, c and d of the last batch's README, "The lead's stop"):
 * a, nothing signed for it and no runner reading; c, its only runner reading is a refusal at a first
 * send with node code 1010; d, a signed copy and no runner reading, which the lead says was never
 * sent. For c and d the owner's next nonce by lab.accountReads must equal the copy's.
 */
export function leadStop({ plan, run, results, id, why, kase: named = null, readsText, readsSha256, nowIso = new Date().toISOString() }) {
  if (!planStepOf(plan, id)) no(`steps.json has no step ${id}`);
  if (typeof why !== "string" || why.trim().length === 0) no("--why '<words>' is required");
  const n = nextOf(plan, results);
  if (n.step !== id) no(`no stop at ${id}: ${id} is not next by the record (${n.word}${n.step ? ` ${n.step}` : ""})`);
  if (viewOf(results, id)?.final) no(`no stop at ${id}: the record holds it in a finalized block`);
  const e = entryOf(results, id);
  const readings = readingsOf(viewOf(results, id));
  const hasSigned = existsSync(signedFile(run, id));
  let kase, evidence = {};
  if (!hasSigned && readings.length === 0) kase = "a";
  else {
    if (!hasSigned) no(`no stop at ${id}: the record holds a runner reading and signed/${id}.json is gone; the lead rules`);
    if (readings.some((x) => x.status === "already-sent")) no(`no stop at ${id}: the pane's sent list held these bytes; use lab.find from the start of the run`);
    const last = e?.run_time?.sent ?? null;
    if (!last) kase = "d";
    else if (last.status === "refused-at-submission" && last.node?.code === 1010 && last.sent_by === "send" && (e.run_time.earlier_readings ?? []).length === 0) kase = "c";
    else no(`no stop at ${id}: its last runner reading is ${last.status}; its copy may still land. Follow send_outcomes: lab.find from the start of the run, then lab.sendSame`);
    let reads;
    try { reads = takeSignerReads(plan, V(plan, "OWNER"), readsText, readsSha256); } catch (err) { if (err instanceof LeadStopError) no(err.message); throw err; }
    const signed = readJson(signedFile(run, id));
    const nonce = BigInt(entryOf(results, id)?.signed_check?.nonce ?? no(`no stop at ${id}: its signed file was not checked`));
    if (BigInt(reads.account_nonce) !== nonce) no(`no stop at ${id}: the owner's next nonce is ${reads.account_nonce}, not the copy's ${nonce}${BigInt(reads.account_nonce) > nonce ? ": the nonce is used, or a transaction with it is in the pool; use lab.find from the start of the run" : ": the record and the chain disagree; the lead rules"}`);
    evidence = { copy: `signed/${id}.json`, extrinsic_hash: signed.extrinsic_hash, signer: V(plan, "OWNER"), nonce: String(nonce), finalized_head: reads.finalized, signer_next_nonce: reads.account_nonce, reads_sha256: readsSha256 };
  }
  if (named !== null && named !== undefined && named !== kase) no(`no stop at ${id}: the line names case ${named}, the record gives case ${kase}`);
  const { r, e: entry } = withEntry(results, id);
  entry.lead_stop = { case: kase, why, words: kase === "d" ? NEVER_SENT : null, evidence, recorded_utc: nowIso, unsent: kase === "a" ? [] : [`signed/${id}.json`, ...(existsSync(sendFile(run, id)) ? [`signed/${id}.send.json`] : [])] };
  return r;
}

const writeRecord = (run, r) => { const f = runFiles(run).results, tmp = `${f}.writing`; writeFileSync(tmp, JSON.stringify(r, null, 1) + "\n", { flag: "w" }); renameSync(tmp, f); };

/** The judge's word, in words. */
export function wordOf(plan, results) {
  const n = nextOf(plan, results);
  const lines = [n.word === "go" ? `go on: ${n.step} ${n.phase}: ${n.why}` : n.word === "wait" ? `wait: ${n.step}: ${n.why}` : n.word === "stop" ? `stop at ${n.stopped_at}: ${n.why}` : `the end: ${n.why}`];
  if (n.cleanup.length) lines.push(`cleanup steps that apply: ${n.cleanup.join(", ")}`);
  for (const f of n.findings) lines.push(`finding: ${f}`);
  for (const l of n.left) lines.push(`left: ${l}`);
  return lines.join("\n");
}

function flags(argv, names) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith("--") ? argv[i].slice(2) : null;
    if (!names.includes(name)) no(`${argv[i]} is not a flag here (flags: ${names.map((x) => `--${x}`).join(", ")})`);
    if (i + 1 >= argv.length) no(`${argv[i]} needs a value`);
    out[name] = argv[++i];
  }
  return out;
}

async function main(argv) {
  const plan = loadPlan();
  const errors = readJson(join(REPO, plan.files.errors));
  const [cmd, a1, a2] = argv;
  const idArg = () => (a1 && !a1.startsWith("--") ? a1 : no(`usage: node record-step.mjs ${cmd} <id> --run <folder> ...`));
  const rest = (n) => argv.slice(n);
  const record = (run) => loadRecord(run) ?? no("the run folder has no results.json: make it with record-step.mjs start");
  if (cmd === "start") {
    const f = flags(rest(1), ["run", "reads-file", "reads-sha256", "probe-file", "probe-sha256"]);
    const run = resolve(f.run ?? no("--run <run folder> is required"));
    if (existsSync(runFiles(run).results)) no(`${runFiles(run).results} exists: start never writes over a record`);
    const reads = relayed(f["reads-file"], f["reads-sha256"], "reads").value;
    const probe = relayed(f["probe-file"], f["probe-sha256"], "probe").value;
    const r = await startRecord({ plan, run, reads, readsSha256: f["reads-sha256"], probe, probeSha256: f["probe-sha256"] });
    writeFileSync(runFiles(run).results, JSON.stringify(r, null, 1) + "\n", { flag: "wx" });
    console.log(`recorded the start: owner next nonce ${r.owner_account_nonce_at_start}, device ${r.accounts.device.ss58}, SessionCount(S) ${r.p0.session_count.value ?? "unknown"}, probe ${r.probe.answered ? `answered, ${r.probe.length} bytes` : "not answered"}`);
    console.log(wordOf(plan, r));
    return;
  }
  if (cmd === "call") {
    const id = idArg(); const run = resolve(flags(rest(2), ["run"]).run ?? no("--run is required"));
    const { results, callText } = recordCall(plan, run, record(run), id);
    if (callText) { mkdirSync(runFiles(run).calls, { recursive: true }); writeFileSync(callFile(run, id), callText, { flag: "wx" }); }
    writeRecord(run, results);
    console.log(callText ? `calls/${id}.json written: the tool's call equals the second encoder's` : `no call file: ${entryOf(results, id).call.refused}`);
    console.log(wordOf(plan, results));
    return;
  }
  if (cmd === "send-file") {
    const id = idArg(); const run = resolve(flags(rest(2), ["run"]).run ?? no("--run is required"));
    const { results, sendText: text } = recordSigned(plan, run, record(run), id);
    if (text) writeFileSync(sendFile(run, id), text, { flag: "wx" });
    writeRecord(run, results);
    if (text) { console.log(JSON.stringify({ send_file: sendFile(run, id), send_sha256: sha256Text(text) })); console.log(text); }
    else console.log(`no send file: ${entryOf(results, id).signed_check.refused}`);
    console.log(wordOf(plan, results));
    return;
  }
  if (cmd === "step") {
    const id = idArg(); const f = flags(rest(2), ["run", "sent-file", "sent-sha256", "explorer-file", "explorer-sha256"]);
    const run = resolve(f.run ?? no("--run is required"));
    const sent = f["sent-file"] !== undefined || f["sent-sha256"] !== undefined ? relayed(f["sent-file"], f["sent-sha256"], "sent").value : null;
    const explorer = f["explorer-file"] !== undefined || f["explorer-sha256"] !== undefined ? relayed(f["explorer-file"], f["explorer-sha256"], "explorer").value : null;
    const r = recordReading({ plan, run, results: record(run), id, sent, sentSha256: f["sent-sha256"], explorer, explorerSha256: f["explorer-sha256"], errors });
    writeRecord(run, r);
    const v = viewOf(r, id);
    console.log(`recorded ${id}: ${v.final ? `in finalized block ${v.block_number} (${v.block_hash}), as the node reported` : `the runner said ${v.sent_status}`}`);
    console.log(wordOf(plan, r));
    return;
  }
  if (cmd === "tool") {
    const id = idArg(); const purpose = a2 && !a2.startsWith("--") ? a2 : no("usage: node record-step.mjs tool <id> <block|after> --run <folder>");
    const run = resolve(flags(rest(3), ["run"]).run ?? no("--run is required"));
    const r = recordTool(plan, run, record(run), id, purpose, errors);
    writeRecord(run, r);
    console.log(`recorded the tool's ${purpose} reading of ${id}`);
    console.log(wordOf(plan, r));
    return;
  }
  if (cmd === "stop") {
    const id = idArg(); const f = flags(rest(2), ["run", "case", "why", "reads-file", "reads-sha256"]);
    const run = resolve(f.run ?? no("--run is required"));
    const readsText = f["reads-file"] !== undefined ? relayed(f["reads-file"], f["reads-sha256"], "reads").text : undefined;
    const r = leadStop({ plan, run, results: record(run), id, why: f.why, kase: f.case ?? null, readsText, readsSha256: f["reads-sha256"] });
    writeRecord(run, r);
    console.log(`recorded the lead's stop at ${id}, case ${entryOf(r, id).lead_stop.case}`);
    console.log(wordOf(plan, r));
    return;
  }
  no("commands: start, call, send-file, step, tool, stop (see the head of this file)");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { await main(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`record-step: ${e instanceof RecordStepError ? e.message : `failed (${e?.constructor?.name ?? typeof e})`}\n`);
    process.exit(2);
  }
}
