// The check of a research signer step's signed file (F1): its extrinsic's own bytes must be the
// one extrinsic the research signer can have made for the plan's step, read from the bytes and not
// from the file's other fields. record-step.mjs send-file runs it before it writes a send file, and
// record-step.mjs step runs it for a research signer id before it records a reading. No network,
// no key: the research signer's call command takes no key.
//
// What the plan expects of a research signer id (T1, T2, T8, T9 and their attempts):
//   the signer     OWNER of steps.json; for T9 the device the record names
//   the nonce      for the owner, owner_account_nonce_at_start plus the owner transactions the record
//                  holds as included in a finalized block; for T9, the device transactions the record
//                  holds so. The id itself is not counted.
//   the call       the bytes our own research/2026-11-11-session-deny-list/flop-sign.mjs prints for
//                  `call <the step's call of steps.json, every $NAME resolved>`. That tool is run for
//                  them: the call bytes are not written a second way here.
// From those it builds the envelope exactly as flop-sign.mjs sign writes it (its head and its sign
// command): compact length, then 0x84 (version 4, signed), address kind 0 (Id) and the 32 byte
// signer, signature kind 0 (Ed25519) and 64 bytes, era 0x00 (immortal), compact nonce, compact tip 0,
// CheckMetadataHash mode 0x00, then the call. CheckNonZeroSender, CheckSpecVersion, CheckTxVersion,
// CheckGenesis and CheckWeight add nothing to the extrinsic. The 64 signature bytes are taken from
// the file's extrinsic at their place. The file's extrinsic must equal that, byte for byte, and its
// extrinsic_hash must be the blake2b-256 of the extrinsic.
//
// The signature itself is not checked: a wrong signature is refused by the node at no cost (the
// extrinsic is invalid, it enters no pool and no block, and no fee is paid), while every byte that
// decides what the chain does with a valid one is checked here.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO, HASH, blake2b256Hex, substitute } from "./lib.mjs";
import { planStepOf, recordedIds, viewOf, deviceIncluded } from "./record.mjs";

export class ResearchSignedError extends Error {}
const no = (m) => { throw new ResearchSignedError(m); };
const hex = (b) => "0x" + Buffer.from(b).toString("hex");

// ---- SCALE compact, in our own lines --------------------------------------------------------------

/** The SCALE compact encoding of a whole number. */
export function compact(v) {
  const n = BigInt(v);
  if (n < 0n) throw new Error("a compact number is not negative");
  const le = (x, len) => { const b = Buffer.alloc(len); let y = x; for (let i = 0; i < len; i++) { b[i] = Number(y & 0xffn); y >>= 8n; } return b; };
  if (n < 1n << 6n) return le(n << 2n, 1);
  if (n < 1n << 14n) return le((n << 2n) | 1n, 2);
  if (n < 1n << 30n) return le((n << 2n) | 2n, 4);
  let len = 0;
  for (let x = n; x > 0n; x >>= 8n) len++;
  return Buffer.concat([Buffer.of(((len - 4) << 2) | 3), le(n, len)]);
}

/** A compact number at an offset of bytes: { value, size }, or null when the bytes end first. */
export function readCompact(b, o) {
  if (o >= b.length) return null;
  const mode = b[o] & 3;
  if (mode === 0) return { value: BigInt(b[o] >> 2), size: 1 };
  const size = mode === 1 ? 2 : mode === 2 ? 4 : 1 + (b[o] >> 2) + 4;
  if (o + size > b.length) return null;
  let v = 0n;
  const from = mode === 3 ? o + 1 : o;
  for (let i = o + size - 1; i >= from; i--) v = (v << 8n) | BigInt(b[i]);
  return { value: mode === 3 ? v : v >> 2n, size };
}

// ---- what the plan expects --------------------------------------------------------------------

/** The account nonce the plan gives a research signer id, by the record (F1). The id itself is not counted. */
export function nonceOf(plan, results, id) {
  const step = planStepOf(plan, id) ?? no(`steps.json has no step ${id}`);
  if (step.signer === "device") return BigInt(deviceIncluded(plan, results)) - (viewOf(results, id)?.final ? 1n : 0n);
  const start = results?.owner_account_nonce_at_start;
  if (typeof start !== "string" || !/^(0|[1-9][0-9]*)$/.test(start)) no("the record has no owner_account_nonce_at_start");
  const included = recordedIds(plan, results).filter((x) => x !== id && planStepOf(plan, x).signer === "owner" && viewOf(results, x).final).length;
  return BigInt(start) + BigInt(included);
}

/** The signer the plan gives a research signer id: OWNER, or the device of the record. */
export function signerOf(plan, results, step) {
  if (step.signer === "owner") return plan.values.OWNER.value;
  const d = results?.accounts?.device?.public_key;
  if (!HASH.test(d ?? "")) no("the record names no device");
  return d;
}

/** The research signer's arguments of a step's call, every $NAME resolved. */
export const callArgsOf = (plan, results, step) => step.call.map((a) => substitute(a, plan, results, true));

/**
 * The call bytes our research signer prints for a step: it is run, with no key (F1). Before it is
 * run, the device's public key the record gives ($DEVICE of the calls) must be 0x and 64 lower case
 * hex digits, for every step (H8).
 */
export function callOf(plan, results, step, repo = REPO) {
  const device = results?.accounts?.device?.public_key;
  if (typeof device !== "string" || !HASH.test(device)) no(`the record's device public key ${JSON.stringify(device ?? null)} is not 0x and 64 lower case hex digits: the research signer is not run for ${step.id}`);
  const args = callArgsOf(plan, results, step);
  const out = execFileSync(process.execPath, [join(repo, plan.files.signer), "call", ...args, "--libs", join(repo, "imd-flop")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const call = JSON.parse(out).call;
  if (typeof call !== "string" || !/^0x([0-9a-f]{2})+$/.test(call)) no(`the research signer printed no call for ${step.id}`);
  return call;
}

/** What the plan expects of a research signer id: { signer, nonce, call } as hex, bigint and hex. */
export function expectedOf(plan, results, id) {
  const step = planStepOf(plan, id) ?? no(`steps.json has no step ${id}, and ${id} is not an attempt S5 allows`);
  if (step.tool !== "research-signer") no(`${id} is not a research signer step`);
  return { signer: signerOf(plan, results, step), nonce: nonceOf(plan, results, id), call: callOf(plan, results, step) };
}

// ---- the envelope -----------------------------------------------------------------------------

const PREFIX = Buffer.of(0x84, 0x00); // version 4 signed, address kind Id

/** The extrinsic flop-sign.mjs sign writes for these, with the given 64 signature bytes. */
export function envelope({ signer, nonce, call, signature }) {
  const body = Buffer.concat([PREFIX, Buffer.from(signer.slice(2), "hex"), Buffer.of(0x00), Buffer.from(signature), Buffer.of(0x00), compact(nonce), compact(0), Buffer.of(0x00), Buffer.from(call.slice(2), "hex")]);
  return Buffer.concat([compact(body.length), body]);
}

/** The parts of an extrinsic in the shape of flop-sign.mjs sign, read leniently so a difference can be named; null where the bytes end. */
export function partsOf(b) {
  const p = {};
  const len = readCompact(b, 0);
  if (!len) return p;
  p.length = len.value; p.body_bytes = b.length - len.size;
  let o = len.size;
  const take = (n) => { if (o + n > b.length) return null; const s = b.subarray(o, o + n); o += n; return s; };
  const one = (k) => { const s = take(1); p[k] = s ? s[0] : null; return s; };
  if (!one("version") || !one("address_kind")) return p;
  const signer = take(32); if (!signer) return p; p.signer = hex(signer);
  if (!one("signature_kind")) return p;
  const sig = take(64); if (!sig) return p; p.signature = sig;
  if (o >= b.length) return p;
  p.era = b[o] === 0 ? "immortal" : `mortal (${hex(b.subarray(o, o + 2))})`;
  o += b[o] === 0 ? 1 : 2;
  const nonce = readCompact(b, o); if (!nonce) return p; p.nonce = nonce.value; o += nonce.size;
  const tip = readCompact(b, o); if (!tip) return p; p.tip = tip.value; o += tip.size;
  if (!one("metadata_mode")) return p;
  p.call = hex(b.subarray(o));
  return p;
}

/**
 * Refuses a research signer's signed file of an id unless its extrinsic is, byte for byte, the one
 * the plan's step makes (F1). The refusal names what differs: the signer, the nonce, the era, the
 * tip, the call, the length. Returns { extrinsic_hash } when it holds.
 */
export function checkResearchSigned(plan, results, id, signed, expected = expectedOf(plan, results, id)) {
  const where = `signed/${id}.json`;
  if (!signed || typeof signed.extrinsic !== "string" || !/^0x([0-9a-f]{2})+$/.test(signed.extrinsic)) no(`${where} has no extrinsic`);
  const b = Buffer.from(signed.extrinsic.slice(2), "hex");
  if (signed.extrinsic_hash !== blake2b256Hex(b)) no(`${where}: its extrinsic_hash ${signed.extrinsic_hash} is not the blake2b-256 of its extrinsic, ${blake2b256Hex(b)}`);
  const p = partsOf(b);
  if (!p.signature) no(`${where}: its extrinsic is not an envelope of flop-sign.mjs sign (it ends before the signature)`);
  const want = envelope({ ...expected, signature: p.signature });
  if (b.equals(want)) return { extrinsic_hash: signed.extrinsic_hash };
  const w = partsOf(want);
  const diffs = [];
  const say = (what, got, plan_) => diffs.push(`${what} is ${got ?? "missing"}, the plan's is ${plan_}`);
  if (p.version !== w.version) say("the version byte", p.version, w.version);
  if (p.address_kind !== w.address_kind) say("the address kind", p.address_kind, w.address_kind);
  if (p.signer !== w.signer) say("the signer", p.signer, `${w.signer}${plan.values.OWNER.value === w.signer ? " (OWNER)" : " (the device)"}`);
  if (p.signature_kind !== w.signature_kind) say("the signature kind", p.signature_kind, w.signature_kind);
  if (p.era !== w.era) say("the era", p.era, w.era);
  if (p.nonce !== w.nonce) say("the nonce", p.nonce, w.nonce);
  if (p.tip !== w.tip) say("the tip", p.tip, w.tip);
  if (p.metadata_mode !== w.metadata_mode) say("the metadata hash mode", p.metadata_mode, w.metadata_mode);
  if (p.call !== w.call) say("the call", p.call, w.call);
  if (p.length !== w.length || p.body_bytes !== Number(p.length)) diffs.push(`the length is ${p.length} with ${p.body_bytes} bytes after it, the plan's is ${w.length}`);
  if (!diffs.length) diffs.push("the bytes differ");
  no(`${where} is not the plan's ${id}, refused: ${diffs.join("; ")}`);
}
