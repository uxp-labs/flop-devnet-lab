// The final record of the run of 2026-11-13, results.final.json, filled from the observatory's fifth
// recording by observatory/scripts/fill-encoder-results.mjs (observatory review round 32). The
// observatory's own tests hold the record to the fill byte for byte; they import nothing of this
// folder's judge, since the observatory depends on nothing of imd-flop. What needs the judge is here,
// where both packages are built: the verdict through the checker's own module and through its
// command, pinned exactly, and the README's section "The final record", each claim by its field. No
// network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { context, judgeRun } from "./judge.mjs";

const HERE = new URL("./", import.meta.url);
const text = (p) => readFileSync(new URL(p, HERE), "utf8");
const FINAL_TEXT = text("results.final.json");
const FINAL = JSON.parse(FINAL_TEXT);
const RUN_TIME_TEXT = text("results.json");
const sha256 = (t) => createHash("sha256").update(t).digest("hex");
/** The value at a field path of the final record, as the README names it: steps.2.after.channel.escrow. */
const at = (path) => path.split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), FINAL);
const section = () => {
  const t = text("README.md");
  const from = t.indexOf("## The final record");
  assert.ok(from >= 0, "the README has a section The final record");
  return t.slice(from, t.indexOf("\n## ", from + 1));
};
const flat = () => section().replace(/\s+/g, " ");
const SENT = FINAL.steps.filter((s) => s.finalized_in_block !== null);
const feeSum = (ids) => SENT.filter((s) => ids.includes(s.step)).reduce((n, s) => n + BigInt(s.fee_raw), 0n);
const OWNER = ["T1", "T2", "T8"];
const DEVICE = ["T3", "T4", "T5", "T6", "T9"];

test("the run time record is not changed, and the final record is its own file of kind final with balances from the decoder", () => {
  assert.equal(sha256(RUN_TIME_TEXT), "a0c853cda774e3e57a44663519eef92cfe4405d4fe3952f33e8b8561c9c7267f");
  assert.equal(JSON.parse(RUN_TIME_TEXT).record, "run-time");
  assert.deepEqual([FINAL.record, FINAL.balances_source], ["final", "decoder"]);
});

test("the checker's own module: kind final, passed as planned (balances: decoder), exit 0, eight steps pass and T7 not needed", () => {
  const out = judgeRun(context(FINAL));
  assert.equal(out.kind, "final");
  assert.equal(out.verdict, "passed as planned (balances: decoder)");
  assert.equal(out.exit, 0);
  assert.equal(out.all, true);
  assert.deepEqual(out.top, []);
  assert.deepEqual(out.left, []);
  assert.deepEqual(out.findings, []);
  assert.equal(out.stoppedAt, null);
  assert.deepEqual(out.run.map((r) => [r.id, r.status]), [["T1", "pass"], ["T2", "pass"], ["T3", "pass"], ["T4", "pass"], ["T5", "pass"], ["T6", "pass"], ["T7", "not needed"], ["T8", "pass"], ["T9", "pass"]]);
});

test("the command: node check.mjs results.final.json prints the summary and the verdict, exit 0", () => {
  const c = spawnSync(process.execPath, ["check.mjs", "results.final.json"], { cwd: HERE, encoding: "utf8" });
  const lines = c.stdout.split("\n").filter(Boolean);
  assert.equal(c.status, 0);
  assert.equal(c.stderr, "");
  assert.deepEqual(lines.slice(-2), ["8 pass, 0 differ, 0 incomplete, 1 not needed, 0 not run", "verdict: passed as planned (balances: decoder)"]);
  assert.deepEqual(lines.filter((l) => /^(PASS|NOT NEEDED|DIFFERS|INCOMPLETE|NOT RUN|STOPPED|NOT SENT|RUN|FINDING|LEFT) /.test(l)), ["PASS       T1", "PASS       T2", "PASS       T3", "PASS       T4", "PASS       T5", "PASS       T6", "NOT NEEDED T7", "PASS       T8", "PASS       T9"]);
  // The README gives both lines word for word.
  for (const l of lines.slice(-2)) assert.ok(section().includes(`\`${l}\``), l);
});

test("the README names the final record's sha256, and says the run time record is not changed", () => {
  assert.ok(flat().includes(`The sha256 of \`results.final.json\` is ${sha256(FINAL_TEXT)}.`));
  assert.ok(flat().includes("`results.json` is not changed: a record of its day is not rewritten."));
});

test("the README's table is the record, row by row: block, hash, result, fee, the owner's and the device's free balance", () => {
  const free = (a) => (a.absent === true ? "absent" : a.free);
  const rows = section().split("\n").filter((l) => /^\| (start|T\d) \|/.test(l));
  const b = FINAL.before;
  assert.deepEqual(rows, [
    `| start | ${b.block_number} | ${b.block_hash} | | | ${b.accounts.owner.free} | ${free(b.accounts.device)} |`,
    ...SENT.map((s) => `| ${s.step} | ${s.finalized_in_block} | ${s.block_hash} | ${s.result} | ${s.fee_raw} | ${s.after.accounts.owner.free} | ${free(s.after.accounts.device)} |`),
  ]);
  // Each block is called finalized only as the run time record reports it.
  for (const s of SENT) assert.deepEqual([s.run_time.sent.status, s.run_time.sent.block_hash], ["finalized", s.block_hash], s.step);
  assert.equal(FINAL.steps.find((s) => s.step === "T7").finalized_in_block, null);
});

test("the cost: the sum of the eight fee_raw, the owner's three and the device's five, each with its signer", () => {
  const s = flat();
  assert.ok(s.includes(`over the eight steps sent: ${feeSum([...OWNER, ...DEVICE])} raw.`));
  assert.ok(s.includes(`and paid their fees, ${feeSum(OWNER)} raw.`));
  assert.ok(s.includes(`and paid their fees, ${feeSum(DEVICE)} raw, from what T1 sent it`));
  for (const id of OWNER) assert.equal(FINAL.steps.find((x) => x.step === id).signer, FINAL.accounts.owner.public_key, id);
  for (const id of DEVICE) assert.equal(FINAL.steps.find((x) => x.step === id).signer, FINAL.accounts.device.public_key, id);
});

test("each value the section names beside a field is the value at that field of results.final.json", () => {
  const s = flat();
  const pairs = [...s.matchAll(/(0x[0-9a-f]+|\d+) raw \(`([a-z_0-9.]+)`/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 5, `${pairs.length} values beside a field`);
  for (const [value, field] of pairs) assert.equal(String(at(field)), value, field);
  const ack = /ack deadline (\d+) \(`(steps\.2\.after\.channel\.state\.value\.ack_deadline)`\)/.exec(s);
  assert.ok(ack);
  assert.equal(String(at(ack[2])), ack[1]);
  // The event each amount is read from is the one named beside it.
  assert.equal(`${at("steps.0.events.3.pallet")}.${at("steps.0.events.3.name")}`, "Balances.Transfer");
  assert.equal(`${at("steps.2.events.3.pallet")}.${at("steps.2.events.3.name")}`, "ComputeChannel.ForceOpenRequested");
  assert.equal(`${at("steps.5.events.1.pallet")}.${at("steps.5.events.1.name")}`, "Balances.Transfer");
  assert.equal(at("steps.5.events.1.fields.amount"), at("steps.2.events.3.fields.escrow"));
});

test("the balances the section claims hold in the record: the eight fees and nothing else, the escrow out at T3 and back at T6, the device absent and T9's sweep", () => {
  const owner = (path) => BigInt(at(path));
  assert.equal(owner("before.accounts.owner.free") - owner("steps.8.after.accounts.owner.free"), feeSum([...OWNER, ...DEVICE]));
  assert.equal(owner("steps.1.after.accounts.owner.free") - owner("steps.2.after.accounts.owner.free"), BigInt(at("steps.2.events.3.fields.escrow")));
  assert.equal(owner("steps.5.after.accounts.owner.free") - owner("steps.4.after.accounts.owner.free"), BigInt(at("steps.2.events.3.fields.escrow")));
  assert.deepEqual([at("before.accounts.device"), at("steps.8.after.accounts.device")], [{ absent: true }, { absent: true }]);
  assert.equal(owner("steps.8.after.accounts.owner.free") - owner("steps.7.after.accounts.owner.free"), BigInt(at("steps.0.events.3.fields.amount")) - feeSum(DEVICE));
  // The lead's two readings by position, in the section on the run, are the decoder's.
  const t = text("README.md");
  assert.ok(t.includes(`- before: ${at("before.accounts.owner.free")} raw;`) && t.includes(`- after: ${at("steps.8.after.accounts.owner.free")} raw;`));
});

test("the absent words at the start and after T1, and the channel's life, as the section tells them", () => {
  const s = flat();
  for (const p of ["before", "steps.0.after"]) {
    assert.deepEqual([at(`${p}.session`), at(`${p}.session_nonce`), at(`${p}.breaker_tx_count`)], [{ absent: true }, "absent", "absent"], p);
  }
  assert.ok(s.includes("`before.session` and `steps.0.after.session` are `{ \"absent\": true }`"));
  assert.ok(String(at("filled_from.words.absent")).includes("\"absent\""));
  for (const p of ["before.channel", "steps.0.after.channel", "steps.1.after.channel"]) assert.deepEqual(at(p), { absent: true }, p);
  for (const i of [2, 3, 4]) assert.equal(at(`steps.${i}.after.channel.state.type`), "PendingAck", `steps.${i}`);
  for (const i of [5, 7, 8]) assert.equal(at(`steps.${i}.after.channel.state.type`), "Closed", `steps.${i}`);
  assert.ok(s.includes("`PendingAck` (`steps.2.after.channel.state.type`)"));
  assert.ok(s.includes("after T6: `Closed` (`steps.5.after.channel.state.type`). The closed record stays stored"));
  assert.ok(s.includes("(`steps.8.after.channel.state.type` is `Closed`)"));
});

test("the section names its sources by the record's filled_from, and calls nothing verified", () => {
  const s = flat();
  for (const f of ["filled_from.recording", "filled_from.from_the_recording", "filled_from.shape", "filled_from.by", "filled_from.from_the_run", "filled_from.channel"]) {
    assert.ok(s.includes(`\`${f}\``), f);
    assert.notEqual(at(f), undefined, f);
  }
  assert.ok(s.includes(`\`${at("filled_from.recording")}\``));
  assert.ok(s.includes(`format \`${at("filled_from.shape")}\``));
  assert.doesNotMatch(s, /verified/i);
  assert.ok(!text("README.md").includes("## Not done here: the final record"));
});

test("the README's section What is not known: each answer and each count is the value at the field it names", () => {
  const t = text("README.md");
  const from = t.indexOf("## What is not known");
  assert.ok(from >= 0);
  const s = t.slice(from, t.indexOf("\n## ", from + 1)).replace(/\s+/g, " ");
  assert.equal(at("steps.3.result"), "failed: ComputeChannel.BadState (pallet 103, error 11)");
  assert.ok(s.includes(`\`${at("steps.3.result")}\` (\`steps.3.result\`)`));
  assert.equal(at("steps.2.after.channel.state.type"), "PendingAck");
  assert.ok(s.includes("(`steps.2.after.channel.state.type` is `PendingAck`)"));
  assert.equal(at("steps.4.result"), "failed: ComputeChannel.CalibrationUnavailable (pallet 103, error 97)");
  assert.ok(s.includes(`(\`steps.4.result\`): \`${at("steps.4.result")}\`.`));
  assert.ok(s.includes(`${at("steps.3.fee_raw")} raw and ${at("steps.4.fee_raw")} raw (\`steps.3.fee_raw\`, \`steps.4.fee_raw\`)`));
  assert.deepEqual([2, 3, 4].map((i) => at(`steps.${i}.after.session_nonce`)), ["1", "1", "1"]);
  assert.equal(at("steps.5.after.session_nonce"), "2");
  assert.ok(s.includes("it is 1 after T3, T4 and T5 and 2 after T6 (`steps.2.after.session_nonce` to `steps.5.after.session_nonce`)"));
  assert.deepEqual([at("steps.2.after.breaker_tx_count"), at("steps.5.after.breaker_tx_count")], ["1", "1"]);
  assert.ok(s.includes("`breaker_tx_count` 1 after T3 and 1 after T6"));
  assert.ok(s.includes("(`steps.2.after.breaker_tx_count`, `steps.5.after.breaker_tx_count`)"));
  assert.ok(!s.includes("no like step was ever sent."), "the pre run words are gone");
});
