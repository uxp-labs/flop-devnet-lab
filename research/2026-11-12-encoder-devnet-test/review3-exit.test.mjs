// Review 3, attack E: the exit codes and verdicts (V8) of a final record after a stop by the lead.
// The synthetic final record below is the one of check.test.mjs (syntheticRun), copied so this
// file runs alone; nothing in it is changed. No network, no key. No source file is changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { RERUN, readJson, loadPlan, rerunFee } from "./lib.mjs";
import { context, judgeRun } from "./judge.mjs";
import { template } from "./plan.mjs";

const plan = loadPlan();
const errors = readJson(join(RERUN, "errors-1014020.json"));
const V = (n) => plan.values[n].value;
const OWNER = V("OWNER"), NAMED = V("NAMED"), PALLET = V("PALLET_ACCOUNT");
const DEVICE = "0x" + "d1".repeat(32);
const CH3 = V("CH_T3"), CH5 = V("CH_T5");
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const err = (name) => { const [p, n] = name.split("."); const e = errors.errors.find((x) => x.pallet === p && x.name === n); return { index: e.pallet_index, error: "0x" + e.error_index.toString(16).padStart(2, "0") + "000000" }; };
const ev = (pallet, name, fields) => ({ pallet, name, fields });
void PALLET;
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

test("review3 E DEFECT (V8): a final record of a batch stopped at T2 by the lead (T2 to T8 never on chain, T9 swept) gets the verdict passed as planned, not stopped at T2", () => {
  const r = syntheticRun({ skip: ["T2", "T3", "T4", "T5", "T6", "T7", "T8"] });
  const t2 = r.steps.find((s) => s.step === "T2") ?? (r.steps.push({ step: "T2" }), r.steps.find((s) => s.step === "T2"));
  t2.lead_stop = { why: "refused with 1010 at a first send", utc: "2026-11-13T06:00:00.000Z", case: "c", evidence: {} };
  const out = judge(r);
  assert.match(out.verdict, /^stopped at T2/, `T3 to T7 never ran and nothing is left (exit 0 may be right): the verdict is ${out.verdict}, exit ${out.exit}`);
});

test("review3 E DEFECT (V8): the same with no stop recorded at all: T2 to T8 missing from a final record gets passed as planned and exit 0, not failed and exit 1", () => {
  const r = syntheticRun({ skip: ["T2", "T3", "T4", "T5", "T6", "T7", "T8"] });
  const out = judge(r);
  assert.equal(out.exit, 1, `test steps T2 to T5 are missing with no stop: the record is not right; the verdict is ${out.verdict}, exit ${out.exit}`);
});

test("review3 E HELD: the run as planned is passed as planned with exit 0 (control)", () => {
  const out = judge(syntheticRun());
  assert.match(out.verdict, /^passed as planned/);
  assert.equal(out.exit, 0);
});
