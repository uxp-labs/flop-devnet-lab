// Review of piece F (observatory round 32): the README's words against results.final.json, and
// which fields of the final record the folder's checker judges. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { context, judgeRun } from "./judge.mjs";

const HERE = new URL("./", import.meta.url);
const text = (p) => readFileSync(new URL(p, HERE), "utf8");
const FINAL_TEXT = text("results.final.json");
const FINAL = JSON.parse(FINAL_TEXT);
const README = text("README.md");
const sectionOf = (h) => {
  const from = README.indexOf(`## ${h}`);
  assert.ok(from >= 0, h);
  return README.slice(from, README.indexOf("\n## ", from + 1)).replace(/\s+/g, " ");
};
const stepOf = (id) => FINAL.steps.find((s) => s.step === id);

test("review defect W-1, fixed: the README's section What is not known still says the fees of T4 and T5 are not known, while results.final.json holds both", () => {
  assert.notEqual(stepOf("T4").fee_raw, null);
  assert.notEqual(stepOf("T5").fee_raw, null);
  assert.ok(!sectionOf("What is not known").includes("The fees of T4 and T5: no like step was ever sent."), "a fee the final record holds is told as not known");
});

test("review defect W-2, fixed: the README's section What is not known still asks what the chain answers to T4 and T5 and whether top_up_escrow is taken on a channel waiting for an ack, while results.final.json holds both answers", () => {
  assert.match(stepOf("T4").result, /^failed: ComputeChannel\.BadState/);
  assert.match(stepOf("T5").result, /^failed: ComputeChannel\.CalibrationUnavailable/);
  assert.equal(stepOf("T4").after.channel.state.type, "PendingAck");
  assert.ok(!sectionOf("What is not known").includes("What the chain answers to T4 and T5"), "an answer the final record holds is told as not known");
});

// What the checker judges and what it does not. Each change below leaves the verdict "passed as
// planned": only the README's sha256 of results.final.json (final-record.test.mjs) and the
// observatory's byte for byte fill (encoder-results.test.ts) hold these fields.
const set = (o, path, v) => {
  const ks = path.split(".");
  const last = ks.pop();
  ks.reduce((x, k) => x[k], o)[last] = v;
};
const verdictWith = (path, v) => {
  const c = structuredClone(FINAL);
  set(c, path, v);
  return judgeRun(context(c)).verdict;
};
for (const [path, v] of [
  ["steps.3.result", "success"],
  ["steps.4.events.3.fields.dispatch_error.value.error", "0x0b000000"],
  ["steps.2.block_hash", `0x${"00".repeat(32)}`],
  ["steps.2.extrinsic_index", 5],
  ["steps.4.events_value_sha256", "00".repeat(32)],
  ["steps.5.after.channel.state.type", "PendingAck"],
  ["steps.5.events.1.fields.amount", "1"],
  ["before.session_nonce", "0"],
  ["steps.8.after.accounts.device", { free: "0", reserved: "0", nonce: "5" }],
]) {
  test(`check.mjs does not judge ${path}: the verdict stays passed as planned, and the sha256 the README names catches the change`, () => {
    assert.equal(verdictWith(path, v), "passed as planned (balances: decoder)");
    const c = structuredClone(FINAL);
    set(c, path, v);
    const changed = `${JSON.stringify(c, null, 1)}\n`;
    assert.notEqual(createHash("sha256").update(changed).digest("hex"), createHash("sha256").update(FINAL_TEXT).digest("hex"));
    assert.ok(README.includes(createHash("sha256").update(FINAL_TEXT).digest("hex")));
  });
}

test("check.mjs changes its verdict for a balance digit, a moved amount, a fee and a dropped after", () => {
  for (const [path, v] of [
    ["steps.4.after.accounts.device.free", "125061785135000001"],
    ["steps.0.events.3.fields.amount", "150000000000000001"],
    ["steps.3.fee_raw", "5219861070000001"],
    ["steps.5.after", null],
  ]) assert.notEqual(verdictWith(path, v), "passed as planned (balances: decoder)", path);
});
