// Tests of plan.mjs next (R4) and of record-step.mjs send-file: node --test in this folder. No
// network, no key: the records are the fixtures' run time records.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, REPO, RERUN, readJson, sessionNonceKey, sha256Text, ss58 } from "./lib.mjs";
import { nextText } from "./plan.mjs";
import { plan, V, asPlanned, runFolder, sent, startedRecord, tempDir, planSigned } from "./fixtures.mjs";

const DIR = tempDir("plan-next-test");
after(() => rmSync(DIR, { recursive: true, force: true }));
const DEVICE = "0x" + "d4".repeat(32);
const errors = readJson(join(RERUN, "errors-1014020.json"));
const next = (results) => { const run = runFolder(results); return { run, text: nextText(plan, run, results) }; };
const cli = (args) => spawnSync(process.execPath, [join(HERE, "plan.mjs"), ...args], { encoding: "utf8" });

test("R4: at the start, the next lines are T1's with every value filled: the device's account, the owner's start nonce, the run folder", () => {
  const { run, text } = next(startedRecord(DEVICE));
  assert.match(text, /^# T1: owner signs/m);
  assert.match(text, new RegExp(`call transfer --to ${DEVICE} --amount ${V("FUND")}`));
  assert.match(text, new RegExp(`--nonce 14 --out "${run}/signed/T1.json"`));
  assert.match(text, new RegExp(`send-file T1 --run "${run}"`));
  assert.match(text, new RegExp(`record-step.mjs" step T1 --run "${run}" --sent`));
  assert.doesNotMatch(text, /# T2/, "only what the lead does next");
  assert.doesNotMatch(text, /\$DEVICE|\$RUN|\$\(\(OWNER_NONCE/, "no placeholder is left");
  const viaCli = cli(["next", "--run", run]);
  assert.equal(viaCli.status, 0, viaCli.stderr);
  assert.equal(viaCli.stdout, text);
});

test("R4: the owner's nonce is the start nonce plus the owner transactions the record holds as included", () => {
  const r = asPlanned(DEVICE, "T7").results;
  r.owner_account_nonce_at_start = "20";
  const { text } = next(r);
  assert.match(text, /^# T8: owner/m);
  assert.match(text, /--nonce 22 /);
  assert.match(text, new RegExp(`revoke --delegate ${DEVICE}`));
});

test("R4: a device step's lines: the device's reads with its SS58 address and the session nonce key, sign-device in the run folder, the send, the record, the explorer", () => {
  const { run, text } = next(asPlanned(DEVICE, "T2").results);
  assert.match(text, /^# T3: device signs with the encoder/m);
  assert.match(text, new RegExp(`lab\\.deviceReads\\("${ss58(DEVICE)}", "${sessionNonceKey(plan, V("OWNER"), DEVICE)}"\\)`));
  assert.match(text, new RegExp(`sign-device.mjs" T3 --run "${run}" --key "\\$KEY_DEVICE" --reads '<relay>' --reads-sha256 <relay_sha256>`));
  assert.match(text, /window\.__s = lab\.send\(/);
  assert.match(text, /explorer\.read\(/);
});

test("R4: the session nonce key is the one the research signer's keys command prints", () => {
  const r = spawnSync(process.execPath, [join(REPO, "research/2026-11-11-session-deny-list/flop-sign.mjs"), "keys", "--libs", join(REPO, "imd-flop"), "--owner", V("OWNER"), "--delegate", DEVICE], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sessionNonceKey(plan, V("OWNER"), DEVICE), JSON.parse(r.stdout).session_nonce);
});

test("R4: T6 and T7 say the block their birth must be above; T9's nonce is the device's count", () => {
  const t5 = asPlanned(DEVICE, "T5");
  assert.match(next(t5.results).text, new RegExp(`# T6 is signed only from a birth block above ${t5.blocks.T3 + 600}`));
  const t8 = asPlanned(DEVICE, "T8").results;
  const { text } = next(t8);
  assert.match(text, /^# T9: device signs with the research-signer/m);
  assert.match(text, /--nonce 5 /, "T3 to T7: five device transactions");
  assert.match(text, /--key "\$KEY_DEVICE"/);
});

test("R4: a wait for the explorer's reading prints the explorer line of that step only", () => {
  const r = asPlanned(DEVICE, "T3").results;
  const t3 = r.steps.find((s) => s.step === "T3");
  t3.run_time.explorer = null;
  const { text } = next(r);
  assert.match(text, /^# wait: the explorer reading of T3/m);
  assert.match(text, new RegExp(`explorer\\.read\\("${t3.run_time.extrinsic_hash}"\\)`));
  assert.doesNotMatch(text, /sign-device/);
});

test("R4: a wait for a step's inclusion prints find from its birth block, then the second copy of S4 for a mortal step and sendSame for an immortal one", () => {
  const r = asPlanned(DEVICE, "T2").results;
  sent(r, "T3", { status: "deadline" });
  const run = runFolder(r);
  writeFileSync(join(run, "signed", "T3.json"), JSON.stringify({ step: "T3", extrinsic: "0xabcd", era: { birth_number: 3600010, last_valid_block: 3600073 } }));
  const text = nextText(plan, run, r);
  assert.match(text, /^# wait: T3 is sent and not in a finalized block \(the runner said deadline\)/m);
  assert.match(text, /lab\.find\("0xabcd", 3600010\)/);
  assert.match(text, /finalized head is above 3600073/);
  assert.match(text, /sign-device.mjs" T3 .* --again/);
  const o = startedRecord(DEVICE);
  sent(o, "T1", { status: "connection-lost" });
  const run2 = runFolder(o);
  writeFileSync(join(run2, "signed", "T1.json"), JSON.stringify({ extrinsic: "0xbeef" }));
  const t2 = nextText(plan, run2, o);
  assert.match(t2, /lab\.find\("0xbeef", 3599990\)/, "an immortal step is looked for from the start of the run");
  assert.match(t2, /lab\.sendSame\(/);
  assert.doesNotMatch(t2, /--again|flop-sign.mjs" sign/, "an immortal step is never signed to different bytes");
});

test("R4: a stop prints the stop row and the cleanup steps that apply, then the next cleanup step; an attempt is printed when S5 allows it", () => {
  const stop = asPlanned(DEVICE, "T3", { outcomes: { T3: "FlopSessionKeys.SpendExceedsDeclared" }, errors }).results;
  const { text } = next(stop);
  assert.match(text, /^# stop at T3: /m);
  assert.match(text, /^# cleanup steps that apply: T8, T9/m);
  assert.match(text, /^# finding: T3: FlopSessionKeys.SpendExceedsDeclared/m);
  assert.match(text, /^# T8: owner/m);
  const t6 = asPlanned(DEVICE, "T6", { outcomes: { T6: "ComputeChannel.AckWindowNotElapsed" }, errors }).results;
  const a = next(t6).text;
  assert.match(a, /^# T6\.2: device signs with the encoder/m);
  assert.match(a, /sign-device.mjs" T6\.2 --run/);
  const done = asPlanned(DEVICE, "T9").results;
  assert.match(next(done).text, /^# go on: nothing is left to send/m);
});

test("send-file: an owner step's send file is exactly {step, extrinsic} with no line end; a device step's is sign-device's own", () => {
  const run = runFolder(startedRecord(DEVICE));
  mkdirSync(join(run, "signed"), { recursive: true });
  const f = planSigned(run, "T1", startedRecord(DEVICE));
  const r = spawnSync(process.execPath, [join(HERE, "record-step.mjs"), "send-file", "T1", "--run", run], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(join(run, "signed", "T1.send.json"), "utf8");
  assert.equal(text, `{"step":"T1","extrinsic":"${f.extrinsic}"}`);
  assert.equal(JSON.parse(r.stdout.split("\n")[0]).send_sha256, sha256Text(text));
  assert.equal(r.stdout.split("\n")[1], text);
  const again = spawnSync(process.execPath, [join(HERE, "record-step.mjs"), "send-file", "T1", "--run", run], { encoding: "utf8" });
  assert.equal(again.status, 2, "never written over");
  const dev = spawnSync(process.execPath, [join(HERE, "record-step.mjs"), "send-file", "T3", "--run", run], { encoding: "utf8" });
  assert.match(dev.stderr, /signed by sign-device.mjs/);
});
