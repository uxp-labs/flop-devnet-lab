#!/usr/bin/env node
// check: says for each transaction of the encoder's devnet test whether the chain answered as
// steps.json expects, and whether the balances moved by exactly what the steps move and the fees.
// Usage: node check.mjs <results.json>   (results.template.json filled in by the lead)
// Error names come from the rerun's errors-1014020.json, event fields from its facts-1014020.json.
// No network, no key. Exit 0 only when every needed step passes and nothing is left on chain.
import { readJson } from "./lib.mjs";
import { context, judgeRun } from "./judge.mjs";

const file = process.argv[2];
if (!file) { process.stderr.write("usage: node check.mjs <results.json>\n"); process.exit(2); }
const out = judgeRun(context(readJson(file)));
for (const t of out.top) console.log(`RUN   ${t}`);
for (const r of out.run) {
  console.log(`${r.status.toUpperCase().padEnd(10)} ${r.id}`);
  for (const p of r.problems) console.log(`    ${p}`);
  for (const i of r.info) console.log(`    (${i})`);
}
for (const l of out.left) console.log(`LEFT  ${l}`);
const n = (s) => out.run.filter((r) => r.status === s).length;
console.log(`${n("pass")} pass, ${n("differs")} differ, ${n("incomplete")} incomplete, ${n("not needed")} not needed, ${out.run.length - n("pass") - n("differs") - n("incomplete") - n("not needed")} not run${out.stoppedAt ? `; the batch stopped at ${out.stoppedAt}` : ""}`);
process.exit(out.all ? 0 : 1);
