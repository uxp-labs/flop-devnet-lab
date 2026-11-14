// Review of G-19, attack 7 (G8) and attack 9 (G10). G8: a scan of the folder's scripts for key
// material. G10: the research signer at d3b39e7 and at this branch sign every owner call of the
// rerun and of the last batch to the same bytes with a test key; 86400 blocks sign, 86401 refuse.
// No network, no real key: the key is a test key from a fixed seed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./lib.mjs";
import { REPO, tempDir, testKey, V } from "./fixtures.mjs";

const DIR = tempDir("g19-review-scan");
after(() => rmSync(DIR, { recursive: true, force: true }));
const scripts = readdirSync(HERE).filter((f) => /\.(mjs|js)$/.test(f) && !/\.test\.mjs$/.test(f) && !["fixtures.mjs", "records.mjs", "walk.mjs", "rerun-node.mjs", "pane.mjs"].includes(f));

test("HOLDS (G8): no script of the folder names a key file, a seed or the seat's key; $KEY_OWNER is only on the signer's printed line", () => {
  assert.ok(scripts.length >= 12, scripts.join(" "));
  for (const f of scripts) {
    const s = readFileSync(join(HERE, f), "utf8");
    assert.doesNotMatch(s, /flop\.key|\.key["'`]|seed_b64|secretKey|privateKey/i, f);
    for (const m of s.matchAll(/KEY_OWNER/g)) assert.equal(f, "plan.mjs", `${f} names KEY_OWNER`);
    for (const m of s.matchAll(/"seats",\s*seat,\s*"([^"]+)"/g)) assert.equal(m[1], "identity.json", `${f} opens seats/<seat>/${m[1]}`);
    assert.doesNotMatch(s, /process\.env\b/, `${f} reads the environment`);
  }
  const lines = readFileSync(join(HERE, "plan.mjs"), "utf8").split("\n").filter((l) => l.includes("KEY_OWNER"));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\$\{SIGNER\} sign --key "\$KEY_OWNER"/);
});

// The signer at d3b39e7 is this file with its one changed line put back (git diff d3b39e7 HEAD shows
// that line alone; the review compared the two files byte for byte by hand). No git history is read,
// so a shallow checkout runs this test the same.
const NEW = join(REPO, "research/2026-11-11-session-deny-list/flop-sign.mjs");
const NEW_LINE = "const MAX_SESSION_BLOCKS = 86400; // nor a session longer than one SessionEpochLength of 1014020, the tool's shortest grant";
const OLD_LINE = "const MAX_SESSION_BLOCKS = 14400; // nor a session longer than about four hours";
const OLD = join(DIR, "flop-sign-d3b39e7.mjs");
const now = readFileSync(NEW, "utf8");
assert.equal(now.split(NEW_LINE).length, 2, "the changed line is in the signer once");
writeFileSync(OLD, now.replace(NEW_LINE, OLD_LINE));
const key = testKey(DIR, "review-g10");
let k = 0;
const sign = (signer, call, nonce) => {
  const out = join(DIR, `x${k++}.json`);
  const p = spawnSync(process.execPath, [signer, "sign", "--key", key.path, "--call", call, "--nonce", nonce, "--out", out, "--spec", V("SPEC"), "--txv", V("TXV"), "--genesis", V("GENESIS"), "--libs", join(REPO, "imd-flop")], { encoding: "utf8" });
  return p.status === 0 ? JSON.parse(readFileSync(out, "utf8")).extrinsic : `refused: ${p.stderr.trim()}`;
};

test("HOLDS (G10): the signer before and after its one line signs every recorded owner call of the rerun and of the last batch to the same bytes", () => {
  const rerun = JSON.parse(readFileSync(join(REPO, "research/2026-11-12-session-rerun-1014020/results.json"), "utf8")).steps;
  const enc = JSON.parse(readFileSync(join(REPO, "research/2026-11-12-encoder-devnet-test/results.final.json"), "utf8")).steps;
  const calls = [...rerun, ...enc].map((s) => s.call).filter((c) => typeof c === "string" && /^0x([0-9a-f]{2})+$/.test(c));
  assert.ok(calls.length >= 20, String(calls.length));
  let same = 0;
  for (const [i, c] of calls.entries()) {
    const a = sign(OLD, c, String(i)), b = sign(NEW, c, String(i));
    assert.equal(b, a, c.slice(0, 12));
    if (!a.startsWith("refused")) same++;
  }
  assert.ok(same >= 10, `${same} signed to the same bytes`);
});

test("HOLDS (G10): 86400 blocks sign and 86401 refuse at this branch; at d3b39e7 86400 refused", () => {
  const call = (blocks) => JSON.parse(execFileSync(process.execPath, [NEW, "call", "create-session", "--delegate", "0x" + "11".repeat(32), "--cap", V("SPENDING_CAP"), "--per-tx", V("A_PER_TX"), "--daily", V("A_DAILY"), "--blocks", String(blocks), "--allow", V("ALLOW"), "--libs", join(REPO, "imd-flop")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).call;
  const c86400 = call(86400);
  assert.doesNotMatch(sign(NEW, c86400, "1"), /^refused/);
  assert.match(sign(OLD, c86400, "1"), /^refused.*14400/);
  const c86401 = c86400.replace(/80510100/, "81510100");
  assert.notEqual(c86401, c86400);
  assert.match(sign(NEW, c86401, "1"), /^refused.*86400 blocks/);
});
