// Review 2 (Q3, Q7): what record-step.mjs takes into the run folder and the record. No network.
// The device key is made here in a temporary folder. The research signer's signed files are stand
// ins written here, in the shape flop-sign.mjs sign writes (research/2026-11-11-session-deny-list/
// flop-sign.mjs, the sign command): no owner key is used and nothing is signed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, RERUN, readJson, sha256Text, ss58, fromSs58 } from "./lib.mjs";
import { loadDeviceSigner } from "./device-key.mjs";
import { explorerReading } from "./record-step.mjs";
import { nextOf } from "./judge.mjs";
import { plan, V, H, makeKey, tempDir, relay, asPlanned, runFolder } from "./fixtures.mjs";

const DIR = tempDir("review2-record");
after(() => rmSync(DIR, { recursive: true, force: true }));
const { path: KEY } = makeKey(DIR);
const DEVICE = "0x" + Buffer.from(loadDeviceSigner(KEY).publicKey).toString("hex");
const errors = readJson(join(RERUN, "errors-1014020.json"));
const node = (args) => spawnSync(process.execPath, [join(HERE, "record-step.mjs"), ...args], { encoding: "utf8", cwd: DIR });

/**
 * A stand in of signed/T2.json that is wrong in every field the plan fixes: signed by the device
 * (T2 is the owner's), with an account nonce that leaves a gap (the plan's is the start nonce plus
 * one), and with the call of a transfer (T2 is create-session). The extrinsic bytes are made up.
 */
function wrongT2(run) {
  const xt = "0x" + sha256Text(`wrong T2 ${run}`).repeat(4);
  const file = {
    what: "Balances.transfer_keep_alive: 999 raw to the device", signer: DEVICE, signer_ss58: ss58(DEVICE), account_nonce: "99", tip: "0", era: "immortal",
    spec_version: Number(V("SPEC")), transaction_version: Number(V("TXV")), genesis: V("GENESIS"),
    call: "0x0403" + DEVICE.slice(2) + "1d0f", extrinsic: xt, extrinsic_hash: "0x" + sha256Text(xt),
  };
  writeFileSync(join(run, "signed", "T2.json"), JSON.stringify(file, null, 2) + "\n");
  return file;
}

test("review2 Q7 DEFECT: send-file writes the send file of a signed/T2.json signed by the device, with a nonce gap and the call of a transfer", () => {
  const run = runFolder(asPlanned(DEVICE, "T1").results);
  wrongT2(run);
  const out = node(["send-file", "T2", "--run", run]);
  assert.notEqual(out.status, 0, `send-file took a T2 file the plan does not make and printed a send file for the pane:\n${out.stdout}`);
});

test("review2 Q7 DEFECT: record-step records that wrong T2 as included in a finalized block", () => {
  const run = runFolder(asPlanned(DEVICE, "T1").results);
  const f = wrongT2(run);
  const send = JSON.stringify({ step: "T2", extrinsic: f.extrinsic });
  writeFileSync(join(run, "signed", "T2.send.json"), send); // what send-file writes, so the step is reached even if send-file is fixed
  const sent = relay({ step: null, bundle_sha256: sha256Text(send), extrinsic_sha256: sha256Text(f.extrinsic), extrinsic_hash: null, statuses: ["ready", "finalized"], status: "finalized", block_hash: H(3600006), block_number: 3600006, extrinsic_index: 2, events_sha256: "ab".repeat(32), events_length: 700 });
  const out = node(["step", "T2", "--run", run, "--sent", sent.text, "--sent-sha256", sent.sha]);
  assert.notEqual(out.status, 0, `record-step recorded a T2 whose signer, nonce and call are not the plan's:\n${out.stdout}`);
});

// ---- the explorer's reading -----------------------------------------------------------------

const HASH_X = "0x" + "ab".repeat(32), BLOCK_X = H(3600006);
const rt = { extrinsic_hash: HASH_X, sent: { status: "finalized", block_hash: BLOCK_X } };
const reading = (o) => ({ source: `${V("EXPLORER")}/api/transactions/${HASH_X}`, read_utc: "2026-11-13T03:00:00.000Z", hash: HASH_X, block_hash: BLOCK_X, success: true, error: null, names: ["system.ExtrinsicSuccess"], events: [], ...o });
const T1 = plan.steps.find((s) => s.id === "T1");

test("review2 Q3 DEFECT: an explorer reading that says success while its last event is system.ExtrinsicFailed is recorded as success", () => {
  let r = null, why = null;
  try { r = explorerReading(plan, T1, rt, reading({ success: true, names: ["balances.Withdraw", "system.ExtrinsicFailed"] }), "55".repeat(32), errors, null); } catch (e) { why = e.message; }
  assert.equal(r, null, `recorded as success: ${JSON.stringify(r?.names)} success ${r?.success}`);
  assert.ok(why);
});

test("review2 Q3 DEFECT: an explorer reading that says refused while its events hold system.ExtrinsicSuccess is recorded as refused", () => {
  let r = null;
  try { r = explorerReading(plan, T1, rt, reading({ success: false, error: { index: 94, error: 20 }, names: ["system.ExtrinsicSuccess"] }), "55".repeat(32), errors, null); } catch { r = null; }
  assert.equal(r, null, `recorded as refused with ${r?.error?.name} beside ExtrinsicSuccess`);
});

test("review2 Q3 DEFECT: a run time record whose explorer reading says success beside ExtrinsicFailed lets the judge go on past T1", () => {
  const { results } = asPlanned(DEVICE, "T1");
  results.steps.find((s) => s.step === "T1").run_time.explorer.names = ["Balances.Transfer", "System.ExtrinsicFailed"];
  const n = nextOf(plan, results);
  assert.notEqual(n.step, "T2", `the judge says ${n.word} ${n.step}: ${n.why}`);
});

test("review2 Q3 low: an SS58 text with a leading 1 is not the account's SS58, yet fromSs58 turns it into the account", () => {
  const owner = ss58(V("OWNER"));
  assert.equal(fromSs58(owner), V("OWNER")); // control
  assert.equal(fromSs58("1" + owner), null, "a non canonical SS58 text becomes the owner's account in the record");
});
