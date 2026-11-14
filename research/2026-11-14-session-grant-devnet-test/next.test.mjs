// T5, rules H10, H11 and H12: plan.mjs next over made run records (records.mjs): each stop, both
// branches of G2, the cleanup tries of a revoke, the send outcomes of the last batch's immortal rows,
// and the fence in numbers over steps.json. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, V } from "./fixtures.mjs";
import { nextOf } from "./next.mjs";
import { costs, immortalRows } from "./plan.mjs";
import { started, step, asPlanned } from "./records.mjs";

const n = (r) => nextOf(plan, r);
const stops = (r, at, re) => { const x = n(r); assert.equal(x.word, "stop", JSON.stringify(x)); assert.equal(x.stopped_at, at); assert.match(x.why, re); return x; };
const goes = (r, id, phase) => { const x = n(r); assert.equal(x.word, phase === "wait" ? "wait" : "go", JSON.stringify(x)); assert.equal(x.step, id); assert.equal(x.phase, phase); return x; };

test("T5: no record: P0; a good P0: G1's call, then each phase in order", () => {
  assert.equal(n(null).phase, "start");
  goes(started(), "G1", "call");
  for (const [upTo, phase] of [["call", "sign"], ["sign", "send"], ["final", "block"], ["block", "after"]]) goes(step(started(), "G1", { upTo }), "G1", phase);
  goes(step(started(), "G1"), "R1", "call");
});

test("T5 H10 P0: the runtime, the genesis or the transaction version not the plan's stops", () => {
  stops(started({ chain: { spec_version_at_start: 1014021 } }), "P0", /runtime at the start/);
  stops(started({ chain: { genesis_at_start: "0x" + "11".repeat(32) } }), "P0", /genesis at the start/);
  stops(started({ chain: { transaction_version_at_start: 3 } }), "P0", /transaction version at the start/);
});

test("T5 H10 P0: SessionCount(S) of 9 or more, or unknown, stops; 8 goes on", () => {
  stops(started({ count: { value: Number(V("SESSION_COUNT_STOP")) } }), "P0", /SessionCount\(S\) is 9, at or above 9/);
  stops(started({ count: { value: null, reason: "the node said: no" } }), "P0", /cannot be read/);
  stops(started({ count: null }), "P0", /cannot be read/);
  goes(started({ count: { value: 8, stored: true } }), "G1", "call");
});

test("T5 H10 P0: the pair not absent, or show not exit 0, stops", () => {
  stops(started({ session: { state: "stored", value: { active: false } } }), "P0", /not absent/);
  stops(started({ exit: 1 }), "P0", /exited 1/);
});

test("T5 H10: the tool's call refused (exit other than 0, or not the second encoder's) and a refused signed file stop before anything is sent", () => {
  stops(step(started(), "G1", { callRefused: "the tool exited 5 for G1, not 0" }), "G1", /call of G1 is refused, nothing is signed: the tool exited 5/);
  stops(step(started(), "G1", { callRefused: "the tool's call 0x5e00 is not the second encoder's 0x5e01" }), "G1", /not the second encoder's/);
  stops(step(started(), "G1", { signedRefused: "the nonce is 21, the plan's is 20" }), "G1", /signed file of G1 is refused, nothing is sent/);
});

test("T5 H10 H11: a send that is not a clean inclusion waits on the immortal rows", () => {
  const x = goes(step(started(), "G1", { sent: { status: "deadline", sent_by: "send" } }), "G1", "wait");
  assert.equal(x.sent.status, "deadline");
  const rows = immortalRows(plan);
  assert.ok(rows.every((r) => !/^mortal:/.test(r.second_copy)), "only the immortal part of second_copy is kept");
  assert.ok(rows.find((r) => r.outcome === "deadline").second_copy.startsWith("never; lab.sendSame"));
});

test("T5 H10: G1 failed in its block: stop, nothing is active, no cleanup", () => {
  const x = stops(step(started(), "G1", { ok: false, error: "FlopSessionKeys.TooManySessions" }), "G1", /G1 failed in its block with FlopSessionKeys.TooManySessions: nothing is active/);
  assert.deepEqual(x.cleanup, []);
});

test("T5 H10: G1's fields not the derived caps, or its expiry not block plus DURATION, or show not active: R1 then stop", () => {
  for (const o of [{ fields: { spending_cap: "1" } }, { fields: { expires_at: 1 } }, { after: "revoked" }, { fee: (BigInt(V("MAX_FEE")) + 1n).toString() }]) {
    const r = step(started(), "G1", o);
    const x = goes(r, "R1", "call");
    assert.deepEqual(x.cleanup, ["R1"]);
    assert.match(x.why, /then stop: G1 is not the plan's/);
    step(r, "R1");
    stops(r, "G1", /G1 was not the plan's .*R1 has ended its session/);
  }
});

test("T5 H10: a show that exits other than 0 after a step stops", () => {
  stops(step(started(), "G1", { after: "exit" }), "G1", /session show after G1 exited 1/);
});

test("T5 H10: a revoke that failed has a cleanup try at the next nonce, three at most, then stop with the session left", () => {
  const r = step(started(), "G1");
  step(r, "R1", { ok: false, error: "FlopSessionKeys.SessionNotFound" });
  const x = goes(r, "R1.2", "call");
  assert.ok(x.findings.some((f) => /R1 failed in its block with FlopSessionKeys.SessionNotFound: a cleanup try at the next nonce/.test(f)));
  step(r, "R1.2", { ok: false, error: "FlopSessionKeys.SessionNotFound" });
  goes(r, "R1.3", "call");
  step(r, "R1.3", { ok: false, error: "FlopSessionKeys.SessionNotFound" });
  const s = stops(r, "R1", /every try of R1 \(3\) failed/);
  assert.match(s.left[0], /an active session of the owner for the device, made by G1, until block \d+/);
  const ok = step(step(step(started(), "G1"), "R1", { ok: false, error: "x" }), "R1.2");
  goes(ok, "G2", "call");
});

test("T5 H10: a revoke that succeeded but is not the plan's, or with a fee above the most, stops", () => {
  stops(step(step(started(), "G1"), "R1", { after: "active" }), "R1", /R1 is not the plan's revoke/);
  stops(step(step(started(), "G1"), "R1", { fee: (BigInt(V("MAX_FEE")) + 1n).toString() }), "R1", /not the plan's revoke/);
});

test("T5 H10 U1: G2 taken: R2, then the end", () => {
  const r = step(step(step(started(), "G1"), "R1"), "G2");
  assert.deepEqual(goes(r, "R2", "call").cleanup, ["R2"]);
  const e = n(asPlanned("taken"));
  assert.equal(e.word, "end");
  assert.match(e.why, /U1: the chain took G2/);
});

test("T5 H10 U1: G2 refused with SessionAlreadyExists: the end; another error: the end, U1 open; no R2", () => {
  const e = n(asPlanned("refused"));
  assert.equal(e.word, "end");
  assert.match(e.why, /U1: the chain refused G2 with FlopSessionKeys.SessionAlreadyExists/);
  const o = n(step(step(step(started(), "G1"), "R1"), "G2", { ok: false, error: "FlopSessionKeys.TooManySessions" }));
  assert.equal(o.word, "end");
  assert.match(o.why, /U1 stays open: the chain refused G2 with FlopSessionKeys.TooManySessions/);
});

test("T5 H10: G2 taken with a fee above the most: R2 then stop", () => {
  const r = step(step(step(started(), "G1"), "R1"), "G2", { fee: (BigInt(V("MAX_FEE")) + 1n).toString() });
  goes(r, "R2", "call");
  step(r, "R2");
  stops(r, "G2", /took G2, which was not the plan's/);
});

test("T5 H10: an outcome the events cannot give stops", () => {
  const r = step(started(), "G1", { upTo: "block" });
  r.steps[0].decoder.success = null;
  stops(r, "G1", /outcome of G1 is unknown/);
  r.steps[0].decoder = { exit: 1, unknown: "the decoder: refused", success: null };
  stops(r, "G1", /readBlockEvents of G1's block exited 1/);
});

test("T5 H10: a lead stop at G1 stops; at R1 it is a try that did not happen, and R1.2 follows", () => {
  const r = started();
  r.steps.push({ step: "G1", run_time: null, lead_stop: { case: "a" } });
  stops(r, "G1", /the lead stopped G1 \(case a\)/);
  const q = step(started(), "G1");
  q.steps.push({ step: "R1", run_time: null, lead_stop: { case: "d" } });
  goes(q, "R1.2", "call");
});

test("T5 H12: the fence over steps.json: nothing moves, the expected fees, the worst case at or under 0.15 FLOP", () => {
  const c = costs(plan);
  assert.deepEqual(c.moved, []);
  assert.equal(c.expected_taken, 20638783460000000n, "B-10's expected fees");
  assert.equal(c.expected_taken, 2n * BigInt(V("FEE_GRANT")) + 2n * BigInt(V("FEE_REVOKE")));
  assert.equal(c.tries, 8n, "G1 and G2 once, R1 and R2 three times each");
  assert.equal(c.worst, 8n * BigInt(V("MAX_FEE")));
  assert.equal(c.fence, 150000000000000000n);
  assert.equal(c.within, true);
  for (const s of plan.steps) assert.deepEqual(s.moves ?? [], [], `${s.id} moves nothing`);
});
