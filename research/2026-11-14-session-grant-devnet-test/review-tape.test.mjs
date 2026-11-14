// Review of G-19, attack 3 (G3): tool-run.mjs over forged tapes, each relayed with its sha256 made
// right, as a pane that read that would relay it. The tapes are session-reads.js's over the rerun's
// recording (rerun-node.mjs). No network, no key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { plan, V, runWithSeat, sessionTapeOf, writeRecord, relayOf } from "./fixtures.mjs";
import { rerunNode, rerunStep, RERUN } from "./rerun-node.mjs";
import { runTool, ToolRunError } from "./tool-run.mjs";
import { paneKeys } from "./lib.mjs";
import { atR1Call } from "./records.mjs";

const DEV1 = RERUN.accounts.dev1.public_key;
const K = await paneKeys(plan, V("OWNER"), DEV1);
const runs = [];
after(() => { for (const r of runs) rmSync(r, { recursive: true, force: true }); });
function run(steps = []) {
  const r = runWithSeat(DEV1);
  runs.push(r);
  writeRecord(r, { record: "run-time", accounts: { owner: { public_key: V("OWNER") }, device: { public_key: DEV1 } }, steps });
  return r;
}
const A6 = await sessionTapeOf(rerunNode("A6"), DEV1);
const changed = (change) => { const v = structuredClone(A6.value); change(v); return relayOf(v); };
const go = (r, t, id = "R1", purpose = "call") => runTool({ plan, run: r, id, purpose, tapeText: t.text, tapeSha256: t.sha });
const refused = (r, t, re, id, purpose) => assert.rejects(go(r, t, id, purpose), (e) => e instanceof ToolRunError && re.test(e.message), re.toString());
const sessionsAt = (v) => v.tape.findIndex((c) => c.method === "state_getStorage" && c.params[0] === K.sessions);

test("HOLDS: a head hash that is not the tape's own finalized head is refused; an upper case sha256 is refused", async () => {
  await refused(run(), changed((v) => { v.head.hash = "0x" + "12".repeat(32); }), /the tool printed the head/);
  await refused(run(), { text: A6.text, sha: A6.sha.toUpperCase() }, /sha256 is required/);
});

test("HOLDS: the tape's answers in another order give the same output; an answer more changes nothing", async () => {
  // each run folder's record is at R1's call (tool-run runs only there, F10), G1 in the block of A1
  const atCall = () => { const r = run(); writeRecord(r, atR1Call(DEV1, rerunStep("A1").finalized_in_block)); return r; };
  const base = (await go(atCall(), A6)).output;
  const reversed = (await go(atCall(), changed((v) => { v.tape.reverse(); }))).output;
  const more = (await go(atCall(), changed((v) => { v.tape.push({ method: "state_getStorage", params: ["0x" + "ab".repeat(32), v.head.hash], result: "0x01" }); }))).output;
  for (const o of [reversed, more]) assert.deepEqual(o.json, base.json);
});

test("HOLDS: RG19-5: a tape with two different answers to one question is refused, so the answer the tool gets does not hang on their order", async () => {
  const twice = changed((v) => { const i = sessionsAt(v); v.tape.splice(i, 0, { ...v.tape[i], result: null }); });
  await assert.rejects(go(run(), twice), ToolRunError, "the first of two answers is used and the tape is taken");
});

test("HOLDS: RG19-6: tool-run writes no output for a phase the record is not at, so an early run cannot block the step", async () => {
  // G1 is sent but not in a finalized block: its after is not next, and a tape read now is before it
  const r = run([{ step: "G1", call: { refused: null }, signed_check: { refused: null }, run_time: { sent: { status: "deadline", sent_by: "send" } } }]);
  await assert.rejects(go(r, A6, "G1", "after"), ToolRunError, "the after of G1 is run over a tape before G1's block");
  assert.ok(!existsSync(join(r, "tool")) || readdirSync(join(r, "tool")).length === 0);
});

test("HOLDS: a block tape is refused for a step the record does not hold as finalized, and a session tape for P0 is not checked against a record", async () => {
  const r = run([{ step: "G1", run_time: { sent: { status: "deadline" } } }]);
  const { blockTapeOf } = await import("./fixtures.mjs");
  const node = rerunNode("A6");
  const b = await blockTapeOf(node, DEV1, node.blockOf("A2"));
  await refused(r, b, /no finalized block for G1/, "G1", "block");
  const a10 = rerunStep("A10");
  await refused(run([{ step: "G1", run_time: { sent: { status: "finalized", block_number: a10.finalized_in_block, block_hash: a10.block_hash, extrinsic_index: 1 } } }]), A6, /stale/, "R1", "call");
});
