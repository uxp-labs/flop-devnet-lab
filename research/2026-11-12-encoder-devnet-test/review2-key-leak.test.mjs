// Review 2 (Q4, attack H): no part of the test seed reaches stdout, stderr or any file written, on the
// paths of sign-device.mjs and record-step.mjs start, the refusals among them. The key is made here
// in a temporary folder. No network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { HERE, ss58 } from "./lib.mjs";
import { loadDeviceSigner } from "./device-key.mjs";
import { V, H, RUNTIME, makeKey, tempDir, relay, deviceReads, asPlanned, runFolder } from "./fixtures.mjs";

const DIR = tempDir("review2-key-leak");
after(() => rmSync(DIR, { recursive: true, force: true }));
const { path: KEY, seed } = makeKey(DIR);
const DEVICE = "0x" + Buffer.from(loadDeviceSigner(KEY).publicKey).toString("hex");
const node = (script, args) => spawnSync(process.execPath, [join(HERE, script), ...args], { encoding: "utf8", cwd: DIR });

/** Every form of the seed and of each 8 byte window of it. */
const forms = (() => {
  const out = [seed.toString("hex"), seed.toString("base64"), [...seed].join(","), [...seed].join(", ")];
  for (let i = 0; i + 8 <= 32; i += 4) { const w = seed.subarray(i, i + 8); out.push(w.toString("hex"), w.toString("base64").replace(/=+$/, ""), [...w].join(",")); }
  return out;
})();
const files = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : [p]; });
function clean(texts, where) { for (const t of texts) for (const f of forms) assert.ok(!t.includes(f), `a form of the seed is in ${where}`); }

test("review2 Q4 HELD: no form of the seed in the outputs and files of record-step start, sign-device T3 and their refusals", () => {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  const outs = [];
  const good = deviceReads(DEVICE, { number: 3600010, accountNonce: 0 });
  outs.push(node("sign-device.mjs", ["T3", "--run", run, "--key", KEY, "--reads", good.text, "--reads-sha256", good.sha]));
  assert.equal(outs[0].status, 0, outs[0].stderr);
  const bad = relay({ account: ss58(DEVICE), runtime: { ...RUNTIME, specVersion: 1 }, birth: { number: 3600200, hash: H(1) }, account_nonce: 0, session_nonce_raw: null });
  outs.push(node("sign-device.mjs", ["T3", "--run", run, "--key", KEY, "--reads", bad.text, "--reads-sha256", bad.sha, "--again"]));
  outs.push(node("sign-device.mjs", ["T3", "--run", run, "--key", KEY, "--reads", good.text, "--reads-sha256", good.sha]));
  const o = relay({ account: ss58(V("OWNER")), runtime: RUNTIME, finalized: { number: 3599990, hash: H(3599990) }, account_nonce: 14 });
  outs.push(node("record-step.mjs", ["start", "--run", join(DIR, "run-start"), "--key", KEY, "--reads", o.text, "--reads-sha256", o.sha]));
  outs.push(node("record-step.mjs", ["start", "--run", join(DIR, "run-start"), "--key", KEY, "--reads", o.text, "--reads-sha256", o.sha]));
  clean(outs.flatMap((x) => [x.stdout, x.stderr]), "an output");
  for (const f of [...files(run), ...files(join(DIR, "run-start"))]) clean([readFileSync(f, "latin1"), readFileSync(f).toString("hex")], f);
});
