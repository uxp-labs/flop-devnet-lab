// Review of G-19, attack 6 (G7): the judge over made results files. Each piece of evidence missing or
// unknown in turn, each claim differing in turn, and records where the judge and plan.mjs next part.
// No network, no key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, V } from "./fixtures.mjs";
import { judge } from "./judge.mjs";
import { nextOf } from "./next.mjs";
import { asPlanned, step, started } from "./records.mjs";

const at = (r, id) => r.steps.find((e) => e.step === id);
const passed = (r) => judge(plan, r).exit === 0;

test("HOLDS: both branches as planned pass; each piece of evidence missing or unknown in turn is never a pass", () => {
  for (const branch of ["taken", "refused"]) {
    assert.ok(passed(asPlanned(branch)), `${branch} as planned passes`);
    const ids = asPlanned(branch).steps.map((e) => e.step);
    const edits = [];
    for (const id of ids) {
      edits.push(
        [`${id} no decoder`, (r) => { delete at(r, id).decoder; }],
        [`${id} fee null`, (r) => { at(r, id).decoder.fee_raw = null; }],
        [`${id} fee "unknown"`, (r) => { at(r, id).decoder.fee_raw = "unknown"; }],
        [`${id} success null`, (r) => { at(r, id).decoder.success = null; }],
        [`${id} no after`, (r) => { delete at(r, id).after; }],
        [`${id} after exit 1`, (r) => { at(r, id).after.exit = 1; }],
        [`${id} after session null`, (r) => { at(r, id).after.session = null; }],
        [`${id} after unknown`, (r) => { at(r, id).after.session = { state: "unknown", value: null }; }],
        [`${id} no explorer`, (r) => { at(r, id).run_time.explorer = null; }],
        [`${id} sources differ`, (r) => { at(r, id).sources_differ = ["made"]; }],
        [`${id} block unknown`, (r) => { at(r, id).run_time.sent.block_number = null; }],
      );
      if (at(asPlanned(branch), id).decoder.success) {
        const ev = at(asPlanned(branch), id).decoder.events[0];
        for (const k of Object.keys(ev.fields)) edits.push([`${id} ${k} null`, (r) => { at(r, id).decoder.events[0].fields[k] = null; }], [`${id} ${k} other`, (r) => { at(r, id).decoder.events[0].fields[k] = "1"; }]);
      }
    }
    // the three balance edits (no balances, after balance null, balance one off) went by the lead's rule on L1 (13:03 UTC): this record judges no balance
    edits.push(["no device", (r) => { delete r.accounts.device.public_key; }]);
    for (const [what, edit] of edits) {
      if (branch === "refused" && /^G2 (no after|after)/.test(what)) continue; // RG19-10
      const r = asPlanned(branch); edit(r); assert.ok(!passed(r), `${branch}: ${what} passes`); }
    assert.ok(edits.length >= 50, String(edits.length));
  }
});

test("HOLDS: RG19-10: a record at which plan.mjs next does not say the end never gets the verdict passed", () => {
  const cases = [
    ["R2's runtime after is not the plan's", "taken", (r) => { at(r, "R2").after.runtime = { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")) + 1 }; }],
    ["G2 refused, no show after it", "refused", (r) => { delete at(r, "G2").after; }],
    ["G2 refused, show after it exited 1", "refused", (r) => { at(r, "G2").after.exit = 1; }],
  ];
  for (const [what, branch, edit] of cases) {
    const r = asPlanned(branch); edit(r);
    assert.notEqual(nextOf(plan, r).word, "end", what);
    const j = judge(plan, r);
    assert.notEqual(j.exit, 0, `${what}: verdict: ${j.verdict}`);
  }
});

test("HOLDS: RG19-11: a balance in the record never passes a claim: this record judges no balance (the lead's L1, ruled again)", () => {
  const r = asPlanned("taken");
  assert.equal(r.balances.source, "made");
  const c = judge(plan, r).claims.find((x) => x.id === "batch");
  assert.notEqual(c.status, "pass", "balances with no relay and no sha256 are judged pass");
});

test("HOLDS: RG19-12: G2 refused with an error the 1014020 table does not name is not a pass of its outcome", () => {
  const r = step(step(step(started(), "G1"), "R1"), "G2", { ok: false, error: null });
  at(r, "G2").decoder.error = { pallet_index: 77, error_index: 3, name: null };
  const c = judge(plan, r).claims.find((x) => x.id === "G2" && /outcome/.test(x.what));
  assert.notEqual(c.status, "pass", c.why);
});

test("HOLDS: RG19-13: the judge reads each claim from the evidence the record holds, not from the record's own derived words (sources_differ, success, error)", () => {
  const r = asPlanned("taken");
  at(r, "G1").run_time.explorer.events[0].fields.daily_cap = "1";
  const c = judge(plan, r).claims.find((x) => x.id === "G1" && /explorer/.test(x.what));
  assert.equal(c.status, "differ", "explorer and decoder events differ, sources_differ says nothing");
  for (const id of ["G1", "G2"]) {
    const q = asPlanned(id === "G1" ? "taken" : "refused");
    at(q, id).decoder.events = at(q, id).decoder.events.filter((e) => e.pallet !== "System");
    assert.ok(!passed(q), `${id}: no System.ExtrinsicSuccess or ExtrinsicFailed in its events, and the record's success word passes`);
  }
});
