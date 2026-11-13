// Review 4 (list 5), part A: the README's section "The run of 2026-11-13" read against results.json.
// L6: the section says only what the record holds. Each test below states that promise for one
// sentence and fails at ae31282. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const REPO = new URL("../../", import.meta.url);
const text = (p) => readFileSync(new URL(p, REPO), "utf8");
const HERE = "research/2026-11-12-encoder-devnet-test/";
const RESULTS = JSON.parse(text(HERE + "results.json"));
const section = () => {
  const t = text(HERE + "README.md");
  const from = t.indexOf("## The run of 2026-11-13");
  return t.slice(from, t.indexOf("\n## ", from + 1)).replace(/\s+/g, " ");
};

test("R1: the README says the three balances are in no committed file but itself, yet the 'before' number is a committed field of the session rerun's results.json", () => {
  const s = section();
  const raw = [...s.matchAll(/(\d+) raw/g)].map((m) => m[1]);
  assert.equal(raw.length, 3);
  const rerun = JSON.parse(text("research/2026-11-12-session-rerun-1014020/results.json"));
  // The committed field that holds the same number (the owner's free balance at block 3553688, after B12).
  assert.equal(rerun.owner_free_balance_raw.after, raw[0]);
  // The promise: a sentence that says "in no committed file" is true. It is not for raw[0].
  const claims = s.includes("They are in no committed file but this README.");
  assert.equal(claims && rerun.owner_free_balance_raw.after === raw[0], false, "the README says no committed file holds a number that research/2026-11-12-session-rerun-1014020/results.json owner_free_balance_raw.after holds");
});

test("R2: the README says T3 was accepted 'with a mortal era', but the record's era of T3 is all null and nothing in it shows the era", () => {
  const s = section();
  const era = RESULTS.steps[2].era;
  assert.deepEqual(era, { birth_number: null, birth_hash: null, last_valid_block: null });
  const recordShowsEra = Object.values(era).some((v) => v !== null);
  // The promise: a claim of the section is carried by the record.
  assert.ok(!s.includes("with a mortal era") || recordShowsEra, "the section claims a mortal era that results.json does not hold (steps.2.era is all null)");
});

test("R3: the README says T3 had 'a declared spend equal to the escrow', but the record holds the spend and the escrow, not the declared spend", () => {
  const s = section();
  const t3 = RESULTS.steps[2];
  const flat = JSON.stringify(t3);
  assert.equal(t3.call, null);
  const recordShowsDeclared = /declared/.test(flat);
  assert.ok(!s.includes("with a declared spend equal to the escrow") || recordShowsDeclared, "the section claims a declared spend that results.json does not hold (steps.2.call is null; only events.2.fields.spent is there)");
});
