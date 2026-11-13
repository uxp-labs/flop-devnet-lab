// Review 3, attack A: the research signer's file (V1). Real files made with flop-sign.mjs sign and
// test keys made here in a temporary folder, then changed. The plan's OWNER is the test owner key in
// a copy of steps.json held in memory. No network. No source file is changed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO, blake2b256Hex } from "./lib.mjs";
import { checkResearchSigned, expectedOf, nonceOf, callOf, compact, readCompact, ResearchSignedError } from "./research-signed.mjs";
import { recordProblems } from "./judge.mjs";
import { plan as realPlan, V, asPlanned, tempDir, sent, explored, errorOf } from "./fixtures.mjs";

const DIR = tempDir("review3-research-signed");
after(() => rmSync(DIR, { recursive: true, force: true }));
const SIGNER = join(REPO, realPlan.files.signer), LIBS = join(REPO, "imd-flop");
const flopSign = (...args) => execFileSync(process.execPath, [SIGNER, ...args, "--libs", LIBS], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const keygen = (name) => JSON.parse(flopSign("keygen", "--out", join(DIR, `${name}.json`))).public_key;
const OWNER_T = keygen("owner"), DEVICE_T = keygen("device");
const KEYS = { [OWNER_T]: join(DIR, "owner.json"), [DEVICE_T]: join(DIR, "device.json") };
const plan = structuredClone(realPlan);
plan.values.OWNER.value = OWNER_T;
const errors = JSON.parse(readFileSync(join(REPO, "research/2026-11-12-session-rerun-1014020/errors-1014020.json"), "utf8"));
let n = 0;
function signWith(pub, call, nonce) {
  const out = join(DIR, `signed-${n++}.json`);
  flopSign("sign", "--key", KEYS[pub], "--call", call, "--nonce", String(nonce), "--out", out, "--spec", V("SPEC"), "--txv", V("TXV"), "--genesis", V("GENESIS"));
  return JSON.parse(readFileSync(out, "utf8"));
}
const before = (upTo) => { const r = asPlanned(DEVICE_T, upTo).results; r.accounts.owner.public_key = OWNER_T; return r; };
const bytesOf = (f) => Buffer.from(f.extrinsic.slice(2), "hex");
const withBytes = (b) => ({ extrinsic: "0x" + Buffer.from(b).toString("hex"), extrinsic_hash: blake2b256Hex(b) });
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof ResearchSignedError && re.test(e.message), re.toString());

const r2 = before("T1");
const w2 = expectedOf(plan, r2, "T2");
const T2 = signWith(w2.signer, w2.call, w2.nonce);

/** Offsets in flop-sign's envelope: length prefix, then 0x84 0x00, signer 32, kind 1, signature 64, era 1, then the nonce. */
function split(b) {
  const len = readCompact(b, 0);
  const body = b.subarray(len.size);
  const nonceAt = 2 + 32 + 1 + 64 + 1;
  const nonce = readCompact(body, nonceAt);
  return { len, body, nonceAt, nonce };
}

test("review3 A HELD: the plan's T2 from flop-sign passes", () => {
  assert.deepEqual(checkResearchSigned(plan, r2, "T2", T2), { extrinsic_hash: T2.extrinsic_hash });
});

test("review3 A HELD: the nonce in a longer compact mode than needed is refused", () => {
  const { body, nonceAt, nonce } = split(bytesOf(T2));
  assert.equal(nonce.size, 1);
  const long = Buffer.alloc(2); long.writeUInt16LE((Number(nonce.value) << 2) | 1);
  assert.equal(readCompact(long, 0).value, nonce.value, "the same nonce, read back");
  const nb = Buffer.concat([body.subarray(0, nonceAt), long, body.subarray(nonceAt + 1)]);
  refused(() => checkResearchSigned(plan, r2, "T2", withBytes(Buffer.concat([compact(nb.length), nb]))), /not the plan's T2/);
});

test("review3 A HELD: a length prefix in a longer compact mode with the same body is refused", () => {
  const { len, body } = split(bytesOf(T2));
  assert.equal(len.size, 2);
  const long = Buffer.alloc(4); long.writeUInt32LE((body.length << 2) | 2);
  assert.equal(readCompact(long, 0).value, BigInt(body.length));
  refused(() => checkResearchSigned(plan, r2, "T2", withBytes(Buffer.concat([long, body]))), /not the plan's T2/);
});

test("review3 A HELD: an extrinsic_hash that is right for other bytes is refused", () => {
  const other = signWith(w2.signer, w2.call, w2.nonce + 1n);
  refused(() => checkResearchSigned(plan, r2, "T2", { ...T2, extrinsic_hash: other.extrinsic_hash }), /is not the blake2b-256 of its extrinsic/);
});

test("review3 A HELD: a file whose extrinsic is right while every other field lies passes, and the decision reads only the bytes", () => {
  const lie = { ...T2, signer: DEVICE_T, account_nonce: "99", tip: "5", era: "mortal", call: "0x0000", what: "a transfer" };
  assert.deepEqual(checkResearchSigned(plan, r2, "T2", lie), { extrinsic_hash: T2.extrinsic_hash });
  const wrongBytes = { ...signWith(w2.signer, w2.call, w2.nonce + 1n), account_nonce: String(w2.nonce) };
  refused(() => checkResearchSigned(plan, r2, "T2", wrongBytes), /the nonce is 16, the plan's is 15/);
});

test("review3 A HELD: the nonce the plan gives an attempt and the sweep after attempts", () => {
  // T8 included and refused at dispatch: T8.2 counts it
  const r8 = before("T7");
  sent(r8, "T8", { block: 3700000 });
  explored(r8, "T8", { success: false, error: errorOf(errors, "FlopSessionKeys.SessionNotFound") });
  assert.equal(nonceOf(plan, r8, "T8.2"), nonceOf(plan, r8, "T8") + 1n);
  assert.equal(nonceOf(plan, r8, "T8"), BigInt(V("OWNER_NONCE_AFTER_RERUN")) + 2n, "T8's own nonce is not counted with it");
  // T8 refused at submission (not in a block): T8.2 would have T8's nonce
  const r8s = before("T7");
  sent(r8s, "T8", { status: "refused-at-submission" });
  assert.equal(nonceOf(plan, r8s, "T8.2"), nonceOf(plan, r8s, "T8"));
  // T9 after T6 refused at dispatch and T6.2 included: six device transactions
  const r9 = before("T8");
  const t6 = r9.steps.find((s) => s.step === "T6");
  r9.steps.splice(r9.steps.indexOf(t6) + 1, 0, structuredClone({ ...t6, step: "T6.2" }));
  assert.equal(nonceOf(plan, r9, "T9"), 6n);
  assert.equal(nonceOf(plan, r9, "T9.2"), 6n, "T9 not yet in a block");
});

test("review3 A HELD: an owner step recorded twice breaks the record, so nextOf stops before any nonce is used", () => {
  const r = before("T2");
  r.steps.push(structuredClone(r.steps.find((s) => s.step === "T1")));
  assert.ok(recordProblems(plan, r).some((p) => /holds T1 twice/.test(p.problem)));
});

test("review3 A HELD: a device key in the record that begins with -- does not reach flop-sign as a flag that takes effect: callOf refuses", () => {
  const r = before("T1");
  r.accounts.device.public_key = "--amount";
  assert.throws(() => callOf(plan, r, plan.steps.find((s) => s.id === "T1")));
  r.accounts.device.public_key = "--libs";
  assert.throws(() => callOf(plan, r, plan.steps.find((s) => s.id === "T1")));
});

test("review3 A info: expectedOf for an owner step takes the device of the call ($DEVICE) from the record unchecked; only T9 checks the device is a 32 byte key", () => {
  const r = before("T1");
  r.accounts.device.public_key = "0x" + "ab".repeat(32);
  assert.match(callOf(plan, r, plan.steps.find((s) => s.id === "T1")), /abababab/);
});
