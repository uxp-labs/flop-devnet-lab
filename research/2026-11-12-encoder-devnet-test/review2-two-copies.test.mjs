// Review 2 (Q1, attack A): the lead's bad minutes, played through sign-device.mjs with a test key made
// here in a temporary folder. No network, nothing is sent. The record is written as record-step.mjs
// writes it (fixtures.mjs). Tests named HELD show a rule that held; DEFECT tests fail on e18e725.
// Every second copy the tools sign must carry the first copy's account nonce, so the chain can take
// one of them at most.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./lib.mjs";
import { loadDeviceSigner } from "./device-key.mjs";
import { makeKey, tempDir, deviceReads, asPlanned, runFolder, sent } from "./fixtures.mjs";

const DIR = tempDir("review2-two-copies");
after(() => rmSync(DIR, { recursive: true, force: true }));
const { path: KEY } = makeKey(DIR);
const DEVICE = "0x" + Buffer.from(loadDeviceSigner(KEY).publicKey).toString("hex");
const BIRTH = 3600010;
const sign = (run, id, reads, again = false) => spawnSync(process.execPath, [join(HERE, "sign-device.mjs"), id, "--run", run, "--key", KEY, "--reads", reads.text, "--reads-sha256", reads.sha, ...(again ? ["--again"] : [])], { encoding: "utf8", cwd: DIR });
const signed = (run, id) => JSON.parse(readFileSync(join(run, "signed", `${id}.json`), "utf8"));
const results = (run) => JSON.parse(readFileSync(join(run, "results.json"), "utf8"));
const save = (run, r) => writeFileSync(join(run, "results.json"), JSON.stringify(r, null, 1) + "\n");

/** A run through T2, with T3's first copy A signed from reads at BIRTH (nonce 0). */
function firstCopy() {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  const out = sign(run, "T3", deviceReads(DEVICE, { number: BIRTH, accountNonce: 0 }));
  assert.equal(out.status, 0, out.stderr);
  return { run, a: signed(run, "T3") };
}
/** Records a runner reading of T3's copy A with a status, as record-step step --sent does. */
function recordT3(run, status) { const r = results(run); sent(r, "T3", { status }); save(run, r); }
const refused = (out, re) => { assert.equal(out.status, 2, `signed: ${out.stdout}`); if (re) assert.match(out.stderr, re); };

for (const status of ["deadline", "connection-lost", "ended"]) {
  test(`review2 Q1 HELD: ${status}, copy A still in the pool: no second copy, with or without --again, old or fresh reads`, () => {
    const { run, a } = firstCopy();
    recordT3(run, status);
    const last = a.era.last_valid_block;
    refused(sign(run, "T3", deviceReads(DEVICE, { number: last + 1, accountNonce: 1 })), /not next/); // without --again
    refused(sign(run, "T3", deviceReads(DEVICE, { number: last + 1, accountNonce: 1 }), true), /in the pool or on chain/); // A in the pool: S2e
    refused(sign(run, "T3", deviceReads(DEVICE, { number: BIRTH, accountNonce: 0 }), true), /era is not over/); // the old reads again
    refused(sign(run, "T3", deviceReads(DEVICE, { number: last, accountNonce: 0 }), true), /era is not over/); // one block short
    refused(sign(run, "T4", deviceReads(DEVICE, { number: last + 1, accountNonce: 1, sessionNonce: 1 })), /not next/); // the next step
  });
}

test("review2 Q1 HELD: refused at submission, then --again after the era: the second copy has the first copy's nonce", () => {
  const { run, a } = firstCopy();
  recordT3(run, "refused-at-submission");
  const out = sign(run, "T3", deviceReads(DEVICE, { number: a.era.last_valid_block + 1, accountNonce: 0, hash: "0x" + "ce".repeat(32) }), true); // a new block has a new hash
  assert.equal(out.status, 0, out.stderr);
  const b = signed(run, "T3");
  assert.equal(b.account_nonce, a.account_nonce);
  assert.notEqual(b.extrinsic_hash, a.extrinsic_hash);
  assert.deepEqual(b.earlier_copies.map((c) => c.extrinsic_hash), [a.extrinsic_hash]);
  assert.ok(existsSync(join(run, "signed", "T3.dead-1.json")) && existsSync(join(run, "signed", "T3.dead-1.send.json")));
});

test("review2 Q1 HELD: copy A included and not recorded: the device's nonce refuses a second copy and the next step", () => {
  const { run, a } = firstCopy();
  recordT3(run, "deadline");
  refused(sign(run, "T3", deviceReads(DEVICE, { number: a.era.last_valid_block + 5, accountNonce: 1, sessionNonce: 1 }), true), /in the pool or on chain/);
});

test("review2 Q1 HELD: copy A never sent and nothing recorded: no second copy before its era is over, then one of the same nonce", () => {
  const { run, a } = firstCopy();
  refused(sign(run, "T3", deviceReads(DEVICE, { number: a.era.last_valid_block + 1, accountNonce: 0 })), /never replaced/);
  refused(sign(run, "T3", deviceReads(DEVICE, { number: a.era.last_valid_block, accountNonce: 0 }), true), /era is not over/);
  const out = sign(run, "T3", deviceReads(DEVICE, { number: a.era.last_valid_block + 1, accountNonce: 0 }), true);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(signed(run, "T3").account_nonce, a.account_nonce);
});

test("review2 Q1 HELD: T3 finalized, the explorer has no entry yet: neither T4 nor a second T3 is signed", () => {
  const { results: r } = asPlanned(DEVICE, "T3");
  r.steps.find((s) => s.step === "T3").run_time.explorer = null;
  const run = runFolder(r);
  refused(sign(run, "T4", deviceReads(DEVICE, { number: 3600100, accountNonce: 1, sessionNonce: 1 })), /explorer reading/);
  refused(sign(run, "T3", deviceReads(DEVICE, { number: 3600100, accountNonce: 1 }), true), /not next|never signed again/);
});

test("review2 Q1 HELD: the reads of T3 used again for T4 are refused by the nonce", () => {
  const { results: r } = asPlanned(DEVICE, "T3");
  const run = runFolder(r);
  refused(sign(run, "T4", deviceReads(DEVICE, { number: BIRTH, accountNonce: 0 })), /next nonce is 0/);
});

test("review2 Q1 HELD: a stop after a crash between the two renames of retire leaves no tool that signs (A's send file still beside no signed file)", () => {
  const { run } = firstCopy();
  recordT3(run, "deadline");
  renameSync(join(run, "signed", "T3.json"), join(run, "signed", "T3.dead-1.json")); // the first rename done, then the stop
  const fresh = deviceReads(DEVICE, { number: BIRTH + 64, accountNonce: 0 });
  refused(sign(run, "T3", fresh));
  refused(sign(run, "T3", fresh, true), /no earlier copy/);
});

test("review2 Q3 DEFECT: a stop after both renames of retire, with nothing recorded, lets T3 be signed without --again and the new record forgets copy A", () => {
  const { run, a } = firstCopy(); // A never sent (not-sent records nothing)
  renameSync(join(run, "signed", "T3.json"), join(run, "signed", "T3.dead-1.json"));
  renameSync(join(run, "signed", "T3.send.json"), join(run, "signed", "T3.dead-1.send.json")); // both renames done, then the stop
  const out = sign(run, "T3", deviceReads(DEVICE, { number: a.era.last_valid_block + 1, accountNonce: 0 })); // no --again
  if (out.status !== 0) return; // a refusal is a fix
  const b = signed(run, "T3");
  assert.deepEqual((b.earlier_copies ?? []).map((c) => c.extrinsic_hash), [a.extrinsic_hash], "signed/T3.json no longer names copy A, whose files are still in signed/");
});
