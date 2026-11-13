// Reviewer's tests of check.mjs and judge.mjs (P6, P7, P8). No network, no key. A right run is built
// here, by the reviewer's own code, from steps.json; each wrong record is that run with one fault.
// Tests named "DEFECT" fail on fcfb8b5.
// Adapted by the builder of the fix round: the right run is a final record (C1) with its
// balances_source (C4), the derived channel ids (P1, C7), and T6 after T3's block plus the ack
// window (S7); the recovery's second T6 is "T6.2" (S5) with an extrinsic hash of its own (C2).
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
const DEVICE = "0x" + "d7".repeat(32);
const CH3 = V("CH_T3"), CH5 = V("CH_T5");
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const ev = (pallet, name, fields) => ({ pallet, name, fields });
const modErr = (name) => { const [p, n] = name.split("."); const e = errors.errors.find((x) => x.pallet === p && x.name === n); return { index: e.pallet_index, error: "0x" + e.error_index.toString(16).padStart(2, "0") + "000000" }; };
const E1 = BigInt(V("ESCROW_1")), TOP = BigInt(V("TOP_UP"));

/** The run of the plan with T4 succeeding (so T6 returns the top up) and T5 opening a channel. */
function rightRun() {
  const r = template(plan);
  r.record = "final";
  r.balances_source = "by position";
  r.accounts = { owner: { public_key: OWNER, ss58: "o" }, device: { public_key: DEVICE, ss58: "d" } };
  r.owner_account_nonce_at_start = V("OWNER_NONCE_AFTER_RERUN");
  const a = { owner: { free: 30n * 10n ** 18n, nonce: BigInt(V("OWNER_NONCE_AFTER_RERUN")) }, device: null };
  const snap = () => ({ owner: { free: String(a.owner.free), reserved: "0", nonce: String(a.owner.nonce), absent: false },
    device: a.device ? { free: String(a.device.free), reserved: "0", nonce: String(a.device.nonce), absent: false } : { free: null, reserved: null, nonce: null, absent: true } });
  r.before = { ...r.before, block_number: 4000000, block_hash: H(4000000), accounts: snap() };
  let block = 4000000, nonceS = 0n, spent = 0n, active = null, ack = 0, t5 = 0, t3 = 0;
  const steps = [];
  for (const st of plan.steps) {
    block = st.id === "T6" ? Math.max(block, ack, t3 + Number(V("ACK_WINDOW"))) + 3 : st.id === "T7" ? Math.max(block, t5 + Number(V("MAX_DURATION_D2"))) + 3 : block + 3;
    const fee = BigInt(rerunFee(st.fee_like) ?? "9000000000000000");
    const who = a[st.signer], signer = st.signer === "owner" ? OWNER : DEVICE;
    const nonce = who.nonce; who.free -= fee; who.nonce += 1n;
    const events = [];
    const exec = (d) => { nonceS += 1n; spent += d; events.push(ev("FlopSessionKeys", "SessionCallExecuted", { owner: OWNER, delegate: DEVICE, spent: String(spent), epoch_spent: String(spent) })); };
    const out = (x) => { a.owner.free -= x; events.push(ev("Balances", "Transfer", { from: OWNER, to: PALLET, amount: String(x) })); };
    const back = (x) => { a.owner.free += x; events.push(ev("Balances", "Transfer", { from: PALLET, to: OWNER, amount: String(x) })); };
    if (st.id === "T1") { a.owner.free -= BigInt(V("FUND")); a.device = { free: BigInt(V("FUND")), nonce: 0n }; events.push(ev("Balances", "Transfer", { from: OWNER, to: DEVICE, amount: V("FUND") })); }
    if (st.id === "T2") { active = "true"; events.push(ev("FlopSessionKeys", "SessionCreated", { owner: OWNER, delegate: DEVICE, spending_cap: V("A_CAP"), per_tx_limit: V("A_PER_TX"), daily_cap: V("A_DAILY"), expires_at: block + 7200 })); }
    if (st.id === "T3") { out(E1); ack = block + 595; t3 = block; events.push(ev("ComputeChannel", "ForceOpenRequested", { channel_id: CH3, agent: OWNER, miner: NAMED, escrow: String(E1), ack_deadline: ack })); exec(E1); }
    if (st.id === "T4") { out(TOP); events.push(ev("ComputeChannel", "EscrowToppedUp", { channel_id: CH3, added: String(TOP), total: String(E1 + TOP) })); exec(TOP); }
    if (st.id === "T5") { out(E1); t5 = block; events.push(ev("ComputeChannel", "ChannelOpened", { channel_id: CH5, agent: OWNER, miner: NAMED, escrow: String(E1), measured_root: V("ROOT") })); exec(E1); }
    if (st.id === "T6") { back(E1 + TOP); events.push(ev("ComputeChannel", "ForceOpenExpired", { channel_id: CH3, miner: NAMED, refunded: String(E1 + TOP), failed_acks: "0" })); exec(0n); }
    if (st.id === "T7") { back(E1); events.push(ev("ComputeChannel", "TimedOutRefunded", { channel_id: CH5, refunded: String(E1) })); exec(0n); }
    if (st.id === "T8") { active = "false"; events.push(ev("FlopSessionKeys", "SessionRevoked", { owner: OWNER, delegate: DEVICE })); }
    if (st.id === "T9") { const rest = a.device.free; a.owner.free += rest; a.device = null; events.push(ev("System", "KilledAccount", { account: DEVICE }), ev("Balances", "Transfer", { from: DEVICE, to: OWNER, amount: String(rest) })); }
    events.push(ev("TransactionPayment", "TransactionFeePaid", { who: signer, actual_fee: String(fee), tip: "0" }), ev("System", "ExtrinsicSuccess", { dispatch_info: {} }));
    const rec = r.steps.find((s) => s.step === st.id);
    Object.assign(rec, { signer, account_nonce: String(nonce), extrinsic_hash: H(block * 11), finalized_in_block: block, block_hash: H(block), extrinsic_index: 1,
      last_runtime_upgrade_spec: plan.spec_version, events_value_sha256: "11".repeat(32), events, result: "success", fee_raw: String(fee) });
    rec.after = { accounts: snap(), session: { active, spent_raw: active === null ? null : String(spent), epoch_spent_raw: active === null ? null : String(spent) }, session_nonce: active === null ? null : String(nonceS), breaker_tx_count: "1" };
    steps.push(st.id);
  }
  return r;
}
const judge = (r) => judgeRun(context(r));
const rec = (r, id) => r.steps.find((s) => s.step === id);
const why = (o) => JSON.stringify([o.top, o.left, o.run.filter((x) => x.status !== "pass").map((x) => [x.id, x.status, x.problems])]);

test("review held P7: the reviewer's right run passes whole", () => {
  const o = judge(rightRun());
  assert.equal(o.all, true, why(o));
});

test("review DEFECT P7: a record whose T8 (revoke) is in a block before T6 and T7 is out of order and does not pass", () => {
  const r = rightRun();
  rec(r, "T8").finalized_in_block = rec(r, "T5").finalized_in_block + 1;
  rec(r, "T8").block_hash = H(rec(r, "T8").finalized_in_block);
  const o = judge(r);
  assert.equal(o.all, false, "the session was revoked before T6 and T7 were sent through it, and the record passes");
});

test("review DEFECT P7: a record whose T1 (the fund) is in a block after T3 is out of order and does not pass", () => {
  const r = rightRun();
  rec(r, "T1").finalized_in_block = rec(r, "T3").finalized_in_block + 1;
  assert.equal(judge(r).all, false, "the device paid T3's fee before it was funded, and the record passes");
});

test("review DEFECT P7 P3: a record that holds T4 twice (sent twice) does not pass", () => {
  const r = rightRun();
  const i = r.steps.findIndex((s) => s.step === "T4");
  const twice = structuredClone(r.steps[i]);
  twice.finalized_in_block += 1; twice.block_hash = H(twice.finalized_in_block); twice.extrinsic_hash = H(1234567);
  r.steps.splice(i + 1, 0, twice);
  assert.equal(judge(r).all, false, "a second T4 is ignored by the check");
});

test("review DEFECT P6 P7: the plan's own recovery for a failed T6 (signed again under a new step id) gives a record that can pass", () => {
  // The run the plan describes: T6 is included and refused with AckWindowNotElapsed, the lead signs
  // T6 again "with a new step id" and it succeeds. Everything comes back. The record is right.
  const r = rightRun();
  const i = r.steps.findIndex((s) => s.step === "T6");
  const ok = r.steps[i], failed = structuredClone(ok);
  const fee = BigInt(failed.fee_raw);
  failed.events = [ev("TransactionPayment", "TransactionFeePaid", { who: DEVICE, actual_fee: String(fee), tip: "0" }), ev("System", "ExtrinsicFailed", { dispatch_error: { type: "Module", value: modErr("ComputeChannel.AckWindowNotElapsed") }, dispatch_info: {} })];
  failed.finalized_in_block -= 2; failed.block_hash = H(failed.finalized_in_block); failed.extrinsic_hash = H(failed.finalized_in_block * 13);
  const prev = r.steps[i - 1].after;
  failed.after = structuredClone(prev);
  failed.after.accounts.device.free = String(BigInt(prev.accounts.device.free) - fee);
  failed.after.accounts.device.nonce = String(BigInt(prev.accounts.device.nonce) + 1n);
  const retry = { ...ok, step: "T6.2" };
  retry.account_nonce = String(BigInt(ok.account_nonce) + 1n);
  r.steps.splice(i, 1, failed, retry);
  // every later device step and balance moves by one more fee and one more nonce
  for (const s of r.steps.slice(i + 1)) {
    if (s.signer === DEVICE && s !== retry) s.account_nonce = String(BigInt(s.account_nonce) + 1n);
    for (const k of ["device", "owner"]) {
      const acc = s.after.accounts[k];
      if (k === "device" && acc.free !== null) { acc.free = String(BigInt(acc.free) - fee); acc.nonce = String(BigInt(acc.nonce) + 1n); }
    }
  }
  const t9 = rec(r, "T9"); const rest = BigInt(t9.events.find((e) => e.name === "Transfer").fields.amount) - fee;
  t9.events.find((e) => e.name === "Transfer").fields.amount = String(rest);
  for (const s of r.steps.slice(r.steps.indexOf(t9))) s.after.accounts.owner.free = String(BigInt(s.after.accounts.owner.free) - fee);
  const o = judge(r);
  assert.equal(o.all, true, `the plan's recovery path cannot pass the check: ${why(o).slice(0, 600)}`);
});

const fault = (name, f) => test(`review held P7 P8: ${name} does not pass`, () => { const r = rightRun(); f(r); assert.equal(judge(r).all, false); });
fault("the owner's free balance off by one raw unit after T3", (r) => { rec(r, "T3").after.accounts.owner.free = String(BigInt(rec(r, "T3").after.accounts.owner.free) - 1n); });
fault("an extra unexplained outflow of the owner at T5, with its transfer event", (r) => { const s = rec(r, "T5"); s.events.splice(0, 0, ev("Balances", "Transfer", { from: OWNER, to: NAMED, amount: "5" })); s.after.accounts.owner.free = String(BigInt(s.after.accounts.owner.free) - 5n); });
fault("T3's fee charged to the owner", (r) => { const s = rec(r, "T3"); s.events.find((e) => e.name === "TransactionFeePaid").fields.who = OWNER; });
fault("a refund at T6 one unit smaller than escrow and top up", (r) => { const s = rec(r, "T6"); s.events.find((e) => e.name === "ForceOpenExpired").fields.refunded = String(E1 + TOP - 1n); });
fault("T6 refunding the escrow but not the top up", (r) => { const s = rec(r, "T6"); s.events.find((e) => e.name === "ForceOpenExpired").fields.refunded = String(E1); });
fault("T3 signed by the owner", (r) => { rec(r, "T3").signer = OWNER; });
fault("T2 missing", (r) => { r.steps = r.steps.filter((s) => s.step !== "T2"); });
fault("a reserved balance of the owner after T5", (r) => { rec(r, "T5").after.accounts.owner.reserved = "1"; });
fault("T5 refused with an error the 1014020 table does not name (a Token error)", (r) => { const s = rec(r, "T5"); s.events = [s.events.find((e) => e.name === "TransactionFeePaid"), ev("System", "ExtrinsicFailed", { dispatch_error: { type: "Token", value: "FundsUnavailable" }, dispatch_info: {} })]; });
