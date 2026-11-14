// T1, the offline rehearsal (H5, H16): the tool's own code, run by tool-run.mjs over tapes of the
// pane's form, made by session-reads.js over the rerun's recording (rerun-node.mjs: the header and
// the metadata made as imd-flop/test/lib/recorded-node.ts makes them). The seat's identity names the
// rerun's dev1. No network, no key.
//
// What the recording does not hold, and these tests therefore set, said where it is set:
//  - the pair absent: the recording reads no session key of dev1 before A2, so at A1 the tape's
//    answers for Sessions, SessionNonces and CircuitBreakers of (S, dev1) are set to null (no value
//    stored), as imd-flop's own tests set them (test/lib/session-fixtures.ts withNone).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO, plan, V, runWithSeat, sessionTapeOf, blockTapeOf, keysFor, writeRecord } from "./fixtures.mjs";
import { rerunNode, rerunStep, RERUN } from "./rerun-node.mjs";
import { runTool } from "./tool-run.mjs";
import { decoderReading } from "./events.mjs";
import { readJson } from "./lib.mjs";

const DEV1 = RERUN.accounts.dev1.public_key;
const ERRORS = readJson(join(REPO, plan.files.errors));
const runs = [];
after(() => { for (const r of runs) rmSync(r, { recursive: true, force: true }); });
const flopSign = (...args) => JSON.parse(execFileSync(process.execPath, [join(REPO, plan.files.signer), ...args, "--libs", join(REPO, "imd-flop")], { encoding: "utf8" })).call;

/** A run folder with the seat of dev1 and a run time record with no step yet, or with the steps given. */
function run(steps = []) {
  const r = runWithSeat(DEV1);
  runs.push(r);
  writeRecord(r, { record: "run-time", accounts: { owner: { public_key: V("OWNER"), ss58: V("OWNER_SS58") }, device: { public_key: DEV1, ss58: RERUN.accounts.dev1.ss58 } }, steps });
  return r;
}
async function over(node, id, purpose, r = run()) {
  const t = await sessionTapeOf(node, DEV1);
  return (await runTool({ plan, run: r, id, purpose, tapeText: t.text, tapeSha256: t.sha })).output;
}
async function absentAtA1() {
  const node = rerunNode("A1");
  const k = await keysFor(DEV1);
  for (const key of [k.sessions, k.nonces, k.breakers]) node.set(key, null); // set by this test: the recording holds no session key at A1
  return node;
}
const created = (id) => rerunStep(id).events.find((e) => e.name === "SessionCreated").fields;

test("T1: the local caps of the rehearsal's seat are the rerun's A2 grant's per_tx_limit and daily_cap", () => {
  assert.equal(created("A2").per_tx_limit, V("A_PER_TX"));
  assert.equal(created("A2").daily_cap, V("A_DAILY"));
});

test("T1: at A1, the pair absent: session grant prints, and its hex is flop-sign's create-session for the same values with 86400 blocks", async () => {
  const o = await over(await absentAtA1(), "G1", "call");
  assert.equal(o.exit, 0, o.stderr.join("\n"));
  assert.deepEqual(o.json.head, { number: rerunStep("A1").finalized_in_block, hash: rerunStep("A1").block_hash });
  assert.equal(o.json.stored_record, null);
  assert.deepEqual(o.json.caps, { spending_cap: V("SPENDING_CAP"), per_tx_limit: V("A_PER_TX"), daily_cap: V("A_DAILY"), duration_blocks: 86400, days: 1, epoch_length: 86400 });
  const second = flopSign("call", "create-session", "--delegate", DEV1, "--cap", V("SPENDING_CAP"), "--per-tx", V("A_PER_TX"), "--daily", V("A_DAILY"), "--blocks", V("DURATION"), "--allow", V("ALLOW"));
  assert.equal(o.json.call_hex, second);
});

test("T1: at A2, the session active: session grant refuses with exit 5 and prints no call", async () => {
  const o = await over(rerunNode("A2"), "G1", "call");
  assert.equal(o.exit, 5);
  assert.equal(o.json, null);
  assert.match(o.stderr.join("\n"), /SessionAlreadyExists/);
});

test("T1: at A10, the session revoked: grant prints with the stored record line; revoke's hex is the rerun's recorded revoke call", async () => {
  const g = await over(rerunNode("A10"), "G2", "call");
  assert.equal(g.exit, 0, g.stderr.join("\n"));
  assert.equal(g.json.stored_record, `A record is stored for this pair, revoked. ${V("STORED_RECORD_LINE")}`);
  for (const at of ["A10", "A2"]) {
    const r = await over(rerunNode(at), "R1", "call");
    assert.equal(r.exit, 0, r.stderr.join("\n"));
    assert.equal(r.json.call_hex, rerunStep("A10").call, at);
    assert.equal(r.json.call_hex, flopSign("call", "revoke", "--delegate", DEV1), at);
  }
});

test("T1: session show at the active state (A6) gives the recorded values", async () => {
  const o = await over(rerunNode("A6"), "R1", "after");
  assert.equal(o.exit, 0, o.stderr.join("\n"));
  const s = o.json.session.value, ra = rerunStep("A6").reads_after, c = created("A2");
  assert.equal(s.active, true);
  for (const f of ["spending_cap", "per_tx_limit", "daily_cap"]) assert.equal(s[f], c[f], f);
  assert.equal(s.expires_at, c.expires_at);
  assert.equal(s.spent, ra.spent_raw);
  assert.equal(s.epoch_spent, ra.epoch_spent_raw);
  assert.equal(o.json.session_nonce.value, ra.session_nonce);
  assert.equal(String(o.json.circuit_breaker.value.tx_count), ra.breaker_tx_count);
});

test("T1: session show at the revoked state (A10) gives active false, as recorded; the nonce and the breaker are unknown there (the recording does not read them at A10), so exit 1", async () => {
  const o = await over(rerunNode("A10"), "R1", "after");
  assert.equal(o.exit, 1);
  assert.equal(String(o.json.session.value.active), rerunStep("A10").reads_after.session_active);
  assert.equal(o.json.session_nonce.state, "unknown");
  assert.equal(o.json.circuit_breaker.state, "unknown");
});

test("T1: readBlockEvents over a block tape of A2 gives the recorded SessionCreated fields and fee", async () => {
  const a2 = rerunStep("A2");
  const r = run([{ step: "G1", run_time: { sent: { status: "finalized", block_number: a2.finalized_in_block, block_hash: a2.block_hash, extrinsic_index: a2.extrinsic_index } } }]);
  const node = rerunNode("A6");
  const t = await blockTapeOf(node, DEV1, node.blockOf("A2"));
  const o = (await runTool({ plan, run: r, id: "G1", purpose: "block", tapeText: t.text, tapeSha256: t.sha })).output;
  assert.equal(o.exit, 0);
  const d = decoderReading(o, a2.extrinsic_index, ERRORS, V("OWNER"));
  assert.deepEqual(d.events, a2.events);
  assert.equal(d.success, true);
  assert.equal(d.fee_raw, a2.fee_raw);
  assert.deepEqual(d.events.find((e) => e.name === "SessionCreated").fields, created("A2"));
  assert.equal(readFileSync(join(r, "tapes", "G1.block.json"), "utf8"), t.text, "the tape is kept byte for byte");
});
