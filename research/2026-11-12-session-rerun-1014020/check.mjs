#!/usr/bin/env node
// check: says for each transaction of the rerun whether the chain answered as steps.json expects.
// Usage: node check.mjs <results.json>   (results.template.json filled in by the lead)
// Error names come from errors-1014020.json, event fields from facts-1014020.json, expected amounts
// from the earlier results.json files through steps.json. No network, no key.
// Exit 0 only when every step passes.
import { readJson, context, judgeRun } from "./rerun-lib.mjs";

const file = process.argv[2];
if (!file) { process.stderr.write("usage: node check.mjs <results.json>\n"); process.exit(2); }
const out = judgeRun(context(readJson(file)));
for (const t of out.top) console.log(`RUN   ${t}`);
for (const r of out.run) {
  console.log(`${r.status.toUpperCase().padEnd(10)} ${r.id}`);
  for (const p of r.problems) console.log(`    ${p}`);
  for (const i of r.info) console.log(`    (${i})`);
}
const n = (s) => out.run.filter((r) => r.status === s).length;
console.log(`${n("pass")} pass, ${n("differs")} differ, ${n("incomplete")} incomplete, ${n("not run")} not run${out.stoppedAt ? `; the run should have stopped at ${out.stoppedAt}` : ""}`);
process.exit(out.all ? 0 : 1);
