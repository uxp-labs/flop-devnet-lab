// Reviewer's tests of steps.json and plan.md (P5, P6, P9, P10). No network. The test key is made
// here in a temporary folder. Tests named "DEFECT" fail on fcfb8b5.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, RERUN, loadPlan, readJson, fromSource, computed } from "./lib.mjs";
import { asPlanned, runFolder, deviceReads } from "./fixtures.mjs";

const plan = loadPlan();
const V = (n) => plan.values[n].value;
const PLAN_MD = readFileSync(join(HERE, "plan.md"), "utf8");
const PROSE = PLAN_MD.split("## The command lines")[0];
const rerun = readJson(join(RERUN, "results.json"));
const fee = (id) => BigInt(rerun.steps.find((s) => s.step === id).fee_raw);

test("review held P5: every value with a source equals its file and field; every computed value is its computation", () => {
  for (const [name, v] of Object.entries(plan.values)) {
    if (v.from) assert.equal(fromSource(plan, v.from), v.value, name);
    if (v.same_as) assert.equal(fromSource(plan, v.same_as), v.value, `${name} same_as`);
    if (v.computed) assert.equal(computed(plan, v.computed), v.value, name);
    if (!v.from && !v.computed) assert.ok(v.decided && v.decided.length > 20, `${name} has no source and no reason`);
  }
  const a6 = rerun.steps.find((s) => s.step === "A6");
  const fo = a6.events.find((e) => e.name === "ForceOpenRequested");
  assert.match(PROSE, new RegExp(`ack_deadline\` ${fo.fields.ack_deadline}, block\\s+${a6.finalized_in_block}`));
  assert.match(PROSE, new RegExp(`${fo.fields.ack_deadline - a6.finalized_in_block} blocks`));
});

test("review held P10: MAX_FEE is the rerun's largest fee, the known fees sum as plan.md says, and FUND covers the device twice over", () => {
  const max = rerun.steps.reduce((m, s) => (BigInt(s.fee_raw) > m ? BigInt(s.fee_raw) : m), 0n);
  assert.equal(String(max), V("MAX_FEE"));
  const known = plan.steps.filter((s) => s.fee_like).reduce((n, s) => n + fee(s.fee_like), 0n);
  assert.match(PROSE, new RegExp(`\\| sum \\| \\| ${known} `));
  const device = plan.fund_rule.transactions_of_the_device.length;
  assert.equal(device, plan.steps.filter((s) => s.signer === "device").length);
  assert.ok(BigInt(V("FUND")) >= BigInt(device) * max * BigInt(plan.fund_rule.margin_times));
});

test("review held P10: the session caps of T2 admit T3, T4 and T5 in order, with the declared spends", () => {
  let spent = 0n;
  for (const id of ["T3", "T4", "T5", "T6", "T7"]) {
    const d = BigInt(plan.values[plan.steps.find((s) => s.id === id).declared.replace("$", "")]?.value ?? plan.steps.find((s) => s.id === id).declared);
    assert.ok(d <= BigInt(V("A_PER_TX")), `${id} per tx`);
    spent += d;
    assert.ok(spent <= BigInt(V("A_DAILY")) && spent <= BigInt(V("A_CAP")), `${id} daily and total`);
  }
});

test("review DEFECT P10 (low): plan.md says which cap of the session each device step is counted against", () => {
  assert.match(PROSE, /daily/i, "plan.md names no cap per step: the daily cap, 0.025, is the one that binds T3 + T4 + T5 = 0.021");
});

test("review DEFECT P9 P6: plan.md says what the lead does for each way send can end other than finalized", () => {
  // pane-runner.js send() ends in: refused-bundle, already-sent, refused-at-submission (an outdated
  // or stale extrinsic comes back this way), deadline (perhaps still in the pool, or in a block not
  // final), ended (usurped, finality timeout), finalized-not-found, finalized-not-canonical, finalized-unread.
  const missing = ["refused-at-submission", "outdated", "deadline", "ended", "finalized-not-found", "finalized-unread"].filter((w) => !PROSE.includes(w));
  assert.deepEqual(missing, [], "plan.md is silent on these outcomes of send, so the lead does not know whether signing the step again is safe");
});

test("review DEFECT P6: T4 can be signed from what the run time record holds when T3 is done (the pane decodes nothing)", () => {
  // Adapted by the builder of the fix round to S1 (--run) and S2b (--reads-sha256): the record is
  // a run time record whose T3 holds only what the runner and the explorer relayed; the decoded
  // events of the template stay empty, because nothing at run time decodes events_raw.
  const dir = mkdtempSync(join(tmpdir(), "review-plan-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, "device.json");
  writeFileSync(key, JSON.stringify({ v: 0, alg: "ed25519", seed_b64: randomBytes(32).toString("base64") }) + "\n", { mode: 0o600 });
  const pub = JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", `import { loadDeviceSigner } from ${JSON.stringify(join(HERE, "device-key.mjs"))}; console.log(JSON.stringify("0x" + Buffer.from(loadDeviceSigner(${JSON.stringify(key)}).publicKey).toString("hex")))`], { encoding: "utf8" }).stdout);
  const { results } = asPlanned(pub, "T3");
  assert.deepEqual(results.steps.find((s) => s.step === "T3").events, [], "no decoded events in the record");
  const run = runFolder(results);
  const reads = deviceReads(pub, { number: 3600010, accountNonce: 1, sessionNonce: 1 });
  const r = spawnSync(process.execPath, [join(HERE, "sign-device.mjs"), "T4", "--run", run, "--key", key, "--reads", reads.text, "--reads-sha256", reads.sha], { encoding: "utf8" });
  assert.equal(r.status, 0, `the plan gives no run time source for T3's channel id: ${r.stderr.trim()}`);
});
