// F2, F3 and F9: what stands between a signed file and a line that sends. The signed file is held to
// the call the record holds (F2); the send line is printed only for the send text the check took
// (F3); the signed file has exactly the fields flop-sign.mjs sign writes (F9). The plan's OWNER is a
// test key from a fixed seed in a copy held in memory. No network, no real key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, plan as realPlan, V, tempDir, testKey, writeRecord } from "./fixtures.mjs";
import { ss58, sha256Text } from "./lib.mjs";
import { RERUN } from "./rerun-node.mjs";
import { recordSigned } from "./record-step.mjs";
import { nextText } from "./plan.mjs";
import { started, step } from "./records.mjs";
import { callFile, sendFile, signedFile } from "./run.mjs";

const DIR = tempDir("g19-send-guard");
after(() => rmSync(DIR, { recursive: true, force: true }));
const owner = testKey(DIR, "guard-owner");
const plan = structuredClone(realPlan);
plan.values.OWNER.value = owner.public_key;
plan.values.OWNER_SS58.value = ss58(owner.public_key);
const DEV1 = RERUN.accounts.dev1.public_key;
const flopSign = (args) => JSON.parse(execFileSync(process.execPath, [join(REPO, plan.files.signer), ...args, "--libs", join(REPO, "imd-flop")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const CALL = flopSign(["call", "create-session", "--delegate", DEV1, "--cap", V("SPENDING_CAP"), "--per-tx", V("A_PER_TX"), "--daily", V("A_DAILY"), "--blocks", V("DURATION"), "--allow", V("ALLOW")]).call;
const OTHER = flopSign(["call", "revoke", "--delegate", DEV1]).call;
let n = 0;
const signed = ({ call = CALL, nonce = "5" } = {}) => {
  const out = join(DIR, `s${n++}.json`);
  flopSign(["sign", "--key", owner.path, "--call", call, "--nonce", nonce, "--out", out, "--spec", V("SPEC"), "--txv", V("TXV"), "--genesis", V("GENESIS")]);
  return readFileSync(out, "utf8");
};

/** A run folder at G1's sign: the record holds CALL as the tool's call; calls/G1.json holds callInFile. */
function atSign(callInFile = CALL) {
  const run = join(DIR, `run${n++}`);
  mkdirSync(join(run, "calls"), { recursive: true });
  mkdirSync(join(run, "signed"), { recursive: true });
  const r = step(started({ nonce: "5" }), "G1", { upTo: "call" });
  r.accounts.device.public_key = DEV1;
  r.steps[0].call.call_hex = CALL;
  writeRecord(run, r);
  writeFileSync(callFile(run, "G1"), JSON.stringify({ call: callInFile }) + "\n");
  return { run, r };
}

test("F2: the sign line names the call the record holds, and send-file refuses when calls/<id>.json is no longer it", async () => {
  const { run, r } = atSign(OTHER);
  const text = await nextText(plan, run, r);
  assert.match(text, new RegExp(`flop-sign\\.mjs" sign --key "\\$KEY_OWNER" --call ${CALL} `));
  writeFileSync(signedFile(run, "G1"), signed());
  const out = recordSigned(plan, run, r, "G1");
  assert.equal(out.sendText, null);
  assert.match(out.results.steps[0].signed_check.refused, /calls\/G1\.json holds 0x.*, not the call the record holds/);
  const same = atSign(CALL);
  writeFileSync(signedFile(same.run, "G1"), signed());
  assert.ok(recordSigned(plan, same.run, same.r, "G1").sendText, "the record's call in both places: the send file is written");
});

test("F3: send-file keeps the sha256 of the send text and the extrinsic's hash; plan.mjs next prints a send line only while the send file still has that sha256", async () => {
  const { run, r } = atSign();
  writeFileSync(signedFile(run, "G1"), signed());
  const s = recordSigned(plan, run, r, "G1");
  writeFileSync(sendFile(run, "G1"), s.sendText);
  const c = s.results.steps[0].signed_check;
  assert.equal(c.send_sha256, sha256Text(s.sendText));
  assert.equal(c.extrinsic_hash, JSON.parse(readFileSync(signedFile(run, "G1"), "utf8")).extrinsic_hash);
  const { nextOutput } = await import("./plan.mjs");
  const ok = await nextOutput(plan, run, s.results);
  assert.equal(ok.word, "NEXT");
  assert.match(ok.text, /lab\.send\(/);
  // the send file changed after the check: a stop, and no line that sends, at the send and at a wait
  writeFileSync(sendFile(run, "G1"), s.sendText.replace(/"\}/, "00\"}"));
  const bad = await nextOutput(plan, run, s.results);
  assert.equal(bad.word, "STOP");
  assert.equal(bad.exit, 3);
  assert.match(bad.text, /signed\/G1\.send\.json has sha256 [0-9a-f]{64}, not the send text the check took/);
  assert.doesNotMatch(bad.text, /lab\.send(Same)?\(|lab\.find\(/);
  const waiting = structuredClone(s.results);
  waiting.steps[0].run_time = { sent: { status: "not-found", sent_by: "find" }, sent_sha256: "00", earlier_readings: [] };
  const w = await nextOutput(plan, run, waiting);
  assert.equal(w.word, "STOP");
  assert.doesNotMatch(w.text, /lab\.send(Same)?\(/);
  rmSync(sendFile(run, "G1"));
  assert.match((await nextOutput(plan, run, s.results)).text, /signed\/G1\.send\.json is not in the run folder/);
});

test("F9: the signed file has exactly the fields flop-sign.mjs sign writes: one more or one less is refused", async () => {
  const { checkOwnerSigned, OwnerCallError, SIGNED_FIELDS } = await import("./owner-call.mjs");
  const good = JSON.parse(signed());
  assert.deepEqual(Object.keys(good).sort(), [...SIGNED_FIELDS].sort(), "the list is what the signer writes today");
  const results = { record: "run-time", owner_account_nonce_at_start: "5", accounts: { owner: { public_key: owner.public_key }, device: { public_key: DEV1 } }, steps: [] };
  assert.equal(checkOwnerSigned(plan, results, "G1", good, CALL).nonce, "5");
  for (const f of SIGNED_FIELDS) {
    const less = { ...good }; delete less[f];
    assert.throws(() => checkOwnerSigned(plan, results, "G1", less, CALL), (e) => e instanceof OwnerCallError && /not exactly those flop-sign\.mjs sign writes/.test(e.message), f);
  }
  assert.throws(() => checkOwnerSigned(plan, results, "G1", { ...good, note: "x" }, CALL), /its fields are .*note/);
});
