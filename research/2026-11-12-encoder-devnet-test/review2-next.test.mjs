// Review 2 (Q2, Q8, Q9): nextOf over every cell of table F, the dead end after a refusal at
// submission, and the verdicts and exit codes of check.mjs. No network, no key. syntheticRun below is
// copied from the builder's check.test.mjs (same folder) so this file stands alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, RERUN, readJson, rerunFee } from "./lib.mjs";
import { nextOf } from "./judge.mjs";
import { viewOf, planStepOf, baseOf } from "./record.mjs";
import { template } from "./plan.mjs";
import { plan, V, asPlanned, sent, errorOf } from "./fixtures.mjs";

const errors = readJson(join(RERUN, "errors-1014020.json"));
const DEVICE = "0x" + "d1".repeat(32);
const ids = plan.steps.map((s) => s.id);
const ERR = { T1: "FlopSessionKeys.NotOwner", T2: "FlopSessionKeys.SessionAlreadyExists", T3: "ComputeChannel.ChannelExists", T4: "ComputeChannel.BadState", T5: "ComputeChannel.BadState", T6: "ComputeChannel.WindowNotElapsed", T7: "ComputeChannel.WindowNotElapsed", T8: "FlopSessionKeys.SessionNotFound", T9: "FlopSessionKeys.NotOwner" };
const NOT_FINAL = { sub: "refused-at-submission", nf: "deadline", none: "connection-lost" };

/** The record of table F's cell (step, answer): every earlier step as planned. */
function cell(id, answer) {
  if (answer === "ok") return asPlanned(DEVICE, id).results;
  if (answer === "err") return asPlanned(DEVICE, id, { outcomes: { [id]: ERR[id] }, errors }).results;
  const prev = ids[ids.indexOf(id) - 1];
  const r = prev ? asPlanned(DEVICE, prev).results : asPlanned(DEVICE, "T1").results;
  if (!prev) r.steps.find((s) => s.step === "T1").run_time = null;
  return sent(r, id, { status: NOT_FINAL[answer] });
}

test("review2 Q2 HELD: over every cell of table F, nextOf names no step out of order, none past an unknown outcome, and only cleanup steps after a stop", () => {
  for (const id of ids) for (const answer of ["ok", "err", "sub", "nf", "none"]) {
    const r = cell(id, answer);
    const n = nextOf(plan, r);
    const where = `${id} ${answer}: ${n.word} ${n.step}: ${n.why}`;
    const open = (r.steps ?? []).filter((s) => s.run_time && !(viewOf(r, s.step).final && viewOf(r, s.step).success !== null)).map((s) => s.step);
    if (open.length) { assert.equal(n.word, "wait", where); assert.equal(n.step, open[0], where); continue; }
    if (n.stopped_at && n.step) assert.ok(planStepOf(plan, n.step).cleanup, where);
    if (n.step) assert.ok(ids.indexOf(baseOf(n.step)) >= ids.indexOf(id), where);
  }
});

test("review2 Q2 HELD: a cleanup step refused once, twice, three times: T6.2, T6.3, then T7 or the next cleanup step, never T6.4", () => {
  const blocks = asPlanned(DEVICE, "T6").blocks;
  let r = asPlanned(DEVICE, "T6", { outcomes: { T6: ERR.T6 }, errors }).results;
  assert.equal(nextOf(plan, r).step, "T6.2");
  for (const [k, id] of [[1, "T6.2"], [2, "T6.3"]]) {
    sent(r, id, { block: blocks.T6 + 3 * k });
    r.steps.find((s) => s.step === id).run_time.explorer = { ...r.steps.find((s) => s.step === "T6").run_time.explorer, hash: r.steps.find((s) => s.step === id).run_time.extrinsic_hash, block_hash: r.steps.find((s) => s.step === id).run_time.sent.block_hash };
  }
  const n = nextOf(plan, r);
  assert.ok(n.step !== "T6.4" && !String(n.step).startsWith("T6"), `${n.word} ${n.step}`);
  assert.match(n.left.join("\n"), /T6 was refused 3 times/);
});

test("review2 Q8 DEFECT: T2 refused at submission (it never comes on chain): no tool path reaches T9, and FUND stays on the device", async () => {
  // adapted by the builder (F3): the tool path is the lead's stop, record-step.mjs stop, case c (node code 1010)
  const { leadStop } = await import("./lead-stop.mjs");
  const { runFolder, planSigned } = await import("./fixtures.mjs");
  const before = cell("T2", "sub");
  before.steps.find((s) => s.step === "T2").run_time.sent.node = { code: 1010, message: "Invalid Transaction", data: null };
  before.steps.find((s) => s.step === "T2").run_time.sent.sent_by = "send"; // F3c: a first send
  const run = runFolder(before);
  planSigned(run, "T2", before);
  const r = leadStop({ plan, run, results: before, id: "T2", why: "refused at submission with 1010" });
  rmSync(run, { recursive: true, force: true });
  const n = nextOf(plan, r);
  // record-step and sign-device follow nextOf; the only lines plan.mjs next prints are find and sendSame of T2
  const reaches = n.step === "T9" || n.cleanup.includes("T9");
  assert.ok(reaches, `nextOf says ${n.word} ${n.step} (${n.why}); cleanup ${JSON.stringify(n.cleanup)}: T1's FUND is on the device and nothing brings it back`);
});

test("review2 Q8 DEFECT: the stop table says nothing is left when T2 is refused at submission, while T1's FUND is on the device", () => {
  const row = plan.stop_table.find((x) => x.step === "T2" && x.answer === "sub");
  assert.match(`${row.on_chain}; ${row.brings_back}`, /FUND|T9/, `the row: ${row.on_chain}; ${row.brings_back}`);
});

// ---- check.mjs: verdicts and exit codes -----------------------------------------------------

const OWNER = V("OWNER"), PALLET = V("PALLET_ACCOUNT"), NAMED = V("NAMED"), CH3 = V("CH_T3"), CH5 = V("CH_T5");
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const err = (name) => { const [p, n] = name.split("."); const e = errors.errors.find((x) => x.pallet === p && x.name === n); return { index: e.pallet_index, error: "0x" + e.error_index.toString(16).padStart(2, "0") + "000000" }; };
const ev = (pallet, name, fields) => ({ pallet, name, fields });
function syntheticRun({ t4 = "ComputeChannel.BadState", t5 = "success", t3 = "success", skip = [] } = {}) {
  const r = template(plan);
  r.record = "final"; r.balances_source = "by position";
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
      if (st.id === "T1") { acct.owner.free -= BigInt(V("FUND")); acct.device = { free: BigInt(V("FUND")), reserved: 0n, nonce: 0n }; events.push(ev("Balances", "Transfer", { from: OWNER, to: DEVICE, amount: V("FUND") })); }
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
const cli = (r) => { const d = mkdtempSync(join(tmpdir(), "review2-check-")); try { const f = join(d, "r.json"); writeFileSync(f, JSON.stringify(r)); const o = spawnSync(process.execPath, [join(HERE, "check.mjs"), f], { encoding: "utf8" }); return { code: o.status, verdict: (o.stdout.match(/^verdict: (.*)$/m) ?? [])[1] }; } finally { rmSync(d, { recursive: true, force: true }); } };
const C3 = [/^passed as planned \(balances: /, /^stopped at T\d, cleanup complete, nothing left \(balances: /, /^stopped at T\d, left: /, /^failed: /];

function topUpLeft() {
  const r = syntheticRun({ t4: "success" });
  const t6 = r.steps.find((s) => s.step === "T6");
  t6.events.find((e) => e.name === "ForceOpenExpired").fields.refunded = V("ESCROW_1");
  t6.events.find((e) => e.name === "Transfer" && e.fields.to === OWNER).fields.amount = V("ESCROW_1");
  for (const s of r.steps.slice(r.steps.indexOf(t6))) s.after.accounts.owner.free = String(BigInt(s.after.accounts.owner.free) - BigInt(V("TOP_UP")));
  return r;
}

test("review2 Q9 DEFECT: the top up left after T6 gets a verdict that is none of C3's four and begins with passed as planned, with exit 1", () => {
  const out = cli(topUpLeft());
  // adapted by the builder (F12, the lead's ruling 4): exit 4 (right, something left) and the verdict "as planned, left: ..."
  assert.equal(out.code, 4);
  assert.ok([...C3, /^as planned, left: /].some((re) => re.test(out.verdict)), `verdict: ${out.verdict}`);
  assert.doesNotMatch(out.verdict, /^passed/);
});

test("review2 Q9 measured: the exit code of each kind of verdict (info for ruling 4)", () => {
  const right = cli(syntheticRun({ t4: "success" }));
  const wrong = syntheticRun({ t4: "success" }); wrong.steps.find((s) => s.step === "T9").after.accounts.owner.free = "1";
  const bad = cli(wrong);
  const left = cli(topUpLeft());
  assert.equal(right.code, 0); assert.match(right.verdict, /^passed as planned \(/);
  assert.equal(bad.code, 1); assert.match(bad.verdict, /^failed: /);
  assert.equal(left.code, 4); // adapted by the builder: ruling 4 (F12) gives 4, not the code of a wrong record
  const d = mkdtempSync(join(tmpdir(), "review2-rt-")); const f = join(d, "r.json"); writeFileSync(f, JSON.stringify(asPlanned(DEVICE, "T3").results));
  assert.equal(spawnSync(process.execPath, [join(HERE, "check.mjs"), f]).status, 3); rmSync(d, { recursive: true, force: true });
});
