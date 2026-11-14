#!/usr/bin/env node
// check: judges a run time record of the batch (judge.mjs, H15). It prints each claim pass, differ,
// incomplete, not run or not needed, the counts, and one verdict line. It never says verified.
// Usage: node check.mjs <results.json>
// Exit codes: 0 every claim passes (or is not needed); 1 a claim differs; 4 a claim is incomplete or
// not run; 2 this script's own refusals (no file, a file that is not JSON). No network, no key.
import { loadPlan, readJson } from "./lib.mjs";
import { judge } from "./judge.mjs";

const file = process.argv[2];
if (!file) { process.stderr.write("usage: node check.mjs <results.json>\n"); process.exit(2); }
let results;
try { results = readJson(file); } catch (e) { process.stderr.write(`check: ${file} is not a JSON file this script can read (${e?.constructor?.name ?? typeof e})\n`); process.exit(2); }
if (results?.record !== "run-time" || !Array.isArray(results.steps)) { process.stderr.write("check: the file is not a run time record of this batch\n"); process.exit(2); }
const out = judge(loadPlan(), results);
for (const c of out.claims) console.log(`${c.status.toUpperCase().padEnd(10)} ${c.id}: ${c.what}${c.why ? ` (${c.why})` : ""}`);
for (const f of out.next.findings) console.log(`FINDING ${f}`);
console.log(`${out.counts.pass} pass, ${out.counts.differ} differ, ${out.counts.incomplete} incomplete, ${out.counts["not run"]} not run, ${out.counts["not needed"]} not needed`);
console.log(`verdict: ${out.verdict} (a run time record: one node, read through the pane, decoded by the lab's own decoder)`);
process.exit(out.exit);
