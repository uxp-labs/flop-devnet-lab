// Review 3, attack B: the lead's stop (V2, V3). Every way a step can fail to come on chain or come on
// chain late, for a device step and an owner step, played against lead-stop.mjs and nextOf. No
// network. The device key is made here in a temporary folder. No source file is changed.
// A test named DEFECT fails on a9442dd and shows a break of the promise line it names. HELD tests
// pass and record what was attacked and held.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";
import { HERE, readJson, sha256Text } from "./lib.mjs";
import { loadDeviceSigner } from "./device-key.mjs";
import { leadStop, LeadStopError } from "./lead-stop.mjs";
import { nextOf } from "./judge.mjs";
import { recordReading } from "./record-step.mjs";
import { plan, asPlanned, runFolder, sent, makeKey, tempDir, deviceReads, planSigned, relay } from "./fixtures.mjs";

const DIR = tempDir("review3-stop");
after(() => rmSync(DIR, { recursive: true, force: true }));
const { path: KEY } = makeKey(DIR);
const DEVICE = "0x" + Buffer.from(loadDeviceSigner(KEY).publicKey).toString("hex");
const cli = (script, args) => spawnSync(process.execPath, [join(HERE, script), ...args], { encoding: "utf8", cwd: DIR });
const save = (run, r) => writeFileSync(join(run, "results.json"), JSON.stringify(r, null, 1) + "\n");
const load = (run) => readJson(join(run, "results.json"));
const stop = (run, id, o = {}) => leadStop({ plan, run, results: load(run), id, why: "review3: the lead's words", ...o });
const isRefused = (fn) => { try { fn(); return null; } catch (e) { if (e instanceof LeadStopError) return e.message; throw e; } };
const SRC = readFileSync(join(HERE, "pane-runner.js"), "utf8");
const loadPane = () => { const g = { crypto: webcrypto, TextEncoder, setTimeout, clearTimeout }; vm.runInNewContext(SRC, g); return g.paneRunner; };

/** A run folder through the step before id, with id signed with the plan's bytes (research signer). */
function ownerSigned(id, prev) {
  const run = runFolder(asPlanned(DEVICE, prev).results);
  planSigned(run, id, load(run));
  return run;
}
/** Sets the run_time of an id to one runner reading (and earlier ones), as record-step writes them. */
function withReading(run, id, reading, earlier = []) {
  const rec = load(run);
  sent(rec, id, { status: reading.status });
  const rt = rec.steps.find((s) => s.step === id).run_time;
  Object.assign(rt.sent, reading);
  rt.earlier_readings = earlier;
  save(run, rec);
  return run;
}
const R1010 = (data, by = "send") => ({ status: "refused-at-submission", sent_by: by, node: { code: 1010, message: "Invalid Transaction", data } });

// ---- the table of attack B ------------------------------------------------------------------------
// Each row: a record, whether a stop must be allowed, and when allowed what nextOf must name after it.
// cleanup is nextOf's list after a stop at a test step; after a stop of a cleanup step there is no
// stop of the batch, so the list is empty and nextOf names the next cleanup step as go on.
const ROWS = [
  { name: "T1 never signed (case a)", make: () => { const r = asPlanned(DEVICE, "T1").results; r.steps = r.steps.filter((s) => s.step !== "T1"); return runFolder(r); }, id: "T1", allow: "a", cleanup: [] },
  { name: "T2 signed, never sent (case d)", make: () => ownerSigned("T2", "T1"), id: "T2", allow: "d", cleanup: ["T9"] },
  { name: "T2 first send 1010 (case c)", make: () => withReading(ownerSigned("T2", "T1"), "T2", R1010("Transaction has a bad signature")), id: "T2", allow: "c", cleanup: ["T9"] },
  { name: "T2 first send 1013", make: () => withReading(ownerSigned("T2", "T1"), "T2", { status: "refused-at-submission", sent_by: "send", node: { code: 1013, message: "Already Imported", data: null } }), id: "T2", allow: null },
  { name: "T2 first send 1014", make: () => withReading(ownerSigned("T2", "T1"), "T2", { status: "refused-at-submission", sent_by: "send", node: { code: 1014, message: "Priority is too low", data: null } }), id: "T2", allow: null },
  { name: "T2 first send other code", make: () => withReading(ownerSigned("T2", "T1"), "T2", { status: "refused-at-submission", sent_by: "send", node: { code: 1012, message: "Transaction is temporarily banned", data: null } }), id: "T2", allow: null },
  { name: "T2 deadline", make: () => withReading(ownerSigned("T2", "T1"), "T2", { status: "deadline", sent_by: "send" }), id: "T2", allow: null },
  { name: "T2 connection-lost", make: () => withReading(ownerSigned("T2", "T1"), "T2", { status: "connection-lost", sent_by: "send" }), id: "T2", allow: null },
  { name: "T2 ended (dropped)", make: () => withReading(ownerSigned("T2", "T1"), "T2", { status: "ended", node_status: "dropped", sent_by: "send" }), id: "T2", allow: null },
  { name: "T2 deadline, then sendSame 1010", make: () => withReading(ownerSigned("T2", "T1"), "T2", R1010(null, "sendSame"), [{ sent: { status: "deadline", sent_by: "send" }, sent_sha256: "55".repeat(32) }]), id: "T2", allow: null },
  { name: "T2 find not-found", make: () => withReading(ownerSigned("T2", "T1"), "T2", { status: "not-found", sent_by: "find", step: null }, [{ sent: { status: "deadline", sent_by: "send" }, sent_sha256: "55".repeat(32) }]), id: "T2", allow: null },
  { name: "T2 1010 with sent_by missing", make: () => withReading(ownerSigned("T2", "T1"), "T2", { status: "refused-at-submission", node: { code: 1010, message: "x", data: null } }), id: "T2", allow: null },
  { name: "T2 1010 with sent_by find", make: () => withReading(ownerSigned("T2", "T1"), "T2", R1010(null, "find")), id: "T2", allow: null },
  { name: "T2 1010 as code text", make: () => withReading(ownerSigned("T2", "T1"), "T2", { status: "refused-at-submission", sent_by: "send", node: { code: "1010", message: "x", data: null } }), id: "T2", allow: null },
  { name: "T8 first send 1010 (case c, cleanup)", make: () => withReading(ownerSigned("T8", "T7"), "T8", R1010("Transaction has a bad signature")), id: "T8", allow: "c", cleanup: [], step: "T9" },
  { name: "T9 first send 1010 (case c, cleanup)", make: () => withReading(ownerSigned("T9", "T8"), "T9", R1010("Transaction has a bad signature")), id: "T9", allow: "c", cleanup: [], step: null },
  { name: "T3 never signed (case a)", make: () => runFolder(asPlanned(DEVICE, "T2").results), id: "T3", allow: "a", cleanup: ["T8", "T9"] },
  { name: "T5 never signed (case a)", make: () => runFolder(asPlanned(DEVICE, "T4").results), id: "T5", allow: "a", cleanup: ["T6", "T8", "T9"] },
  { name: "T4 never signed (case a)", make: () => runFolder(asPlanned(DEVICE, "T3").results), id: "T4", allow: "a", cleanup: ["T6", "T8", "T9"] },
  { name: "T6 never signed (case a, cleanup)", make: () => runFolder(asPlanned(DEVICE, "T5").results), id: "T6", allow: "a", cleanup: [], step: "T7" },
  { name: "T2 finalized", make: () => runFolder(asPlanned(DEVICE, "T2").results), id: "T2", allow: null },
];

test("review3 B HELD: the table of cases: a stop is recorded exactly where the rule allows it, and nextOf names the cleanup that applies", () => {
  const lines = [];
  for (const row of ROWS) {
    const run = row.make();
    const why = isRefused(() => stop(run, row.id));
    let got = why === null ? "allowed" : "refused";
    let r = null;
    if (why === null) r = stop(run, row.id);
    const ls = r?.steps.find((s) => s.step === row.id)?.lead_stop;
    lines.push(`${row.name}: ${got}${ls ? ` case ${ls.case}` : ""}`);
    if (row.allow === null) { assert.notEqual(why, null, `${row.name}: a stop must be refused`); continue; }
    assert.equal(why, null, `${row.name}: ${why}`);
    assert.equal(ls.case, row.allow, row.name);
    const n = nextOf(plan, r);
    assert.deepEqual(n.cleanup, row.cleanup, `${row.name}: cleanup`);
    if ("step" in row) assert.equal(n.step, row.step, `${row.name}: next`);
  }
  // console.log(lines.join("\n"));
});

test("review3 B HELD: a device copy refused with 1010 at a first send is not stopped by case c: case b's reads are needed", () => {
  const run = runFolder(asPlanned(DEVICE, "T2").results);
  const r = deviceReads(DEVICE, { number: 3600020, accountNonce: 0 });
  const out = cli("sign-device.mjs", ["T3", "--run", run, "--key", KEY, "--reads", r.text, "--reads-sha256", r.sha]);
  assert.equal(out.status, 0, out.stderr);
  withReading(run, "T3", R1010("Transaction has a bad signature"));
  assert.match(isRefused(() => stop(run, "T3")) ?? "", /case b needs the device's reads/);
});

test("review3 B HELD: sent_by changed in the relay text is refused by its sha256 (the pane's sha256 is of the text it made)", () => {
  const run = ownerSigned("T2", "T1");
  const rec = load(run);
  const signed = readJson(join(run, "signed", "T2.json"));
  const send = cli("record-step.mjs", ["send-file", "T2", "--run", run]);
  assert.equal(send.status, 0, send.stderr);
  const bundleSha = sha256Text(readFileSync(join(run, "signed", "T2.send.json"), "utf8"));
  const reading = { step: "T2", bundle_sha256: bundleSha, extrinsic_sha256: sha256Text(signed.extrinsic), extrinsic_hash: signed.extrinsic_hash, sent_by: "sendSame", submitted_utc: "x", statuses: [], status: "refused-at-submission", node: { code: 1010, message: "Invalid Transaction", data: null } };
  const text = JSON.stringify(reading);
  const sha = sha256Text(text);
  const changed = text.replace('"sent_by":"sendSame"', '"sent_by":"send"');
  const out = cli("record-step.mjs", ["step", "T2", "--run", run, "--sent", changed, "--sent-sha256", sha]);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /changed on its way/);
  void rec;
});

// ---- defects --------------------------------------------------------------------------------------

test("review3 B DEFECT (V2): case c takes a lone first-send 1010 whose node words say the nonce is used (outdated): the record says T1 never came on chain while it may be", async () => {
  // How the record gets there with the tools: a page without localStorage keeps the sent list in
  // memory. The lead's first lab.send of T1 is written to the node and its result is lost with the
  // tab (a pane call ends after 45 s; the promise lives on window). A fresh page has an empty sent
  // list, so lab.send of the same bundle is again a first send, and the node answers 1010 outdated
  // because the first copy is in a block. record-step records it (sent_by "send", no earlier reading).
  const pane = loadPane();
  const r = asPlanned(DEVICE, "T1").results;
  r.steps = r.steps.filter((s) => s.step !== "T1");
  const run = runFolder(r);
  planSigned(run, "T1", load(run));
  assert.equal(cli("record-step.mjs", ["send-file", "T1", "--run", run]).status, 0);
  const bundle = readFileSync(join(run, "signed", "T1.send.json"), "utf8");
  const written = [];
  const transport = (answer) => ({
    request: async () => { throw { code: -32601, message: "not scripted" }; },
    subscribe: async (m, params, u, on, onWrite) => { written.push(params[0]); onWrite(); if (answer) throw answer; return { unsubscribe() {} }; },
  });
  // first page: written, then the tab is gone before the result is read (the deadline is not waited for)
  const page1 = pane.createRunner({ transport: transport(null), deadlineMs: 50 });
  void page1.send(bundle, sha256Text(bundle));
  await new Promise((res) => setTimeout(res, 80));
  // second page, memory store again: the same bytes go out as a first send and are refused as outdated
  const page2 = pane.createRunner({ transport: transport({ code: 1010, message: "Invalid Transaction", data: "Transaction is outdated" }), deadlineMs: 1000 });
  const res = await page2.send(bundle, sha256Text(bundle));
  assert.equal(written.length, 2, "the same bytes were written twice, each as a first send");
  assert.equal(res.sent_by, "send");
  assert.equal(res.status, "refused-at-submission");
  const rec = recordReading({ plan, run, results: load(run), id: "T1", sent: JSON.parse(res.relay), sentSha256: res.relay_sha256, errors: null });
  save(run, rec);
  const why = isRefused(() => stop(run, "T1"));
  assert.notEqual(why, null, "a 1010 that says the nonce is used is evidence the copy may be on chain: the stop must be refused and name find (it was recorded as case c, and nextOf names no T9 for the FUND on the device)");
});

test("review3 B DEFECT (V2): the record cannot hold the pane's already-sent, so case d (never sent) is recorded after the pane said these bytes were sent", async () => {
  // The pane's sent list (localStorage) says the bytes went out; the result of that send was lost.
  // record-step refuses to record already-sent ("nothing was submitted by that call"), so the
  // record still holds no reading, and the stop by case d says the copy was never sent.
  const pane = loadPane();
  const run = ownerSigned("T2", "T1");
  assert.equal(cli("record-step.mjs", ["send-file", "T2", "--run", run]).status, 0);
  const bundle = readFileSync(join(run, "signed", "T2.send.json"), "utf8");
  const store = (() => { const m = new Set(); return { has: (k) => m.has(k), add: (k) => m.add(k) }; })();
  const transport = { request: async () => { throw { code: -32601, message: "x" }; }, subscribe: async (m, p, u, on, onWrite) => { onWrite(); return { unsubscribe() {} }; } };
  void pane.createRunner({ transport, store, deadlineMs: 50 }).send(bundle, sha256Text(bundle)); // the result is lost
  await new Promise((res) => setTimeout(res, 80));
  const res = await pane.createRunner({ transport, store, deadlineMs: 50 }).send(bundle, sha256Text(bundle));
  assert.equal(res.status, "already-sent");
  const out = cli("record-step.mjs", ["step", "T2", "--run", run, "--sent", res.relay, "--sent-sha256", res.relay_sha256]);
  const recorded = out.status === 0;
  const why = isRefused(() => stop(run, "T2"));
  assert.ok(recorded || why !== null, `already-sent was not recorded (${out.stderr.trim()}) and the stop was allowed as case d: the record says the lead says this copy was never sent`);
});

test("review3 B DEFECT (V2): case a says nothing was signed while the record holds a runner reading of the id (signed file gone)", () => {
  const run = withReading(ownerSigned("T2", "T1"), "T2", { status: "deadline", sent_by: "send" });
  unlinkSync(join(run, "signed", "T2.json"));
  assert.ok(!existsSync(join(run, "signed", "T2.send.json")));
  const why = isRefused(() => stop(run, "T2"));
  assert.notEqual(why, null, "the record holds a deadline reading of T2 (its copy may be in the pool): case a must not say nothing was signed");
});

test("review3 B DEFECT (V3): after case c on T1 for a fee the owner could not pay, what is left says nothing of the immortal copy the node was given, valid while the owner's nonce is unused", () => {
  const r = asPlanned(DEVICE, "T1").results;
  r.steps = r.steps.filter((s) => s.step !== "T1");
  const run = withReading((() => { const x = runFolder(r); planSigned(x, "T1", load(x)); return x; })(), "T1", R1010("Inability to pay some fees (e.g. account balance too low)"));
  const s = stop(run, "T1");
  const n = nextOf(plan, s);
  assert.equal(s.steps.find((e) => e.step === "T1").lead_stop.case, "c");
  assert.ok(n.left.some((l) => /T1/.test(l)), `nothing is left in words, while signed/T1.json is an immortal copy with the owner's nonce ${load(run).owner_account_nonce_at_start} that anyone holding the bytes can submit until that nonce is used: left = ${JSON.stringify(n.left)}`);
});
