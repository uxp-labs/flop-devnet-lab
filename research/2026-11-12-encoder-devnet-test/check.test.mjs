// Tests of check.mjs and judge.mjs (rules R7, R8 of the first brief; C1 to C7 of the fix brief):
// node --test in this folder. No network, no key. A synthetic final record built from steps.json
// must pass, and each wrong outcome must be caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, RERUN, readJson, loadPlan, rerunFee } from "./lib.mjs";
import { context, judgeRun, recordedExpectation } from "./judge.mjs";
import { template } from "./plan.mjs";
import { judgeStep } from "../2026-11-12-session-rerun-1014020/rerun-lib.mjs";

const plan = loadPlan();
const errors = readJson(join(RERUN, "errors-1014020.json"));
const V = (n) => plan.values[n].value;
const OWNER = V("OWNER"), NAMED = V("NAMED"), PALLET = V("PALLET_ACCOUNT");
const DEVICE = "0x" + "d1".repeat(32);
const CH3 = V("CH_T3"), CH5 = V("CH_T5");
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const err = (name) => { const [p, n] = name.split("."); const e = errors.errors.find((x) => x.pallet === p && x.name === n); return { index: e.pallet_index, error: "0x" + e.error_index.toString(16).padStart(2, "0") + "000000" }; };
const ev = (pallet, name, fields) => ({ pallet, name, fields });

/**
 * A run as the chain would answer it if every step went as planned, with T4 and T5 answering as
 * given (a success, or the name of an error), and every read consistent with what moved.
 */
function syntheticRun({ t4 = "ComputeChannel.BadState", t5 = "success", t3 = "success", skip = [] } = {}) {
  const r = template(plan);
  r.record = "final";
  r.balances_source = "by position";
  r.accounts = { owner: { public_key: OWNER, ss58: "o" }, device: { public_key: DEVICE, ss58: "d" } };
  r.owner_account_nonce_at_start = V("OWNER_NONCE_AFTER_RERUN");
  const acct = { owner: { free: 24000000000000000000n, reserved: 0n, nonce: BigInt(V("OWNER_NONCE_AFTER_RERUN")) }, device: null };
  const snap = () => ({ owner: { free: acct.owner.free.toString(), reserved: "0", nonce: acct.owner.nonce.toString(), absent: null }, device: acct.device ? { free: acct.device.free.toString(), reserved: "0", nonce: acct.device.nonce.toString(), absent: null } : { free: null, reserved: null, nonce: null, absent: true } });
  r.before = { ...r.before, block_number: 3599999, block_hash: H(3599999), accounts: snap() };
  let block = 3600000, sessionNonce = 0n, spent = 0n, active = null, ackDeadline = null, t5Block = null, t3Block = null;
  const outcome = { T3: t3, T4: t4, T5: t5 };
  const ok = (id) => (outcome[id] ?? "success") === "success";
  const steps = [];
  for (const st of plan.steps) {
    if (skip.includes(st.id)) continue;
    if (st.id === "T6" && !ok("T3")) continue;
    if (st.id === "T7" && (!ok("T5") || skip.includes("T5"))) continue;
    if (st.id === "T6") block = Math.max(ackDeadline, t3Block + Number(V("ACK_WINDOW"))) + 1;
    if (st.id === "T7") block = Math.max(block, t5Block + Number(V("MAX_DURATION_D2")) + 1);
    block += 5;
    const fee = BigInt(rerunFee(st.fee_like) ?? "5000000000000000");
    const signer = st.signer === "owner" ? OWNER : DEVICE;
    const payer = acct[st.signer];
    const nonce = payer.nonce;
    payer.free -= fee; payer.nonce += 1n;
    const events = [];
    const success = ok(st.id);
    const moveFromOwner = (amount) => { acct.owner.free -= amount; events.push(ev("Balances", "Transfer", { from: OWNER, to: PALLET, amount: amount.toString() })); };
    const moveToOwner = (amount) => { acct.owner.free += amount; events.push(ev("Balances", "Transfer", { from: PALLET, to: OWNER, amount: amount.toString() })); };
    const executed = (declared) => { sessionNonce += 1n; spent += declared; events.push(ev("FlopSessionKeys", "SessionCallExecuted", { owner: OWNER, delegate: DEVICE, spent: spent.toString(), epoch_spent: spent.toString() })); };
    if (success) {
      if (st.id === "T1") { acct.owner.free -= BigInt(V("FUND")); acct.device = { free: BigInt(V("FUND")), reserved: 0n, nonce: 0n }; acct.device.free; events.push(ev("Balances", "Transfer", { from: OWNER, to: DEVICE, amount: V("FUND") })); }
      if (st.id === "T2") { active = "true"; events.push(ev("FlopSessionKeys", "SessionCreated", { owner: OWNER, delegate: DEVICE, spending_cap: V("A_CAP"), per_tx_limit: V("A_PER_TX"), daily_cap: V("A_DAILY"), expires_at: block + 7200 })); }
      if (st.id === "T3") { moveFromOwner(BigInt(V("ESCROW_1"))); ackDeadline = block + 595; t3Block = block; events.push(ev("ComputeChannel", "ForceOpenRequested", { channel_id: CH3, agent: OWNER, miner: NAMED, escrow: V("ESCROW_1"), ack_deadline: ackDeadline })); executed(BigInt(V("ESCROW_1"))); }
      if (st.id === "T4") { moveFromOwner(BigInt(V("TOP_UP"))); events.push(ev("ComputeChannel", "EscrowToppedUp", { channel_id: CH3, added: V("TOP_UP"), total: "11000000000000000" })); executed(BigInt(V("TOP_UP"))); }
      if (st.id === "T5") { moveFromOwner(BigInt(V("ESCROW_1"))); t5Block = block; events.push(ev("ComputeChannel", "ChannelOpened", { channel_id: CH5, agent: OWNER, miner: NAMED, escrow: V("ESCROW_1"), measured_root: V("ROOT") })); executed(BigInt(V("ESCROW_1"))); }
      if (st.id === "T6") { const back = BigInt(V("ESCROW_1")) + (ok("T4") ? BigInt(V("TOP_UP")) : 0n); moveToOwner(back); events.push(ev("ComputeChannel", "ForceOpenExpired", { channel_id: CH3, miner: NAMED, refunded: back.toString(), failed_acks: "0" })); executed(0n); }
      if (st.id === "T7") { moveToOwner(BigInt(V("ESCROW_1"))); events.push(ev("ComputeChannel", "TimedOutRefunded", { channel_id: CH5, refunded: V("ESCROW_1") })); executed(0n); }
      if (st.id === "T8") { active = "false"; events.push(ev("FlopSessionKeys", "SessionRevoked", { owner: OWNER, delegate: DEVICE })); }
      if (st.id === "T9") { const rest = acct.device.free; acct.owner.free += rest; acct.device = null; events.push(ev("System", "KilledAccount", { account: DEVICE }), ev("Balances", "Transfer", { from: DEVICE, to: OWNER, amount: rest.toString() })); }
      events.push(ev("TransactionPayment", "TransactionFeePaid", { who: signer, actual_fee: fee.toString(), tip: "0" }), ev("System", "ExtrinsicSuccess", { dispatch_info: {} }));
    } else {
      events.push(ev("TransactionPayment", "TransactionFeePaid", { who: signer, actual_fee: fee.toString(), tip: "0" }), ev("System", "ExtrinsicFailed", { dispatch_error: { type: "Module", value: err(outcome[st.id]) }, dispatch_info: {} }));
    }
    const rec = r.steps.find((s) => s.step === st.id);
    Object.assign(rec, { signer, account_nonce: nonce.toString(), extrinsic_hash: H(block * 7), finalized_in_block: block, block_hash: H(block), extrinsic_index: 2,
      last_runtime_upgrade_spec: plan.spec_version, events_value_sha256: "00".repeat(32), events, result: success ? "success" : `failed: ${outcome[st.id]}`, fee_raw: fee.toString() });
    rec.after = { accounts: snap(), session: { active, spent_raw: active === null ? null : spent.toString(), epoch_spent_raw: active === null ? null : spent.toString() }, session_nonce: active === null ? null : sessionNonce.toString(), breaker_tx_count: "1" };
    steps.push(st.id);
  }
  r.steps = r.steps.filter((s) => steps.includes(s.step));
  return r;
}

const judge = (r) => judgeRun(context(r));
const status = (out) => Object.fromEntries(out.run.map((x) => [x.id, x.status]));
const problemsOf = (out, id) => out.run.find((x) => x.id === id).problems.join("\n");
const recIn = (r, id) => r.steps.find((s) => s.step === id);

test("R7: results.template.json is what plan.mjs template prints", () => {
  assert.deepEqual(readJson(join(HERE, "results.template.json")), template(plan));
});

test("R7: a run as planned passes whole: T4 refused with a named error, T5 opened, T7 closed it", () => {
  const out = judge(syntheticRun());
  assert.deepEqual(out.top, []);
  assert.deepEqual(out.left, []);
  for (const r of out.run) assert.equal(r.status, "pass", `${r.id}: ${r.problems.join("; ")}`);
  assert.equal(out.all, true);
});

test("R7: recorded, not expected: T4 succeeding and T5 refused with a named error both pass; T7 is then not needed", () => {
  const out = judge(syntheticRun({ t4: "success", t5: "ComputeChannel.MeasuredRootRejected" }));
  assert.deepEqual(out.left, []);
  assert.equal(status(out).T4, "pass");
  assert.equal(status(out).T5, "pass");
  assert.equal(status(out).T7, "not needed");
  assert.equal(status(out).T6, "pass", "the refund of T6 holds the top up");
  assert.equal(out.all, true);
});

test("R7: the rerun's judgeStep alone cannot judge a recorded step: the addition is needed", () => {
  const r = syntheticRun();
  const step = plan.steps.find((s) => s.id === "T4");
  const ctx = context(r);
  const plain = judgeStep({ ...step, nonce: 1, reads_after: {} }, recIn(r, "T4"), ctx);
  assert.equal(plain.status, "differs", "as it stands it reads expect \"recorded\" as an error name");
  assert.equal(recordedExpectation(step, recIn(r, "T4"), errors).expect, "ComputeChannel.BadState");
});

test("R7: a recorded step whose error the 1014020 table does not name differs, and the batch stops there", () => {
  const r = syntheticRun();
  recIn(r, "T4").events.find((e) => e.name === "ExtrinsicFailed").fields.dispatch_error = { type: "Module", value: { index: 4, error: "0x02000000" } };
  let out = judge(r);
  assert.equal(status(out).T4, "differs");
  assert.match(problemsOf(out, "T4"), /not named by the 1014020 table/);
  assert.equal(out.stoppedAt, "T4");
  assert.equal(status(out).T5, "differs");
  assert.match(problemsOf(out, "T5"), /sent after T4 went wrong/);
  assert.equal(status(out).T6, "pass", "the cleanup after a stop is judged as usual");
  const r2 = syntheticRun();
  recIn(r2, "T4").events.find((e) => e.name === "ExtrinsicFailed").fields.dispatch_error = { type: "Other", value: null };
  assert.match(problemsOf(judge(r2), "T4"), /not a module error/);
});

test("R7: a recorded step's allowed pallets are held: an error of a pallet not listed differs", () => {
  const changed = structuredClone(plan);
  changed.steps.find((s) => s.id === "T4").errors_allowed_of = ["FlopSessionKeys"];
  const r = syntheticRun();
  assert.match(recordedExpectation(changed.steps[3], recIn(r, "T4"), errors).problem, /ComputeChannel.BadState is not an error of FlopSessionKeys/);
});


test("R7 C5: SpendExceedsDeclared at T3 is a finding about rule E5, and the batch stops; the cleanup still passes", () => {
  const r = syntheticRun({ t3: "FlopSessionKeys.SpendExceedsDeclared", skip: ["T4", "T5"] });
  const out = judge(r);
  assert.equal(status(out).T3, "differs");
  assert.match(out.findings.join("\n"), /T3: FlopSessionKeys.SpendExceedsDeclared: the encoder's rule E5/);
  assert.equal(out.stoppedAt, "T3");
  assert.equal(status(out).T4, "not sent: stopped");
  assert.equal(status(out).T6, "not needed");
  assert.equal(status(out).T8, "pass");
  assert.equal(status(out).T9, "pass");
  assert.deepEqual(out.left, []);
  assert.equal(out.verdict, "stopped at T3, cleanup complete, nothing left (balances: by position)");
  assert.equal(out.all, false);
});

test("R7: an open that moves more than the escrow out of the owner is caught, in free and in reserved", () => {
  const r = syntheticRun();
  for (const s of r.steps.slice(r.steps.findIndex((x) => x.step === "T5"))) s.after.accounts.owner.free = (BigInt(s.after.accounts.owner.free) - 7n).toString();
  let out = judge(r);
  assert.match(problemsOf(out, "T5"), /the owner's free balance moved by -10000000000000007, the plan's moves and the fee say -10000000000000000/);
  assert.equal(status(out).T6, "pass", "each step is judged against the read before it");
  const r2 = syntheticRun();
  for (const s of r2.steps.slice(r2.steps.findIndex((x) => x.step === "T5"))) s.after.accounts.owner.reserved = "1";
  out = judge(r2);
  assert.match(problemsOf(out, "T5"), /the owner's reserved balance moved by 1, the plan says 0/);
});

test("R7: the device's balance must fall by exactly its fee", () => {
  const r = syntheticRun();
  for (const s of r.steps.slice(r.steps.findIndex((x) => x.step === "T3"), r.steps.findIndex((x) => x.step === "T9"))) s.after.accounts.device.free = (BigInt(s.after.accounts.device.free) - 1n).toString();
  const out = judge(r);
  assert.match(problemsOf(out, "T3"), /the device's free balance moved by -9422731810000001, the plan's moves and the fee say -9422731810000000/);
});

test("R7: the refund must return what the steps moved: T6 with the top up when T4 moved one", () => {
  const r = syntheticRun({ t4: "success" });
  const t6 = recIn(r, "T6");
  t6.events.find((e) => e.name === "ForceOpenExpired").fields.refunded = String(BigInt(V("ESCROW_1")) + BigInt(V("TOP_UP")) - 1n);
  const out = judge(r);
  assert.match(problemsOf(out, "T6"), /ForceOpenExpired.refunded is 10999999999999999, the moves it returns add up to 11000000000000000/);
  assert.match(out.verdict, /^failed: /);
});

test("R7: the session's nonce and spent are read after each step and must count the session calls that succeeded", () => {
  const r = syntheticRun();
  recIn(r, "T4").after.session_nonce = "2";
  const out = judge(r);
  assert.match(problemsOf(out, "T4"), /read session_nonce is 2, expected 1/);
  const r2 = syntheticRun();
  recIn(r2, "T8").after.session.active = "true";
  assert.match(problemsOf(judge(r2), "T8"), /read active is true, expected false/);
});

test("R7: a missing read leaves a step incomplete, never passed: unknown is not 0", () => {
  const r = syntheticRun();
  recIn(r, "T5").after.accounts.owner.free = null;
  const out = judge(r);
  assert.equal(status(out).T5, "incomplete");
  assert.equal(out.all, false);
});

test("R8: T6 sent before the ack deadline of T3 differs, and T7 before max_duration of T5 differs", () => {
  const r = syntheticRun();
  const deadline = recIn(r, "T3").events.find((e) => e.name === "ForceOpenRequested").fields.ack_deadline;
  recIn(r, "T6").finalized_in_block = deadline;
  assert.match(problemsOf(judge(r), "T6"), /not after/);
  const r2 = syntheticRun();
  recIn(r2, "T7").finalized_in_block = recIn(r2, "T5").finalized_in_block + Number(V("MAX_DURATION_D2"));
  assert.match(problemsOf(judge(r2), "T7"), /not after/);
});

test("R8: a needed cleanup step not run leaves something on chain, and the run does not pass", () => {
  const r = syntheticRun({ skip: ["T7"] });
  const out = judge(r);
  assert.equal(status(out).T7, "not run");
  assert.equal(out.left.length, 1);
  assert.match(out.left[0], /the escrow of T5 stays in the pallet account/);
  assert.equal(out.all, false);
});

test("R8: a step sent though its condition does not hold differs", () => {
  const r = syntheticRun({ t5: "ComputeChannel.MeasuredRootRejected" });
  const t7 = structuredClone(recIn(syntheticRun(), "T7"));
  r.steps.splice(r.steps.findIndex((s) => s.step === "T8"), 0, t7);
  assert.match(problemsOf(judge(r), "T7"), /sent though its condition does not hold/);
});

test("the owner's nonce at the start must be the one after the rerun", () => {
  const r = syntheticRun();
  r.owner_account_nonce_at_start = "15";
  assert.match(judge(r).top.join("\n"), /something else was sent from the owner/);
});

test("check.mjs exits 0 on a run as planned and 1 otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "encoder-check-"));
  try {
    const good = join(dir, "good.json"), bad = join(dir, "bad.json");
    writeFileSync(good, JSON.stringify(syntheticRun()));
    const b = syntheticRun(); recIn(b, "T3").after.accounts.owner.reserved = "5";
    writeFileSync(bad, JSON.stringify(b));
    const g = spawnSync(process.execPath, [join(HERE, "check.mjs"), good], { encoding: "utf8" });
    assert.equal(g.status, 0, g.stdout);
    assert.match(g.stdout, /9 pass, 0 differ, 0 incomplete, 0 not needed, 0 not run/);
    assert.match(g.stdout, /^verdict: passed as planned \(balances: by position\)$/m);
    assert.equal(spawnSync(process.execPath, [join(HERE, "check.mjs"), bad], { encoding: "utf8" }).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the fix round: C1 to C7 ----------------------------------------------------------------------
import { nextOf, recordProblems } from "./judge.mjs";
import { asPlanned, runFolder as runFolderOf } from "./fixtures.mjs";

const cliCheck = (r) => { const dir = mkdtempSync(join(tmpdir(), "encoder-check-")); try { const f = join(dir, "r.json"); writeFileSync(f, JSON.stringify(r)); return spawnSync(process.execPath, [join(HERE, "check.mjs"), f], { encoding: "utf8" }); } finally { rmSync(dir, { recursive: true, force: true }); } };

test("C1: a run time record is judged by order, outcomes and the explorer's events; it says go on, wait or stop at, never passed, and check.mjs exits 3", () => {
  const all = asPlanned(DEVICE, "T9").results;
  const out = judge(all);
  assert.equal(out.kind, "run-time");
  assert.equal(out.all, false);
  assert.equal(out.word, "go on: nothing is left to send");
  const c = cliCheck(all);
  assert.equal(c.status, 3);
  assert.match(c.stdout, /^run time record: go on/m);
  assert.doesNotMatch(c.stdout, /pass/i);
  const stop = asPlanned(DEVICE, "T3", { outcomes: { T3: "ComputeChannel.BadState" }, errors }).results;
  assert.match(judge(stop).word, /^stop at T3: /);
  const w = asPlanned(DEVICE, "T2").results; w.steps.find((s) => s.step === "T2").run_time.explorer = null;
  assert.equal(judge(w).word, "wait: the explorer reading of T2");
  const none = syntheticRun(); delete none.record;
  assert.match(judge(none).verdict, /^failed: results.json says record null/);
});

test("C2: the blocks of the recorded steps rise in the plan's order across signers, and a step id or an extrinsic hash twice fails the record", () => {
  const r = syntheticRun();
  recIn(r, "T8").finalized_in_block = recIn(r, "T5").finalized_in_block + 1;
  recIn(r, "T8").block_hash = H(recIn(r, "T8").finalized_in_block);
  assert.match(judge(r).verdict, /^failed: .*T8 is in block \d+ at index 2, not after T7/);
  const same = syntheticRun();
  recIn(same, "T4").finalized_in_block = recIn(same, "T3").finalized_in_block;
  recIn(same, "T4").block_hash = recIn(same, "T3").block_hash;
  recIn(same, "T4").extrinsic_index = 1;
  assert.match(judge(same).verdict, /T4 is in block \d+ at index 1, not after T3 \(block \d+ at index 2\)/, "then the extrinsic index");
  const twice = syntheticRun();
  twice.steps.push(structuredClone(recIn(twice, "T4")));
  assert.match(judge(twice).verdict, /the record holds T4 twice/);
  const hash = syntheticRun();
  recIn(hash, "T5").extrinsic_hash = recIn(hash, "T4").extrinsic_hash;
  assert.match(judge(hash).verdict, /is recorded twice, as T4 and T5/);
  const rt = asPlanned(DEVICE, "T4").results;
  rt.steps.find((s) => s.step === "T4").run_time.sent.block_number = rt.steps.find((s) => s.step === "T3").run_time.sent.block_number - 1;
  const n = nextOf(plan, rt);
  assert.equal(n.word, "stop");
  assert.equal(n.step, null, "a broken run time record lets nothing be signed");
  assert.equal(recordProblems(plan, rt).length, 1);
});

/** A final record whose T6 was refused once and then attempted again as T6.2 with success. */
function withAttempt() {
  const r = syntheticRun({ t4: "success" });
  const i = r.steps.findIndex((s) => s.step === "T6");
  const ok = r.steps[i], failed = structuredClone(ok);
  const fee = BigInt(failed.fee_raw);
  failed.events = [ev("TransactionPayment", "TransactionFeePaid", { who: DEVICE, actual_fee: String(fee), tip: "0" }), ev("System", "ExtrinsicFailed", { dispatch_error: { type: "Module", value: err("ComputeChannel.AckWindowNotElapsed") }, dispatch_info: {} })];
  failed.finalized_in_block -= 2; failed.block_hash = H(failed.finalized_in_block); failed.extrinsic_hash = H(7777);
  const prev = r.steps[i - 1].after;
  failed.after = structuredClone(prev);
  failed.after.accounts.device.free = String(BigInt(prev.accounts.device.free) - fee);
  failed.after.accounts.device.nonce = String(BigInt(prev.accounts.device.nonce) + 1n);
  const retry = { ...ok, step: "T6.2", account_nonce: String(BigInt(ok.account_nonce) + 1n) };
  r.steps.splice(i, 1, failed, retry);
  for (const s of r.steps.slice(i + 1)) {
    if (s.signer === DEVICE && s !== retry) s.account_nonce = String(BigInt(s.account_nonce) + 1n);
    const acc = s.after.accounts.device;
    if (acc.free !== null) { acc.free = String(BigInt(acc.free) - fee); acc.nonce = String(BigInt(acc.nonce) + 1n); }
  }
  const t9 = recIn(r, "T9"); const tr = t9.events.find((e) => e.name === "Transfer"); tr.fields.amount = String(BigInt(tr.fields.amount) - fee);
  for (const s of r.steps.slice(r.steps.indexOf(t9))) s.after.accounts.owner.free = String(BigInt(s.after.accounts.owner.free) - fee);
  return { r, fee };
}

test("C3: a cleanup step refused once and attempted again as T6.2 passes; the failed attempt's fee is counted in the balance check", () => {
  const { r } = withAttempt();
  const out = judge(r);
  assert.equal(out.verdict, "passed as planned (balances: by position)", JSON.stringify(out.run.filter((x) => x.status !== "pass")));
  assert.match(out.run.find((x) => x.id === "T6").info.join(" "), /refused, attempted again: ComputeChannel.AckWindowNotElapsed/);
  const noFee = withAttempt().r;
  recIn(noFee, "T6").after.accounts.device.free = recIn(noFee, "T5").after.accounts.device.free;
  assert.match(judge(noFee).verdict, /^failed: .*T6: the device's free balance moved by 0/);
  const t32 = syntheticRun(); recIn(t32, "T3").step = "T3.2";
  assert.match(judge(t32).verdict, /T3.2 the plan does not have, and it is not an attempt S5 allows/);
});

test("C3: the verdicts: a cleanup step refused and not attempted again stops the batch there and names what is left", () => {
  const r = syntheticRun({ t4: "success" });
  const t6 = recIn(r, "T6");
  const fee = BigInt(t6.fee_raw);
  t6.events = [ev("TransactionPayment", "TransactionFeePaid", { who: DEVICE, actual_fee: String(fee), tip: "0" }), ev("System", "ExtrinsicFailed", { dispatch_error: { type: "Module", value: err("ComputeChannel.AckWindowNotElapsed") }, dispatch_info: {} })];
  // the record after T6 keeps the escrow in the pallet: the owner gets nothing back
  const back = BigInt(V("ESCROW_1")) + BigInt(V("TOP_UP"));
  for (const s of r.steps.slice(r.steps.indexOf(t6))) s.after.accounts.owner.free = String(BigInt(s.after.accounts.owner.free) - back);
  for (const s of r.steps.slice(r.steps.indexOf(t6))) s.after.session.spent_raw = s.after.session.epoch_spent_raw = s.after.session.spent_raw;
  for (const s of r.steps.slice(r.steps.indexOf(t6))) s.after.session_nonce = String(BigInt(s.after.session_nonce) - 1n);
  const out = judge(r);
  assert.match(out.verdict, /^stopped at T6, left: T6 was refused: the escrow of T3/);
  assert.equal(status(out).T6, "pass", "the refused attempt itself is a consistent record");
  assert.match(out.run.find((x) => x.id === "T6").info.join(" "), /refused: ComputeChannel.AckWindowNotElapsed/);
  assert.equal(out.all, false);
});

test("C4: a final record must say where its balances come from, and the verdict prints it", () => {
  const r = syntheticRun();
  r.balances_source = null;
  assert.match(judge(r).verdict, /^failed: balances_source is null: a final record says "decoder" or "by position"/);
  r.balances_source = "decoder";
  assert.equal(judge(r).verdict, "passed as planned (balances: decoder)");
  r.balances_source = "guess";
  assert.equal(judge(r).all, false);
});

test("C5: SpendExceedsDeclared on T4 or T5 is a finding the verdict prints, and the step still counts as recorded", () => {
  for (const id of ["T4", "T5"]) {
    const r = syntheticRun(id === "T4" ? { t4: "FlopSessionKeys.SpendExceedsDeclared" } : { t5: "FlopSessionKeys.SpendExceedsDeclared" });
    const out = judge(r);
    assert.equal(status(out)[id], "pass", JSON.stringify(out.run.find((x) => x.id === id)));
    assert.match(out.findings.join("\n"), new RegExp(`${id}: FlopSessionKeys.SpendExceedsDeclared: the encoder's declared spend for`));
    assert.equal(out.verdict, "passed as planned (balances: by position)");
    const c = cliCheck(r);
    assert.match(c.stdout, new RegExp(`^FINDING ${id}: FlopSessionKeys.SpendExceedsDeclared`, "m"));
    const rt = asPlanned(DEVICE, id, { outcomes: { [id]: "FlopSessionKeys.SpendExceedsDeclared" }, errors }).results;
    const n = nextOf(plan, rt);
    assert.equal(n.word, "go on", "at run time too it counts as recorded");
    assert.match(n.findings.join("\n"), /SpendExceedsDeclared/);
  }
});

test("C6: T6 refunding the escrow alone after T4 succeeded is not a failed record: the verdict says the top up is left under the channel of T3", () => {
  const r = syntheticRun({ t4: "success" });
  const t6 = recIn(r, "T6");
  t6.events.find((e) => e.name === "ForceOpenExpired").fields.refunded = V("ESCROW_1");
  t6.events.find((e) => e.name === "Transfer" && e.fields.to === OWNER).fields.amount = V("ESCROW_1");
  for (const s of r.steps.slice(r.steps.indexOf(t6))) s.after.accounts.owner.free = String(BigInt(s.after.accounts.owner.free) - BigInt(V("TOP_UP")));
  const out = judge(r);
  assert.equal(status(out).T6, "pass", JSON.stringify(out.run.find((x) => x.id === "T6")));
  assert.doesNotMatch(out.verdict, /^failed/);
  assert.match(out.verdict, new RegExp(`left: the top up of T4, ${V("TOP_UP")} \\(0.001 FLOP\\), is left in the pallet account ${PALLET} under the channel ${CH3} of T3; no step of this batch brings it back`));
  const clean = judge(syntheticRun({ t4: "success" }));
  assert.equal(clean.verdict, "passed as planned (balances: by position)", "escrow and top up back is clean");
});

test("C7: every channel id in the record's events must be CH_T3 or CH_T5, in a final record and at run time", () => {
  const r = syntheticRun();
  recIn(r, "T3").events.find((e) => e.name === "ForceOpenRequested").fields.channel_id = "0x" + "c3".repeat(32);
  const out = judge(r);
  assert.match(problemsOf(out, "T3"), new RegExp(`ComputeChannel.ForceOpenRequested names the channel 0x(c3){32}, not the derived CH_T3 ${CH3}`));
  const r5 = syntheticRun();
  recIn(r5, "T7").events.find((e) => e.name === "TimedOutRefunded").fields.channel_id = CH3;
  assert.match(problemsOf(judge(r5), "T7"), /not the derived CH_T5/);
  const rt = asPlanned(DEVICE, "T5").results;
  rt.steps.find((s) => s.step === "T5").run_time.explorer.events.find((e) => e.name === "ChannelOpened").fields.channel_id = CH3;
  const n = nextOf(plan, rt);
  assert.equal(n.word, "stop");
  assert.match(n.said.join("\n"), /T5: .*ComputeChannel.ChannelOpened names the channel/);
});

test("C3 S5: an attempt recorded after its step succeeded fails the record", () => {
  const r = syntheticRun();
  const t7 = recIn(r, "T7");
  const extra = structuredClone(t7); extra.step = "T7.2"; extra.finalized_in_block += 1; extra.block_hash = H(extra.finalized_in_block); extra.extrinsic_hash = H(424242);
  r.steps.splice(r.steps.indexOf(t7) + 1, 0, extra);
  assert.match(judge(r).verdict, /^failed: .*T7 succeeded, yet T7.2 was sent after it/);
});
