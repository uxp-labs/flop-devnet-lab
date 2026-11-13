// Review 4 (list 5), part A: the README's section "The run of 2026-11-13" read against results.json.
// L6: the section says only what the record holds. Each test below states that promise for one
// sentence. These were the reviewer's proofs against ae31282, where the record alone did not carry
// the claims; they now hold the lead's rules Z1 to Z3 against the signed files and the rerun's
// record: each claim names a committed field, and that field holds the value. Each fails if the
// README drops the field's name or if the field's value changes. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const REPO = new URL("../../", import.meta.url);
const text = (p) => readFileSync(new URL(p, REPO), "utf8");
const HERE = "research/2026-11-12-encoder-devnet-test/";
const RESULTS = JSON.parse(text(HERE + "results.json"));
const SIGNED_T3 = JSON.parse(text(HERE + "run-2026-11-13/signed/T3.json"));
const { blake2b } = await import(new URL("imd-flop/node_modules/@noble/hashes/blake2.js", REPO).href);
const section = () => {
  const t = text(HERE + "README.md");
  const from = t.indexOf("## The run of 2026-11-13");
  return t.slice(from, t.indexOf("\n## ", from + 1)).replace(/\s+/g, " ");
};

test("Z1: the README does not say the three balances are in no committed file but itself, since the 'before' number is a committed field of the session rerun's results.json", () => {
  const s = section();
  const raw = [...s.matchAll(/(\d+) raw/g)].map((m) => m[1]);
  assert.equal(raw.length, 3);
  const rerun = JSON.parse(text("research/2026-11-12-session-rerun-1014020/results.json"));
  // The committed field that holds the same number (the owner's free balance at block 3553688, after B12).
  assert.equal(rerun.owner_free_balance_raw.after, raw[0]);
  // The promise: a sentence that says "in no committed file" is true. It is not for raw[0].
  const claims = s.includes("They are in no committed file but this README.");
  assert.equal(claims && rerun.owner_free_balance_raw.after === raw[0], false, "the README says no committed file holds a number that research/2026-11-12-session-rerun-1014020/results.json owner_free_balance_raw.after holds");
  // Z1: the README names that field for the number before.
  assert.ok(s.includes("The number before is also in a committed file: it is `owner_free_balance_raw.after` of `research/2026-11-12-session-rerun-1014020/results.json`"), "the README names the committed field of the number before");
});

test("Z2: the README says T3 was accepted 'with a mortal era' only where the signed file of T3 shows the era and its extrinsic hashes to the hash the record reports for T3", () => {
  const s = section();
  const era = RESULTS.steps[2].era;
  assert.deepEqual(era, { birth_number: null, birth_hash: null, last_valid_block: null });
  const hash = `0x${Buffer.from(blake2b(Uint8Array.from(Buffer.from(SIGNED_T3.extrinsic.slice(2), "hex")), { dkLen: 32 })).toString("hex")}`;
  const signedShowsEra = SIGNED_T3.era !== "immortal" && Object.values(SIGNED_T3.era).every((v) => v !== null) && hash === RESULTS.steps[2].run_time.extrinsic_hash;
  // The promise: a claim of the section is carried by a committed file the section names.
  assert.ok(!s.includes("with a mortal era") || (signedShowsEra && s.includes("`era` of `run-2026-11-13/signed/T3.json`")), "the section claims a mortal era that no file it names holds");
  // Z2: each value of the era stands beside its field, and the hash beside the record's field.
  for (const [field, value] of [["era.period", SIGNED_T3.era.period], ["era.birth_number", SIGNED_T3.era.birth_number], ["era.birth_hash", SIGNED_T3.era.birth_hash], ["era.last_valid_block", SIGNED_T3.era.last_valid_block]]) assert.ok(new RegExp(`${value}( blocks)? \\(\`${field.replace(".", "\\.")}\`\\)`).test(s), `${value} beside ${field}`);
  assert.ok(s.includes("is its `extrinsic_hash`, the hash the node and the explorer reported for T3 in its block (`steps.2.run_time.extrinsic_hash`)"), "the README names the hash fields");
});

test("Z3: the README says T3 had 'a declared spend equal to the escrow' only where the signed file of T3 holds the declared spend, equal to the escrow it signed", () => {
  const s = section();
  const t3 = RESULTS.steps[2];
  assert.equal(t3.call, null);
  const signedShowsDeclared = typeof SIGNED_T3.declared_spend_raw === "string" && SIGNED_T3.declared_spend_raw === SIGNED_T3.fields.inner.escrow;
  assert.ok(!s.includes("with a declared spend equal to the escrow") || (signedShowsDeclared && s.includes("`declared_spend_raw` of `run-2026-11-13/signed/T3.json`")), "the section claims a declared spend that no file it names holds");
  // Z3: each value stands beside its field.
  assert.ok(s.includes(`a declared spend of ${SIGNED_T3.declared_spend_raw} (\`declared_spend_raw\` of \`run-2026-11-13/signed/T3.json\`)`), "the declared spend beside its field");
  assert.ok(s.includes(`an escrow of ${SIGNED_T3.fields.inner.escrow} (\`fields.inner.escrow\`)`), "the escrow signed beside its field");
});
