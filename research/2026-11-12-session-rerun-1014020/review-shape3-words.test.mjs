// Review of decoder-shape@3 (round 29), attack 11: sentences of this folder's README that the change
// made false, beyond the lead's finding L1 (lines 5 to 6, 72 to 73 and the section "The A10 read the
// decoder does not state"). Since round 29 the reviewed shape states FailedAcks and DelegateSessions
// (observatory/src/scale/shape.ts STATED_TABLE) and A10's read is decoded through the door
// (results.json A10 reads_after.delegate_sessions_of_device).
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const README = readFileSync(new URL("./README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
const SHAPE = readFileSync(new URL("../../observatory/src/scale/shape.ts", import.meta.url), "utf8");
const RESULTS = JSON.parse(readFileSync(new URL("./results.json", import.meta.url), "utf8"));
const a10 = RESULTS.steps.find((s) => s.step === "A10");

test("the facts the words are held to", () => {
  assert.ok(SHAPE.includes('["DelegateSessions", "delegate_sessions"]'));
  assert.ok(SHAPE.includes('["FailedAcks", "failed_acks"]'));
  assert.equal(a10.reads_after.delegate_sessions_of_device, "empty");
});

test("review defect W1, fixed: probe:28 still says DelegateSessions empty rests not on the decoder", () => {
  assert.ok(!README.includes("rests on the by position reading above, not on the decoder"));
});

test("review defect W2, fixed: Not done still says FailedAcks and DelegateSessions are not stated in the reviewed shape", () => {
  assert.ok(!README.includes("`ComputeChannel.FailedAcks` and `FlopSessionKeys.DelegateSessions` are not stated in the reviewed shape"));
});
