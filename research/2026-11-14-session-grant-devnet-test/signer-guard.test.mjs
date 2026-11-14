// T7, rule H2: the research signer signs a create_session of one SessionEpochLength of 1014020,
// 86400 blocks (facts-1014020.json constants.FlopSessionKeys.SessionEpochLength.value), the tool's
// shortest grant, and refuses one block more. The key is a test key from a fixed seed, written here
// in a temporary folder in the form flop-sign.mjs keygen writes. No network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO, plan, V, tempDir, testKey } from "./fixtures.mjs";

const DIR = tempDir("g19-signer-guard");
after(() => rmSync(DIR, { recursive: true, force: true }));
const SIGNER = join(REPO, plan.files.signer);
const flopSign = (...args) => spawnSync(process.execPath, [SIGNER, ...args, "--libs", join(REPO, "imd-flop")], { encoding: "utf8" });
const EPOCH = V("EPOCH_BLOCKS");
const owner = testKey(DIR, "guard-owner");
const device = testKey(DIR, "guard-device");
const callArgs = (blocks) => ["call", "create-session", "--delegate", device.public_key, "--cap", V("A_DAILY"), "--per-tx", V("A_PER_TX"), "--daily", V("A_DAILY"), "--blocks", String(blocks), "--allow", V("ALLOW")];

test("T7: the epoch of steps.json is 86400 blocks, from the facts file", () => {
  assert.equal(EPOCH, "86400");
  assert.deepEqual(plan.values.EPOCH_BLOCKS.from, { file: "facts", path: "constants.FlopSessionKeys.SessionEpochLength.value" });
});

test("T7: a create_session of 86400 blocks is described and signed with a test key", () => {
  const c = flopSign(...callArgs(EPOCH));
  assert.equal(c.status, 0, c.stderr);
  const { call, what } = JSON.parse(c.stdout);
  assert.match(what, /for 86400 blocks, allowed pallets ComputeChannel$/);
  const out = join(DIR, "signed-86400.json");
  const s = flopSign("sign", "--key", owner.path, "--call", call, "--nonce", "0", "--out", out, "--spec", V("SPEC"), "--txv", V("TXV"), "--genesis", V("GENESIS"));
  assert.equal(s.status, 0, s.stderr);
  const signed = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(signed.call, call);
  assert.equal(signed.signer, owner.public_key);
  assert.ok(!(s.stdout + s.stderr).includes(owner.seed_b64), "no key material is printed");
});

test("T7: a create_session of 86401 blocks is refused by call and by sign", () => {
  const c = flopSign(...callArgs(BigInt(EPOCH) + 1n));
  assert.equal(c.status, 2);
  assert.equal(c.stderr, "flop-sign: this tool signs no session longer than 86400 blocks\n");
  const ok = JSON.parse(flopSign(...callArgs(EPOCH)).stdout).call;
  // the same call with the u32 duration one higher: the 4 bytes after delegate and three u128
  const at = 2 + 2 * (2 + 32 + 48);
  const longer = ok.slice(0, at) + Buffer.from(new Uint32Array([Number(EPOCH) + 1]).buffer).toString("hex") + ok.slice(at + 8);
  const s = flopSign("sign", "--key", owner.path, "--call", longer, "--nonce", "0", "--out", join(DIR, "signed-86401.json"), "--spec", V("SPEC"), "--txv", V("TXV"), "--genesis", V("GENESIS"));
  assert.equal(s.status, 2);
  assert.equal(s.stderr, "flop-sign: this tool signs no session longer than 86400 blocks\n");
});
