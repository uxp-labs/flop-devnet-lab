// Tests of the lead's stop (F3, lead-stop.mjs and record-step.mjs stop): each of the cases a to d,
// each refusal, what nextOf names after a stop, and that no tool signs or sends a stopped step.
// No network. The device key is made here in a temporary folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, readJson } from "./lib.mjs";
import { loadDeviceSigner } from "./device-key.mjs";
import { leadStop, LeadStopError, NEVER_SENT } from "./lead-stop.mjs";
import { nextOf } from "./judge.mjs";
import { plan, asPlanned, runFolder, sent, makeKey, tempDir, deviceReads, planSigned, relay } from "./fixtures.mjs";

const DIR = tempDir("lead-stop-test");
after(() => rmSync(DIR, { recursive: true, force: true }));
const { path: KEY } = makeKey(DIR);
const DEVICE = "0x" + Buffer.from(loadDeviceSigner(KEY).publicKey).toString("hex");
const BIRTH = 3600020;
const cli = (script, args) => spawnSync(process.execPath, [join(HERE, script), ...args], { encoding: "utf8", cwd: DIR });
const save = (run, r) => writeFileSync(join(run, "results.json"), JSON.stringify(r, null, 1) + "\n");
const load = (run) => readJson(join(run, "results.json"));
const stop = (run, id, o = {}) => leadStop({ plan, run, results: load(run), id, why: "the lead's words for this stop", ...o });
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof LeadStopError && re.test(e.message), re.toString());

/** A run folder through T2, with T3 signed by sign-device (copy A) and a reading of it recorded. */
function t3Signed(status = "deadline") {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  const r = deviceReads(DEVICE, { number: BIRTH, accountNonce: 0 });
  const out = cli("sign-device.mjs", ["T3", "--run", run, "--key", KEY, "--reads", r.text, "--reads-sha256", r.sha]);
  assert.equal(out.status, 0, out.stderr);
  const a = readJson(join(run, "signed", "T3.json"));
  if (status) { const rec = load(run); sent(rec, "T3", { status }); save(run, rec); }
  return { run, a };
}
/** A run folder through T1, with T2 signed with the plan's bytes and a runner reading of it, if any. */
function t2Signed(reading) {
  const run = runFolder(asPlanned(DEVICE, "T1").results);
  planSigned(run, "T2", load(run));
  if (reading) { const rec = load(run); sent(rec, "T2", { status: reading.status }); Object.assign(rec.steps.find((s) => s.step === "T2").run_time.sent, reading); save(run, rec); }
  return run;
}

test("F3 a: nothing signed: the stop is recorded, and nextOf stops at T3 with the cleanup that applies", () => {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  const r = stop(run, "T3", { nowIso: "2026-11-13T05:00:00.000Z" });
  const ls = r.steps.find((s) => s.step === "T3").lead_stop;
  assert.equal(ls.case, "a");
  assert.equal(ls.utc, "2026-11-13T05:00:00.000Z");
  assert.equal(ls.why, "the lead's words for this stop");
  const n = nextOf(plan, r);
  assert.equal(n.word, "stop");
  assert.equal(n.stopped_at, "T3");
  assert.deepEqual(n.cleanup, ["T8", "T9"]);
  assert.equal(n.step, "T8");
  assert.match(n.row, /stopped by the lead \(case a\)/);
  assert.match(n.row, /nothing of T3/, "the stop table's row for a step that never came on chain");
});

test("F3 b: T3's copy whose era is over by the device's reads, the nonce unmoved: stopped, and T8 and T9 follow", () => {
  const { run, a } = t3Signed();
  const reads = deviceReads(DEVICE, { number: a.era.last_valid_block + 1, accountNonce: 0 });
  const r = stop(run, "T3", { readsText: reads.text, readsSha256: reads.sha });
  const ls = r.steps.find((s) => s.step === "T3").lead_stop;
  assert.equal(ls.case, "b");
  assert.equal(ls.evidence.last_valid_block, a.era.last_valid_block);
  assert.equal(ls.evidence.finalized_head.number, a.era.last_valid_block + 1);
  assert.equal(ls.evidence.extrinsic_hash, a.extrinsic_hash);
  const n = nextOf(plan, r);
  assert.deepEqual([n.stopped_at, n.cleanup, n.step], ["T3", ["T8", "T9"], "T8"]);
});

test("F3 b refused: a copy whose era is not over, a device nonce that moved, and no reads", () => {
  const { run, a } = t3Signed();
  const early = deviceReads(DEVICE, { number: a.era.last_valid_block, accountNonce: 0 });
  refused(() => stop(run, "T3", { readsText: early.text, readsSha256: early.sha }), /its era is not over\. Instead follow send_outcomes deadline/);
  const moved = deviceReads(DEVICE, { number: a.era.last_valid_block + 5, accountNonce: 1 });
  refused(() => stop(run, "T3", { readsText: moved.text, readsSha256: moved.sha }), /the device's next nonce is 1 and the record holds 0 device transactions as finalized/);
  refused(() => stop(run, "T3"), /case b needs the device's reads/);
  assert.throws(() => stop(run, "T3", { readsText: early.text, readsSha256: "00".repeat(32) }), /changed on its way/); // the reads checker of sign-device.mjs
});

test("F3 c: T2 refused at submission with node code 1010: stopped, and T9 follows and nothing else", () => {
  const run = t2Signed({ status: "refused-at-submission", node: { code: 1010, message: "Invalid Transaction", data: "x" } });
  const r = stop(run, "T2");
  assert.equal(r.steps.find((s) => s.step === "T2").lead_stop.case, "c");
  const n = nextOf(plan, r);
  assert.deepEqual([n.stopped_at, n.cleanup, n.step], ["T2", ["T9"], "T9"]);
});

test("F3 c refused: the last reading is a deadline, a lost connection, or a refusal with code 1013; each names the row to follow", () => {
  refused(() => stop(t2Signed({ status: "deadline" }), "T2"), /last runner reading of T2 is deadline.*Instead follow send_outcomes deadline/);
  refused(() => stop(t2Signed({ status: "connection-lost" }), "T2"), /is connection-lost.*follow send_outcomes connection-lost/);
  refused(() => stop(t2Signed({ status: "refused-at-submission", node: { code: 1013, message: "Already Imported", data: null } }), "T2"), /with node code 1013.*follow send_outcomes refused-at-submission \(node code 1013\): treat it as sent/);
});

test("F3 d: a research signer copy the record holds no reading of: the record says the lead says it was never sent, and what is left names the unsent files", () => {
  const run = t2Signed(null);
  writeFileSync(join(run, "signed", "T2.send.json"), "{}");
  const r = stop(run, "T2");
  const ls = r.steps.find((s) => s.step === "T2").lead_stop;
  assert.equal(ls.case, "d");
  assert.equal(ls.words, NEVER_SENT);
  assert.equal(NEVER_SENT, "the lead says this copy was never sent");
  const n = nextOf(plan, r);
  assert.equal(n.step, "T9");
  assert.ok(n.left.some((l) => l.includes("signed/T2.json and signed/T2.send.json of T2: the lead says this copy was never sent; they must never be sent")), n.left.join("\n"));
});

test("F3 refused: a finalized reading, a step nextOf does not name, and a second stop", () => {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  refused(() => stop(run, "T2"), /in finalized block .*: a step on chain is not stopped/);
  refused(() => stop(run, "T4"), /T4 is not the step nextOf names: go on T3/);
  save(run, stop(run, "T3"));
  refused(() => stop(run, "T3"), /holds a stop by the lead at T3: it is not replaced/);
  refused(() => stop(run, "T3", { why: "" }), /--why/);
});

test("F3: a stop of a cleanup step goes into what is left and the steps after it go on", () => {
  const { results } = asPlanned(DEVICE, "T5");
  const run = runFolder(results);
  const r = stop(run, "T6");
  const n = nextOf(plan, r);
  assert.equal(n.step, "T7");
  assert.ok(n.left.some((l) => /^T6 was stopped by the lead \(case a\)/.test(l)), n.left.join("\n"));
});

test("F3: after a stop no tool signs the step, writes a send file for it, or records a reading of it", () => {
  const { run, a } = t3Signed();
  const reads = deviceReads(DEVICE, { number: a.era.last_valid_block + 1, accountNonce: 0 });
  const out = cli("record-step.mjs", ["stop", "T3", "--run", run, "--why", "copy A is dead", "--reads", reads.text, "--reads-sha256", reads.sha]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /recorded the lead's stop at T3, case b/);
  assert.match(out.stdout, /stop at T3/);
  const again = cli("sign-device.mjs", ["T3", "--run", run, "--key", KEY, "--reads", reads.text, "--reads-sha256", reads.sha, "--again"]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /the lead stopped T3 \(case b\): it is never signed after the stop/);
  const s = relay({ step: "T3", bundle_sha256: "00".repeat(32), extrinsic_sha256: "00".repeat(32), status: "deadline" });
  assert.match(cli("record-step.mjs", ["step", "T3", "--run", run, "--sent", s.text, "--sent-sha256", s.sha]).stderr, /the lead stopped T3 \(case b\): nothing of it is recorded after the stop/);
  const run2 = t2Signed({ status: "refused-at-submission", node: { code: 1010, message: "Invalid", data: null } });
  save(run2, stop(run2, "T2"));
  const sf = cli("record-step.mjs", ["send-file", "T2", "--run", run2]);
  assert.match(sf.stderr, /the lead stopped T2: no send file is written for it/);
  assert.equal(existsSync(join(run2, "signed", "T2.send.json")), false);
  assert.ok(readFileSync(join(run, "results.json"), "utf8").includes('"case": "b"'));
});

test("G4: an explorer channel id that is not the derived one: at T3 the judge stops and T6 does not apply; at T5, T7 does not apply; at T6 it is left and T7 goes on", async () => {
  const OTHER = "0x" + "e7".repeat(32);
  const at = (id) => { const { results } = asPlanned(DEVICE, id); const ex = results.steps.find((s) => s.step === id).run_time.explorer; ex.events.find((e) => "channel_id" in e.fields).fields.channel_id = OTHER; return nextOf(plan, results); };
  const t3 = at("T3");
  assert.deepEqual([t3.word, t3.stopped_at, t3.cleanup, t3.step], ["stop", "T3", ["T8", "T9"], "T8"]);
  assert.match(t3.row, /not the derived CH_T3/);
  assert.ok(t3.left.some((l) => l.includes(`under the channel id ${OTHER} the explorer gave`)), t3.left.join("\n"));
  const t5 = at("T5");
  assert.deepEqual([t5.stopped_at, t5.cleanup], ["T5", ["T6", "T8", "T9"]]);
  const t6 = at("T6");
  assert.equal(t6.step, "T7");
  assert.ok(t6.left.some((l) => l.includes(`what T6 moved, under the channel id ${OTHER}`)), t6.left.join("\n"));
});
