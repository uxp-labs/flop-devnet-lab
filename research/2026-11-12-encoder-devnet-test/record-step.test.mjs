// Tests of record-step.mjs (R1 to R3): node --test in this folder. No network. The device key is
// made here in a temporary folder. The owner's signed files are stand ins written here: the owner's
// key is never used.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, RERUN, readJson, sha256Text, ss58 } from "./lib.mjs";
import { loadDeviceSigner, KEY_REFUSAL } from "./device-key.mjs";
import { recordForm } from "./record-step.mjs";
import { plan, V, H, RUNTIME, makeKey, tempDir, relay, deviceReads, explorerAnswer, startedRecord } from "./fixtures.mjs";

const SCRIPT = join(HERE, "record-step.mjs"), SIGN = join(HERE, "sign-device.mjs");
const DIR = tempDir("record-step-test");
after(() => rmSync(DIR, { recursive: true, force: true }));
const { path: KEY, seed } = makeKey(DIR);
const DEVICE = "0x" + Buffer.from(loadDeviceSigner(KEY).publicKey).toString("hex");
const errors = readJson(join(RERUN, "errors-1014020.json"));
const node = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: DIR });
const ownerReads = (o = {}) => relay({ account: ss58(V("OWNER")), runtime: RUNTIME, finalized: { number: 3599990, hash: H(3599990) }, account_nonce: 14, ...o });
let n = 0;
function started(o) {
  const run = join(DIR, `run-${n++}`);
  const r = ownerReads(o);
  const out = node(SCRIPT, ["start", "--run", run, "--key", KEY, "--reads", r.text, "--reads-sha256", r.sha]);
  return { run, out };
}
const record = (run) => readJson(join(run, "results.json"));
/** A stand in for the research signer's signed file of an owner step (the extrinsic is made up). */
function ownerSigned(run, id) {
  mkdirSync(join(run, "signed"), { recursive: true });
  const xt = "0x" + sha256Text(`owner ${id} ${run}`).repeat(3);
  const file = { what: `stand in for ${id}`, extrinsic: xt, extrinsic_hash: "0x" + sha256Text(xt) };
  writeFileSync(join(run, "signed", `${id}.json`), JSON.stringify(file, null, 2) + "\n");
  ok(node(SCRIPT, ["send-file", id, "--run", run]));
  return file;
}
/** The runner's relay of a send of a file in signed/. */
function sentRelay(run, id, { status = "finalized", block = 3600000, index = 2, bundle } = {}) {
  const text = bundle ?? readFileSync(join(run, "signed", `${id}.send.json`), "utf8");
  const xt = JSON.parse(readFileSync(join(run, "signed", `${id}.json`), "utf8")).extrinsic;
  const v = { step: id.startsWith("T1") || id.startsWith("T2") || id.startsWith("T8") || id.startsWith("T9") ? null : id, bundle_sha256: sha256Text(text), extrinsic_sha256: sha256Text(xt), extrinsic_hash: null, submitted_utc: "2026-11-13T02:00:00.000Z", statuses: ["ready", "inBlock", "finalized"], status };
  if (status === "finalized") Object.assign(v, { block_hash: H(block), block_number: block, extrinsic_index: index, events_sha256: "ab".repeat(32), events_length: 700, finalized_utc: "2026-11-13T02:00:09.000Z" });
  else Object.assign(v, { in_block: null, final: false, problem: "not in any block before the deadline" });
  return relay(v);
}
/** The explorer reader's relay of an answer. */
function explorerRelay(hash, blockHash, answer, read = "2026-11-13T02:01:00.000Z") {
  const keep = answer.events.filter((e) => ["computeChannel", "flopSessionKeys"].includes(e.section)).map(({ section, method, data }) => ({ section, method, data }));
  const last = answer.events[answer.events.length - 1];
  const error = last.section === "system" && last.method === "ExtrinsicFailed" ? { index: Number(last.data.dispatchError.Module.index), error: parseInt(last.data.dispatchError.Module.error.slice(2, 4), 16) } : null;
  return relay({ source: `${V("EXPLORER")}/api/transactions/${hash}`, read_utc: read, hash, block_hash: blockHash, success: answer.success, error, names: answer.events.map((e) => `${e.section}.${e.method}`), events: keep });
}
const step = (run, id, ...a) => node(SCRIPT, ["step", id, "--run", run, ...a]);
const sentArgs = (r) => ["--sent", r.text, "--sent-sha256", r.sha];
const exArgs = (r) => ["--explorer", r.text, "--explorer-sha256", r.sha];
const ok = (r) => { assert.equal(r.status, 0, r.stderr); return r; };
const commaed = (raw) => BigInt(raw).toLocaleString("en-US");
/** The events of an owner step's answer, in the explorer's names. */
const t2Events = () => [{ id: "1-0", section: "flopSessionKeys", method: "SessionCreated", data: { owner: ss58(V("OWNER")), delegate: ss58(DEVICE), spendingCap: commaed(V("A_CAP")), perTxLimit: commaed(V("A_PER_TX")), dailyCap: commaed(V("A_DAILY")), expiresAt: "3,607,206" } }];
/** Records T1 and T2 as planned. */
function throughT2(run) {
  for (const [id, block, events] of [["T1", 3600003, [{ id: "1-0", section: "balances", method: "Transfer", data: {} }]], ["T2", 3600006, t2Events()]]) {
    const f = ownerSigned(run, id);
    ok(step(run, id, ...sentArgs(sentRelay(run, id, { block }))));
    ok(step(run, id, ...exArgs(explorerRelay(f.extrinsic_hash, H(block), explorerAnswer({ events })))));
  }
}
function signT3(run, birth = 3600010) {
  const r = deviceReads(DEVICE, { number: birth, accountNonce: 0, sessionNonce: null });
  return ok(node(SIGN, ["T3", "--run", run, "--key", KEY, "--reads", r.text, "--reads-sha256", r.sha]));
}
const t3Answer = (o = {}) => explorerAnswer({ events: [
  { id: "2-0", section: "balances", method: "Transfer", data: { from: ss58(V("OWNER")), to: ss58(V("PALLET_ACCOUNT")), amount: commaed(V("ESCROW_1")) } },
  { id: "2-1", section: "computeChannel", method: "ForceOpenRequested", data: { channelId: o.channel ?? V("CH_T3"), agent: ss58(V("OWNER")), miner: ss58(V("NAMED")), escrow: commaed(V("ESCROW_1")), ackDeadline: "3,600,604" } },
  { id: "2-2", section: "flopSessionKeys", method: "SessionCallExecuted", data: { owner: ss58(V("OWNER")), delegate: ss58(DEVICE), spent: commaed(V("ESCROW_1")), epochSpent: commaed(V("ESCROW_1")) } }], ...o });

test("R1: start makes results.json from the template, a run time record of the owner's reads, and prints only the public key and the SS58 address", () => {
  const { run, out } = started();
  ok(out);
  assert.deepEqual(JSON.parse(out.stdout.trim()), { public_key: DEVICE, ss58: ss58(DEVICE) });
  assert.equal(out.stdout.trim().split("\n").length, 1, "no notice when the nonce is the one after the rerun");
  const r = record(run);
  assert.equal(r.record, "run-time");
  assert.deepEqual(r.accounts, { owner: { public_key: V("OWNER"), ss58: ss58(V("OWNER")) }, device: { public_key: DEVICE, ss58: ss58(DEVICE) } });
  assert.equal(r.owner_account_nonce_at_start, "14");
  assert.deepEqual(r.start.finalized, { number: 3599990, hash: H(3599990) });
  const fixture = startedRecord(DEVICE);
  assert.deepEqual(Object.keys(r).sort(), Object.keys(fixture).sort(), "the fixtures make what start makes");
  assert.deepEqual(r.steps, fixture.steps);
  for (const s of [seed.toString("base64"), seed.toString("hex")]) assert.ok(!(out.stdout + out.stderr + readFileSync(join(run, "results.json"), "utf8")).includes(s));
});

test("R1: start records another start nonce and prints a notice; it refuses a record that exists, other reads and a key that is not keygen's", () => {
  const { run, out } = started({ account_nonce: 15 });
  ok(out);
  assert.match(out.stdout, /notice: the owner's next nonce at the start is 15, not OWNER_NONCE_AFTER_RERUN 14/);
  assert.equal(record(run).owner_account_nonce_at_start, "15");
  const r = ownerReads();
  const again = node(SCRIPT, ["start", "--run", run, "--key", KEY, "--reads", r.text, "--reads-sha256", r.sha]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /exists: start never writes over a record/);
  assert.equal(record(run).owner_account_nonce_at_start, "15");
  assert.match(started({ account: ss58(DEVICE) }).out.stderr, /not the owner of steps.json/);
  assert.match(started({ runtime: { ...RUNTIME, specVersion: 1014021 } }).out.stderr, /specVersion is 1014021/);
  const bad = node(SCRIPT, ["start", "--run", join(DIR, "run-bad-sha"), "--key", KEY, "--reads", r.text, "--reads-sha256", sha256Text(r.text + " ")]);
  assert.match(bad.stderr, /changed on its way/);
  const k = join(DIR, "sr.json"); writeFileSync(k, JSON.stringify({ v: 0, alg: "sr25519", seed_b64: seed.toString("base64") }) + "\n");
  const wrongKey = node(SCRIPT, ["start", "--run", join(DIR, "run-bad-key"), "--key", k, "--reads", r.text, "--reads-sha256", r.sha]);
  assert.equal(wrongKey.stderr, `record-step: ${KEY_REFUSAL}\n`);
  assert.equal(existsSync(join(DIR, "run-bad-key", "results.json")), false);
});

test("R2: a step's run_time from the runner and the explorer: sha256s, the bundle of signed/, names and numbers in the record's form, and the judge's word", () => {
  const { run } = started();
  throughT2(run);
  const signed = JSON.parse(signT3(run).stdout.split("\n")[0]);
  const s = sentRelay(run, "T3", { block: 3600012 });
  const out = ok(step(run, "T3", ...sentArgs(s)));
  assert.match(out.stdout, /recorded T3: in finalized block 3600012 \(0x0+36ee8c\), as the node reported/);
  assert.match(out.stdout, /wait: the explorer reading of T3/);
  const ex = explorerRelay(signed.extrinsic_hash, H(3600012), t3Answer());
  const out2 = ok(step(run, "T3", ...exArgs(ex)));
  assert.match(out2.stdout, /the explorer says success/);
  assert.match(out2.stdout, /go on: the next step T4/);
  const rt = record(run).steps.find((x) => x.step === "T3").run_time;
  assert.equal(rt.sent_sha256, s.sha);
  assert.equal(rt.bundle_sha256, signed.send_sha256, "the bundle is the send file");
  assert.equal(rt.extrinsic_hash, signed.extrinsic_hash);
  assert.equal(rt.explorer.relay_sha256, ex.sha);
  assert.deepEqual(rt.explorer.names, ["Balances.Transfer", "ComputeChannel.ForceOpenRequested", "FlopSessionKeys.SessionCallExecuted", "System.ExtrinsicSuccess"]);
  assert.deepEqual(rt.explorer.events[0], { pallet: "ComputeChannel", name: "ForceOpenRequested", fields: { channel_id: V("CH_T3"), agent: V("OWNER"), miner: V("NAMED"), escrow: V("ESCROW_1"), ack_deadline: "3600604" } });
  assert.deepEqual(rt.explorer.events[1].fields, { owner: V("OWNER"), delegate: DEVICE, spent: V("ESCROW_1"), epoch_spent: V("ESCROW_1") });
  assert.deepEqual(Object.keys(rt).sort(), ["bundle_sha256", "earlier_copies", "earlier_readings", "explorer", "extrinsic_hash", "sent", "sent_sha256"], "the fixtures' form");
});

test("R2: the sha256s are checked, the bundle must be the step's file in signed/, and only the next step is recorded", () => {
  const { run } = started();
  ownerSigned(run, "T1");
  const s = sentRelay(run, "T1");
  assert.match(step(run, "T1", "--sent", s.text, "--sent-sha256", sha256Text(s.text + "x")).stderr, /changed on its way/);
  assert.match(step(run, "T1", "--sent", s.text).stderr, /--sent-sha256 is required/);
  assert.match(step(run, "T1", ...sentArgs(sentRelay(run, "T1", { bundle: "{}" }))).stderr, /the step's file in signed\/ has/);
  const other = JSON.parse(s.text); other.extrinsic_sha256 = "00".repeat(32);
  assert.match(step(run, "T1", ...sentArgs(relay(other))).stderr, /is not the one of signed\/T1.json/);
  ownerSigned(run, "T2");
  assert.match(step(run, "T2", ...sentArgs(sentRelay(run, "T2"))).stderr, /T2 is not next by the record: go on T1/);
  for (const nothing of ["not-sent", "already-sent", "refused-bundle", "not-in-sent-list"]) {
    const v = JSON.parse(s.text); v.status = nothing;
    assert.match(step(run, "T1", ...sentArgs(relay(v))).stderr, /nothing was submitted by that call/);
  }
  assert.equal(record(run).steps.find((x) => x.step === "T1").run_time, null, "nothing was written");
});

test("R2: a run_time that holds a finalized block is never replaced; one that does not is replaced and kept under earlier_readings", () => {
  const { run } = started();
  const f = ownerSigned(run, "T1");
  const late = sentRelay(run, "T1", { status: "deadline" });
  const w = ok(step(run, "T1", ...sentArgs(late)));
  assert.match(w.stdout, /recorded T1: the runner said deadline/);
  assert.match(w.stdout, /wait: T1 is sent and not in a finalized block \(the runner said deadline\)/);
  assert.match(step(run, "T1", ...exArgs(explorerRelay(f.extrinsic_hash, H(1), explorerAnswer({ events: [] })))).stderr, /no finalized block for T1/);
  const fin = sentRelay(run, "T1", { block: 3600003 });
  ok(step(run, "T1", ...sentArgs(fin)));
  const rt = record(run).steps.find((x) => x.step === "T1").run_time;
  assert.equal(rt.sent.status, "finalized");
  assert.deepEqual(rt.earlier_readings, [{ sent: JSON.parse(late.text), sent_sha256: late.sha }]);
  const again = step(run, "T1", ...sentArgs(sentRelay(run, "T1", { block: 3600009 })));
  assert.equal(again.status, 2);
  assert.match(again.stderr, /never replaced|not next by the record/);
  assert.equal(record(run).steps.find((x) => x.step === "T1").run_time.sent.block_number, 3600003);
  ok(step(run, "T1", ...exArgs(explorerRelay(f.extrinsic_hash, H(3600003), explorerAnswer({ events: [] })))));
  assert.match(step(run, "T1", ...exArgs(explorerRelay(f.extrinsic_hash, H(3600003), explorerAnswer({ events: [] }), "2026-11-13T03:00:00.000Z"))).stderr, /holds an explorer reading of T1: it is not replaced/);
});

test("R2: the explorer's hash must be the step's extrinsic hash, its block hash the runner's, and every channelId the derived one", () => {
  const { run } = started();
  throughT2(run);
  const signed = JSON.parse(signT3(run).stdout.split("\n")[0]);
  ok(step(run, "T3", ...sentArgs(sentRelay(run, "T3", { block: 3600012 }))));
  const otherHash = JSON.parse(explorerRelay(signed.extrinsic_hash, H(3600012), t3Answer()).text); otherHash.hash = "0x" + "99".repeat(32);
  assert.match(step(run, "T3", ...exArgs(relay(otherHash))).stderr, /is not the extrinsic hash/);
  assert.match(step(run, "T3", ...exArgs(explorerRelay(signed.extrinsic_hash, H(3600013), t3Answer()))).stderr, /is not the runner's/);
  const wrong = step(run, "T3", ...exArgs(explorerRelay(signed.extrinsic_hash, H(3600012), t3Answer({ channel: "0x" + "77".repeat(32) }))));
  assert.match(wrong.stderr, /channelId 0x7{64} in ComputeChannel.ForceOpenRequested is not the derived channel id/);
  assert.equal(record(run).steps.find((x) => x.step === "T3").run_time.explorer, null);
  const src = JSON.parse(explorerRelay(signed.extrinsic_hash, H(3600012), t3Answer()).text); src.source = "https://elsewhere.example/api/transactions/" + signed.extrinsic_hash;
  assert.match(step(run, "T3", ...exArgs(relay(src))).stderr, /source is https:\/\/elsewhere/);
});

test("R2: an error is named by the 1014020 table from the pallet index and the error index; a stop prints the plan's row and the cleanup steps that apply", () => {
  const { run } = started();
  throughT2(run);
  const signed = JSON.parse(signT3(run).stdout.split("\n")[0]);
  ok(step(run, "T3", ...sentArgs(sentRelay(run, "T3", { block: 3600012 }))));
  const out = ok(step(run, "T3", ...exArgs(explorerRelay(signed.extrinsic_hash, H(3600012), explorerAnswer({ success: false, events: [], failedWith: { Module: { index: "94", error: "0x14000000" } } })))));
  const e = errors.errors.find((x) => x.pallet_index === 94 && x.error_index === 20);
  assert.deepEqual(record(run).steps.find((x) => x.step === "T3").run_time.explorer.error, { pallet_index: 94, error_index: 20, name: `${e.pallet}.${e.name}` });
  assert.match(out.stdout, new RegExp(`refused with ${e.pallet}.${e.name}`));
  assert.match(out.stdout, /^stop at T3: /m);
  assert.match(out.stdout, /cleanup steps that apply: T8, T9/);
  assert.match(out.stdout, /next: T8/);
});

test("R3: the run time record says what it is: record run-time, explorer readings with source and read_utc, nothing called verified, no balance written", () => {
  const { run } = started();
  throughT2(run);
  const r = record(run);
  assert.equal(r.record, "run-time");
  const { what, events_form, reads_form, run_time_form, ...data } = r;
  assert.match(what, /Nothing in it is called verified/);
  assert.doesNotMatch(JSON.stringify(data), /verif/i);
  for (const st of r.steps.filter((x) => x.run_time?.explorer)) {
    assert.match(st.run_time.explorer.source, new RegExp(`^${V("EXPLORER").replace(/\./g, "\\.")}/api/transactions/0x[0-9a-f]{64}$`));
    assert.ok(Date.parse(st.run_time.explorer.read_utc));
    assert.ok(st.run_time.sent.block_hash && st.run_time.sent.status === "finalized", "a block is named finalized with its hash");
  }
  const balances = [r.before.accounts, ...r.steps.map((x) => x.after.accounts)].flatMap((a) => Object.values(a)).flatMap((a) => [a.free, a.reserved]);
  assert.ok(balances.every((b) => b === null), "no balance at run time");
  assert.equal(r.balances_source, null);
});

test("R2: the record's form of the explorer's values: commas out, SS58 accounts as hex, camel case keys as snake case", () => {
  assert.equal(recordForm("3,553,433"), "3553433");
  assert.equal(recordForm("0"), "0");
  assert.equal(recordForm(ss58(V("OWNER"))), V("OWNER"));
  assert.equal(recordForm("BF16"), "BF16");
  assert.deepEqual(recordForm({ channelId: "0xab", epochSpent: "1,000", class: { type: "TeeToploc" } }), { channel_id: "0xab", epoch_spent: "1000", class: { type: "TeeToploc" } });
  assert.equal(recordForm(42), "42");
});
