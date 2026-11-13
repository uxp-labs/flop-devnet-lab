// Tests of the committed run time record of the run of 2026-11-13 (results.json, rule A2 of the
// list 5 brief): node --test in this folder. No network, no key. The record is held byte for byte by
// its sha256, check.mjs on it says go on with nothing left to send and exits 3, each step has the
// verdict the lead read from the run, and T7, which was not needed, has no run time reading.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { HERE, loadPlan } from "./lib.mjs";

const FILE = join(HERE, "results.json");
const SHA256 = "a0c853cda774e3e57a44663519eef92cfe4405d4fe3952f33e8b8561c9c7267f";
const record = () => JSON.parse(readFileSync(FILE, "utf8"));
const check = () => spawnSync(process.execPath, [join(HERE, "check.mjs"), FILE], { encoding: "utf8" });

/** The verdict of each step, as check.mjs says it of the run of 2026-11-13. */
const VERDICTS = {
  T1: "success, as expected",
  T2: "success, as expected",
  T3: "success, as expected",
  T4: "recorded: ComputeChannel.BadState",
  T5: "recorded: ComputeChannel.CalibrationUnavailable",
  T6: "success, as expected",
  T7: "not needed",
  T8: "success, as expected",
  T9: "success, as expected",
};

test("A2: the committed results.json is the lead's run time record of 2026-11-13, byte for byte", () => {
  assert.equal(createHash("sha256").update(readFileSync(FILE)).digest("hex"), SHA256);
  const r = record();
  assert.equal(r.record, "run-time");
  assert.equal(r.balances_source, null);
});

test("A2: check.mjs on the committed record says go on: nothing is left to send, and exits 3", () => {
  const out = check();
  assert.equal(out.status, 3, out.stderr);
  assert.equal(out.stdout.split("\n")[0], "run time record: go on: nothing is left to send");
  assert.doesNotMatch(out.stdout, /FINDING|LEFT|cleanup steps that apply/);
});

test("A2: check.mjs gives each step of the plan, in its order, the verdict of the run", () => {
  const lines = check().stdout.split("\n").slice(1).filter((l) => l.startsWith("    ")).map((l) => l.trim());
  assert.deepEqual(loadPlan().steps.map((s) => s.id), Object.keys(VERDICTS));
  assert.deepEqual(lines, Object.entries(VERDICTS).map(([id, v]) => `${id}: ${v}`));
});

test("A2: T7 has no run time reading, and every other step one in a finalized block", () => {
  const r = record();
  assert.deepEqual(r.steps.map((s) => s.step), Object.keys(VERDICTS));
  for (const s of r.steps) {
    if (s.step === "T7") { assert.equal(s.run_time, null); continue; }
    assert.equal(s.run_time?.sent?.status, "finalized", s.step);
    assert.match(s.run_time.sent.block_hash, /^0x[0-9a-f]{64}$/, s.step);
  }
});
