// Review of G-19, attack 8 (G9): tests for the rules whose mutants no builder test killed (the
// review's mutants M2, M18, M19, M27 and M38, run against the builder's twelve test files in a copy
// under /tmp). Each test here fails with its mutant in place. No network, no key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { plan, V, runWithSeat, sessionTapeOf, writeRecord } from "./fixtures.mjs";
import { rerunNode, rerunStep, RERUN } from "./rerun-node.mjs";
import { runTool, ToolRunError } from "./tool-run.mjs";
import { nextOf } from "./next.mjs";
import { sessionCountOf, startRecord, RecordStepError } from "./record-step.mjs";
import { atR1Call, started, step } from "./records.mjs";
import { sha256Text } from "./lib.mjs";

const DEV1 = RERUN.accounts.dev1.public_key;
const runs = [];
after(() => { for (const r of runs) rmSync(r, { recursive: true, force: true }); });

test("HOLDS (M2): a tape whose head is one block below the last finalized step is refused, and one at that block is taken", async () => {
  const A6 = await sessionTapeOf(rerunNode("A6"), DEV1);
  const head = A6.value.head.number;
  for (const [block, ok] of [[head + 1, false], [head, true]]) {
    const r = runWithSeat(DEV1);
    runs.push(r);
    // a record at R1's call, G1 in the block of the case (tool-run runs only at the record's phase, F10)
    writeRecord(r, atR1Call(DEV1, block));
    const p = runTool({ plan, run: r, id: "R1", purpose: "call", tapeText: A6.text, tapeSha256: A6.sha });
    if (ok) await p; else await assert.rejects(p, (e) => e instanceof ToolRunError && /stale/.test(e.message));
  }
});

test("HOLDS (M18): a runtime after G1 that is not the plan's is a finding: R1, then stop", () => {
  const r = step(started(), "G1");
  r.steps[0].after.runtime = { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")) + 1 };
  const x = nextOf(plan, r);
  assert.equal(x.step, "R1");
  assert.ok(x.findings.some((f) => /runtime after G1/.test(f)));
});

test("HOLDS (M19): R2 that succeeded but whose show after says active is a stop at R2", () => {
  const r = step(step(step(step(started(), "G1"), "R1"), "G2"), "R2", { after: "active" });
  const x = nextOf(plan, r);
  assert.equal(x.word, "stop");
  assert.equal(x.stopped_at, "R2");
});

test("HOLDS (M27): SessionCount(S) that is not 4 bytes is unknown, never a number", () => {
  for (const raw of ["0x0900", "0x0900000000", "0x09"]) assert.equal(sessionCountOf({ result: raw }).value, null, raw);
  assert.equal(sessionCountOf({ result: "0x09000000" }).value, 9);
});

test("HOLDS (M38): start refuses the reads of an account that is not the plan's owner", async () => {
  const r = runWithSeat(DEV1);
  runs.push(r);
  const a1 = rerunStep("A1");
  const reads = { account: RERUN.accounts.dev1.ss58, runtime: { specName: V("SPEC_NAME"), specVersion: Number(V("SPEC")), transactionVersion: Number(V("TXV")), genesisHash: V("GENESIS") }, finalized: { number: a1.finalized_in_block, hash: a1.block_hash }, account_nonce: 0 };
  await assert.rejects(startRecord({ plan, run: r, reads, readsSha256: sha256Text(JSON.stringify(reads)), probe: { kind: "probe" }, probeSha256: "00".repeat(32) }), (e) => e instanceof RecordStepError && /not the owner/.test(e.message));
});
