// T2, rule H6: tool-run.mjs refuses each case, and then writes no output file and no tape file.
// The tapes are made by session-reads.js over the rerun's recording (rerun-node.mjs) and changed
// here, each with its relay sha256 made right, as a pane that read that would relay it. No network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { HERE } from "./lib.mjs";
import { plan, V, runWithSeat, sessionTapeOf, blockTapeOf, writeRecord, relayOf, relay } from "./fixtures.mjs";
import { rerunNode, rerunStep, RERUN } from "./rerun-node.mjs";
import { runTool, ToolRunError } from "./tool-run.mjs";
import { atR1Call } from "./records.mjs";

const DEV1 = RERUN.accounts.dev1.public_key;
const runs = [];
after(() => { for (const r of runs) rmSync(r, { recursive: true, force: true }); });
function run(steps = []) {
  const r = runWithSeat(DEV1);
  runs.push(r);
  writeRecord(r, { record: "run-time", accounts: { owner: { public_key: V("OWNER") }, device: { public_key: DEV1 } }, steps });
  return r;
}
const A6 = await sessionTapeOf(rerunNode("A6"), DEV1);
const nothingWritten = (r) => { for (const d of ["tool", "tapes"]) assert.ok(!existsSync(join(r, d)) || readdirSync(join(r, d)).length === 0, `${d} is empty`); };
async function refused(r, t, re, id = "R1", purpose = "call") {
  await assert.rejects(runTool({ plan, run: r, id, purpose, tapeText: t.text, tapeSha256: t.sha }), (e) => e instanceof ToolRunError && re.test(e.message), re.toString());
}
/** A run folder whose record is at R1's call (F10), G1 in the block of A1, below every tape's head here. */
function atCall() {
  const r = runWithSeat(DEV1);
  runs.push(r);
  writeRecord(r, atR1Call(DEV1, rerunStep("A1").finalized_in_block));
  return r;
}
const changed = (t, change) => { const v = structuredClone(t.value); change(v); return relayOf(v); };

test("T2: the tape as made passes, and writes one output and the tape", async () => {
  const r = atCall();
  const o = await runTool({ plan, run: r, id: "R1", purpose: "call", tapeText: A6.text, tapeSha256: A6.sha });
  assert.equal(o.output.exit, 0);
  assert.deepEqual(readdirSync(join(r, "tool")), ["R1.call.json"]);
  assert.deepEqual(readdirSync(join(r, "tapes")), ["R1.call.json"]);
});

test("T2 H6: a tape whose block 0 is not the plan's genesis is refused", async () => {
  const r = run();
  await refused(r, changed(A6, (v) => { v.tape.find((c) => c.method === "chain_getBlockHash" && c.params[0] === 0).result = "0x" + "11".repeat(32); }), /block 0 is 0x1111.*not the plan's genesis/);
  nothingWritten(r);
});

test("T2 H6: a tape whose head is below the last finalized step of the record is refused", async () => {
  const a10 = rerunStep("A10");
  const r = run([{ step: "G1", run_time: { sent: { status: "finalized", block_number: a10.finalized_in_block, block_hash: a10.block_hash, extrinsic_index: 1 } } }]);
  await refused(r, A6, new RegExp(`head ${rerunStep("A6").finalized_in_block} is below block ${a10.finalized_in_block}.*stale`));
  nothingWritten(r);
});

test("T2 H6: a head the tool prints that is not the tape's is refused", async () => {
  const r = run();
  await refused(r, changed(A6, (v) => { v.head.number += 1; }), /the tool printed the head .* not the tape's/);
  nothingWritten(r);
});

test("T2 H6: a metadata sha256 that is not the committed one is refused, and so is a length that differs", async () => {
  const r = run();
  await refused(r, changed(A6, (v) => { v.metadata.sha256 = "00".repeat(32); }), /metadata has sha256 0000.*not the committed/);
  await refused(r, changed(A6, (v) => { v.metadata.length += 1; }), /not the committed/);
  nothingWritten(r);
});

test("T2 H6: a tape used a second time, for another command, is refused", async () => {
  const r = atCall();
  await runTool({ plan, run: r, id: "R1", purpose: "call", tapeText: A6.text, tapeSha256: A6.sha });
  await refused(r, A6, /was used already, for R1\.call\.json/, "R1", "after");
  assert.deepEqual(readdirSync(join(r, "tool")), ["R1.call.json"]);
});

test("T2 H5: a question the tape does not hold is refused, never answered by a default", async () => {
  const r = run();
  await refused(r, changed(A6, (v) => { v.tape = v.tape.filter((c) => !(c.method === "state_getStorage" && c.params[0] === v.tape[v.tape.length - 1].params[0])); }), /asked what the tape does not answer: state_getStorage/);
  nothingWritten(r);
});

test("T2: a relay whose sha256 is not its text's, a block tape for a call, and a block tape of another block are refused", async () => {
  const r = run();
  await refused(r, { text: A6.text, sha: "ab".repeat(32) }, /changed on its way/);
  const node = rerunNode("A6");
  const b = await blockTapeOf(node, DEV1, node.blockOf("A2"));
  await refused(r, b, /a call reads a session tape, not a block tape/);
  const a3 = rerunStep("A3");
  const rb = run([{ step: "G1", run_time: { sent: { status: "finalized", block_number: a3.finalized_in_block, block_hash: a3.block_hash, extrinsic_index: 1 } } }]);
  await refused(rb, b, /the tape is of block .* not G1's/, "G1", "block");
  nothingWritten(r); nothingWritten(rb);
});

test("T2: the command line refuses with exit 2 and its words, and prints no tape", () => {
  const r = run();
  const bad = relay({ kind: "session" });
  const p = spawnSync(process.execPath, [join(HERE, "tool-run.mjs"), "R1", "call", "--run", r, "--tape", bad.text, "--tape-sha256", bad.sha], { encoding: "utf8" });
  assert.equal(p.status, 2);
  assert.equal(p.stderr, "tool-run: the tape is not a list of { method, params, result or error }\n");
  assert.equal(p.stdout, "");
});

test("T2 H5: the tape's transport answers the metadata question with the committed bytes only when the tape's sha256 is theirs", async () => {
  const { committedMetadata, tapeTransport } = await import("./tape.mjs");
  const md = await committedMetadata(plan);
  const ok = tapeTransport(A6.value, md);
  assert.equal(await ok("state_getMetadata", [A6.value.metadata.at]), md.hex);
  const missed = [];
  const bad = tapeTransport({ ...A6.value, metadata: { ...A6.value.metadata, sha256: "00".repeat(32) } }, md, { missed });
  await assert.rejects(bad("state_getMetadata", [A6.value.metadata.at]), /not the committed bytes/);
  assert.equal(missed[0].why, "the metadata's sha256 is not the committed one");
  await assert.rejects(ok("state_getMetadata", ["0x" + "12".repeat(32)]), /holds no answer/);
});
