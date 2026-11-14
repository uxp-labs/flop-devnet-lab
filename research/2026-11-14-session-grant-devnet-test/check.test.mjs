// T6, rule H15: check.mjs and judge.mjs over made run time records (records.mjs): a whole pass on
// each branch of G2; each claim differing in turn; an incomplete record; unknown never judged as a
// pass. No network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./lib.mjs";
import { plan, V, tempDir } from "./fixtures.mjs";
import { judge } from "./judge.mjs";
import { asPlanned, started, step } from "./records.mjs";

const DIR = tempDir("g19-check");
after(() => rmSync(DIR, { recursive: true, force: true }));
const statusOf = (out, id, re) => { const c = out.claims.find((x) => x.id === id && re.test(x.what)); assert.ok(c, `${id} ${re}`); return c.status; };
const cli = (r) => { const f = join(DIR, `r-${Math.random().toString(16).slice(2)}.json`); writeFileSync(f, JSON.stringify(r)); return spawnSync(process.execPath, [join(HERE, "check.mjs"), f], { encoding: "utf8" }); };

test("T6: a whole pass with G2 taken: every claim passes, exit 0, and the verdict says the end", () => {
  const out = judge(plan, asPlanned("taken"));
  assert.deepEqual(out.claims.filter((c) => c.status !== "pass").map((c) => `${c.id} ${c.what} ${c.status}`), []);
  assert.equal(out.branch, "taken");
  assert.equal(out.exit, 0);
  assert.match(out.verdict, /^passed; the end: U1: the chain took G2/);
  const p = cli(asPlanned("taken"));
  assert.equal(p.status, 0);
  assert.match(p.stdout, /verdict: passed; the end/);
  assert.doesNotMatch(p.stdout, /verified/);
});

test("T6: a whole pass with G2 refused with SessionAlreadyExists: R2 not needed, exit 0", () => {
  const out = judge(plan, asPlanned("refused"));
  assert.equal(out.branch, "refused");
  assert.equal(statusOf(out, "R2", /SessionRevoked/), "not needed");
  assert.equal(statusOf(out, "G2", /outcome/), "pass");
  assert.deepEqual(out.claims.filter((c) => !["pass", "not needed"].includes(c.status)).map((c) => c.what), []);
  assert.equal(out.exit, 0);
  assert.match(out.verdict, /^passed; the end: U1: the chain refused G2 with FlopSessionKeys.SessionAlreadyExists/);
});

test("T6: G2 refused with another error: U1 stays open, said in the claim", () => {
  const r = asPlanned("refused", "FlopSessionKeys.TooManySessions");
  const out = judge(plan, r);
  assert.equal(out.branch, "other");
  assert.match(out.claims.find((c) => c.id === "G2").why, /U1 stays open/);
});

test("T6: each claim differing in turn says differ, exit 1", () => {
  const cases = [
    ["G1", /SessionCreated is the derived/, (r) => { r.steps[0].decoder.events[0].fields.daily_cap = "1"; }],
    ["G1", /SessionCreated is the derived/, (r) => { r.steps[0].decoder.events[0].fields.delegate = "0x" + "77".repeat(32); }],
    ["G1", /expires_at/, (r) => { r.steps[0].decoder.events[0].fields.expires_at += 1; }],
    ["G1", /show after says active/, (r) => { r.steps[0].after.session.value.per_tx_limit = "1"; }],
    ["G1", /show after says active/, (r) => { r.steps[0].after.session.value.active = false; }],
    ["R1", /SessionRevoked/, (r) => { r.steps[1].decoder.events[0].fields.delegate = "0x" + "77".repeat(32); }],
    ["R1", /show after says revoked/, (r) => { r.steps[1].after.session.value.active = true; }],
    ["R2", /SessionRevoked/, (r) => { r.steps[3].decoder.events[0].name = "SessionCreated"; }],
    ["G2", /its fee/, (r) => { r.steps[2].decoder.fee_raw = (BigInt(V("MAX_FEE")) + 1n).toString(); }],
    ["R1", /explorer's reading agrees/, (r) => { r.steps[1].sources_differ = ["success: the decoder says true, the explorer false"]; }],
    ["batch", /free balance/, (r) => { r.balances.owner_free_after = "1"; }],
  ];
  for (const [id, re, change] of cases) {
    const r = asPlanned("taken");
    change(r);
    const out = judge(plan, r);
    assert.equal(statusOf(out, id, re), "differ", `${id} ${re}`);
    assert.equal(out.exit, 1, `${id} ${re}`);
    assert.match(out.verdict, /^differs/);
  }
});

test("T6: an incomplete record: a step not run is not run, a missing explorer reading is incomplete, no balances is not run; exit 4", () => {
  const r = step(started(), "G1");
  const out = judge(plan, r);
  assert.equal(statusOf(out, "G1", /SessionCreated/), "pass");
  assert.equal(statusOf(out, "R1", /SessionRevoked/), "not run");
  assert.equal(statusOf(out, "G2", /outcome/), "not run");
  assert.equal(statusOf(out, "G1", /explorer/), "incomplete");
  assert.equal(statusOf(out, "batch", /free balance/), "not run");
  assert.equal(out.exit, 4);
  assert.match(out.verdict, /^incomplete; not finished: next R1 call/);
  assert.equal(cli(r).status, 4);
});

test("T6: unknown is never a pass: a fee not read, an outcome not read, a show that exited 1, an unknown balance", () => {
  const cases = [
    ["G1", /its fee/, (r) => { r.steps[0].decoder.fee_raw = null; }],
    ["G2", /outcome/, (r) => { r.steps[2].decoder.success = null; }],
    ["G1", /show after says active/, (r) => { r.steps[0].after = { exit: 1, session: { state: "unknown", value: null } }; }],
    ["G1", /SessionCreated/, (r) => { r.accounts.device.public_key = undefined; }],
    ["batch", /free balance/, (r) => { r.balances.owner_free_before = null; }],
  ];
  for (const [id, re, change] of cases) {
    const r = asPlanned("taken");
    change(r);
    const out = judge(plan, r);
    assert.notEqual(statusOf(out, id, re), "pass", `${id} ${re}`);
    assert.notEqual(out.exit, 0);
  }
});

test("T6: a record stopped at P0 is judged not run throughout, with the stop in the verdict", () => {
  const out = judge(plan, started({ count: { value: 9 } }));
  assert.match(out.verdict, /stopped at P0: SessionCount\(S\) is 9/);
  assert.equal(out.claims.filter((c) => c.status === "pass").length, 0);
});

test("T6: check.mjs refuses what is not a run time record, with exit 2", () => {
  assert.equal(cli({ record: "final", steps: [] }).status, 2);
  const p = spawnSync(process.execPath, [join(HERE, "check.mjs")], { encoding: "utf8" });
  assert.equal(p.status, 2);
});
