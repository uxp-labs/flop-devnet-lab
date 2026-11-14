// F13: plan.mjs next prints NEXT, END or STOP as its first word, and exits 0 for a next action or
// the end and 3 for a stop. Over made records (records.mjs) in temporary run folders. No network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./lib.mjs";
import { tempDir, writeRecord } from "./fixtures.mjs";
import { asPlanned, started, step } from "./records.mjs";

const DIR = tempDir("g19-word");
after(() => rmSync(DIR, { recursive: true, force: true }));
let k = 0;
const next = (r) => {
  const run = join(DIR, `run${k++}`);
  mkdirSync(run, { recursive: true });
  if (r) writeRecord(run, r);
  return spawnSync(process.execPath, [join(HERE, "plan.mjs"), "next", "--run", run], { encoding: "utf8" });
};

test("F13: an empty run folder: NEXT P0, exit 0", () => {
  const p = next(null);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^NEXT P0 start\n# P0/);
});

test("F13: a next action is NEXT with exit 0; a stop is STOP with exit 3; the end is END with exit 0", () => {
  const go = next(started());
  assert.equal(go.status, 0, go.stderr);
  assert.match(go.stdout, /^NEXT G1 call\n/);
  const stop = next(started({ count: { value: 9 } }));
  assert.equal(stop.status, 3, stop.stderr);
  assert.match(stop.stdout, /^STOP at P0\n# STOP at P0/);
  const g1 = next(step(started(), "G1", { ok: false, error: "FlopSessionKeys.TooManySessions" }));
  assert.equal(g1.status, 3);
  assert.match(g1.stdout, /^STOP at G1\n/);
  const end = next(asPlanned("taken"));
  assert.equal(end.status, 0, end.stderr);
  assert.match(end.stdout, /^END\n/);
});
