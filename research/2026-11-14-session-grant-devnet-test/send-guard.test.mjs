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
