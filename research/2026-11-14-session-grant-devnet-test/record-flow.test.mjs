// The rehearsal's walk of the run time record (walk.mjs), step by step, with each state held (H13,
// H14): record-step.mjs's own functions and tool-run.mjs over the rerun's tapes, with the seat of
// dev1. The rerun's dev1 grant (A2) was made for 7200 blocks with a lifetime cap of 0.05 FLOP, so
// the tools must find G1 not the plan's and say R1, then stop. What the walk makes is said in the
// head of walk.mjs. No network, no real key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan, V, runWithSeat, writeRecord } from "./fixtures.mjs";
import { rerunNode, rerunStep } from "./rerun-node.mjs";
import { readerOver, plain } from "./pane.mjs";
import { runTool } from "./tool-run.mjs";
import { sourcesDiffer, startRecord } from "./record-step.mjs";
import { nextOf } from "./next.mjs";
import { nextText } from "./plan.mjs";
import { newWalk, DEV1 } from "./walk.mjs";

test("the walk: P0 at A1, then G1 at A2 is found not the plan's, so R1 at A10, then stop", async () => {
  const w = await newWalk("g19-flow");
  try {
    await w.p0();
    assert.equal(w.results.p0.session.state, "none");
    assert.deepEqual(w.results.p0.session_count, { raw: null, value: 0, stored: false, reason: "no value stored: the metadata default 0 (research/2026-11-11-onchain-spend-limit/report.md, FlopSessionKeys.SessionCount)" });
    assert.equal(w.results.accounts.device.public_key, DEV1, "the device comes from the seat's identity.json did");
    assert.equal(w.results.probe.answered, false);
    assert.equal(nextOf(plan, w.results).phase, "call");
    const c = await w.call("G1", w.node("A1", ["sessions", "nonces", "breakers"]));
    assert.ok(c.callText);
    assert.equal(w.results.steps[0].call.equal, true);
    assert.equal(nextOf(plan, w.results).phase, "sign");
    assert.ok(w.sign("G1").sendText);
    assert.equal(nextOf(plan, w.results).phase, "send");
    w.sent("G1", "A2");
    assert.equal(nextOf(plan, w.results).phase, "block");
    await w.block("G1", rerunNode("A6"), "A2");
    assert.equal(w.results.steps[0].decoder.fee_raw, rerunStep("A2").fee_raw);
    assert.equal(w.results.steps[0].decoder.source, "the tool's readBlockEvents over the block tape: the lab's own decoder");
    await w.after("G1", rerunNode("A6"));
    const n1 = nextOf(plan, w.results);
    assert.equal(n1.step, "R1");
    assert.deepEqual(n1.cleanup, ["R1"]);
    assert.ok(n1.findings.some((f) => /SessionCreated spending_cap is 50000000000000000, the plan's is 25000000000000000/.test(f)));
    assert.ok(n1.findings.some((f) => /expires_at is 3559929, not its block 3552729 plus 86400/.test(f)));
    const text = await nextText(plan, w.run, w.results);
    assert.match(text, /tool-run\.mjs" R1 call --run/);
    assert.match(text, /explorer\.read\("0x[0-9a-f]{64}"\)/, "the explorer's reading of G1 is asked beside");
    w.explorer("G1", "A2");
    assert.deepEqual(w.results.steps[0].sources_differ, []);
    assert.equal(w.results.steps[0].run_time.explorer.source_kind, "second, weaker: FLOP's explorer API");
    const other = structuredClone(w.results.steps[0]);
    other.run_time.explorer.events[0].fields.spending_cap = "1";
    assert.match(sourcesDiffer(other).join("; "), /SessionCreated spending_cap: the decoder says 50000000000000000, the explorer 1/);
    await w.call("R1", rerunNode("A8"));
    w.sign("R1"); w.sent("R1", "A10");
    await w.block("R1", rerunNode("A10"), "A10");
    assert.ok(w.results.steps[1].decoder.names.includes("FlopSessionKeys.SessionRevoked"));
    await w.after("R1", w.node("A10", ["nonces", "breakers"]));
    const n2 = nextOf(plan, w.results);
    assert.equal(n2.word, "stop");
    assert.match(n2.why, /G1 was not the plan's .*R1 has ended its session/);
    assert.match(await nextText(plan, w.run, w.results), /# STOP at G1/);
    assert.ok(existsSync(join(w.run, "tapes", "R1.after.json")));
  } finally { w.done(); }
});

test("a start whose runtime the reads do not give stops at P0, and nothing is signed", async () => {
  const w = await newWalk("g19-flow-p0");
  try {
    const t = await w.tape(w.node("A1", ["sessions", "nonces", "breakers", "session_count"]));
    await runTool({ plan, run: w.run, id: "P0", purpose: "show", tapeText: t.text, tapeSha256: t.sha });
    const probe = plain(await readerOver(rerunNode("A1")).reader.probe(5));
    const r = await startRecord({ plan, run: w.run, reads: { account: V("OWNER"), runtime: {}, finalized: { number: 1, hash: "0x" + "00".repeat(32) }, account_nonce: 3 }, readsSha256: "00".repeat(32), probe, probeSha256: probe.relay_sha256 });
    assert.equal(nextOf(plan, r).word, "stop");
    assert.match(nextOf(plan, r).why, /the runtime at the start is null null/);
    assert.match(await nextText(plan, w.run, r), /# STOP at P0/);
  } finally { w.done(); }
});

test("start refuses a seat home whose caps are not the plan's", async () => {
  const run = runWithSeat(DEV1, "g19-flow-caps");
  try {
    writeRecord(run, { record: "run-time", steps: [] });
    writeFileSync(join(run, "seat", "config.json"), JSON.stringify({ network: "devnet", seat: V("SEAT"), payer: "holder", caps: { [V("SEAT")]: { daily: 0.05, perCall: 0.02 } } }));
    await assert.rejects(startRecord({ plan, run, reads: { account: V("OWNER"), finalized: { number: 1, hash: "0x" + "00".repeat(32) }, account_nonce: 3 }, readsSha256: "00", probe: { kind: "probe" }, probeSha256: "00" }), /the seat's caps are .*not the plan's daily 0.025/);
  } finally { rmSync(run, { recursive: true, force: true }); }
});
