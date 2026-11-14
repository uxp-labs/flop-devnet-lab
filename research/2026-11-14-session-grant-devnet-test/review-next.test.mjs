// Review of G-19, attack 4 (G4): plan.mjs next over made run records (records.mjs), hunting for a
// state where it prints a line that signs or sends when it should stop. No network, no key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan, V, tempDir } from "./fixtures.mjs";
import { nextOf } from "./next.mjs";
import { nextText } from "./plan.mjs";
import { started, step, DEVICE, H } from "./records.mjs";
import { nonceOf } from "../2026-11-12-encoder-devnet-test/research-signed.mjs";
import { sendFile, signedFile } from "./run.mjs";

const DIR = tempDir("g19-review-next");
after(() => rmSync(DIR, { recursive: true, force: true }));
const n = (r) => nextOf(plan, r);
const SIGN_OR_SEND = /flop-sign\.mjs" sign|lab\.send\(|lab\.sendSame\(/;
const one = (x, d) => (BigInt(x) + BigInt(d)).toString();

/** A run folder with a signed file and a send file for an id, so the wait and send lines can be printed. */
function folder(ids) {
  const run = join(DIR, `r${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(run, "signed"), { recursive: true });
  for (const id of ids) {
    writeFileSync(signedFile(run, id), JSON.stringify({ extrinsic: "0x00", extrinsic_hash: H(1) }));
    writeFileSync(sendFile(run, id), JSON.stringify({ step: id, extrinsic: "0x00" }));
  }
  return run;
}

test("HOLDS: each field of G1's SessionCreated one unit off, its expiry one block off, or its fee one unit above the most: R1 with cleanup, then stop", () => {
  const offs = [
    { fields: { spending_cap: one(V("SPENDING_CAP"), 1) } }, { fields: { spending_cap: one(V("SPENDING_CAP"), -1) } },
    { fields: { per_tx_limit: one(V("A_PER_TX"), 1) } }, { fields: { daily_cap: one(V("A_DAILY"), -1) } },
    { fields: { owner: DEVICE } }, { fields: { delegate: V("OWNER") } },
    { fields: { expires_at: 4000010 + Number(V("DURATION")) + 1 } }, { fields: { expires_at: 4000010 + Number(V("DURATION")) - 1 } },
    { fee: one(V("MAX_FEE"), 1) },
  ];
  for (const o of offs) {
    const x = n(step(started(), "G1", o));
    assert.equal(x.step, "R1", JSON.stringify(o));
    assert.deepEqual(x.cleanup, ["R1"]);
    const y = n(step(step(started(), "G1", o), "R1"));
    assert.equal(y.word, "stop", JSON.stringify(o));
    assert.equal(y.stopped_at, "G1");
  }
});

test("HOLDS: at every stop and every end the review made, plan.mjs next prints no line that signs or sends", async () => {
  const states = [
    started({ chain: { spec_version_at_start: 1 } }), started({ count: { value: 9 } }), started({ session: { state: "stored", value: { active: false } } }),
    step(started(), "G1", { callRefused: "x" }), step(started(), "G1", { signedRefused: "x" }), step(started(), "G1", { ok: false, error: "FlopSessionKeys.TooManySessions" }),
    step(step(started(), "G1", { fee: one(V("MAX_FEE"), 1) }), "R1"),
    step(step(step(step(started(), "G1"), "R1", { ok: false }), "R1.2", { ok: false }), "R1.3", { ok: false }),
    step(step(started(), "G1"), "R1", { after: "active" }),
    step(step(step(started(), "G1"), "R1"), "G2", { ok: false, error: `FlopSessionKeys.${V("ALREADY_EXISTS")}` }),
    step(step(step(started(), "G1"), "R1"), "G2", { ok: false, error: "FlopSessionKeys.TooManySessions" }),
    step(step(step(started(), "G1"), "R1"), "G2", { ok: false, error: null }),
    step(step(step(step(started(), "G1"), "R1"), "G2"), "R2"),
    step(step(step(step(step(step(started(), "G1"), "R1"), "G2"), "R2", { ok: false }), "R2.2", { ok: false }), "R2.3", { ok: false }),
    step(step(step(step(started(), "G1"), "R1"), "G2", { fields: { daily_cap: "1" } }), "R2"),
  ];
  for (const r of states) {
    const x = n(r);
    assert.ok(["stop", "end"].includes(x.word), JSON.stringify(x));
    const text = await nextText(plan, folder([]), r);
    assert.doesNotMatch(text, SIGN_OR_SEND, x.why);
  }
});

test("HOLDS: a cleanup try after the lead stopped a revoke is signed at the same nonce as the stopped copy, so only one can land", () => {
  const r = step(step(started(), "G1"), "R1", { upTo: "sign" });
  r.steps[1].lead_stop = { case: "d" };
  const x = n(r);
  assert.equal(x.step, "R1.2");
  assert.equal(nonceOf(plan, r, "R1.2"), nonceOf(plan, r, "R1"));
});

test("DEFECT RG19-7: after G2 refused, or G1 failed, a show after that does not say what the end claims is a stop that says a session may be active", () => {
  const g2 = step(step(step(started(), "G1"), "R1"), "G2", { ok: false, error: `FlopSessionKeys.${V("ALREADY_EXISTS")}`, after: "active" });
  const x = n(g2);
  assert.notEqual(x.word, "end", `the end says "${x.why}" while show after G2 says active`);
  const g1 = step(started(), "G1", { ok: false, error: "FlopSessionKeys.TooManySessions", after: "active" });
  const y = n(g1);
  assert.ok(!/nothing is active/.test(y.why), `the stop says "${y.why}" while show after G1 says active`);
});

test("DEFECT RG19-8: at a refusal with node code 1010 at a first send of an immortal step, plan.mjs next prints no sendSame line: the row says the lead stops", async () => {
  for (const code of [1010, 1014]) {
    const r = step(started(), "G1", { sent: { status: "refused-at-submission", sent_by: "send", node: { code, message: "made" } } });
    const x = n(r);
    const text = await nextText(plan, folder(["G1"]), r);
    assert.doesNotMatch(text, /lab\.sendSame\(/, `${code}: ${x.word} ${x.phase}: a sendSame line is printed`);
  }
});

test("DEFECT RG19-9: a record that holds an id twice, or an id the plan does not have, is a stop, not a nonce counted from it", () => {
  const twice = step(started(), "G1");
  twice.steps.push(structuredClone(twice.steps[0]));
  assert.equal(nonceOf(plan, twice, "R1"), 22n, "R1's nonce counts G1 twice");
  assert.equal(n(twice).word, "stop", "a record with G1 twice goes on to R1 at a nonce one above the chain's");
  const unknown = step(step(started(), "G1"), "R1", { ok: false });
  unknown.steps.push({ ...structuredClone(unknown.steps[1]), step: "R1.4" });
  assert.equal(n(unknown).word, "stop", "a record with an id the plan does not have goes on");
});
