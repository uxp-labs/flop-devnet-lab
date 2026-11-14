// F5 (RG19-7) and F12 (RG19-15): the words of the end, and of a stop after a failed first grant,
// come from the show after the last step. A show that says active is a stop that names the session
// and prints the cleanup revoke's next action, three tries at most. A fee above the most is a stop
// in every branch, the refused second grant included. Over made records. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, V } from "./fixtures.mjs";
import { nextOf } from "./next.mjs";
import { nextText } from "./plan.mjs";
import { started, step } from "./records.mjs";

const EXISTS = `FlopSessionKeys.${V("ALREADY_EXISTS")}`;
const g2refused = (o = {}) => step(step(step(started(), "G1"), "R1"), "G2", { ok: false, error: EXISTS, ...o });
const n = (r) => nextOf(plan, r);

test("F5: G2 refused and the show after it says active: a stop that names the session, with R2's tries as the cleanup", async () => {
  const r = g2refused({ after: "active" });
  const x = n(r);
  assert.equal(x.word, "stop");
  assert.equal(x.stopped_at, "G2");
  assert.equal(x.step, "R2");
  assert.equal(x.phase, "call");
  assert.deepEqual(x.cleanup, ["R2"]);
  assert.match(x.why, /the show after G2 says a session is active: an active session of the owner for the device, by the show after G2 \(spending cap 25000000000000000/);
  assert.doesNotMatch(x.why, /no session is active/);
  const text = await nextText(plan, "/run", r);
  assert.match(text, /# STOP at G2: /);
  assert.match(text, /tool-run\.mjs" R2 call --run/);
  step(r, "R2", { ok: false }); assert.equal(n(r).step, "R2.2");
  step(r, "R2.2", { ok: false }); assert.equal(n(r).step, "R2.3");
  step(r, "R2.3", { ok: false });
  const done = n(r);
  assert.equal(done.word, "stop");
  assert.equal(done.step, null);
  assert.match(done.why, /every try of R2 \(3\) failed/);
  assert.match(done.left[0], /an active session of the owner for the device, by the show after G2/);
  const ended = g2refused({ after: "active" }); step(ended, "R2");
  assert.match(n(ended).why, /R2 has ended it: the show after R2 says no session is active/);
  assert.equal(n(ended).word, "stop");
});

test("F5: G1 failed and the show after it says active: a stop, never \"nothing is active\", with R1 as the cleanup", () => {
  const r = step(started(), "G1", { ok: false, error: "FlopSessionKeys.TooManySessions", after: "active" });
  const x = n(r);
  assert.equal(x.word, "stop");
  assert.equal(x.stopped_at, "G1");
  assert.equal(x.step, "R1");
  assert.doesNotMatch(x.why, /nothing is active/);
  const quiet = step(started(), "G1", { ok: false, error: "FlopSessionKeys.TooManySessions" });
  assert.match(n(quiet).why, /nothing is active \(the show after G1 says so\)/);
  const unknown = step(started(), "G1", { ok: false, error: "x" });
  unknown.steps[0].after.session = { state: "unknown", value: null };
  assert.match(n(unknown).why, /does not say that no session is active/);
  assert.equal(n(unknown).step, null);
});

test("F5: the end says no session is active only from a show after the last step that says so", () => {
  const e = n(g2refused());
  assert.equal(e.word, "end");
  assert.match(e.why, /the show after G2 says no session is active/);
  const t = n(step(step(step(step(started(), "G1"), "R1"), "G2"), "R2"));
  assert.match(t.why, /the show after R2 says no session is active/);
});

test("F12: a fee above the most per step is a stop in every branch, the refused second grant included", () => {
  const above = (BigInt(V("MAX_FEE")) + 1n).toString();
  const x = n(g2refused({ fee: above }));
  assert.equal(x.word, "stop");
  assert.match(x.why, /above the most per step/);
  assert.equal(n(step(started(), "G1", { ok: false, error: "x", fee: above })).word, "stop");
  assert.equal(n(step(step(started(), "G1"), "R1", { fee: above })).word, "stop");
  const g2 = step(step(step(started(), "G1"), "R1"), "G2", { fee: above }); step(g2, "R2");
  assert.equal(n(g2).word, "stop");
  const r2 = step(step(step(step(started(), "G1"), "R1"), "G2"), "R2", { fee: above });
  assert.equal(n(r2).word, "stop");
});
