// A walk of the run time record through record-step.mjs's own functions and tool-run.mjs, over tapes
// session-reads.js makes from the rerun's recording (rerun-node.mjs), with the seat of dev1 (H13,
// H14). The rerun's dev1 grant (A2) was made for 7200 blocks with a lifetime cap of 0.05 FLOP, so the
// tools must find G1 not the plan's and say R1, then stop. What is made, and said here:
//  - the pair absent at A1, and SessionCount(S) not stored there: the recording reads neither, so
//    their answers are set to null (no value stored);
//  - at A10 the recording reads no session nonce and no breaker of dev1: they are set to null too;
//  - the runner's and the explorer's relays are made in their forms, from the recorded step;
//  - the signed files are flop-sign.mjs sign's with a test key, and recordSigned runs with the plan's
//    OWNER set to that key in a copy held in memory (owner-signed.test.mjs holds the check itself).
// No network, no real key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REPO, plan, V, tempDir, testKey, runWithSeat, sessionTapeOf, blockTapeOf, keysFor, relay, writeRecord } from "./fixtures.mjs";
import { readJson, sha256Text, ss58 } from "./lib.mjs";
import { rerunNode, rerunStep, RERUN } from "./rerun-node.mjs";
import { readerOver, plain } from "./pane.mjs";
import { runTool } from "./tool-run.mjs";
import { recordCall, recordReading, recordSigned, recordTool, startRecord, sourcesDiffer } from "./record-step.mjs";
import { nextOf } from "./next.mjs";
import { nextText } from "./plan.mjs";
import { callFile, sendFile, signedFile } from "./run.mjs";

const DEV1 = RERUN.accounts.dev1.public_key;
const ERRORS = readJson(join(REPO, plan.files.errors));
const DIR = tempDir("g19-flow-keys");
const run = runWithSeat(DEV1, "g19-flow");
after(() => { rmSync(DIR, { recursive: true, force: true }); rmSync(run, { recursive: true, force: true }); });
const owner = testKey(DIR, "flow-owner");
const signerPlan = structuredClone(plan);
signerPlan.values.OWNER.value = owner.public_key;
const K = await keysFor(DEV1);
const tape = async (node) => sessionTapeOf(node, DEV1);
let results = null;
const use = async (id, purpose, t) => { if (results) writeRecord(run, results); return (await runTool({ plan, run, id, purpose, tapeText: t.text, tapeSha256: t.sha })).output; };

/** The runner's reading of a recorded rerun step, as pane-runner.js send relays a finalized one. */
const sentOf = (id, rerunId) => {
  const s = rerunStep(rerunId), signed = readJson(signedFile(run, id));
  return relay({ step: id, bundle_sha256: sha256Text(readFileSync(sendFile(run, id), "utf8")), extrinsic_sha256: sha256Text(signed.extrinsic), extrinsic_hash: signed.extrinsic_hash, sent_by: "send", statuses: ["ready", "inBlock", "finalized"], status: "finalized", block_hash: s.block_hash, block_number: s.finalized_in_block, extrinsic_index: s.extrinsic_index, events_sha256: s.events_value_sha256, events_length: 1, finalized_utc: "2026-11-14T00:00:00.000Z" });
};
function sign(id) {
  const call = readJson(callFile(run, id)).call;
  const nonce = String(BigInt(results.owner_account_nonce_at_start) + BigInt(results.steps.filter((e) => e.run_time?.sent?.status === "finalized").length));
  mkdirSync(join(run, "signed"), { recursive: true });
  execFileSync(process.execPath, [join(REPO, plan.files.signer), "sign", "--key", owner.path, "--call", call, "--nonce", nonce, "--out", signedFile(run, id), "--spec", V("SPEC"), "--txv", V("TXV"), "--genesis", V("GENESIS"), "--libs", join(REPO, "imd-flop")], { stdio: ["ignore", "pipe", "pipe"] });
  const s = recordSigned(signerPlan, run, results, id);
  assert.ok(s.sendText, s.results.steps.at(-1).signed_check?.refused);
  writeFileSync(sendFile(run, id), s.sendText);
  results = s.results;
}
function call(id) {
  const c = recordCall(plan, run, results, id);
  assert.ok(c.callText, JSON.stringify(c.results.steps.at(-1).call));
  mkdirSync(join(run, "calls"), { recursive: true });
  writeFileSync(callFile(run, id), c.callText);
  results = c.results;
}

test("the walk: P0 at A1, then G1 at A2 is found not the plan's, so R1 at A10, then stop", async () => {
  // P0
  const a1 = rerunNode("A1");
  for (const key of [K.sessions, K.nonces, K.breakers, K.session_count]) a1.set(key, null); // made: see the head of this file
  assert.equal((await use("P0", "show", await tape(a1))).exit, 0);
  const probe = plain(await readerOver(rerunNode("A1")).reader.probe(Number(V("PROBE_BACK"))));
  const reads = { account: V("OWNER_SS58"), runtime: { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")), transactionVersion: Number(V("TXV")), genesisHash: V("GENESIS") }, finalized: { number: rerunStep("A1").finalized_in_block, hash: rerunStep("A1").block_hash }, account_nonce: 9 };
  results = await startRecord({ plan, run, reads, readsSha256: "ab".repeat(32), probe, probeSha256: probe.relay_sha256 });
  assert.equal(results.p0.session.state, "none");
  assert.deepEqual(results.p0.session_count, { raw: null, value: 0, stored: false, reason: "no value stored: the metadata default 0 (research/2026-11-11-onchain-spend-limit/report.md, FlopSessionKeys.SessionCount)" });
  assert.equal(results.accounts.device.public_key, DEV1, "the device comes from the seat's identity.json did");
  assert.equal(results.probe.answered, false);
  assert.equal(nextOf(plan, results).phase, "call");
  // G1: the call over a tape at A1 again (a new read: its sha256 differs because its time does)
  const a1b = rerunNode("A1");
  for (const key of [K.sessions, K.nonces, K.breakers]) a1b.set(key, null);
  const t = plain(await readerOver(a1b).reader.sessionTape({ lru: K.lru, sessions: K.sessions, nonces: K.nonces, breakers: K.breakers, session_count: K.session_count, rotation_history: K.rotation_history }));
  const again = { ...t, read_utc: "2026-11-14T00:00:01.000Z" };
  const { relay: _a, relay_sha256: _b, ...v } = again;
  await use("G1", "call", relay(v));
  call("G1");
  assert.equal(results.steps[0].call.equal, true);
  sign("G1");
  const sent = sentOf("G1", "A2");
  results = recordReading({ plan, run, results, id: "G1", sent: JSON.parse(sent.text), sentSha256: sent.sha, errors: ERRORS });
  assert.equal(nextOf(plan, results).phase, "block");
  const a6 = rerunNode("A6");
  await use("G1", "block", await blockTapeOf(a6, DEV1, a6.blockOf("A2")));
  results = recordTool(plan, run, results, "G1", "block", ERRORS);
  assert.equal(results.steps[0].decoder.fee_raw, rerunStep("A2").fee_raw);
  await use("G1", "after", await tape(rerunNode("A6")));
  results = recordTool(plan, run, results, "G1", "after", ERRORS);
  const n1 = nextOf(plan, results);
  assert.equal(n1.step, "R1");
  assert.deepEqual(n1.cleanup, ["R1"]);
  assert.ok(n1.findings.some((f) => /SessionCreated spending_cap is 50000000000000000, the plan's is 25000000000000000/.test(f)));
  assert.ok(n1.findings.some((f) => /expires_at is 3559929, not its block 3552729 plus 86400/.test(f)));
  const text = await nextText(plan, run, results);
  assert.match(text, /tool-run\.mjs" R1 call --run/);
  assert.match(text, /explorer\.read\("0x[0-9a-f]{64}"\)/, "the explorer's reading of G1 is asked beside");
  // the explorer's reading of G1, made in its form: the same SessionCreated, so the sources agree
  const c = rerunStep("A2").events.find((e) => e.name === "SessionCreated").fields;
  const xr = { source: `${V("EXPLORER")}/api/transactions/${results.steps[0].run_time.extrinsic_hash}`, read_utc: "2026-11-14T00:00:02.000Z", hash: results.steps[0].run_time.extrinsic_hash, block_hash: rerunStep("A2").block_hash, success: true, error: null, failed_data: null, names: ["balances.Withdraw", "flopSessionKeys.SessionCreated", "balances.Deposit", "transactionPayment.TransactionFeePaid", "system.ExtrinsicSuccess"], events: [{ section: "flopSessionKeys", method: "SessionCreated", data: { owner: ss58(c.owner), delegate: ss58(c.delegate), spendingCap: "50,000,000,000,000,000", perTxLimit: "20,000,000,000,000,000", dailyCap: "25,000,000,000,000,000", expiresAt: "3,559,929" } }] };
  const xrr = relay(xr);
  results = recordReading({ plan, run, results, id: "G1", explorer: JSON.parse(xrr.text), explorerSha256: xrr.sha, errors: ERRORS });
  assert.deepEqual(results.steps[0].sources_differ, []);
  assert.equal(results.steps[0].run_time.explorer.source_kind, "second, weaker: FLOP's explorer API");
  // a differing explorer reading is said to differ
  const other = structuredClone(results.steps[0]);
  other.run_time.explorer.events[0].fields.spending_cap = "1";
  assert.match(sourcesDiffer(other).join("; "), /SessionCreated spending_cap: the decoder says 50000000000000000, the explorer 1/);
  // R1 at A10
  await use("R1", "call", await tape(rerunNode("A8")));
  call("R1");
  sign("R1");
  const s2 = sentOf("R1", "A10");
  results = recordReading({ plan, run, results, id: "R1", sent: JSON.parse(s2.text), sentSha256: s2.sha, errors: ERRORS });
  const a10 = rerunNode("A10");
  await use("R1", "block", await blockTapeOf(a10, DEV1, a10.blockOf("A10")));
  results = recordTool(plan, run, results, "R1", "block", ERRORS);
  assert.ok(results.steps[1].decoder.names.includes("FlopSessionKeys.SessionRevoked"));
  const a10b = rerunNode("A10");
  for (const key of [K.nonces, K.breakers]) a10b.set(key, null); // made: see the head of this file
  await use("R1", "after", await tape(a10b));
  results = recordTool(plan, run, results, "R1", "after", ERRORS);
  const n2 = nextOf(plan, results);
  assert.equal(n2.word, "stop");
  assert.match(n2.why, /G1 was not the plan's .*R1 has ended its session/);
  assert.match(await nextText(plan, run, results), /# STOP at G1/);
  assert.ok(existsSync(join(run, "tapes", "R1.after.json")));
});

test("a start whose runtime the reads do not give stops at P0, and nothing is signed", async () => {
  const r2 = runWithSeat(DEV1, "g19-flow-refused");
  try {
    const a1 = rerunNode("A1");
    for (const key of [K.sessions, K.nonces, K.breakers, K.session_count]) a1.set(key, null);
    const t = await tape(a1);
    await runTool({ plan, run: r2, id: "P0", purpose: "show", tapeText: t.text, tapeSha256: t.sha });
    const probe = plain(await readerOver(rerunNode("A1")).reader.probe(5));
    let r = await startRecord({ plan, run: r2, reads: { account: V("OWNER"), runtime: {}, finalized: { number: 1, hash: "0x" + "00".repeat(32) }, account_nonce: 3 }, readsSha256: "00".repeat(32), probe, probeSha256: probe.relay_sha256 });
    assert.equal(nextOf(plan, r).word, "stop", "a start whose runtime is not read stops at P0");
    assert.match(nextOf(plan, r).why, /the runtime at the start is null null/);
  } finally { rmSync(r2, { recursive: true, force: true }); }
});
