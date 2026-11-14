// T4, rules H1 and H3: the owner signed check, over files flop-sign.mjs sign made with test keys from
// fixed seeds. The plan's OWNER is set to the test owner in a copy of steps.json held in memory: no
// real key is used. The call is the one the tool printed in the rehearsal (session grant at A1 over
// the rerun's recording, rehearsal.test.mjs), and the second encoder must agree with it. No network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO, plan as realPlan, V, tempDir, testKey, runWithSeat, sessionTapeOf, keysFor, writeRecord } from "./fixtures.mjs";
import { ss58 } from "./lib.mjs";
import { rerunNode, RERUN } from "./rerun-node.mjs";
import { runTool } from "./tool-run.mjs";
import { checkOwnerSigned, OwnerCallError, secondEncoder, toolCall } from "./owner-call.mjs";

const DIR = tempDir("g19-owner-signed");
const DEV1 = RERUN.accounts.dev1.public_key;
const owner = testKey(DIR, "owner-signed-owner"), other = testKey(DIR, "owner-signed-other");
const plan = structuredClone(realPlan);
plan.values.OWNER.value = owner.public_key;
plan.values.OWNER_SS58.value = ss58(owner.public_key);
const run = runWithSeat(DEV1);
after(() => { rmSync(DIR, { recursive: true, force: true }); rmSync(run, { recursive: true, force: true }); });
const results = { record: "run-time", owner_account_nonce_at_start: "5", accounts: { owner: { public_key: owner.public_key, ss58: ss58(owner.public_key) }, device: { public_key: DEV1, ss58: RERUN.accounts.dev1.ss58 } }, steps: [] };
writeRecord(run, results);

// the tool's grant at A1, the pair absent there (set, as rehearsal.test.mjs sets it), for the test owner
const node = rerunNode("A1");
const k = await keysFor(DEV1);
for (const key of [k.sessions, k.nonces, k.breakers]) node.set(key, null);
// the tool asks for the test owner's Sessions and SessionNonces keys: the pane is given those, and the node answers them as absent too
const { keys: chainKeys, KEY_TABLE } = await (await import("./lib.mjs")).loadTool();
const line = KEY_TABLE.runtimes[0];
const sk = chainKeys.sessionKeys(line, chainKeys.accountOf(owner.public_key).value, chainKeys.accountOf(DEV1).value).value;
const hx = (b) => "0x" + Buffer.from(b).toString("hex");
for (const key of [sk.sessions.key, sk.sessionNonces.key]) node.set(hx(key), null);
const { readerOver, plain } = await import("./pane.mjs");
const tape = plain(await readerOver(node).reader.sessionTape({ lru: k.lru, sessions: hx(sk.sessions.key), nonces: hx(sk.sessionNonces.key), breakers: k.breakers, session_count: k.session_count, rotation_history: k.rotation_history }));
await runTool({ plan, run, id: "G1", purpose: "call", tapeText: tape.relay, tapeSha256: tape.relay_sha256 });
const TOOL = toolCall(plan, run, results, "G1").call_hex;

const SIGNER = join(REPO, plan.files.signer);
let n = 0;
function sign(key, call, { nonce = "5", spec = V("SPEC"), txv = V("TXV"), genesis = V("GENESIS") } = {}) {
  const out = join(DIR, `signed-${n++}.json`);
  execFileSync(process.execPath, [SIGNER, "sign", "--key", key.path, "--call", call, "--nonce", nonce, "--out", out, "--spec", spec, "--txv", txv, "--genesis", genesis, "--libs", join(REPO, "imd-flop")], { stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(readFileSync(out, "utf8"));
}
const refused = (f, re) => assert.throws(() => checkOwnerSigned(plan, results, "G1", f, TOOL), (e) => e instanceof OwnerCallError && re.test(e.message), re.toString());

test("T4 H3: the tool's hex equals what the second encoder prints for the same values", () => {
  assert.equal(secondEncoder(plan, results, plan.steps.find((s) => s.id === "G1")).call, TOOL);
});

test("T4 H1: a file flop-sign signed for the tool's hex, the owner, the record's nonce and the plan's runtime passes", () => {
  const r = checkOwnerSigned(plan, results, "G1", sign(owner, TOOL), TOOL);
  assert.equal(r.nonce, "5");
});

test("T4: another call is refused", () => {
  const revoke = execFileSync(process.execPath, [SIGNER, "call", "revoke", "--delegate", DEV1, "--libs", join(REPO, "imd-flop")], { encoding: "utf8" });
  refused(sign(owner, JSON.parse(revoke).call), /the call is 0x5e01/);
});

test("T4: another nonce is refused", () => refused(sign(owner, TOOL, { nonce: "6" }), /the nonce is 6, the plan's is 5/));

test("T4: another signer is refused", () => refused(sign(other, TOOL), /the signer is 0x/));

test("T4: another spec, transaction version or genesis is refused by the signature over the plan's payload", () => {
  refused(sign(owner, TOOL, { spec: "1014019" }), /spec_version is 1014019/);
  refused(sign(owner, TOOL, { txv: "3" }), /transaction_version is 3/);
  refused(sign(owner, TOOL, { genesis: "0x" + "22".repeat(32) }), /genesis is "0x2222/);
  const lying = { ...sign(owner, TOOL, { spec: "1014019" }), spec_version: Number(V("SPEC")) };
  refused(lying, /its signature does not verify over the plan's spec/);
});
