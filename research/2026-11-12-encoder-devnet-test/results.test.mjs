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
import { HERE, blake2b256Hex, loadPlan, readJson } from "./lib.mjs";

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

/** The value at a dotted field of the record, list positions as digits. */
const at = (r, field) => field.split(".").reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), r);
const section = () => {
  const text = readFileSync(join(HERE, "README.md"), "utf8");
  const from = text.indexOf("## The run of 2026-11-13");
  return text.slice(from, text.indexOf("\n## ", from + 1));
};

test("A3: each value the README's section on the run names beside a field is the value at that field of results.json", () => {
  const r = record();
  const s = section();
  const named = [
    ["3654835", "steps.0.run_time.sent.block_number"],
    ["3655782", "steps.8.run_time.sent.block_number"],
    ["1014020", "spec_version"],
    ["ComputeChannel.BadState", "steps.3.run_time.explorer.error.name"],
    ["ComputeChannel.CalibrationUnavailable", "steps.4.run_time.explorer.error.name"],
    ["10000000000000000", "steps.2.run_time.explorer.events.1.fields.escrow"],
    ["10000000000000000", "steps.2.run_time.explorer.events.2.fields.spent"],
    ["0xd8ae28f57ec645b73a4ea6deaa2d0b1f9228b93b08eb77779481898d371b8480", "steps.2.run_time.explorer.events.1.fields.channel_id"],
    ["3654783", "start.finalized.number"],
  ];
  for (const [value, field] of named) {
    const flat = s.replace(/\s+/g, " ");
    assert.ok(flat.includes(`${value} (\`${field}\``) || flat.includes(`\`${value}\` (\`${field}\``), `${value} beside ${field}`);
    assert.equal(String(at(r, field)), value, field);
  }
  assert.equal(at(r, "steps.2.run_time.explorer.events.1.name"), "ForceOpenRequested");
  assert.equal(at(r, "steps.2.run_time.explorer.events.1.fields.channel_id"), loadPlan().values.CH_T3.value);
  assert.deepEqual(at(r, "steps.2.run_time.explorer.channel_mismatch"), []);
  const sent = r.steps.filter((x) => x.run_time?.sent?.status === "finalized");
  assert.equal(sent.length, 8);
  assert.match(s, /Eight transactions of nine planned/);
  assert.deepEqual(r.steps.filter((x) => x.run_time?.explorer?.success === true).map((x) => x.step), ["T1", "T2", "T3", "T6", "T8", "T9"]);
  assert.match(s, /T1, T2, T3, T6, T8 and T9 succeeded/);
});

test("Z1: the balance before is the committed owner_free_balance_raw.after of the session rerun's results.json; the README says so, and that only the after and the difference are in no other committed file", () => {
  const s = section().replace(/\s+/g, " ");
  const raw = [...s.matchAll(/(\d+) raw/g)].map((m) => BigInt(m[1]));
  assert.equal(raw.length, 3);
  const [before, after, down] = raw;
  assert.equal(before - after, down);
  assert.ok(s.includes(`(0.${down.toString().padStart(18, "0").replace(/0+$/, "")} FLOP)`));
  const rerun = readJson(join(HERE, "..", "2026-11-12-session-rerun-1014020", "results.json"));
  assert.equal(BigInt(rerun.owner_free_balance_raw.after), before);
  const block = /finalized block (\d+) \(after B12\)/.exec(rerun.owner_free_balance_raw.read)?.[1];
  assert.ok(block, "the rerun's owner_free_balance_raw.read names the block of its after");
  for (const line of [
    "These three numbers are the lead's reading by position.",
    `The number before is also in a committed file: it is \`owner_free_balance_raw.after\` of \`research/2026-11-12-session-rerun-1014020/results.json\`, the owner's free balance at block ${block} after that rerun (its \`owner_free_balance_raw.read\`), also read by position.`,
    "The number after and the difference are in no other committed file.",
  ]) assert.ok(s.includes(line), line);
  assert.ok(!s.includes("in no committed file but this README"));
});

/** The signed file of a step in the run folder. */
const signedOf = (id) => readJson(join(HERE, "run-2026-11-13", "signed", `${id}.json`));
const flat = () => section().replace(/\s+/g, " ");
const words = (n) => ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][n];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const listed = (ids) => (ids.length === 1 ? ids[0] : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);

/** Each line of outcome of the section, built from results.json, steps.json and the signed files. */
function outcomeLines() {
  const r = record();
  const plan = loadPlan();
  const steps = r.steps;
  const sent = steps.filter((x) => x.run_time !== null);
  const i = (id) => steps.findIndex((x) => x.step === id);
  const lines = [
    `- ${cap(words(sent.length))} transactions of ${words(plan.steps.length)} planned were sent.`,
    `- The blocks run from ${sent[0].run_time.sent.block_number} (\`steps.${i(sent[0].step)}.run_time.sent.block_number\`, ${sent[0].step}) to ${sent.at(-1).run_time.sent.block_number} (\`steps.${i(sent.at(-1).step)}.run_time.sent.block_number\`, ${sent.at(-1).step}).`,
    `- The runtime was spec ${r.spec_version} (\`spec_version\`).`,
    `- ${listed(sent.filter((x) => x.run_time.explorer.success === true).map((x) => x.step))} succeeded (\`steps.N.run_time.explorer.success\` is \`true\`).`,
    ...sent.filter((x) => x.run_time.explorer.success === false).map((x) => `- ${x.step} was refused by the chain with \`${x.run_time.explorer.error.name}\` (\`steps.${i(x.step)}.run_time.explorer.error.name\`).`),
    ...steps.filter((x) => x.run_time === null).map((x) => {
      const cond = plan.steps.find((p) => p.id === x.step).only_if;
      return `- ${x.step} was not needed: ${cond.step} opened no channel. It has no run time reading (\`steps.${i(x.step)}.run_time\` is null).`;
    }),
  ];
  for (const x of sent) assert.equal(x.run_time.sent.status, "finalized", x.step);
  return lines;
}

test("Z4: each line of outcome of the section is the one results.json and steps.json give, word for word", () => {
  const s = flat();
  const lines = outcomeLines();
  assert.equal(lines.length, 7);
  for (const line of lines) assert.ok(s.includes(line), line);
});

test("Z4: the three hedges stand word for word, and the section says neither verified nor final record shows", () => {
  const s = flat();
  assert.equal(record().record, "run-time");
  for (const line of [
    "These three numbers are the lead's reading by position.",
    "It is not yet decoded with the lab's decoder.",
    "The record is a run time record (`record` is `run-time`).",
  ]) assert.ok(s.includes(line), line);
  assert.doesNotMatch(s, /verified/i);
  assert.doesNotMatch(s, /final record shows/i);
});

test("Z2, Z5: the mortal era and the encoder of T3 are read from its signed file, whose extrinsic hashes to the hash its block reported", () => {
  const s = flat();
  const r = record();
  const t3 = r.steps[2];
  assert.equal(t3.step, "T3");
  const f = signedOf("T3");
  assert.equal(blake2b256Hex(Uint8Array.from(Buffer.from(f.extrinsic.slice(2), "hex"))), f.extrinsic_hash);
  assert.equal(f.extrinsic_hash, t3.run_time.extrinsic_hash);
  assert.equal(f.extrinsic_hash, t3.run_time.explorer.hash);
  assert.notEqual(f.era, "immortal");
  for (const line of [
    `through the lab's encoder (\`tool\` of \`run-2026-11-13/signed/T3.json\` is "${f.tool}"):`,
    `- with a mortal era: \`era\` of \`run-2026-11-13/signed/T3.json\` gives a period of ${f.era.period} blocks (\`era.period\`), born at block ${f.era.birth_number} (\`era.birth_number\`), binding the hash ${f.era.birth_hash} (\`era.birth_hash\`), valid until block ${f.era.last_valid_block} (\`era.last_valid_block\`).`,
    "The era is read from the bytes the tool signed: the blake2b-256 of that file's `extrinsic` is its `extrinsic_hash`, the hash the node and the explorer reported for T3 in its block (`steps.2.run_time.extrinsic_hash`).",
    "The block's own bytes are read in the final record, from the observatory's recording of the block;",
  ]) assert.ok(s.includes(line), line);
});

test("Z3: the declared spend and the escrow the tool signed for T3 equal the escrow taken and the amount spent the record gives, and the README names all four fields", () => {
  const s = flat();
  const f = signedOf("T3");
  const ev = record().steps[2].run_time.explorer.events;
  const open = ev.findIndex((e) => e.pallet === "ComputeChannel" && e.name === "ForceOpenRequested");
  const spent = ev.findIndex((e) => e.pallet === "FlopSessionKeys" && e.name === "SessionCallExecuted");
  const four = [f.declared_spend_raw, f.fields.inner.escrow, ev[open].fields.escrow, ev[spent].fields.spent];
  assert.equal(new Set(four).size, 1, four.join(" "));
  const [v] = four;
  const line = `- with a declared spend equal to the escrow: the tool signed a declared spend of ${v} (\`declared_spend_raw\` of \`run-2026-11-13/signed/T3.json\`) and an escrow of ${v} (\`fields.inner.escrow\`); the escrow of \`ComputeChannel.ForceOpenRequested\`, ${v} (\`steps.2.run_time.explorer.events.${open}.fields.escrow\`), is what the session spent, ${v} (\`steps.2.run_time.explorer.events.${spent}.fields.spent\`);`;
  assert.ok(s.includes(line), line);
});
