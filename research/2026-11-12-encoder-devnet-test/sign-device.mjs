#!/usr/bin/env node
// sign-device: signs one device step of steps.json (T3 to T7, or an attempt of a cleanup step such
// as T6.2) with the chain encoder of imd-flop, and nothing else. The call is built only by
// signSessionCall of imd-flop/dist/chain/, from the step's inner call in steps.json and the chain
// reads given. No network.
//
//   node sign-device.mjs <id> --run <run folder> --key <key file> --reads '<text>' --reads-sha256 <sha> [--again]
//
// <text> is what lab.deviceReads(...) gave in the pane as its relay text, and <sha> the sha256 it
// gave beside it: { account, runtime: { specName, specVersion, transactionVersion, genesisHash },
// birth: { number, hash }, account_nonce, session_nonce_raw }.
//
// Everything is in the run folder (S1): its results.json (made by record-step.mjs start) and its
// signed/ folder. No path is taken from the working folder.
//
// Before the key file is opened, in this order, each with its own fixed refusal (S2):
//   a. the id is an encoder step of steps.json, or an attempt S5 allows of one;
//   b. the reads' sha256 is the one given;
//   c. the id is the next one by the record (judge.mjs nextOf);
//   d. the record does not hold it as included in a block;
//   e. the device's next account nonce in the reads is the number of device transactions the
//      record holds as included in a finalized block;
//   f. the session nonce in the reads is the number of the device's session calls the record
//      holds as succeeded (a raw null counts as 0, and only when that number is 0);
//   g. a step with after_block: the birth block is above that block (S7).
// Then: without --again a signed file of the id refuses, and so do dead copies of it in signed/;
// with --again (S4) the earlier copy's era must be over at the birth block of the new reads. The
// earlier copy is signed/<id>.json, or the newest dead copy when there is none (F10). The new
// record's earlier_copies is always made from the <id>.dead-* files in signed/ (F10). Every refusal
// of the move of an earlier copy to dead-<n> is also checked before the key (H6): a dead-<n> name
// that exists, and a dead send file with no dead copy of its number beside it.
//
// It writes signed/<id>.json (the whole record, stays on the PC) and signed/<id>.send.json, exactly
// {"step":"<id>","extrinsic":"0x…"} on one line with no line end (S3). Stdout is two lines: one JSON
// line { saved, send_file, send_sha256, extrinsic_hash, last_valid_block, birth_number }, then the
// send file's text. The description goes to stderr.
//
// The key file is read by device-key.mjs (S6). Nothing of it reaches any output or error message.
// Build imd-flop first: cd imd-flop && npm ci && npm run build.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, HASH, RAW, loadPlan, readJson, substitute, sha256Text, ss58, planRuntime } from "./lib.mjs";
import { DeviceKeyError, loadDeviceSigner } from "./device-key.mjs";
import { leadStopOf, sendText as sendTextOf, planStepOf, loadRecord, viewOf, deviceIncluded, sessionSucceeded, afterBlockOf, signedFile, sendFile, runFiles } from "./record.mjs";
import { nextOf } from "./judge.mjs";

const chain = (f) => import(pathToFileURL(join(REPO, "imd-flop", "dist", "chain", f)).href);
const { signSessionCall, encodeSessionCall } = await chain("extrinsic.js");
const { readCall } = await chain("reader.js");
const { runtimeFor } = await chain("table.js");

/** A refusal of this script: its message is its own words, never input bytes of the key. */
export class SignDeviceError extends Error {}
const no = (m) => { throw new SignDeviceError(m); };
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const bytes32 = (v, what) => (typeof v === "string" && HASH.test(v) ? Uint8Array.from(Buffer.from(v.slice(2), "hex")) : no(`${what} must be 0x and 64 lower case hex digits`));

/** The reads of the runner, from its relay text and that text's sha256 (S2b), checked. */
export function takeReads(text, sha256) {
  if (typeof text !== "string") no("--reads is required");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) no("--reads-sha256 is required: the sha256 the pane gave beside the reads");
  if (sha256Text(text) !== sha256) no("the sha256 of --reads is not --reads-sha256: the text changed on its way");
  let reads;
  try { reads = JSON.parse(text); } catch { no("--reads is not JSON"); }
  if (reads === null || typeof reads !== "object" || Array.isArray(reads)) no("--reads must be a JSON object");
  const known = ["account", "runtime", "birth", "account_nonce", "session_nonce_raw"];
  for (const k of Object.keys(reads)) if (!known.includes(k)) no(`--reads has a field ${k} this script does not take`);
  for (const k of known) if (!(k in reads)) no(`--reads needs ${k}`);
  const rt = reads.runtime;
  if (rt === null || typeof rt !== "object") no("--reads needs runtime");
  const runtime = { specName: rt.specName, specVersion: rt.specVersion, transactionVersion: rt.transactionVersion, genesisHash: rt.genesisHash };
  const b = reads.birth;
  if (b === null || typeof b !== "object" || !Number.isSafeInteger(b.number) || b.number < 0) no("birth.number must be a whole number");
  const birth = { number: b.number, hash: bytes32(b.hash, "birth.hash") };
  if (!Number.isSafeInteger(reads.account_nonce) || reads.account_nonce < 0) no("account_nonce must be a whole number");
  const raw = reads.session_nonce_raw;
  if (raw !== null && (typeof raw !== "string" || !/^0x[0-9a-f]{16}$/.test(raw))) no("session_nonce_raw must be null or 0x and 8 bytes of hex");
  const sessionNonce = raw === null ? null : Buffer.from(raw.slice(2), "hex").readBigUInt64LE(0);
  return { account: reads.account, runtime, birth, accountNonce: reads.account_nonce, sessionNonce };
}

/** A value of steps.json as the encoder's input type of that field, read from the encoder's own table. */
function asType(ty, text, what) {
  if (ty.kind === "struct") {
    if (text === null || typeof text !== "object") no(`${what} must be an object`);
    return Object.fromEntries(ty.fields.map((f) => [f.name, asType(f.type, text[f.name], `${what}.${f.name}`)]));
  }
  if (typeof text !== "string") no(`${what} is missing in steps.json`);
  if (/\$[A-Z]/.test(text)) no(`${what}: ${text} is not known`);
  if (ty.kind === "bytes32") return bytes32(text, what);
  if (ty.kind === "u32") return RAW.test(text) ? Number(text) : no(`${what} must be a number`);
  if (ty.kind === "u64" || ty.kind === "u128") return RAW.test(text) ? BigInt(text) : no(`${what} must be a number`);
  if (ty.kind === "enum") return text;
  return no(`${what} has a type this script does not write`);
}

/** The inner call of a step, every $NAME resolved, in the encoder's input types. */
export function innerOf(plan, step, runtime, results) {
  const rt = runtimeFor(runtime);
  const entry = rt.calls.find((c) => c.pallet === "ComputeChannel" && c.name === step.inner.call) ?? no(`the runtime has no ComputeChannel.${step.inner.call}`);
  const sub = (v) => (typeof v === "string" ? substitute(v, plan, results) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
  const spec = sub(step.inner);
  return { call: step.inner.call, ...Object.fromEntries(entry.fields.map((f) => [f.name, asType(f.type, spec[f.name], `${step.inner.call}.${f.name}`)])) };
}

/**
 * Every check of S2 and S4, in the brief's order, before any key file is opened. Returns what
 * signing needs: { step, reads, results, earlier } where earlier is the copy --again replaces.
 */
export function preflight({ plan, run, id, readsText, readsSha256, again = false }) {
  const step = planStepOf(plan, id);
  if (!step) no(`steps.json has no step ${id}, and ${id} is not an attempt S5 allows`);
  if (step.tool !== "encoder") no(`${id} is not signed by the encoder: it is a research signer step`);
  const reads = takeReads(readsText, readsSha256);
  const results = loadRecord(run) ?? no(`the run folder has no results.json: make it with record-step.mjs start`);
  if (results.record !== "run-time") no(`results.json is a ${results.record ?? "unnamed"} record, not a run time record`);
  const device = results.accounts?.device?.public_key;
  if (!HASH.test(device ?? "")) no("results.json names no device: make it with record-step.mjs start");
  if (leadStopOf(results, id)) no(`the lead stopped ${id} (case ${leadStopOf(results, id).case}): it is never signed after the stop`);
  const next = nextOf(plan, results);
  const mayAgain = again && next.word === "wait" && next.waiting === "inclusion" && next.step === id;
  if (next.step !== id || (next.word === "wait" && !mayAgain)) no(`${id} is not next by the record: ${next.word}${next.step ? ` ${next.step}` : ""}: ${next.why}`);
  if (viewOf(results, id)?.final) no(`the record holds ${id} as included in block ${viewOf(results, id).block_number}: it is never signed again`);
  if (reads.account !== device && reads.account !== ss58(device)) no(`the reads are of the account ${reads.account}, not the device of results.json`);
  const included = deviceIncluded(plan, results);
  if (reads.accountNonce !== included) no(`the device's next nonce is ${reads.accountNonce}, the record holds ${included} device transactions as included: a device transaction the record does not hold is in the pool or on chain`);
  const succeeded = sessionSucceeded(plan, results);
  if (reads.sessionNonce === null ? succeeded !== 0 : reads.sessionNonce !== BigInt(succeeded)) no(`the session nonce in the reads is ${reads.sessionNonce ?? "not stored"}, the record holds ${succeeded} session calls as succeeded`);
  const after = afterBlockOf(plan, step, results);
  if (after !== null && typeof after === "object") no(`${id} must wait for a block the record does not give yet: ${after.unknown}`);
  if (after !== null && !(reads.birth.number > after)) no(`${id} is signed only from a birth block above ${after}: the birth block is ${reads.birth.number}, ${after - reads.birth.number + 1} blocks left`);
  let earlier = null;
  const file = signedFile(run, id), send = sendFile(run, id);
  const dead = deadCopies(run, id);
  // H6: every refusal of retire comes before the key: a lone dead send file, a dead-<n> name that exists
  if (again && existsSync(file)) retireTo(run, id);
  const lone = loneDeadSends(run, id);
  if (lone.length) no(`signed/ holds ${lone.map((f) => `signed/${f}`).join(", ")} without its dead copy beside it: a stop in the middle of an earlier --again; the lead rules`);
  if (!again) {
    if (existsSync(file) || existsSync(send)) no(`signed/${id}.json exists: a signed step is never replaced. Sign a second copy only with --again (S4)`);
    if (dead.length) no(`signed/ holds ${dead.length} dead copies of ${id} and no signed/${id}.json: sign it only with --again, so the era of the newest dead copy is checked and the new record lists them (F10)`);
  } else {
    if (!existsSync(file) && existsSync(send)) no(`signed/${id}.send.json exists without signed/${id}.json, so no earlier copy can be named for it: a stop in the middle of an earlier --again; the lead rules`);
    if (!existsSync(file) && !dead.length) no(`--again needs signed/${id}.json or a dead copy: there is no earlier copy`);
    earlier = existsSync(file) ? readJson(file) : readJson(join(runFiles(run).signed, dead[dead.length - 1].file));
    const last = earlier?.era?.last_valid_block;
    if (!Number.isSafeInteger(last)) no(`the earlier copy of ${id} has no last valid block`);
    if (!(reads.birth.number > last)) no(`--again: the earlier copy is valid to block ${last}, and the birth block of the reads is ${reads.birth.number}: its era is not over`);
  }
  // F6: what can refuse without the key comes before it. The runtime of the reads must be one the
  // encoder's table holds (RUNTIME_UNKNOWN otherwise) and the plan's; the call is built unsigned and
  // its declared spend compared with steps.json. After the key only the signature and the writes remain.
  runtimeFor(reads.runtime);
  const want = planRuntime(plan);
  for (const k of Object.keys(want)) if (reads.runtime[k] !== want[k]) no(`the runtime of the reads has ${k} ${reads.runtime[k]}, steps.json has ${want[k]}`);
  const call = encodeSessionCall({ runtime: reads.runtime, owner: bytes32(plan.values.OWNER.value, "OWNER"), inner: innerOf(plan, step, reads.runtime, results), sessionNonce: reads.sessionNonce ?? 0n });
  const declared = substitute(step.declared, plan, results, true);
  const spend = readCall(reads.runtime, call).spend;
  if (spend.toString() !== declared) no(`the encoder declares ${spend}, steps.json says ${declared}: not signed`);
  return { step, reads, results, earlier, call: hex(call) };
}

/** Plain data of the encoder's fields: bytes as hex, bigints as decimal strings. */
const plain = (v) => (v instanceof Uint8Array ? hex(v) : typeof v === "bigint" ? v.toString() : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);

/**
 * Signs one id. The signer is { publicKey, sign }. Returns the record to write. The declared spend
 * is checked against steps.json after the encoder.
 */
export function signStep({ plan, id, step, reads, results, signer }) {
  const withDevice = { ...(results ?? {}), accounts: { ...(results?.accounts ?? {}), device: { public_key: hex(signer.publicKey) } } };
  const known = results?.accounts?.device?.public_key;
  if (known && known !== hex(signer.publicKey)) no("the key file is not the device of results.json");
  const owner = bytes32(plan.values.OWNER.value, "OWNER");
  const inner = innerOf(plan, step, reads.runtime, withDevice);
  const out = signSessionCall({ runtime: reads.runtime, owner, inner, sessionNonce: reads.sessionNonce ?? 0n, accountNonce: reads.accountNonce, birth: reads.birth, signer: { publicKey: signer.publicKey, sign: signer.sign } });
  const declared = substitute(step.declared, plan, withDevice, true);
  if (out.fields.spend.toString() !== declared) no(`the encoder declares ${out.fields.spend}, steps.json says ${declared}: not written`);
  return {
    step: id, of_step: step.id, tool: "chain encoder, imd-flop/dist/chain signSessionCall",
    signer: hex(out.fields.signer), account_nonce: String(out.fields.accountNonce), session_nonce: out.fields.sessionNonce.toString(),
    declared_spend_raw: out.fields.spend.toString(),
    era: { period: out.fields.lastValidBlock - out.fields.birth.number + 1, birth_number: out.fields.birth.number, birth_hash: hex(out.fields.birth.hash), last_valid_block: out.fields.lastValidBlock },
    runtime: reads.runtime, signed_path: out.signed, payload_length: out.payloadLength,
    call: hex(out.call), extrinsic: hex(out.extrinsic), extrinsic_hash: hex(out.hash),
    fields: plain(out.fields), description: out.description,
  };
}

/** The send file's text of a record: exactly {"step","extrinsic"} on one line, no line end (S3). */
export const sendText = (record) => sendTextOf(record.step, record.extrinsic);

/** The dead copies of an id in signed/, by their number: [{ n, file, send_file }] (F10). */
export function deadCopies(run, id) {
  const dir = runFiles(run).signed;
  if (!existsSync(dir)) return [];
  const esc = id.replace(/\./g, "\\.");
  const re = new RegExp(`^${esc}\\.dead-([1-9][0-9]*)\\.json$`);
  return readdirSync(dir).map((f) => re.exec(f)).filter(Boolean).map((m) => ({ n: Number(m[1]), file: m[0], send_file: `${id}.dead-${m[1]}.send.json` })).sort((a, b) => a.n - b.n);
}

/** The dead send files of an id in signed/ with no dead copy of the same number beside them (H6). */
export function loneDeadSends(run, id) {
  const dir = runFiles(run).signed;
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${id.replace(/\./g, "\\.")}\\.dead-([1-9][0-9]*)\\.send\\.json$`);
  return readdirSync(dir).filter((f) => re.test(f) && !existsSync(join(dir, f.replace(/\.send\.json$/, ".json")))).sort();
}

/** The names retire moves signed/<id>.json and its send file to, the next dead-<n>; refused when one exists (S4, H6). */
export function retireTo(run, id) {
  const dir = runFiles(run).signed;
  const dead = deadCopies(run, id);
  const n = 1 + (dead.length ? dead[dead.length - 1].n : 0);
  const to = join(dir, `${id}.dead-${n}.json`), toSend = join(dir, `${id}.dead-${n}.send.json`);
  if (existsSync(to) || existsSync(toSend)) no(`signed/${id}.dead-${n}.json exists`);
  return { to, toSend };
}

/** For --again: moves signed/<id>.json and its send file to the next dead-<n> (S4). */
function retire(run, id) {
  const { to, toSend } = retireTo(run, id);
  renameSync(signedFile(run, id), to);
  if (existsSync(sendFile(run, id))) renameSync(sendFile(run, id), toSend);
}

/** earlier_copies of a new record: always the dead files in signed/, with or without --again (F10). */
export function earlierCopies(run, id) {
  return deadCopies(run, id).map((d) => {
    const r = readJson(join(runFiles(run).signed, d.file));
    return { file: `signed/${d.file}`, send_file: `signed/${d.send_file}`, extrinsic_hash: r.extrinsic_hash ?? null, last_valid_block: r.era?.last_valid_block ?? null };
  });
}

const FLAGS = ["run", "key", "reads", "reads-sha256"];
function main(argv) {
  const id = argv[0] && !argv[0].startsWith("--") ? argv[0] : no("usage: node sign-device.mjs <id> --run <folder> --key <file> --reads '<text>' --reads-sha256 <sha> [--again]");
  const flags = {};
  let again = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--again") { again = true; continue; }
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (!FLAGS.includes(name)) no(`${a} is not a flag of this script (flags: ${FLAGS.map((f) => `--${f}`).join(", ")}, --again)`);
    if (i + 1 >= argv.length) no(`${a} needs a value`);
    flags[name] = argv[++i];
  }
  const run = resolve(flags.run ?? no("--run <run folder> is required"));
  const plan = loadPlan();
  const pre = preflight({ plan, run, id, readsText: flags.reads, readsSha256: flags["reads-sha256"], again });
  const signer = loadDeviceSigner(flags.key ?? no("--key is required"));
  let record;
  try { record = signStep({ plan, id, step: pre.step, reads: pre.reads, results: pre.results, signer }); } finally { signer.wipe(); }
  mkdirSync(runFiles(run).signed, { recursive: true });
  if (pre.earlier && existsSync(signedFile(run, id))) retire(run, id);
  record.earlier_copies = earlierCopies(run, id);
  const send = sendText(record);
  writeFileSync(signedFile(run, id), JSON.stringify(record, null, 1) + "\n", { flag: "wx" });
  writeFileSync(sendFile(run, id), send, { flag: "wx" });
  process.stderr.write(`sign-device: ${id}, valid to block ${record.era.last_valid_block}:\n  ${record.description}\n`);
  process.stdout.write(JSON.stringify({ saved: signedFile(run, id), send_file: sendFile(run, id), send_sha256: sha256Text(send), extrinsic_hash: record.extrinsic_hash, last_valid_block: record.era.last_valid_block, birth_number: record.era.birth_number }) + "\n" + send + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { main(process.argv.slice(2)); } catch (e) {
    // Only this script's, the key loader's and the encoder's own words are printed; anything else is named by its class.
    const words = e instanceof SignDeviceError || e instanceof DeviceKeyError ? e.message : e?.name === "ChainEncodeError" || e?.constructor?.name === "ChainEncodeError" ? `${e.code ?? "refused"}: ${e.message}` : `failed (${e?.constructor?.name ?? typeof e})`;
    process.stderr.write(`sign-device: ${words}\n`);
    process.exit(2);
  }
}
