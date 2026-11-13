// Tests of research-signed.mjs (F1): an extrinsic that our research signer made with a test key for
// each of T1, T2, T8 and T9 passes, and each single change is refused. No network. The keys are
// made here in a temporary folder by flop-sign.mjs keygen. The plan's OWNER is set to the test
// owner key in a copy of steps.json held in memory: no real key is used.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO, blake2b256Hex } from "./lib.mjs";
import { checkResearchSigned, expectedOf, compact, readCompact, ResearchSignedError } from "./research-signed.mjs";
import { plan as realPlan, V, asPlanned, tempDir } from "./fixtures.mjs";

const DIR = tempDir("research-signed-test");
after(() => rmSync(DIR, { recursive: true, force: true }));
const SIGNER = join(REPO, realPlan.files.signer), LIBS = join(REPO, "imd-flop");
const flopSign = (...args) => execFileSync(process.execPath, [SIGNER, ...args, "--libs", LIBS], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const keygen = (name) => JSON.parse(flopSign("keygen", "--out", join(DIR, `${name}.json`))).public_key;
const OWNER_T = keygen("owner"), DEVICE_T = keygen("device");
const KEYS = { [OWNER_T]: join(DIR, "owner.json"), [DEVICE_T]: join(DIR, "device.json") };
const plan = structuredClone(realPlan);
plan.values.OWNER.value = OWNER_T;
let n = 0;

/** What flop-sign.mjs sign writes for a call, a nonce and a key: the signed file, read back. */
function signWith(pub, call, nonce) {
  const out = join(DIR, `signed-${n++}.json`);
  flopSign("sign", "--key", KEYS[pub], "--call", call, "--nonce", String(nonce), "--out", out, "--spec", V("SPEC"), "--txv", V("TXV"), "--genesis", V("GENESIS"));
  return JSON.parse(readFileSync(out, "utf8"));
}
/** A record as planned before an id: the run up to the step before it. */
const before = (id) => {
  const ids = plan.steps.map((s) => s.id);
  const r = asPlanned(DEVICE_T, ids[ids.indexOf(id) - 1]).results;
  r.accounts.owner.public_key = OWNER_T;
  return r;
};
/** A signed file whose extrinsic is given bytes, with its hash made right. */
const withBytes = (b) => ({ extrinsic: "0x" + Buffer.from(b).toString("hex"), extrinsic_hash: blake2b256Hex(b) });
const bytesOf = (f) => Buffer.from(f.extrinsic.slice(2), "hex");
/** The extrinsic with its body changed and its length prefix made right. */
const rebody = (f, change) => { const b = bytesOf(f); const len = readCompact(b, 0); const body = change(Buffer.from(b.subarray(len.size))); return withBytes(Buffer.concat([compact(body.length), body])); };
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof ResearchSignedError && re.test(e.message), re.toString());

const CASES = ["T1", "T2", "T8", "T9"];
const made = {};
for (const id of CASES) {
  const r = before(id);
  const want = expectedOf(plan, r, id);
  made[id] = { r, want, file: signWith(want.signer, want.call, want.nonce) };
}

test("F1: what the plan expects: OWNER and the start nonce plus the owner's included transactions; T9: the device and its included transactions", () => {
  assert.equal(made.T1.want.signer, OWNER_T);
  assert.equal(made.T1.want.nonce, 14n);
  assert.equal(made.T2.want.nonce, 15n);
  assert.equal(made.T8.want.nonce, 16n);
  assert.equal(made.T9.want.signer, DEVICE_T);
  assert.equal(made.T9.want.nonce, 5n, "T3 to T7 are the device's five transactions");
  assert.match(made.T1.want.call, /^0x040300/);
});

for (const id of CASES) {
  test(`F1: ${id} as flop-sign.mjs sign made it with a test key passes`, () => {
    const { r, want, file } = made[id];
    assert.deepEqual(checkResearchSigned(plan, r, id, file, want), { extrinsic_hash: file.extrinsic_hash });
    assert.deepEqual(checkResearchSigned(plan, r, id, file), { extrinsic_hash: file.extrinsic_hash }, "with the call from the research signer run here");
  });
}

test("F1: another signer is refused, and the device's key on an owner step", () => {
  const { r, want } = made.T2;
  const other = keygen("other");
  KEYS[other] = join(DIR, "other.json");
  refused(() => checkResearchSigned(plan, r, "T2", signWith(other, want.call, want.nonce), want), /the signer is 0x/);
  refused(() => checkResearchSigned(plan, r, "T2", signWith(DEVICE_T, want.call, want.nonce), want), new RegExp(`the signer is ${DEVICE_T}, the plan's is ${OWNER_T} \\(OWNER\\)`));
  refused(() => checkResearchSigned(plan, made.T9.r, "T9", signWith(OWNER_T, made.T9.want.call, made.T9.want.nonce), made.T9.want), /the signer is .*the device/);
});

test("F1: a nonce one too high and one too low is refused", () => {
  for (const id of ["T1", "T9"]) {
    const { r, want } = made[id];
    refused(() => checkResearchSigned(plan, r, id, signWith(want.signer, want.call, want.nonce + 1n), want), new RegExp(`the nonce is ${want.nonce + 1n}, the plan's is ${want.nonce}`));
    refused(() => checkResearchSigned(plan, r, id, signWith(want.signer, want.call, want.nonce - 1n), want), new RegExp(`the nonce is ${want.nonce - 1n}, the plan's is ${want.nonce}`));
  }
});

test("F1: a mortal era, a tip and a byte added at the end are refused", () => {
  const { r, want, file } = made.T1;
  const ERA = 1 + 1 + 32 + 1 + 64; // version, address kind, signer, signature kind, signature
  refused(() => checkResearchSigned(plan, r, "T1", rebody(file, (b) => Buffer.concat([b.subarray(0, ERA), Buffer.of(0x15, 0x01), b.subarray(ERA + 1)])), want), /the era is mortal \(0x1501\), the plan's is immortal/);
  const nonceSize = readCompact(bytesOf(file), readCompact(bytesOf(file), 0).size + ERA + 1).size;
  const TIP = ERA + 1 + nonceSize;
  refused(() => checkResearchSigned(plan, r, "T1", rebody(file, (b) => Buffer.concat([b.subarray(0, TIP), compact(5), b.subarray(TIP + 1)])), want), /the tip is 5, the plan's is 0/);
  refused(() => checkResearchSigned(plan, r, "T1", withBytes(Buffer.concat([bytesOf(file), Buffer.of(0)])), want), /the length is \d+ with \d+ bytes after it/);
  refused(() => checkResearchSigned(plan, r, "T1", rebody(file, (b) => Buffer.concat([b, Buffer.of(0)])), want), /the call is 0x/);
});

test("F1: another amount and another call are refused", () => {
  const { r, want } = made.T1;
  const call = JSON.parse(flopSign("call", "transfer", "--to", DEVICE_T, "--amount", String(BigInt(V("FUND")) + 1n))).call;
  refused(() => checkResearchSigned(plan, r, "T1", signWith(OWNER_T, call, want.nonce), want), /the call is 0x0403/);
  refused(() => checkResearchSigned(plan, r, "T1", signWith(OWNER_T, made.T8.want.call, want.nonce), want), /the call is 0x5e01/);
});

test("F1: an extrinsic_hash that is not the blake2b-256 of the extrinsic is refused, and a file with no extrinsic", () => {
  const { r, want, file } = made.T8;
  refused(() => checkResearchSigned(plan, r, "T8", { ...file, extrinsic_hash: "0x" + "00".repeat(32) }, want), /is not the blake2b-256 of its extrinsic/);
  refused(() => checkResearchSigned(plan, r, "T8", { what: "x" }, want), /has no extrinsic/);
  refused(() => checkResearchSigned(plan, r, "T8", withBytes(Buffer.of(4, 0x84, 0, 1)), want), /ends before the signature/);
});

test("F1: the signature is not checked: the plan's bytes with another signature pass, as the file says", () => {
  const { r, want, file } = made.T2;
  const b = bytesOf(file);
  const at = readCompact(b, 0).size + 35;
  const changed = Buffer.from(b); changed[at] ^= 0xff;
  assert.ok(checkResearchSigned(plan, r, "T2", withBytes(changed), want));
  assert.match(readFileSync(new URL("./research-signed.mjs", import.meta.url), "utf8"), /a wrong signature is refused by the node at no cost/);
});

test("F1: the nonce of an attempt counts the refused step before it, and not the id itself", () => {
  const r = before("T9");
  assert.equal(expectedOf(plan, r, "T8").nonce, 16n);
  const withT8 = asPlanned(DEVICE_T, "T8").results;
  assert.equal(expectedOf(plan, withT8, "T8").nonce, 16n, "T8 itself is not counted");
  assert.equal(expectedOf(plan, withT8, "T8.2").nonce, 17n);
});

test("F1: send-file checks before it writes, and record-step step before it records: a nonce one too high is refused and nothing is written", async () => {
  const { spawnSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { runFolder, startedRecord, planSigned, relay } = await import("./fixtures.mjs");
  const { sha256Text } = await import("./lib.mjs");
  const run = runFolder(startedRecord("0x" + "d1".repeat(32)));
  const f = planSigned(run, "T1", startedRecord("0x" + "d1".repeat(32)), { nonce: 15n });
  const rs = (...a) => spawnSync(process.execPath, [join(REPO, "research", "2026-11-12-encoder-devnet-test", "record-step.mjs"), ...a, "--run", run], { encoding: "utf8" });
  const out = rs("send-file", "T1");
  assert.equal(out.status, 2);
  assert.match(out.stderr, /signed\/T1.json is not the plan's T1, refused: the nonce is 15, the plan's is 14/);
  assert.equal(existsSync(join(run, "signed", "T1.send.json")), false);
  const send = JSON.stringify({ step: "T1", extrinsic: f.extrinsic });
  const s = relay({ step: null, bundle_sha256: sha256Text(send), extrinsic_sha256: sha256Text(f.extrinsic), status: "deadline" });
  const step = rs("step", "T1", "--sent", s.text, "--sent-sha256", s.sha);
  assert.equal(step.status, 2);
  assert.match(step.stderr, /the nonce is 15, the plan's is 14/);
});
