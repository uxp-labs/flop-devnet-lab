#!/usr/bin/env node
// record-step: writes the run time record of the batch on the PC, from what the lead relays from
// the pane. Every text it takes comes with the sha256 the pane gave beside it, and is refused on a
// mismatch. No network. It signs nothing.
//
//   node record-step.mjs start --run <folder> --key <device key file> --reads '<text>' --reads-sha256 <sha>
//        makes <folder>/results.json from the template (R1). The reads are lab.accountReads of the
//        owner: the runtime, the finalized head and the owner's next nonce at the start. It reads
//        the device's public key through the loader of sign-device.mjs (device-key.mjs) and prints
//        only the public key and the SS58 address. It never writes over a results.json.
//
//   node record-step.mjs step <id> --run <folder> [--sent '<text>' --sent-sha256 <sha>] [--explorer '<text>' --explorer-sha256 <sha>]
//        writes the run_time of a step or an attempt (R2): the runner's reading (lab.send,
//        lab.sendSame or lab.find) and, then or later, the explorer's (explorer.read). It never
//        replaces a run_time that holds a finalized block. Then it prints the judge's word for the
//        run so far, and which cleanup steps apply.
//
// The record says what it is (R3): record "run-time"; every explorer reading carries its source
// and read_utc; nothing is called verified; a block is called finalized only where the node
// reported it so, with the block hash beside it; no balance is written.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HASH, RAW, RERUN, loadPlan, readJson, sha256Text, ss58, fromSs58, substitute } from "./lib.mjs";
import { DeviceKeyError, loadDeviceSigner } from "./device-key.mjs";
import { planStepOf, loadRecord, entryOf, viewOf, signedFile, sendFile, runFiles } from "./record.mjs";
import { nextOf } from "./judge.mjs";
import { template } from "./plan.mjs";

export class RecordStepError extends Error {}
const no = (m) => { throw new RecordStepError(m); };
const hex = (b) => "0x" + Buffer.from(b).toString("hex");

/** A relayed text, checked against its sha256 and read as a JSON object. */
export function takeRelay(text, sha256, what) {
  if (typeof text !== "string") no(`--${what} is required`);
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) no(`--${what}-sha256 is required: the sha256 the pane gave beside the text`);
  if (sha256Text(text) !== sha256) no(`the sha256 of --${what} is not --${what}-sha256: the text changed on its way`);
  let v;
  try { v = JSON.parse(text); } catch { no(`--${what} is not JSON`); }
  if (v === null || typeof v !== "object" || Array.isArray(v)) no(`--${what} must be a JSON object`);
  return v;
}

const runtimeOfPlan = (plan) => ({ specName: plan.values.SPEC_NAME.value, specVersion: Number(plan.values.SPEC.value), transactionVersion: Number(plan.values.TXV.value), genesisHash: plan.values.GENESIS.value });

/** The run time record at the start (R1), from the owner's reads and the device's public key. */
export function startRecord(plan, reads, readsSha256, devicePublicKey, nowIso = new Date().toISOString()) {
  const owner = plan.values.OWNER.value;
  if (reads.account !== owner && reads.account !== ss58(owner)) no(`the reads are of the account ${reads.account}, not the owner of steps.json`);
  const want = runtimeOfPlan(plan);
  for (const k of Object.keys(want)) if (reads.runtime?.[k] !== want[k]) no(`the runtime's ${k} is ${reads.runtime?.[k]}, steps.json has ${want[k]}`);
  if (!Number.isSafeInteger(reads.finalized?.number) || !HASH.test(reads.finalized?.hash ?? "")) no("the reads need the finalized head's number and hash");
  if (!Number.isSafeInteger(reads.account_nonce) || reads.account_nonce < 0) no("the reads need the owner's next nonce");
  if (devicePublicKey === owner) no("the device key is the owner's key");
  const r = template(plan);
  r.accounts = { owner: { public_key: owner, ss58: ss58(owner) }, device: { public_key: devicePublicKey, ss58: ss58(devicePublicKey) } };
  r.owner_account_nonce_at_start = String(reads.account_nonce);
  r.chain.spec_name_at_start = reads.runtime.specName; r.chain.spec_version_at_start = reads.runtime.specVersion; r.chain.transaction_version_at_start = reads.runtime.transactionVersion;
  r.start = { finalized: { number: reads.finalized.number, hash: reads.finalized.hash }, read_by: "lab.accountReads of the owner, relayed by the lead", reads_sha256: readsSha256, recorded_utc: nowIso };
  return r;
}

const SNAKE = (k) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const PALLET = (section) => section.charAt(0).toUpperCase() + section.slice(1);
const COMMAS = /^[0-9]{1,3}(,[0-9]{3})*$/;
/** A value of the explorer in the record's form: numbers with commas as decimal strings, SS58 accounts as 0x hex, keys in snake case. */
export function recordForm(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) ? String(v) : no(`the explorer gave a number ${v} that is not a safe whole number`);
  if (typeof v === "string") {
    if (COMMAS.test(v)) return v.replace(/,/g, "");
    const account = fromSs58(v);
    return account ?? v;
  }
  if (Array.isArray(v)) return v.map(recordForm);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [SNAKE(k), recordForm(x)]));
  return v;
}

/** The explorer's reading in the record's form, checked against the run time record of the id (R2, R3). */
export function explorerReading(plan, step, rt, v, sha256, errors, results) {
  for (const k of ["source", "read_utc", "hash", "block_hash", "success", "error", "names", "events"]) if (!(k in v)) no(`the explorer reading has no ${k}`);
  const want = `${plan.values.EXPLORER.value}/api/transactions/${rt.extrinsic_hash}`;
  if (v.source !== want) no(`the explorer reading's source is ${v.source}, not ${want}`);
  if (typeof v.read_utc !== "string" || Number.isNaN(Date.parse(v.read_utc))) no("the explorer reading has no read_utc");
  if (v.hash !== rt.extrinsic_hash) no(`the explorer's hash ${v.hash} is not the extrinsic hash ${rt.extrinsic_hash} of the step's signed file`);
  if (v.block_hash !== rt.sent.block_hash) no(`the explorer's block hash ${v.block_hash} is not the runner's ${rt.sent.block_hash}`);
  if (typeof v.success !== "boolean") no("the explorer's success is not true or false");
  if (!Array.isArray(v.names) || !v.names.every((n) => typeof n === "string" && /^[a-z][A-Za-z0-9]*\.[A-Z][A-Za-z0-9]*$/.test(n))) no("the explorer's names are not section.method");
  if (!Array.isArray(v.events)) no("the explorer's events are not a list");
  let error = null;
  if (v.success === false) {
    if (!v.error || typeof v.error !== "object") no("a failed extrinsic needs its error");
    const named = Number.isInteger(v.error.index) && Number.isInteger(v.error.error) ? errors.errors.find((e) => e.pallet_index === v.error.index && e.error_index === v.error.error) : null;
    error = { pallet_index: v.error.index ?? null, error_index: v.error.error ?? null, name: named ? `${named.pallet}.${named.name}` : null };
  } else if (v.error !== null) no("a successful extrinsic has no error");
  const events = v.events.map((e) => {
    if (!e || typeof e.section !== "string" || typeof e.method !== "string") no("an explorer event is not { section, method, data }");
    if (!["computeChannel", "flopSessionKeys"].includes(e.section)) no(`the explorer reading carries an event of ${e.section}: only computeChannel and flopSessionKeys are kept`);
    return { pallet: PALLET(e.section), name: e.method, fields: recordForm(e.data ?? {}) };
  });
  const channel = step.channel ? substitute(step.channel, plan, results, true) : null;
  for (const e of events) {
    const id = e.fields.channel_id;
    if (id === undefined) continue;
    if (id !== channel) no(`the explorer's channelId ${id} in ${e.pallet}.${e.name} is not the derived channel id ${channel ?? "(none for this step)"}: do not go on; the formula is shown for force_open only, and this is the lead's to rule`);
  }
  return { source: v.source, read_utc: v.read_utc, hash: v.hash, block_hash: v.block_hash, success: v.success, error, names: v.names.map((n) => { const [s, m] = n.split("."); return `${PALLET(s)}.${m}`; }), events, relay_sha256: sha256 };
}

/** The outcomes of the runner that submitted nothing in that call: there is nothing to record. */
export const NOTHING_SUBMITTED = ["refused-bundle", "already-sent", "not-in-sent-list", "not-sent"];

/** The run time record with one reading added (R2). Returns the new record; the input is not changed. */
export function recordReading({ plan, run, results, id, sent, sentSha256, explorer, explorerSha256, errors }) {
  const step = planStepOf(plan, id) ?? no(`steps.json has no step ${id}, and ${id} is not an attempt S5 allows`);
  if (results.record !== "run-time") no(`results.json is a ${results.record ?? "unnamed"} record, not a run time record`);
  if (!sent && !explorer) no("give --sent, --explorer or both");
  const r = structuredClone(results);
  let e = entryOf(r, id);
  if (!e) { e = { step: id, run_time: null }; r.steps.push(e); }
  if (sent) {
    const next = nextOf(plan, results);
    if (next.step !== id || (next.word === "wait" && next.waiting !== "inclusion")) no(`${id} is not next by the record: ${next.word}${next.step ? ` ${next.step}` : ""}: ${next.why}`);
    if (viewOf(results, id)?.final) no(`the record holds ${id} in finalized block ${viewOf(results, id).block_number}: a run_time that holds a finalized block is never replaced`);
    if (typeof sent.status !== "string") no("the runner's reading has no status");
    if (NOTHING_SUBMITTED.includes(sent.status)) no(`the runner said ${sent.status}: nothing was submitted by that call, so there is nothing to record`);
    if (sent.step !== null && sent.step !== undefined && sent.step !== id) no(`the runner's reading is of ${sent.step}, not ${id}`);
    const file = signedFile(run, id);
    if (!existsSync(file)) no(`signed/${id}.json is not in the run folder`);
    const signed = readJson(file);
    const bundle = step.tool === "encoder" ? sendFile(run, id) : file;
    if (!existsSync(bundle)) no(`${bundle} is not in the run folder`);
    const bundleSha = sha256Text(readFileSync(bundle, "utf8"));
    if (sent.bundle_sha256 !== null && sent.bundle_sha256 !== undefined && sent.bundle_sha256 !== bundleSha) no(`the bundle the runner sent has sha256 ${sent.bundle_sha256}, the step's file in signed/ has ${bundleSha}`);
    if (sent.extrinsic_sha256 !== sha256Text(signed.extrinsic ?? "")) no(`the extrinsic the runner sent or found is not the one of signed/${id}.json`);
    if (sent.status === "finalized" && (!HASH.test(sent.block_hash ?? "") || !Number.isSafeInteger(sent.block_number) || !Number.isSafeInteger(sent.extrinsic_index))) no("a finalized reading needs the block hash, the block number and the extrinsic index");
    const earlier = e.run_time ? [...(e.run_time.earlier_readings ?? []), { sent: e.run_time.sent, sent_sha256: e.run_time.sent_sha256 }] : [];
    e.run_time = { extrinsic_hash: signed.extrinsic_hash, bundle_sha256: bundleSha, sent, sent_sha256: sentSha256, explorer: null, earlier_readings: earlier, earlier_copies: signed.earlier_copies ?? [] };
  }
  if (explorer) {
    const rt = e.run_time;
    if (!rt || rt.sent?.status !== "finalized") no(`the record holds no finalized block for ${id}: the explorer reading is added to a finalized step`);
    if (rt.explorer) no(`the record holds an explorer reading of ${id}: it is not replaced`);
    rt.explorer = explorerReading(plan, step, rt, explorer, explorerSha256, errors, r);
  }
  return r;
}

/** The judge's word for the run so far, in words. */
export function wordOf(plan, results) {
  const n = nextOf(plan, results);
  const lines = [];
  if (n.word === "wait") lines.push(`wait: ${n.why}`);
  else if (n.word === "stop") lines.push(`stop at ${n.stopped_at}: ${n.row}`);
  else lines.push(`go on${n.step ? `: ${n.why}` : `: ${n.why}`}`);
  if (n.word === "stop") lines.push(`next: ${n.step ?? "nothing"}`);
  if (n.cleanup.length) lines.push(`cleanup steps that apply: ${n.cleanup.join(", ")}`);
  for (const f of n.findings) lines.push(`finding: ${f}`);
  for (const l of n.left) lines.push(`left: ${l}`);
  return lines.join("\n");
}

const writeRecord = (run, r) => { const f = runFiles(run).results, tmp = `${f}.writing`; writeFileSync(tmp, JSON.stringify(r, null, 1) + "\n", { flag: "w" }); renameSync(tmp, f); };

function flags(argv, names) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith("--") ? argv[i].slice(2) : null;
    if (!names.includes(name)) no(`${argv[i]} is not a flag here (flags: ${names.map((n) => `--${n}`).join(", ")})`);
    if (i + 1 >= argv.length) no(`${argv[i]} needs a value`);
    out[name] = argv[++i];
  }
  return out;
}

function main(argv) {
  const plan = loadPlan();
  const errors = readJson(join(RERUN, "errors-1014020.json"));
  if (argv[0] === "start") {
    const f = flags(argv.slice(1), ["run", "key", "reads", "reads-sha256"]);
    const run = resolve(f.run ?? no("--run <run folder> is required"));
    if (existsSync(runFiles(run).results)) no(`${runFiles(run).results} exists: start never writes over a record`);
    const reads = takeRelay(f.reads, f["reads-sha256"], "reads");
    const signer = loadDeviceSigner(f.key ?? no("--key is required"));
    const pub = hex(signer.publicKey);
    signer.wipe();
    const r = startRecord(plan, reads, f["reads-sha256"], pub);
    mkdirSync(run, { recursive: true });
    writeFileSync(runFiles(run).results, JSON.stringify(r, null, 1) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ public_key: pub, ss58: ss58(pub) }));
    if (r.owner_account_nonce_at_start !== plan.values.OWNER_NONCE_AFTER_RERUN.value) console.log(`notice: the owner's next nonce at the start is ${r.owner_account_nonce_at_start}, not OWNER_NONCE_AFTER_RERUN ${plan.values.OWNER_NONCE_AFTER_RERUN.value}: something was sent from the owner since the rerun. It is recorded as read.`);
    return;
  }
  if (argv[0] === "step") {
    const id = argv[1] && !argv[1].startsWith("--") ? argv[1] : no("usage: node record-step.mjs step <id> --run <folder> [--sent '<text>' --sent-sha256 <sha>] [--explorer '<text>' --explorer-sha256 <sha>]");
    const f = flags(argv.slice(2), ["run", "sent", "sent-sha256", "explorer", "explorer-sha256"]);
    const run = resolve(f.run ?? no("--run <run folder> is required"));
    const results = loadRecord(run) ?? no("the run folder has no results.json: make it with record-step.mjs start");
    const sent = f.sent !== undefined || f["sent-sha256"] !== undefined ? takeRelay(f.sent, f["sent-sha256"], "sent") : null;
    const explorer = f.explorer !== undefined || f["explorer-sha256"] !== undefined ? takeRelay(f.explorer, f["explorer-sha256"], "explorer") : null;
    const r = recordReading({ plan, run, results, id, sent, sentSha256: f["sent-sha256"], explorer, explorerSha256: f["explorer-sha256"], errors });
    writeRecord(run, r);
    const v = viewOf(r, id);
    console.log(`recorded ${id}: ${v.final ? `in finalized block ${v.block_number} (${v.block_hash}), as the node reported` : `the runner said ${v.sent_status}`}${v.success === null ? "" : v.success ? ", the explorer says success" : `, the explorer says refused with ${v.error.name ?? `pallet ${v.error.pallet_index} error ${v.error.error_index}, not named by the 1014020 table`}`}`);
    console.log(wordOf(plan, r));
    return;
  }
  no("commands: start, step (see the head of this file)");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { main(process.argv.slice(2)); } catch (e) {
    const words = e instanceof RecordStepError || e instanceof DeviceKeyError ? e.message : `failed (${e?.constructor?.name ?? typeof e})`;
    process.stderr.write(`record-step: ${words}\n`);
    process.exit(2);
  }
}
