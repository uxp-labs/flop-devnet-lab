// Review 3, attack D: the preflight order of sign-device.mjs (V6) and the dead files (V4). A missing
// key path shows which check ran first: a refusal by the key loader means the key file was opened
// before the check that should refuse. The device key is made here in a temporary folder. No network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, readJson } from "./lib.mjs";
import { loadDeviceSigner, KEY_REFUSAL } from "./device-key.mjs";
import { asPlanned, runFolder, sent, makeKey, tempDir, deviceReads } from "./fixtures.mjs";

const DIR = tempDir("review3-preflight");
after(() => rmSync(DIR, { recursive: true, force: true }));
const { path: KEY } = makeKey(DIR);
const DEVICE = "0x" + Buffer.from(loadDeviceSigner(KEY).publicKey).toString("hex");
const NO_KEY = join(DIR, "no-key-here.json");
const cli = (args) => spawnSync(process.execPath, [join(HERE, "sign-device.mjs"), ...args], { encoding: "utf8", cwd: DIR });
const save = (run, r) => writeFileSync(join(run, "results.json"), JSON.stringify(r, null, 1) + "\n");
const load = (run) => readJson(join(run, "results.json"));
const sign = (run, reads, key = KEY, again = false) => cli(["T3", "--run", run, "--key", key, "--reads", reads.text, "--reads-sha256", reads.sha, ...(again ? ["--again"] : [])]);

/** T3 signed (copy A) and a deadline recorded for it. */
function t3A() {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  const out = sign(run, deviceReads(DEVICE, { number: 3600020, accountNonce: 0 }));
  assert.equal(out.status, 0, out.stderr);
  const rec = load(run); sent(rec, "T3", { status: "deadline" }); save(run, rec);
  return { run, a: readJson(join(run, "signed", "T3.json")) };
}

test("review3 D DEFECT (V6): a lone dead send file beside signed/T3.json: --again opens the key file, then refuses in retire", () => {
  const { run, a } = t3A();
  copyFileSync(join(run, "signed", "T3.send.json"), join(run, "signed", "T3.dead-1.send.json")); // no T3.dead-1.json beside it
  const reads = deviceReads(DEVICE, { number: a.era.last_valid_block + 1, accountNonce: 0 });
  const withKey = sign(run, reads, KEY, true);
  assert.equal(withKey.status, 2);
  assert.match(withKey.stderr, /dead-1\.json exists/, "control: with the key the refusal is retire's");
  const noKey = sign(run, reads, NO_KEY, true);
  assert.equal(noKey.status, 2);
  assert.ok(!noKey.stderr.includes(KEY_REFUSAL), `the key file was opened before a refusal that needs no key: ${noKey.stderr.trim()}`);
});

test("review3 D HELD: dead copies and no signed file: no signing without --again, before the key; with --again the newest dead copy's era decides", () => {
  const { run, a } = t3A();
  const out1 = sign(run, deviceReads(DEVICE, { number: a.era.last_valid_block + 1, accountNonce: 0 }), KEY, true);
  assert.equal(out1.status, 0, out1.stderr); // copy B, A is dead-1
  const b = readJson(join(run, "signed", "T3.json"));
  assert.equal(b.account_nonce, a.account_nonce, "the nonce rule decides: same nonce");
  // a stop between the renames of a later --again: B moved to dead-2, nothing signed
  copyFileSync(join(run, "signed", "T3.json"), join(run, "signed", "T3.dead-2.json"));
  copyFileSync(join(run, "signed", "T3.send.json"), join(run, "signed", "T3.dead-2.send.json"));
  rmSync(join(run, "signed", "T3.json")); rmSync(join(run, "signed", "T3.send.json"));
  const late = deviceReads(DEVICE, { number: b.era.last_valid_block + 1, accountNonce: 0 });
  const noAgain = sign(run, late, NO_KEY, false);
  assert.equal(noAgain.status, 2);
  assert.ok(!noAgain.stderr.includes(KEY_REFUSAL), noAgain.stderr); // refused (the step waits on inclusion) before the key
  const tooEarly = sign(run, deviceReads(DEVICE, { number: b.era.last_valid_block, accountNonce: 0 }), NO_KEY, true);
  assert.match(tooEarly.stderr, /era is not over/, "B (dead-2) decides, not A");
  const moved = sign(run, deviceReads(DEVICE, { number: b.era.last_valid_block + 1, accountNonce: 1 }), NO_KEY, true);
  assert.match(moved.stderr, /next nonce is 1/, "the nonce rule still refuses before the key");
  const c = sign(run, late, KEY, true);
  assert.equal(c.status, 0, c.stderr);
  const cRec = readJson(join(run, "signed", "T3.json"));
  assert.equal(cRec.account_nonce, a.account_nonce);
  assert.deepEqual(cRec.earlier_copies.map((e) => e.file), ["signed/T3.dead-1.json", "signed/T3.dead-2.json"]);
  assert.ok(readdirSync(join(run, "signed")).length === 6);
});

test("review3 D HELD: a lone send file with no signed file is refused before the key, with or without --again", () => {
  const { run, a } = t3A();
  rmSync(join(run, "signed", "T3.json"));
  const reads = deviceReads(DEVICE, { number: a.era.last_valid_block + 1, accountNonce: 0 });
  for (const again of [false, true]) {
    const out = sign(run, reads, NO_KEY, again);
    assert.equal(out.status, 2);
    assert.ok(!out.stderr.includes(KEY_REFUSAL), out.stderr);
  }
  assert.ok(existsSync(join(run, "signed", "T3.send.json")));
});
