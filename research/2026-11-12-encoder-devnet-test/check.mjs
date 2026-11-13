#!/usr/bin/env node
// check: judges a record of the encoder's devnet test against steps.json (judge.mjs).
// Usage: node check.mjs <results.json>
//   a run time record (record "run-time"): the order, the outcomes and the explorer's events. It
//     says only go on, wait or stop at <id>, never passed, and exits 3.
//   a final record (record "final"): the whole check, balances step by step. Its verdict is one of
//     passed as planned; stopped at <id>, cleanup complete, nothing left; stopped at <id>, left: ...;
//     failed: <why>; with balances_source beside it. Exit 0 only for passed as planned, else 1.
// Error names come from the rerun's errors-1014020.json, event fields from its facts-1014020.json.
// No network, no key.
import { readJson } from "./lib.mjs";
import { context, judgeRun } from "./judge.mjs";

const file = process.argv[2];
if (!file) { process.stderr.write("usage: node check.mjs <results.json>\n"); process.exit(2); }
const out = judgeRun(context(readJson(file)));
if (out.kind === "run-time") {
  console.log(`run time record: ${out.word}`);
  for (const r of out.run) for (const i of r.info) console.log(`    ${i}`);
  if (out.next.cleanup.length) console.log(`cleanup steps that apply: ${out.next.cleanup.join(", ")}`);
  for (const f of out.findings) console.log(`FINDING ${f}`);
  for (const l of out.left) console.log(`LEFT  ${l}`);
  process.exit(3);
}
for (const t of out.top) console.log(`RUN   ${t}`);
for (const r of out.run) {
  console.log(`${r.status.toUpperCase().padEnd(10)} ${r.id}`);
  for (const p of r.problems) console.log(`    ${p}`);
  for (const i of r.info) console.log(`    (${i})`);
}
for (const f of out.findings) console.log(`FINDING ${f}`);
for (const l of out.left) console.log(`LEFT  ${l}`);
const n = (s) => out.run.filter((r) => r.status === s).length;
console.log(`${n("pass")} pass, ${n("differs")} differ, ${n("incomplete")} incomplete, ${n("not needed")} not needed, ${out.run.length - n("pass") - n("differs") - n("incomplete") - n("not needed")} not run`);
console.log(`verdict: ${out.verdict}`);
process.exit(out.all ? 0 : 1);
