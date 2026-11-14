// F6 (RG19-10, RG19-12, RG19-13): the judge computes each claim from the events and the readings
// the record holds, never from the record's derived words; a step with no System outcome event is
// incomplete; G2 refused with an error other than SessionAlreadyExists, named or not, differs and
// leaves U1 open; passed, exit 0, only where plan.mjs next says the end. Over made records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, V } from "./fixtures.mjs";
import { judge } from "./judge.mjs";
import { nextOf } from "./next.mjs";
import { asPlanned } from "./records.mjs";

const at = (r, id) => r.steps.find((e) => e.step === id);
const claimOf = (j, id, re) => j.claims.find((c) => c.id === id && re.test(c.what));

test("F6: each derived word of the record changed alone is a claim that differs, named in the verdict", () => {
  const cases = [
    ["G1", /SessionCreated/, (r) => { at(r, "G1").decoder.success = false; }],
    ["G2", /outcome/, (r) => { at(r, "G2").decoder.error = { pallet_index: 94, error_index: 8, name: "FlopSessionKeys.TooManySessions" }; }, "refused"],
    ["R1", /its fee/, (r) => { at(r, "R1").decoder.fee_raw = "1"; }],
    ["R2", /explorer/, (r) => { at(r, "R2").sources_differ = ["made"]; }],
    ["R1", /SessionRevoked/, (r) => { at(r, "R1").decoder.success = null; }],
  ];
  for (const [id, re, edit, branch = "taken"] of cases) {
    const r = asPlanned(branch); edit(r);
    const j = judge(plan, r);
    const c = claimOf(j, id, re);
    assert.equal(c.status, "differ", `${id} ${re}: ${c.why}`);
    assert.match(c.why, /the record says .*, its (events|readings) give/);
    assert.equal(j.exit, 1);
    assert.ok(j.verdict.includes(`${id} ${c.what}: differ`), j.verdict);
  }
});

test("F6: a step whose events hold no System outcome event is incomplete for that step", () => {
  for (const [branch, id, re] of [["taken", "G1", /SessionCreated/], ["refused", "G2", /outcome/]]) {
    const r = asPlanned(branch);
    const e = at(r, id);
    e.decoder.events = e.decoder.events.filter((x) => x.pallet !== "System");
    e.decoder.success = null; e.decoder.error = null;
    const j = judge(plan, r);
    assert.equal(claimOf(j, id, re).status, "incomplete");
    assert.notEqual(j.exit, 0);
  }
});

test("F6: G2 refused with another named error, or one the table does not name, differs and U1 stays open", () => {
  for (const name of ["FlopSessionKeys.TooManySessions", null]) {
    const j = judge(plan, asPlanned("refused", name));
    const c = claimOf(j, "G2", /outcome/);
    assert.equal(c.status, "differ", String(name));
    assert.match(c.why, /U1 stays open/);
    assert.match(c.why, name ? /TooManySessions/ : /an error the 1014020 table does not name/);
    assert.equal(j.exit, 1);
  }
});

test("F6: every claim passing is not passed when plan.mjs next does not say the end: exit 4, and the verdict says why", () => {
  const r = asPlanned("taken");
  at(r, "R2").after.runtime = { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")) + 1 };
  assert.equal(nextOf(plan, r).word, "stop");
  const j = judge(plan, r);
  assert.deepEqual(j.claims.filter((c) => !["pass", "not needed"].includes(c.status)), []);
  assert.equal(j.exit, 4);
  assert.match(j.verdict, /^incomplete; stopped at R2/);
  assert.equal(judge(plan, asPlanned("taken")).exit, 0);
});
