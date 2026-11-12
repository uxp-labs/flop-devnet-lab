// Tests of the rerun's files: node --test research/2026-11-12-session-rerun-1014020/
// No network, no key. A synthetic run built from steps.json must pass, and each wrong outcome must be caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, REPO, readJson, loadPlan, loadErrors, loadFacts, context, judgeRun, substitute, fromSource, atPath, earlierFee } from "./rerun-lib.mjs";
import { template, forceOpenFile, totals } from "./plan.mjs";
import { recordedErrors } from "./build-tables.mjs";

const plan = loadPlan(), errors = loadErrors(), facts = loadFacts();
const RAW = /^(0|[1-9][0-9]*)$/;
const ONE_FLOP = 10n ** 18n;

// ---- the plan's own files ------------------------------------------------------------------
test("every value with a source equals what its file and field give", () => {
  for (const [name, v] of Object.entries(plan.values)) {
    if (v.decided) { assert.equal(v.from, undefined, `${name} is decided, so it names no source`); continue; }
    assert.equal(fromSource(plan, v.from), v.value, `${name} differs from ${v.from.file} ${v.from.path}`);
    if (v.same_as) assert.equal(fromSource(plan, v.same_as), v.value, `${name} differs from ${v.same_as.file} ${v.same_as.path}`);
  }
});

test("every claim names a line of an earlier README that starts a statement", () => {
  const readme = { probe: "2026-11-11-session-probe", escrow: "2026-11-11-session-escrow", deny: "2026-11-11-session-deny-list" };
  for (const st of plan.steps) for (const c of st.claims) {
    const [f, n] = c.split(":");
    const line = readFileSync(join(HERE, "..", readme[f], "README.md"), "utf8").split("\n")[Number(n) - 1];
    assert.ok(line && /^(- |\| |`)/.test(line), `${st.id} claim ${c} points at ${JSON.stringify(line)}`);
  }
});

test("every expected error, event and field exists at spec 1014020", () => {
  for (const st of plan.steps) {
    if (st.expect !== "success") {
      const [p, n] = st.expect.split(".");
      assert.ok(errors.errors.some((e) => e.pallet === p && e.name === n), `${st.id}: no error ${st.expect}`);
    }
    for (const w of st.events ?? []) {
      const [p, n] = w.event.split(".");
      const ev = facts.events[p]?.events.find((e) => e.name === n);
      assert.ok(ev, `${st.id}: no event ${w.event}`);
      for (const f of Object.keys(w.fields)) assert.ok(ev.fields.includes(f), `${st.id}: ${w.event} has no field ${f}`);
    }
  }
});

test("the error table agrees with the moves the upgrade report lists, and with what the earlier tests recorded", () => {
  const moved = readJson(join(HERE, "..", "2026-11-12-runtime-upgrade", "results.json")).what_changed_in_the_metadata.error_indexes_moved.FlopSessionKeys;
  const at = (name) => errors.errors.find((e) => e.pallet === "FlopSessionKeys" && e.name === name).error_index;
  for (const [name, pair] of Object.entries(moved)) if (Array.isArray(pair)) assert.equal(at(name), pair[1], name);
  for (const [name, idx] of Object.entries(moved.added)) assert.equal(at(name), idx, name);
  assert.equal(errors.metadata_sha256, "91294eb61225c4de7459e6a8fed3c37169a2c8a1b1906b46a5890d5e0d328238");
  const n = ["2026-11-11-session-probe", "2026-11-11-session-escrow", "2026-11-11-session-deny-list"].reduce((k, d) => k + recordedErrors(readJson(join(HERE, "..", d, "results.json"))).length, 0);
  assert.equal(errors.cross_check_of_the_reader.errors_recorded_by_the_earlier_tests_found_by_index_and_name.length, n);
});

test("results.template.json is what plan.mjs template prints", () => {
  assert.deepEqual(readJson(join(HERE, "results.template.json")), template(plan));
});

test("the plan keeps the signer's and the lab's limits", () => {
  const sessions = plan.steps.filter((s) => s.call[0] === "create-session");
  assert.equal(sessions.length, 2);
  for (const st of sessions) {
    const arg = (k) => substitute(st.call[st.call.indexOf(k) + 1], plan, null, true);
    const allow = arg("--allow").split(",").filter(Boolean);
    assert.ok(allow.length > 0, `${st.id}: an allow list is never empty`);
    assert.ok(allow.length <= Number(plan.values.MAX_ALLOWED_PALLETS.value));
    for (const k of ["--cap", "--per-tx", "--daily"]) { assert.match(arg(k), RAW); assert.ok(BigInt(arg(k)) <= ONE_FLOP / 10n, `${st.id} ${k} is small`); }
    assert.ok(Number(arg("--blocks")) <= 7200, `${st.id}: a short session`);
  }
  for (const st of plan.steps) for (const k of ["--amount", "--spend"]) {
    const i = st.call.indexOf(k);
    if (i >= 0) assert.match(substitute(st.call[i + 1], plan, null, true), RAW, `${st.id} ${k} is a decimal string of raw units`);
  }
  const t = totals(plan);
  assert.equal(t.transactions, 23);
  assert.ok(BigInt(t.fee_estimate_raw) + BigInt(t.sent_to_devices_raw) < ONE_FLOP, "the run moves less than 1 FLOP");
});

test("a force_open file never names an escrow that would count against the named miner", () => {
  const results = { accounts: { dev1: { public_key: "0x" + "11".repeat(32) } } };
  for (const name of Object.keys(plan.force_open_files)) {
    const f = forceOpenFile(plan, name, results);
    assert.ok(BigInt(f.escrow) < BigInt(plan.values.MIN_FAILED_ACK.value));
    assert.ok(f.max_duration < Number(plan.values.MAX_UNCONSENTED.value));
  }
  const bad = { ...plan, force_open_files: { "x.json": { escrow: "$MIN_FAILED_ACK", nonce: "$N1", agent_key: "$DEV1" } } };
  assert.throws(() => forceOpenFile(bad, "x.json", results), /count against/);
});

// ---- a synthetic run ---------------------------------------------------------------------------
const DEV1 = "0x" + "d1".repeat(32), DEV2 = "0x" + "d2".repeat(32), CHANNEL = "0x" + "c0".repeat(32);
const fieldsFor = (pallet, name, given) => {
  const ev = facts.events[pallet].events.find((e) => e.name === name);
  return Object.fromEntries(ev.fields.map((f) => [f, given[f] ?? "0x00"]));
};
const ev = (pallet, name, given = {}) => ({ pallet, name, fields: fieldsFor(pallet, name, given) });
const moduleError = (full) => {
  const [p, n] = full.split(".");
  const e = errors.errors.find((x) => x.pallet === p && x.name === n);
  return ev("System", "ExtrinsicFailed", { dispatch_error: { type: "Module", value: { index: e.pallet_index, error: "0x" + e.error_index.toString(16).padStart(2, "0") + "000000" } }, dispatch_info: {} });
};

function goodRun() {
  const results = { ...template(plan) };
  results.accounts = { owner: { public_key: plan.values.OWNER.value, ss58: "x" }, dev1: { public_key: DEV1, ss58: "x" }, dev2: { public_key: DEV2, ss58: "x" } };
  results.owner_account_nonce_at_start = "9";
  let block = 4000000, fees = 0n;
  results.steps = plan.steps.map((st, i) => {
    block += st.id === "A9" ? 700 : 20;
    const signer = results.accounts[st.signer].public_key;
    const fee = earlierFee(plan, st.fee_like);
    fees += BigInt(fee);
    const partial = { steps: [], accounts: results.accounts };
    const events = [];
    for (const w of st.events ?? []) {
      const given = {};
      for (const [k, v] of Object.entries(w.fields)) given[k] = substitute(v, plan, { ...partial, steps: results.steps ?? [] });
      if (w.event === "ComputeChannel.ForceOpenRequested") Object.assign(given, { channel_id: CHANNEL, ack_deadline: String(block + 594) });
      if (w.event === "ComputeChannel.ForceOpenExpired") given.channel_id = CHANNEL;
      events.push(ev(...w.event.split("."), given));
    }
    events.push(ev("TransactionPayment", "TransactionFeePaid", { who: signer, actual_fee: fee, tip: "0" }));
    events.push(st.expect === "success" ? ev("System", "ExtrinsicSuccess", { dispatch_info: {} }) : moduleError(st.expect));
    const reads = Object.fromEntries(Object.entries(st.reads_after ?? {}).map(([k, v]) => [k, substitute(v, plan, null)]));
    const start = st.signer === "owner" ? 9n : 0n;
    const rec = { step: st.id, signer, account_nonce: String(start + BigInt(st.nonce)), call: "0x00", extrinsic_hash: "0x" + "ab".repeat(32), finalized_in_block: block,
      block_hash: "0x" + String(i).padStart(2, "0").repeat(32), extrinsic_index: 2, last_runtime_upgrade_spec: 1014020, events_value_sha256: null, events, result: null, fee_raw: fee, reads_after: reads, utc: null, note: null };
    results.steps = [...(results.steps ?? []).filter((s) => s.block_hash !== null), rec];
    return rec;
  });
  results.owner_free_balance_raw = { before: "24847973306290000000", after: (24847973306290000000n - fees).toString() };
  return results;
}
const judge = (r) => judgeRun(context(r));
const clone = (o) => JSON.parse(JSON.stringify(o));
const stepOf = (r, id) => r.steps.find((s) => s.step === id);

test("the expected outcome of every step passes", () => {
  const out = judge(goodRun());
  assert.deepEqual(out.top, []);
  for (const r of out.run) assert.equal(r.status, "pass", `${r.id}: ${r.problems.join("; ")}`);
  assert.equal(out.all, true);
});

test("the empty template passes nothing", () => {
  const out = judge(template(plan));
  assert.equal(out.all, false);
  assert.ok(out.run.every((r) => r.status === "not run"));
});

const WRONG = [
  ["SpendExceedsDeclared recorded at its 1014014 index 18", "A5", (r) => { stepOf(r, "A5").events.at(-1).fields.dispatch_error.value.error = "0x12000000"; }],
  ["a refusal that went through", "A7", (r) => { const s = stepOf(r, "A7"); s.events[s.events.length - 1] = ev("System", "ExtrinsicSuccess", { dispatch_info: {} }); }],
  ["a success that was refused", "B10", (r) => { const s = stepOf(r, "B10"); s.events[s.events.length - 1] = moduleError("FlopSessionKeys.PalletNotAllowed"); }],
  ["a denied pallet let through to its own error", "B5", (r) => { stepOf(r, "B5").events.at(-1).fields.dispatch_error.value = { index: 50, error: "0x00000000" }; }],
  ["an error index the table does not have", "A3", (r) => { stepOf(r, "A3").events.at(-1).fields.dispatch_error.value.error = "0xfe000000"; }],
  ["a dispatch error that is not a module error", "A4", (r) => { stepOf(r, "A4").events.at(-1).fields.dispatch_error = { type: "BadOrigin" }; }],
  ["a refusal that still moved escrow", "A5", (r) => { stepOf(r, "A5").events.unshift(ev("Balances", "Transfer", { from: plan.values.OWNER.value, to: "0x" + "ee".repeat(32), amount: "10000000000000000" })); }],
  ["a refusal that still counted in the session", "A8", (r) => { stepOf(r, "A8").events.unshift(ev("FlopSessionKeys", "SessionCallExecuted", {})); }],
  ["a deposit taken by create_session", "A2", (r) => { stepOf(r, "A2").events.unshift(ev("Balances", "Reserved", { who: plan.values.OWNER.value, amount: "1" })); }],
  ["a block executed by spec 1014014", "A6", (r) => { stepOf(r, "A6").last_runtime_upgrade_spec = 1014014; }],
  ["signed by the wrong key", "A3", (r) => { stepOf(r, "A3").signer = DEV2; }],
  ["the wrong account nonce", "A10", (r) => { stepOf(r, "A10").account_nonce = "12"; }],
  ["the owner paid the device's fee", "A4", (r) => { stepOf(r, "A4").events.find((e) => e.name === "TransactionFeePaid").fields.who = plan.values.OWNER.value; }],
  ["fee_raw not the fee event", "B2", (r) => { stepOf(r, "B2").fee_raw = "1"; }],
  ["more escrow than declared moved", "A6", (r) => { stepOf(r, "A6").events.find((e) => e.name === "ForceOpenRequested").fields.escrow = "12000000000000000"; }],
  ["the meter counted what moved, not what was declared", "A6", (r) => { stepOf(r, "A6").events.find((e) => e.name === "SessionCallExecuted").fields.spent = "10000000000000000"; }],
  ["the refund gave room back", "A9", (r) => { stepOf(r, "A9").events.find((e) => e.name === "SessionCallExecuted").fields.spent = "2000000000000000"; }],
  ["a failed ack counted against the named account", "A9", (r) => { stepOf(r, "A9").events.find((e) => e.name === "ForceOpenExpired").fields.failed_acks = "1"; }],
  ["expire sent before the ack deadline", "A9", (r) => { stepOf(r, "A9").finalized_in_block = stepOf(r, "A6").finalized_in_block + 100; }],
  ["the ack deadline a full window after inclusion", "A6", (r) => { const s = stepOf(r, "A6"); s.events.find((e) => e.name === "ForceOpenRequested").fields.ack_deadline = String(s.finalized_in_block + 600); }],
  ["a refused call moved the session nonce", "A3", (r) => { stepOf(r, "A3").reads_after.session_nonce = "1"; }],
  ["a revoked record not left inactive", "A10", (r) => { stepOf(r, "A10").reads_after.session_active = "true"; }],
  ["an event with the wrong field names", "A1", (r) => { stepOf(r, "A1").events[0].fields = { from: "x", dest: "y", amount: "1" }; }],
  ["an event the metadata does not have", "B1", (r) => { stepOf(r, "B1").events.unshift({ pallet: "FlopSessionKeys", name: "SessionUpdated", fields: {} }); }],
  ["two outcomes in one extrinsic", "B3", (r) => { stepOf(r, "B3").events.push(ev("System", "ExtrinsicSuccess", { dispatch_info: {} })); }],
  ["the device not removed by the sweep", "A11", (r) => { const s = stepOf(r, "A11"); s.events = s.events.filter((e) => e.name !== "KilledAccount"); }],
];
for (const [what, id, spoil] of WRONG) {
  test(`caught: ${what}`, () => {
    const r = goodRun();
    spoil(r);
    const out = judge(r);
    assert.equal(out.all, false);
    const s = out.run.find((x) => x.id === id);
    assert.equal(s.status, "differs", `${id} should differ: ${JSON.stringify(s)}`);
  });
}

test("caught: a read left out is incomplete, never a pass", () => {
  const r = goodRun();
  stepOf(r, "A8").reads_after.breaker_tx_count = null;
  const out = judge(r);
  assert.equal(out.run.find((x) => x.id === "A8").status, "incomplete");
  assert.equal(out.all, false);
});

test("caught: a step sent after a stop step went wrong", () => {
  const r = goodRun();
  stepOf(r, "A6").events.at(-1).name = "ExtrinsicFailed";
  stepOf(r, "A6").events[stepOf(r, "A6").events.length - 1] = moduleError("ComputeChannel.EscrowBelowCapacityFloor");
  const out = judge(r);
  assert.equal(out.stoppedAt, "A6");
  assert.equal(out.run.find((x) => x.id === "A7").status, "differs");
  assert.match(out.run.find((x) => x.id === "A7").problems.join(" "), /sent after A6/);
});

test("caught: the owner lost more than the fees", () => {
  const r = goodRun();
  r.owner_free_balance_raw.after = (BigInt(r.owner_free_balance_raw.after) - 1n).toString();
  const out = judge(r);
  assert.equal(out.all, false);
  assert.match(out.top.join(" "), /something other than fees/);
});

test("caught: a step the plan does not have, and a missing device key", () => {
  const r = goodRun();
  r.steps.push({ ...clone(stepOf(r, "B12")), step: "B13" });
  r.accounts.dev2.public_key = null;
  const out = judge(r);
  assert.equal(out.all, false);
  assert.ok(out.top.some((t) => /B13/.test(t)) && out.top.some((t) => /dev2/.test(t)));
});

test("a path into a results file is read strictly", () => {
  assert.equal(atPath({ a: [{ b: "x" }] }, "a[0].b"), "x");
  assert.throws(() => atPath({ a: [] }, "a[0].b"), /no a\[0\]\.b/);
  assert.equal(REPO.endsWith("wt-rerun") || REPO.length > 0, true);
});
