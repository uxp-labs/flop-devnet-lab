#!/usr/bin/env node
// sign-device: signs one device step of steps.json (T3 to T7) with the chain encoder of imd-flop,
// and nothing else. The call is built only by signSessionCall of imd-flop/dist/chain/, from the
// step's inner call in steps.json and the chain reads given. No network.
//
//   node sign-device.mjs <step> --key <key file> --reads '<json>' [--results <results.json>] [--out-dir <folder>]
//
// <json> holds the reads of moments before (pane-runner.js deviceReads prints them):
//   { "runtime": { "specName", "specVersion", "transactionVersion", "genesisHash" },
//     "birth": { "number", "hash" }, "account_nonce": <n>,
//     "session_nonce": "<decimal>"  or  "session_nonce_raw": "0x<8 bytes, little endian>" }
// The channel id of T4, T6 and T7 is the event field steps.json names, taken from --results.
//
// It writes <out-dir>/<step>.json (default signed/) and refuses if that file exists. It prints the
// encoder's description to stderr and { saved, sha256, extrinsic_hash, last_valid_block } to stdout.
//
// The key file is the research signer's format, { v: 0, alg: "ed25519", seed_b64 }. This script
// reads it itself, makes the signer with @noble/curves from imd-flop/node_modules, wipes the seed
// once the call is signed, and puts nothing of it in any output or error message.
// Build imd-flop first: cd imd-flop && npm ci && npm run build.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO, HASH, RAW, loadPlan, readJson, stepOf, substitute } from "./lib.mjs";

const PKG = join(REPO, "imd-flop");
const chain = (f) => import(pathToFileURL(join(PKG, "dist", "chain", f)).href);
const { signSessionCall } = await chain("extrinsic.js");
const { runtimeFor } = await chain("table.js");
const { ed25519 } = await import(pathToFileURL(createRequire(join(PKG, "package.json")).resolve("@noble/curves/ed25519.js")).href);

/** A refusal of this script: its message is its own words, never input bytes of the key. */
export class SignDeviceError extends Error {}
const no = (m) => { throw new SignDeviceError(m); };
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const bytes32 = (v, what) => (typeof v === "string" && HASH.test(v) ? Uint8Array.from(Buffer.from(v.slice(2), "hex")) : no(`${what} must be 0x and 64 lower case hex digits`));

/**
 * The device signer from a key file of the research signer's format. The seed lives only in the
 * returned closure until wipe() is called. Every failure is one fixed message.
 */
export function loadDeviceSigner(path) {
  let seed;
  try {
    const b64 = JSON.parse(readFileSync(path, "utf8")).seed_b64;
    if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) throw new Error();
    seed = Uint8Array.from(Buffer.from(b64, "base64"));
    if (seed.length !== 32) throw new Error();
  } catch {
    no("the key file cannot be read as the research signer's key format");
  }
  const publicKey = ed25519.getPublicKey(seed);
  return {
    publicKey,
    sign: (message) => ed25519.sign(message, seed),
    wipe: () => { seed.fill(0); seed = undefined; },
  };
}

/** The reads, checked. */
export function takeReads(reads) {
  if (reads === null || typeof reads !== "object") no("--reads must be a JSON object");
  const known = ["runtime", "birth", "account_nonce", "session_nonce", "session_nonce_raw"];
  for (const k of Object.keys(reads)) if (!known.includes(k)) no(`--reads has a field ${k} this script does not take`);
  const rt = reads.runtime ?? no("--reads needs runtime");
  const runtime = { specName: rt.specName, specVersion: rt.specVersion, transactionVersion: rt.transactionVersion, genesisHash: rt.genesisHash };
  const b = reads.birth ?? no("--reads needs birth");
  if (!Number.isSafeInteger(b.number) || b.number < 0) no("birth.number must be a whole number");
  const birth = { number: b.number, hash: bytes32(b.hash, "birth.hash") };
  if (!Number.isSafeInteger(reads.account_nonce) || reads.account_nonce < 0) no("account_nonce must be a whole number");
  const given = ["session_nonce", "session_nonce_raw"].filter((k) => k in reads);
  if (given.length !== 1) no("--reads needs exactly one of session_nonce and session_nonce_raw");
  let sessionNonce;
  if (given[0] === "session_nonce") sessionNonce = RAW.test(String(reads.session_nonce)) ? BigInt(reads.session_nonce) : no("session_nonce must be a decimal string");
  else if (reads.session_nonce_raw === null) no("the node holds no session nonce: give session_nonce as the plan says");
  else if (typeof reads.session_nonce_raw !== "string" || !/^0x[0-9a-f]{16}$/.test(reads.session_nonce_raw)) no("session_nonce_raw must be 0x and 8 bytes of hex");
  else sessionNonce = Buffer.from(reads.session_nonce_raw.slice(2), "hex").readBigUInt64LE(0);
  return { runtime, birth, accountNonce: reads.account_nonce, sessionNonce };
}

/** A value of steps.json as the encoder's input type of that field, read from the encoder's own table. */
function asType(ty, text, what) {
  if (ty.kind === "struct") {
    if (text === null || typeof text !== "object") no(`${what} must be an object`);
    return Object.fromEntries(ty.fields.map((f) => [f.name, asType(f.type, text[f.name], `${what}.${f.name}`)]));
  }
  if (typeof text !== "string") no(`${what} is missing in steps.json`);
  if (/\$[A-Z]/.test(text)) no(`${what}: ${text} is not known yet`);
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

/** Plain data of the encoder's fields: bytes as hex, bigints as decimal strings. */
const plain = (v) => (v instanceof Uint8Array ? hex(v) : typeof v === "bigint" ? v.toString() : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);

/**
 * Signs one step. The signer is { publicKey, sign }. Returns the record to write. Every check of
 * this script comes before the encoder is called, but the one of the declared spend after it.
 */
export function signStep({ plan, stepId, reads, results, signer }) {
  const step = stepOf(plan, stepId);
  if (step.tool !== "encoder") no(`${stepId} is not signed by the encoder: it is a research signer step`);
  const r = takeReads(reads);
  const withDevice = { ...(results ?? {}), accounts: { ...(results?.accounts ?? {}), device: { public_key: hex(signer.publicKey) } } };
  const known = results?.accounts?.device?.public_key;
  if (known && known !== hex(signer.publicKey)) no("the key file is not the device of results.json");
  const owner = bytes32(plan.values.OWNER.value, "OWNER");
  const inner = innerOf(plan, step, r.runtime, withDevice);
  const out = signSessionCall({ runtime: r.runtime, owner, inner, sessionNonce: r.sessionNonce, accountNonce: r.accountNonce, birth: r.birth, signer: { publicKey: signer.publicKey, sign: signer.sign } });
  const declared = substitute(step.declared, plan, withDevice, true);
  if (out.fields.spend.toString() !== declared) no(`the encoder declares ${out.fields.spend}, steps.json says ${declared}: not written`);
  return {
    step: step.id, tool: "chain encoder, imd-flop/dist/chain signSessionCall",
    signer: hex(out.fields.signer), account_nonce: String(out.fields.accountNonce), session_nonce: out.fields.sessionNonce.toString(),
    declared_spend_raw: out.fields.spend.toString(),
    era: { period: out.fields.lastValidBlock - out.fields.birth.number + 1, birth_number: out.fields.birth.number, birth_hash: hex(out.fields.birth.hash), last_valid_block: out.fields.lastValidBlock },
    runtime: r.runtime, signed_path: out.signed, payload_length: out.payloadLength,
    call: hex(out.call), extrinsic: hex(out.extrinsic), extrinsic_hash: hex(out.hash),
    fields: plain(out.fields), description: out.description,
  };
}

function main(argv) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : (argv[i + 1] ?? no(`--${n} needs a value`)); };
  const stepId = argv[0] && !argv[0].startsWith("--") ? argv[0] : no("usage: node sign-device.mjs <step> --key <file> --reads '<json>' [--results <file>] [--out-dir <folder>]");
  const plan = loadPlan();
  const step = plan.steps.find((x) => x.id === stepId) ?? no(`steps.json has no step ${stepId}`);
  if (step.tool !== "encoder") no(`${stepId} is not signed by the encoder: it is a research signer step`);
  const dir = resolve(flag("out-dir") ?? "signed");
  const file = join(dir, `${stepId}.json`);
  if (existsSync(file)) no(`${file} exists: a signed step is never replaced. Move it aside to sign the step again`);
  let reads;
  try { reads = JSON.parse(flag("reads") ?? no("--reads is required")); } catch (e) { if (e instanceof SignDeviceError) throw e; no("--reads is not JSON"); }
  const results = flag("results") ? readJson(flag("results")) : null;
  const keyFile = flag("key") ?? no("--key is required");
  const signer = loadDeviceSigner(keyFile);
  let record;
  try { record = signStep({ plan, stepId, reads, results, signer }); } finally { signer.wipe(); }
  const text = JSON.stringify(record, null, 1) + "\n";
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text, { flag: "wx" });
  process.stderr.write(`sign-device: ${stepId}, valid to block ${record.era.last_valid_block}:\n  ${record.description}\n`);
  console.log(JSON.stringify({ saved: file, sha256: createHash("sha256").update(text).digest("hex"), extrinsic_hash: record.extrinsic_hash, last_valid_block: record.era.last_valid_block }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { main(process.argv.slice(2)); } catch (e) {
    // Only this script's and the encoder's own words are printed; anything else is named by its class.
    const words = e instanceof SignDeviceError ? e.message : e?.name === "ChainEncodeError" || e?.constructor?.name === "ChainEncodeError" ? `${e.code ?? "refused"}: ${e.message}` : `failed (${e?.constructor?.name ?? typeof e})`;
    process.stderr.write(`sign-device: ${words}\n`);
    process.exit(2);
  }
}
