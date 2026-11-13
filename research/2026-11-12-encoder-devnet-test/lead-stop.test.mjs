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
import { plan, asPlanned, runFolder, sent, makeKey, tempDir, deviceReads, planSigned, relay, signerReads, accountReads } from "./fixtures.mjs";

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
/** The signer's reads of an id in a run folder, its next nonce the copy's plus delta (H1). */
const counted = (run, id, o = {}) => { const r = signerReads(load(run), id, o); return { readsText: r.text, readsSha256: r.sha }; };

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
  const run = t2Signed({ status: "refused-at-submission", sent_by: "send", node: { code: 1010, message: "Invalid Transaction", data: "x" } });
  const r = stop(run, "T2", counted(run, "T2"));
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
  const r = stop(run, "T2", counted(run, "T2"));
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
  const run2 = t2Signed({ status: "refused-at-submission", sent_by: "send", node: { code: 1010, message: "Invalid", data: null } });
  save(run2, stop(run2, "T2", counted(run2, "T2")));
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

test("F3 a refused when a dead copy exists: something was signed, so case b's reads are needed", () => {
  const { run } = t3Signed(null);
  const fs = { json: join(run, "signed", "T3.json"), send: join(run, "signed", "T3.send.json") };
  writeFileSync(join(run, "signed", "T3.dead-1.json"), readFileSync(fs.json)); rmSync(fs.json);
  writeFileSync(join(run, "signed", "T3.dead-1.send.json"), readFileSync(fs.send)); rmSync(fs.send);
  refused(() => stop(run, "T3"), /case b needs the device's reads/);
});

test("F3: a record that holds a stop by the lead beside a finalized block of the same step is broken: nextOf stops everything", () => {
  const { results } = asPlanned(DEVICE, "T2");
  results.steps.find((s) => s.step === "T2").lead_stop = { why: "x", utc: "2026-11-13T05:00:00.000Z", case: "a", evidence: {} };
  const n = nextOf(plan, results);
  assert.equal(n.word, "stop");
  assert.equal(n.step, null);
  assert.match(n.why, /holds a stop by the lead at T2 beside a finalized block of it/);
});

test("F3c: a 1010 after a deadline or a lost connection (from sendSame) is refused and names find; a 1010 with no call named is refused", () => {
  const after = (first) => {
    const run = t2Signed({ status: "refused-at-submission", sent_by: "sendSame", node: { code: 1010, message: "Invalid Transaction", data: null } });
    const rec = load(run);
    rec.steps.find((s) => s.step === "T2").run_time.earlier_readings = [{ sent: { status: first, sent_by: "send", step: null }, sent_sha256: "55".repeat(32) }];
    save(run, rec);
    return run;
  };
  refused(() => stop(after("deadline"), "T2"), /answered sendSame, not a first send, and follows 1 earlier runner reading\(s\) of it \(deadline\).*use lab.find from the block before the first send \(the record's start, finalized block 3599990\)/);
  refused(() => stop(after("connection-lost"), "T2"), /\(connection-lost\).*lab.find from the block before the first send/);
  const sameFirst = t2Signed({ status: "refused-at-submission", sent_by: "send", node: { code: 1010, message: "x", data: null } });
  const rec = load(sameFirst); rec.steps.find((s) => s.step === "T2").run_time.earlier_readings = [{ sent: { status: "deadline" }, sent_sha256: "55".repeat(32) }]; save(sameFirst, rec);
  refused(() => stop(sameFirst, "T2"), /follows 1 earlier runner reading/);
  refused(() => stop(t2Signed({ status: "refused-at-submission", node: { code: 1010, message: "x", data: null } }), "T2"), /answered a call the reading does not name/);
});

test("G1: the 1010 row says both: invalid on a first send; on a sendSame after a deadline, connection-lost or ended, find first", () => {
  const row = plan.send_outcomes.find((r) => r.outcome === "refused-at-submission" && r.node_code === 1010);
  assert.match(row.known, /on a first send: the node judged the extrinsic invalid/);
  assert.match(row.known, /On a sendSame after an outcome that may still land \(deadline, connection-lost, ended\), 1010 can mean the first copy is already in a block/);
  assert.match(row.lead, /lab.find before anything else/);
});

// ---- fix round 3: the node's own count (H1), already-sent (H2), case a (H3), what is left (H4) ----

/** T2 signed with the plan's bytes and a first send refused with 1010: the record of case c. */
const t2c = () => t2Signed({ status: "refused-at-submission", sent_by: "send", node: { code: 1010, message: "Invalid Transaction", data: "x" } });

test("H1 c and d: the signer's next nonce equal to the copy's allows the stop, and the evidence holds the head, the next nonce, the copy's hash and nonce", () => {
  for (const [kase, run] of [["c", t2c()], ["d", t2Signed(null)]]) {
    const reads = signerReads(load(run), "T2", { number: 3600123 });
    const ls = stop(run, "T2", { readsText: reads.text, readsSha256: reads.sha }).steps.find((s) => s.step === "T2").lead_stop;
    const f = readJson(join(run, "signed", "T2.json"));
    assert.equal(ls.case, kase);
    assert.deepEqual([ls.evidence.finalized_head.number, ls.evidence.signer_next_nonce, ls.evidence.extrinsic_hash, ls.evidence.nonce, ls.evidence.signer, ls.evidence.reads_sha256],
      [3600123, Number(f.account_nonce), f.extrinsic_hash, f.account_nonce, plan.values.OWNER.value, reads.sha], kase);
  }
});

test("H1 c and d refused: no reads, a next nonce above (names find and sendSame), a next nonce below (the record and the chain disagree)", () => {
  for (const make of [t2c, () => t2Signed(null)]) {
    refused(() => stop(make(), "T2"), /case [cd] needs the node's count of the signer's nonce: --reads and --reads-sha256, lab.accountReads of the step's signer/);
    const up = make();
    refused(() => stop(up, "T2", counted(up, "T2", { delta: 1 })), /next nonce is \d+, above the copy's \d+: the nonce is used, or a transaction with it is in the pool.*lab\.find from the block before the first send \(the record's start, finalized block 3599990\).*lab\.sendSame/);
    const down = make();
    refused(() => stop(down, "T2", counted(down, "T2", { delta: -1 })), /below the copy's \d+: the record and the chain disagree/);
  }
});

test("H1 refused: reads of another account than the step's signer, of another runtime, or changed on the way; the device's reads for T9 are taken", () => {
  const run = t2c();
  const nonce = Number(readJson(join(run, "signed", "T2.json")).account_nonce);
  const dev = accountReads(DEVICE, { nonce });
  refused(() => stop(run, "T2", { readsText: dev.text, readsSha256: dev.sha }), /not the step's signer/);
  const rt = accountReads(plan.values.OWNER.value, { nonce, runtime: { ...JSON.parse(dev.text).runtime, specVersion: 1 } });
  refused(() => stop(run, "T2", { readsText: rt.text, readsSha256: rt.sha }), /the runtime of the reads has specVersion 1/);
  refused(() => stop(run, "T2", { readsText: dev.text, readsSha256: "00".repeat(32) }), /changed on its way/);
  // T9: the sweep is the device's: its reads are the device's, and the owner's are refused
  const t9 = runFolder(asPlanned(DEVICE, "T8").results);
  planSigned(t9, "T9", load(t9));
  const owner = accountReads(plan.values.OWNER.value, { nonce: 0 });
  refused(() => stop(t9, "T9", { readsText: owner.text, readsSha256: owner.sha }), /not the step's signer 0x/);
  assert.equal(stop(t9, "T9", counted(t9, "T9")).steps.find((s) => s.step === "T9").lead_stop.evidence.signer, DEVICE);
});

test("H1 refused: a signed file that is not the plan's step is refused with the words of checkResearchSigned", () => {
  const run = t2Signed(null);
  planSigned(run, "T2", load(run), { nonce: 99n });
  const reads = accountReads(plan.values.OWNER.value, { nonce: 99 });
  refused(() => stop(run, "T2", { readsText: reads.text, readsSha256: reads.sha }), /signed\/T2\.json is not the plan's T2, refused: the nonce is 99.*The lead moves a wrong file aside by hand/);
});

test("H1: find read every finalized block from the start to the head without the copy and the nonce is used: no stop, these tools go no further, and the stop table's nonce row is named", () => {
  const run = t2Signed({ status: "not-found", sent_by: "find", step: null, from: 3600390, to: 3600500, head: 3600500 });
  const rec = load(run);
  rec.steps.find((s) => s.step === "T2").run_time.earlier_readings = [
    { sent: { status: "deadline", sent_by: "send", step: "T2" }, sent_sha256: "55".repeat(32) },
    { sent: { status: "not-found", sent_by: "find", step: null, from: 3599990, to: 3600389, head: 3600500 }, sent_sha256: "56".repeat(32) },
  ];
  save(run, rec);
  const row = plan.stop_table.find((r) => r.step === "T2" && r.answer === "nonce");
  refused(() => stop(run, "T2", counted(run, "T2", { delta: 1 })), new RegExp(`find read the finalized blocks 3599990 to 3600500 and did not find the copy.*a transaction that is not of this batch used the signer's nonce\\. These tools go no further at T2, and no stop is recorded: ${row.on_chain.slice(0, 40)}`));
  const n = nextOf(plan, load(run));
  assert.deepEqual([n.word, n.step, n.waiting, n.cleanup], ["wait", "T2", "inclusion", []], "nextOf goes no further: no cleanup step is named");
  // a gap in the blocks find read is not that: the refusal is the row of not-found
  const gap = load(run); gap.steps.find((s) => s.step === "T2").run_time.earlier_readings[1].sent.to = 3600300; save(run, gap);
  assert.throws(() => stop(run, "T2", counted(run, "T2", { delta: 1 })), (e) => e instanceof LeadStopError && !/go no further/.test(e.message) && /follow send_outcomes not-found/.test(e.message));
});

test("H1: the stop table has a row nonce for each research signer step, saying what is left and that a later piece of work brings it back", () => {
  const ids = plan.steps.filter((s) => s.tool === "research-signer").map((s) => s.id);
  const rows = plan.stop_table.filter((r) => r.answer === "nonce");
  assert.deepEqual(rows.map((r) => r.step), ids);
  for (const r of rows) { assert.match(r.on_chain, /not of this batch/); assert.match(r.brings_back, /go no further at T\d and record no stop/); }
  assert.match(rows.find((r) => r.step === "T2").on_chain, /FUND is on the device/);
});

test("H2: with the pane's already-sent in the record neither c nor d holds: the stop names find and sendSame", () => {
  for (const earlier of [[], [{ sent: { status: "already-sent", sent_by: "send", step: "T2" }, sent_sha256: "57".repeat(32) }]]) {
    const run = earlier.length ? t2c() : t2Signed({ status: "already-sent", sent_by: "send" });
    const rec = load(run); rec.steps.find((s) => s.step === "T2").run_time.earlier_readings = earlier; save(run, rec);
    refused(() => stop(run, "T2", counted(run, "T2")), /already-sent for it, so these bytes were sent before: neither case c nor case d holds\. Instead use lab\.find from the block before the first send.*lab\.sendSame/);
  }
});

test("H3: case a is refused while the record holds a runner reading of the id, current or earlier, and the signed file is gone", () => {
  const run = t2Signed({ status: "already-sent", sent_by: "send" });
  rmSync(join(run, "signed", "T2.json"));
  refused(() => stop(run, "T2"), /the record holds 1 runner reading\(s\) of it \(already-sent\), so something was sent, and signed\/T2\.json is gone: case a \(nothing was signed\) does not hold\. The lead rules/);
  const a = runFolder(asPlanned(DEVICE, "T2").results);
  assert.equal(stop(a, "T3").steps.find((s) => s.step === "T3").lead_stop.evidence.runner_readings, "none in the record");
});

test("H4: after a stop by c or d what is left names the copy's file, extrinsic hash, signer and nonce, and how long it stays valid", () => {
  for (const make of [t2c, () => t2Signed(null)]) {
    const run = make();
    const f = readJson(join(run, "signed", "T2.json"));
    const n = nextOf(plan, stop(run, "T2", counted(run, "T2")));
    const l = n.left.find((x) => x.startsWith("signed/T2.json"));
    assert.ok(l, n.left.join("\n"));
    for (const w of [f.extrinsic_hash, `signer ${plan.values.OWNER.value}`, `nonce ${f.account_nonce}`, "they must never be sent", `stays valid until the nonce ${f.account_nonce} of ${plan.values.OWNER.value} is used`, "the next transaction this signer sends ends it"]) assert.ok(l.includes(w), `${w} in: ${l}`);
  }
});
