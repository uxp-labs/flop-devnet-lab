// Review of G-19, attacks 4 and 10 (G4, G7, G11), by the second reviewer: a committed record edited
// by hand so that its sha256 fields no longer match what they name; G2 refused with a fee above the
// most; the judge's word on a record with no balances; and the lines plan.mjs next prints at each
// state of the rehearsal's walk. No network, no key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plan, V, tempDir } from "./fixtures.mjs";
import { sha256Text } from "./lib.mjs";
import { committedFolder, replay } from "./replay.mjs";
import { nextOf } from "./next.mjs";
import { judge } from "./judge.mjs";
import { nextText } from "./plan.mjs";
import { asPlanned, started, step } from "./records.mjs";
import { newWalk } from "./walk.mjs";
import { rerunNode } from "./rerun-node.mjs";
import { writeRecord } from "./fixtures.mjs";
import { callFile } from "./run.mjs";

const copies = [];
after(() => { for (const c of copies) rmSync(c, { recursive: true, force: true }); });
const copyWith = (change) => {
  const d = join(tempDir("g19-review-record"), "run");
  copies.push(join(d, ".."));
  cpSync(committedFolder("rehearsal-run"), d, { recursive: true });
  const f = join(d, "results.json");
  const r = JSON.parse(readFileSync(f, "utf8"));
  change(r);
  writeFileSync(f, JSON.stringify(r, null, 1) + "\n");
  return d;
};

test("DEFECT RG19-14: replay finds a committed record whose runner reading is not the relay its sent_sha256 names, or whose block is not its block tape's", async () => {
  const r0 = JSON.parse(readFileSync(join(committedFolder("rehearsal-run"), "results.json"), "utf8"));
  for (const e of r0.steps) assert.equal(sha256Text(JSON.stringify(e.run_time.sent)), e.run_time.sent_sha256, `${e.step}: the record's own sent_sha256 names its reading today`);
  const edits = [
    ["G1's extrinsic index", (r) => { r.steps[0].run_time.sent.extrinsic_index = 7; }],
    ["R1's block hash", (r) => { r.steps[1].run_time.sent.block_hash = "0x" + "77".repeat(32); }],
  ];
  for (const [what, edit] of edits) {
    const p = await replay(plan, copyWith(edit));
    assert.ok(p.problems.length > 0, `${what} edited by hand: replay finds nothing`);
  }
});

test("HOLDS: RG19-15: G2 refused with a fee above the most per step is a stop, as H10 and the printed stop rule say, not the end", () => {
  const r = step(step(step(started(), "G1"), "R1"), "G2", { ok: false, error: `FlopSessionKeys.${V("ALREADY_EXISTS")}`, fee: (BigInt(V("MAX_FEE")) + 1n).toString() });
  const x = nextOf(plan, r);
  assert.ok(x.findings.some((f) => /above the most/.test(f)), "the fee is a finding");
  assert.equal(x.word, "stop", `the word is ${x.word}: ${x.why}`);
});

test("HOLDS (G11): a record as planned but with no balances is judged not run, exit 4, as the README says; so no record the tools write today can pass", () => {
  for (const branch of ["taken", "refused"]) {
    const r = asPlanned(branch);
    delete r.balances;
    const j = judge(plan, r);
    assert.equal(j.claims.find((c) => c.id === "batch").status, "not run");
    assert.equal(j.exit, 4, j.verdict);
    assert.equal(nextOf(plan, r).word, "end");
  }
});

test("HOLDS (G11): at each state of the rehearsal's walk, plan.mjs next names only $LAB and $KEY_OWNER, an absolute run folder, and at the sign the call file it reads exists", async () => {
  const w = await newWalk("g19-review-lines");
  try {
    const seen = [];
    const look = async (state) => {
      if (w.results) writeRecord(w.run, w.results);
      const text = await nextText(plan, w.run, w.results);
      const vars = new Set([...text.matchAll(/\$([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]));
      for (const v of vars) assert.ok(["LAB", "KEY_OWNER"].includes(v), `${state}: $${v} is printed and never set`);
      for (const m of text.matchAll(/--run "([^"]*)"/g)) assert.equal(m[1], w.run, `${state}: the run folder`);
      if (/flop-sign\.mjs" sign/.test(text)) { assert.ok(existsSync(callFile(w.run, "G1")), `${state}: calls/G1.json`); assert.match(text, /--key "\$KEY_OWNER"/); }
      seen.push(state);
    };
    await look("seat made, no record");
    await w.p0(); await look("start");
    await w.call("G1", w.node("A1", ["sessions", "nonces", "breakers"])); await look("G1 call");
    w.sign("G1"); await look("G1 sign");
    w.sent("G1", "A2"); await look("G1 sent");
    await w.block("G1", rerunNode("A6"), "A2"); await look("G1 block");
    await w.after("G1", rerunNode("A6")); await look("G1 after");
    assert.equal(seen.length, 7);
  } finally { w.done(); }
});
