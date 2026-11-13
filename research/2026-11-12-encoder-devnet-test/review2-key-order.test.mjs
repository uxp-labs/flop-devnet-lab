// Review 2 (Q4): the key file is opened only after every check that can refuse. No network. The
// device key is made here in a temporary folder; a missing key path shows which check ran first:
// if the refusal is the key loader's, the key file was opened before the check that should refuse.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { HERE, ss58 } from "./lib.mjs";
import { loadDeviceSigner, KEY_REFUSAL } from "./device-key.mjs";
import { V, H, RUNTIME, makeKey, tempDir, relay, asPlanned, runFolder } from "./fixtures.mjs";

const DIR = tempDir("review2-key-order");
after(() => rmSync(DIR, { recursive: true, force: true }));
const { path: KEY } = makeKey(DIR);
const DEVICE = "0x" + Buffer.from(loadDeviceSigner(KEY).publicKey).toString("hex");
const NO_KEY = join(DIR, "there-is-no-key-file.json");
const node = (script, args) => spawnSync(process.execPath, [join(HERE, script), ...args], { encoding: "utf8", cwd: DIR });

/** The device's reads as the runner relays them, with a runtime of our choice. */
const readsWith = (runtime) => relay({ account: ss58(DEVICE), runtime, birth: { number: 3600010, hash: "0x" + "cd".repeat(32) }, account_nonce: 0, session_nonce_raw: null });

test("review2 Q4 DEFECT: sign-device opens the key file before the encoder refuses an unknown runtime in the reads", () => {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  const r = readsWith({ ...RUNTIME, specVersion: RUNTIME.specVersion + 1 });
  // control: with the real key the refusal is RUNTIME_UNKNOWN, so the check exists and can refuse
  const withKey = node("sign-device.mjs", ["T3", "--run", run, "--key", KEY, "--reads", r.text, "--reads-sha256", r.sha]);
  assert.equal(withKey.status, 2);
  assert.match(withKey.stderr, /RUNTIME_UNKNOWN/);
  // with no key file the same reads must give the same refusal: the runtime is known from the reads alone
  const noKey = node("sign-device.mjs", ["T3", "--run", run, "--key", NO_KEY, "--reads", r.text, "--reads-sha256", r.sha]);
  assert.equal(noKey.status, 2);
  assert.ok(!noKey.stderr.includes(KEY_REFUSAL), `the key file was opened before the runtime check: ${noKey.stderr.trim()}`);
});

test("review2 Q4 DEFECT: sign-device opens the key file before it refuses reads of a runtime whose genesis is not steps.json GENESIS", () => {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  const r = readsWith({ ...RUNTIME, genesisHash: "0x" + "ee".repeat(32) });
  const noKey = node("sign-device.mjs", ["T3", "--run", run, "--key", NO_KEY, "--reads", r.text, "--reads-sha256", r.sha]);
  assert.equal(noKey.status, 2);
  assert.ok(!noKey.stderr.includes(KEY_REFUSAL), `the key file was opened before the genesis was checked: ${noKey.stderr.trim()}`);
});

test("review2 Q4 DEFECT: record-step start opens the key file before it refuses reads that are not of the owner", () => {
  const r = relay({ account: ss58(DEVICE), runtime: RUNTIME, finalized: { number: 3599990, hash: H(3599990) }, account_nonce: 14 });
  const run = join(DIR, "run-not-owner");
  const withKey = node("record-step.mjs", ["start", "--run", run, "--key", KEY, "--reads", r.text, "--reads-sha256", r.sha]);
  assert.equal(withKey.status, 2);
  assert.match(withKey.stderr, /not the owner of steps.json/);
  const noKey = node("record-step.mjs", ["start", "--run", run, "--key", NO_KEY, "--reads", r.text, "--reads-sha256", r.sha]);
  assert.equal(noKey.status, 2);
  assert.ok(!noKey.stderr.includes(KEY_REFUSAL), `the key file was opened before the owner check: ${noKey.stderr.trim()}`);
});

test("review2 Q4 DEFECT: record-step start opens the key file before it refuses a runtime that is not steps.json's", () => {
  const r = relay({ account: ss58(V("OWNER")), runtime: { ...RUNTIME, specVersion: 1 }, finalized: { number: 3599990, hash: H(3599990) }, account_nonce: 14 });
  const run = join(DIR, "run-old-runtime");
  const noKey = node("record-step.mjs", ["start", "--run", run, "--key", NO_KEY, "--reads", r.text, "--reads-sha256", r.sha]);
  assert.equal(noKey.status, 2);
  assert.ok(!noKey.stderr.includes(KEY_REFUSAL), `the key file was opened before the runtime check: ${noKey.stderr.trim()}`);
});
