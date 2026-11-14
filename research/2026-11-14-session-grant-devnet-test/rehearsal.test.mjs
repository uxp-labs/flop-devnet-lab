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
import { forDevice, started, step } from "./records.mjs";

const DEV1 = RERUN.accounts.dev1.public_key;
const ERRORS = readJson(join(REPO, plan.files.errors));
const runs = [];
after(() => { for (const r of runs) rmSync(r, { recursive: true, force: true }); });
const flopSign = (...args) => JSON.parse(execFileSync(process.execPath, [join(REPO, plan.files.signer), ...args, "--libs", join(REPO, "imd-flop")], { encoding: "utf8" })).call;

/**
 * A run folder with the seat of dev1 and a made run time record of dev1 at the phase a tool run is
 * for (tool-run.mjs runs only there, F10): G1's call; or, with `upTo`, the steps before it done in
 * the block of A1, the first block of the rerun, at or below the head of every tape here.
 */
const A1_BLOCK = rerunStep("A1").finalized_in_block;
function run(at = "G1 call") {
  const r = runWithSeat(DEV1);
  runs.push(r);
  const rec = forDevice(started(), DEV1);
  if (at === "R1 call") step(rec, "G1", { block: A1_BLOCK });
  if (at === "R1 after") { step(rec, "G1", { block: A1_BLOCK }); step(rec, "R1", { upTo: "block", block: A1_BLOCK }); }
  if (at === "G2 call") { step(rec, "G1", { block: A1_BLOCK }); step(rec, "R1", { block: A1_BLOCK }); }
  writeRecord(r, rec);
  return r;
}
async function over(node, id, purpose, r = run(`${id} ${purpose}`)) {
  const t = await sessionTapeOf(node, DEV1);
  return (await runTool({ plan, run: r, id, purpose, tapeText: t.text, tapeSha256: t.sha })).output;
}
async function absentAtA1() {
  const node = rerunNode("A1");
  const k = await keysFor(DEV1);
  for (const key of [k.sessions, k.nonces, k.breakers]) node.set(key, null); // set by this test: the recording holds no session key at A1
  return node;
}
/**
 * A node at a rerun step whose reads the recording does not hold are answered as nothing stored
 * (null): set by the tests that use it, as walk.mjs sets them, because tool-run refuses a tape that
 * holds a node error (F10). At A2 the recording reads no breaker of dev1; at A10 no nonce and no breaker.
 */
async function nullAt(at, names) {
  const node = rerunNode(at);
  const k = await keysFor(DEV1);
  for (const n of names) node.set(k[n], null);
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
  const o = await over(await nullAt("A2", ["breakers"]), "G1", "call");
  assert.equal(o.exit, 5);
  assert.equal(o.json, null);
  assert.match(o.stderr.join("\n"), /SessionAlreadyExists/);
});

test("T1: at A10, the session revoked: grant prints with the stored record line; revoke's hex is the rerun's recorded revoke call", async () => {
  const g = await over(await nullAt("A10", ["nonces", "breakers"]), "G2", "call");
  assert.equal(g.exit, 0, g.stderr.join("\n"));
  assert.equal(g.json.stored_record, `A record is stored for this pair, revoked. ${V("STORED_RECORD_LINE")}`);
  for (const at of ["A10", "A2"]) {
    const r = await over(await nullAt(at, at === "A10" ? ["nonces", "breakers"] : ["breakers"]), "R1", "call");
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

// This test replaces, by the lead's rule on F10 (13:03 UTC, Nov 14), its old assertion that the
// tool exits 1 over this tape: the tape is the same, and tool-run now refuses it.
test("T1: at the revoked state (A10) the tape holds the node's error for the nonce and the breaker: tool-run refuses it with words to read a fresh tape, writes nothing, and a second tape for the same step is taken", async () => {
  const r = run("R1 after");
  const bad = await sessionTapeOf(rerunNode("A10"), DEV1);
  assert.ok(bad.value.tape.some((c) => "error" in c), "the recording holds no nonce and no breaker of dev1 at A10");
  const { ToolRunError } = await import("./tool-run.mjs");
  await assert.rejects(runTool({ plan, run: r, id: "R1", purpose: "after", tapeText: bad.text, tapeSha256: bad.sha }), (e) => e instanceof ToolRunError && /with an error .*read a fresh tape for the same step/.test(e.message));
  const { existsSync } = await import("node:fs");
  assert.ok(!existsSync(join(r, "tool")) && !existsSync(join(r, "tapes")), "nothing is written");
  const good = await sessionTapeOf(await nullAt("A10", ["nonces", "breakers"]), DEV1);
  const o = (await runTool({ plan, run: r, id: "R1", purpose: "after", tapeText: good.text, tapeSha256: good.sha })).output;
  assert.equal(o.tape_sha256, good.sha, "the refused tape was not counted as used: the second is taken for the same step");
});

test("T1: session show at the revoked state (A10), the nonce and the breaker answered as nothing stored (set by this test, as the walk sets them): active false, as recorded, and exit 0", async () => {
  const o = await over(await nullAt("A10", ["nonces", "breakers"]), "R1", "after");
  assert.equal(o.exit, 0, o.stderr.join("\n"));
  assert.equal(String(o.json.session.value.active), rerunStep("A10").reads_after.session_active);
  assert.equal(o.json.session.value.active, false);
  for (const f of ["spending_cap", "per_tx_limit", "daily_cap"]) assert.equal(o.json.session.value[f], created("A2")[f], f);
  assert.notEqual(o.json.session_nonce.state, "unknown");
  assert.notEqual(o.json.circuit_breaker.state, "unknown");
});

test("T1: readBlockEvents over a block tape of A2 gives the recorded SessionCreated fields and fee", async () => {
  const a2 = rerunStep("A2");
  const r = runWithSeat(DEV1);
  runs.push(r);
  writeRecord(r, step(forDevice(started(), DEV1), "G1", { upTo: "final", sent: { status: "finalized", sent_by: "send", block_number: a2.finalized_in_block, block_hash: a2.block_hash, extrinsic_index: a2.extrinsic_index } }));
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
