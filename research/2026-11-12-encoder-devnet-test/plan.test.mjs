// Tests of the plan as data (rules R1, R5, R8, R9, R10): node --test in this folder. No network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, RERUN, readJson, loadPlan, fromSource, computed, substitute, stepOf, RAW } from "./lib.mjs";

const plan = loadPlan();
const errors = readJson(join(RERUN, "errors-1014020.json"));
const facts = readJson(join(RERUN, "facts-1014020.json"));
const rerun = readJson(join(RERUN, "results.json"));

test("R10: every value names its source and equals what that file and field give, or is decided or computed with a reason", () => {
  for (const [name, v] of Object.entries(plan.values)) {
    const kinds = ["from", "decided", "computed"].filter((k) => k in v);
    assert.equal(kinds.length, 1, `${name} must have exactly one of from, decided, computed`);
    if (v.from) assert.equal(fromSource(plan, v.from), v.value, `${name} differs from ${v.from.file} ${v.from.path}`);
    if (v.same_as) assert.equal(fromSource(plan, v.same_as), v.value, `${name} differs from ${v.same_as.file} ${v.same_as.path}`);
    if (v.computed) { assert.equal(computed(plan, v.computed), v.value, `${name} is not what its computation gives`); assert.ok(v.why, `${name} says why`); }
    if (v.decided) assert.ok(v.decided.length > 20, `${name} says why it was decided`);
  }
});

test("R10: every $NAME in the steps is a value, DEVICE, or a field of an earlier step's event", () => {
  const ids = plan.steps.map((s) => s.id);
  const walk = (x, at, id) => {
    if (typeof x === "string") {
      for (const [, name] of x.matchAll(/\$([A-Z][A-Za-z0-9_.]*)/g)) {
        if (name === "DEVICE" || name in plan.values) continue;
        const [step, pallet, event, field] = name.split(".");
        assert.ok(ids.indexOf(step) >= 0 && ids.indexOf(step) < ids.indexOf(id), `${id} ${at}: ${name} is not an earlier step`);
        const ev = facts.events[pallet]?.events.find((e) => e.name === event);
        assert.ok(ev && ev.fields.includes(field), `${id} ${at}: no event field ${pallet}.${event}.${field} at spec 1014020`);
      }
    } else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) walk(v, `${at}.${k}`, id);
  };
  for (const st of plan.steps) walk(st, "", st.id);
});

test("the device's fund covers its transactions at the rerun's largest fee, with the stated margin", () => {
  const max = rerun.steps.reduce((m, s) => (BigInt(s.fee_raw) > m ? BigInt(s.fee_raw) : m), 0n);
  assert.equal(plan.values.MAX_FEE.value, max.toString(), "MAX_FEE is the largest fee the rerun recorded");
  const r = plan.fund_rule;
  assert.deepEqual(r.transactions_of_the_device, plan.steps.filter((s) => s.signer === "device").map((s) => s.id));
  const need = BigInt(r.margin_times) * BigInt(r.transactions_of_the_device.length) * BigInt(plan.values[r.fee_each].value);
  assert.ok(BigInt(plan.values.FUND.value) >= need, `FUND ${plan.values.FUND.value} is below ${need}`);
});

test("the steps are T1 to T9 with the brief's signer, tool and expectation", () => {
  const want = {
    T1: ["owner", "research-signer", "success"], T2: ["owner", "research-signer", "success"],
    T3: ["device", "encoder", "success"], T4: ["device", "encoder", "recorded"], T5: ["device", "encoder", "recorded"],
    T6: ["device", "encoder", "success"], T7: ["device", "encoder", "success"], T8: ["owner", "research-signer", "success"], T9: ["device", "research-signer", "success"],
  };
  assert.deepEqual(plan.steps.map((s) => s.id), Object.keys(want));
  for (const s of plan.steps) assert.deepEqual([s.signer, s.tool, s.expect], want[s.id], s.id);
  assert.deepEqual(plan.steps.map((s) => s.inner?.call ?? s.call[0]), ["transfer", "create-session", "force_open", "top_up_escrow", "open_channel", "expire_force_open", "timeout", "revoke", "sweep"]);
});

test("R2: the declared spend of each encoder step is what the encoder computes: the escrow, the top up, or 0", () => {
  const field = { force_open: "escrow", open_channel: "escrow", top_up_escrow: "additional", expire_force_open: null, timeout: null };
  for (const s of plan.steps.filter((x) => x.tool === "encoder")) {
    const f = field[s.inner.call];
    assert.equal(s.declared, f === null ? "0" : s.inner[f], s.id);
  }
  assert.equal(stepOf(plan, "T3").declared, "$ESCROW_1");
});

test("the session caps hold every spend of the batch, and the escrows stay below the failed ack floor", () => {
  const v = (n) => BigInt(plan.values[n].value);
  const spends = plan.steps.filter((s) => s.tool === "encoder").map((s) => BigInt(substitute(s.declared, plan, null, true)));
  for (const x of spends) assert.ok(x <= v("A_PER_TX"));
  const sum = spends.reduce((a, b) => a + b, 0n);
  assert.ok(sum <= v("A_DAILY") && sum <= v("A_CAP"), `the batch declares ${sum}`);
  assert.ok(v("ESCROW_1") + v("TOP_UP") < v("MIN_FAILED_ACK"), "the escrow of T3 with its top up would count against the named account");
  const d2 = Number(plan.values.MAX_DURATION_D2.value);
  assert.ok(d2 >= 1 && d2 <= Number(plan.values.MAX_UNCONSENTED.value) && d2 < Number(plan.values.ACK_WINDOW.value));
  assert.ok(Number(plan.values.MAX_TURNS.value) <= Number(plan.values.MAX_SETTLEMENT_TURNS.value));
});

test("every expected event, field and finding exists at spec 1014020", () => {
  for (const st of plan.steps) {
    for (const w of [...(st.events ?? []), ...(st.events_if_success ?? [])]) {
      const [p, n] = w.event.split(".");
      const ev = facts.events[p]?.events.find((e) => e.name === n);
      assert.ok(ev, `${st.id}: no event ${w.event}`);
      for (const f of Object.keys(w.fields)) assert.ok(ev.fields.includes(f), `${st.id}: ${w.event} has no field ${f}`);
    }
    for (const e of Object.keys(st.finding_if ?? {})) { const [p, n] = e.split("."); assert.ok(errors.errors.some((x) => x.pallet === p && x.name === n), e); }
    for (const p of st.errors_allowed_of ?? []) assert.ok(errors.errors.some((x) => x.pallet === p), p);
    if (st.refund_event) { const [p, n, f] = st.refund_event.split("."); assert.ok(facts.events[p].events.find((e) => e.name === n).fields.includes(f)); }
  }
});

test("R8: every step says what the lead does on an unexpected answer, and the cleanup steps are T6 to T9", () => {
  for (const s of plan.steps) assert.ok(["stop", "continue"].includes(s.on_unexpected), s.id);
  assert.deepEqual(plan.steps.filter((s) => s.cleanup).map((s) => s.id), ["T6", "T7", "T8", "T9"]);
  for (const s of plan.steps.filter((x) => x.cleanup)) assert.ok(s.only_if, `${s.id} says when it is needed`);
});

test("R9: every fee estimate names a like step of the rerun, or none", () => {
  for (const s of plan.steps) if (s.fee_like !== null) assert.match(rerun.steps.find((x) => x.step === s.fee_like)?.fee_raw ?? "", RAW, s.id);
  assert.deepEqual(plan.steps.filter((s) => s.fee_like === null).map((s) => s.id), ["T4", "T5"]);
});

test("the owner's account nonces follow one another", () => {
  assert.deepEqual(plan.steps.filter((s) => s.signer === "owner").map((s) => s.nonce), [0, 1, 2]);
  for (const s of plan.steps.filter((x) => x.signer === "device")) assert.equal(s.nonce, undefined, `${s.id}: a device nonce is read from the chain`);
});
