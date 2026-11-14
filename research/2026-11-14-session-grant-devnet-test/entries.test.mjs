// F4 (RG19-9): before anything else, plan.mjs next holds the record's entries to the plan: an id
// twice, an id the plan does not have, or ids out of the plan's order is a stop, with words that
// name the entry, and no nonce is counted from such a record. Over made records. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "./fixtures.mjs";
import { nextOf, planIds } from "./next.mjs";
import { nextText } from "./plan.mjs";
import { started, step } from "./records.mjs";

test("F4: the plan's ids, tries included, in order", () => {
  assert.deepEqual(planIds(plan), ["G1", "R1", "R1.2", "R1.3", "G2", "R2", "R2.2", "R2.3"]);
});

test("F4: an id twice, an id the plan has not, ids out of order, an entry with no id: each a stop that names the entry, and no sign line", async () => {
  const twice = step(started(), "G1", { upTo: "call" }); twice.steps.push(structuredClone(twice.steps[0]));
  const unknown = step(started(), "G1"); unknown.steps.push({ step: "X9", run_time: null });
  const order = step(step(started(), "G1"), "R1"); order.steps.reverse();
  const none = step(started(), "G1"); none.steps.push({ run_time: null });
  for (const [r, at, re] of [[twice, "G1", /entry 1 is of G1, which an earlier entry holds/], [unknown, "X9", /entry 1 is of "X9", an id the plan does not have/], [order, "G1", /entry 1 is of G1, after R1: out of the plan's order/], [none, "entry 1", /entry 1 is of null/]]) {
    const n = nextOf(plan, r);
    assert.equal(n.word, "stop", re.toString());
    assert.equal(n.stopped_at, at);
    assert.match(n.why, re);
    assert.match(n.why, /No nonce is counted from it/);
    assert.doesNotMatch(await nextText(plan, "/nowhere", r), /flop-sign\.mjs" sign|lab\.send/);
  }
  // a record whose bad entry sits at P0's stop still stops on the entry first
  const p0 = started({ count: { value: 9 } }); p0.steps.push({ step: "X9" });
  assert.match(nextOf(plan, p0).why, /X9/);
});
