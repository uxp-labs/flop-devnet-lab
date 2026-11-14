// F10 (RG19-5, RG19-6): tool-run.mjs refuses, and writes nothing, a tape with two different answers
// to one question, a question with no answer, or a read the time ended; a fresh tape is then taken
// for the same step. It runs only at the id and the purpose the record is at, and an after read only
// over a tape whose head is at or above the step's block. Tapes of session-reads.js over the rerun's
// recording, relayed with their sha256 made right. No network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { plan, V, runWithSeat, sessionTapeOf, writeRecord, relayOf } from "./fixtures.mjs";
import { rerunNode, rerunStep, RERUN } from "./rerun-node.mjs";
import { runTool, ToolRunError } from "./tool-run.mjs";
import { atR1Call, forDevice, started, step } from "./records.mjs";
import { paneKeys } from "./lib.mjs";

const DEV1 = RERUN.accounts.dev1.public_key;
const K = await paneKeys(plan, V("OWNER"), DEV1);
const A1_BLOCK = rerunStep("A1").finalized_in_block;
const runs = [];
after(() => { for (const r of runs) rmSync(r, { recursive: true, force: true }); });
const folder = (rec) => { const r = runWithSeat(DEV1); runs.push(r); if (rec) writeRecord(r, rec); return r; };
const A6 = await sessionTapeOf(rerunNode("A6"), DEV1);
const changed = (change) => { const v = structuredClone(A6.value); change(v); return relayOf(v); };
const go = (r, t, id = "R1", purpose = "call") => runTool({ plan, run: r, id, purpose, tapeText: t.text, tapeSha256: t.sha });
const empty = (r) => { for (const d of ["tool", "tapes"]) assert.ok(!existsSync(join(r, d)) || readdirSync(join(r, d)).length === 0, d); };
const refused = async (r, t, re, id, purpose) => { await assert.rejects(go(r, t, id, purpose), (e) => e instanceof ToolRunError && re.test(e.message), re.toString()); empty(r); };
const at = (v, key) => v.tape.findIndex((c) => c.method === "state_getStorage" && c.params[0] === key);

test("F10: two different answers to one question are refused; the same answer twice is not", async () => {
  const r = folder(atR1Call(DEV1, A1_BLOCK));
  await refused(r, changed((v) => { const i = at(v, K.sessions); v.tape.push({ ...v.tape[i], result: null }); }), /two different answers to state_getStorage .*read a fresh tape/);
  await refused(r, changed((v) => { const i = at(v, K.sessions); v.tape.push({ method: v.tape[i].method, params: v.tape[i].params, error: { code: -32000, message: "x" } }); }), /two different answers/);
  const o = await go(r, changed((v) => { const i = at(v, K.sessions); v.tape.push(structuredClone(v.tape[i])); }));
  assert.equal(o.output.exit, 0);
});

test("F10: a question with no answer, a metadata with no answer, or a read the time ended is refused with words that say to read a fresh tape; then a fresh tape is taken for the same step", async () => {
  const r = folder(atR1Call(DEV1, A1_BLOCK));
  await refused(r, changed((v) => { const i = at(v, K.nonces); v.tape[i] = { method: v.tape[i].method, params: v.tape[i].params, no_answer: "no answer in 12 s" }; }), /no answer to state_getStorage .*no answer in 12 s.*not counted as used: read a fresh tape for the same step/);
  await refused(r, changed((v) => { v.metadata = { at: v.metadata.at, sha256: null, length: null, no_answer: "no answer in 12 s" }; }), /no answer to state_getMetadata/);
  await refused(r, changed((v) => { v.deadline = "not finished in 40 s"; }), /not finished in 40 s.*read a fresh tape/);
  const o = await go(r, A6);
  assert.equal(o.output.exit, 0);
  assert.deepEqual(readdirSync(join(r, "tool")), ["R1.call.json"]);
});

test("F10: tool-run runs only at the id and the purpose the record is at", async () => {
  // G1 signed and not sent: neither G1's after nor R1's call is next
  const signedOnly = step(forDevice(started(), DEV1), "G1", { upTo: "sign" });
  await refused(folder(signedOnly), A6, /R1 call is not what the record is at: go G1 send/);
  await refused(folder(signedOnly), A6, /G1 after is not what the record is at/, "G1", "after");
  // P0's show only before the start
  await refused(folder(forDevice(started(), DEV1)), A6, /P0's show is read before the start/, "P0", "show");
  // a stopped record: nothing
  await refused(folder(forDevice(started({ count: { value: 9 } }), DEV1)), A6, /R1 call is not what the record is at: stop/);
});

test("F10: an after read at its phase is refused over a tape whose head is below the step's block, and taken at or above it", async () => {
  const head = A6.value.head.number;
  for (const [block, ok] of [[head + 1, false], [head, true]]) {
    const rec = step(forDevice(started(), DEV1), "G1", { upTo: "block", block });
    const r = folder(rec);
    if (ok) assert.equal((await go(r, A6, "G1", "after")).output.exit, 0);
    else await refused(r, A6, new RegExp(`the tape's head ${head} is below block ${head + 1}, the last finalized step of the record: a stale tape`), "G1", "after");
  }
});
