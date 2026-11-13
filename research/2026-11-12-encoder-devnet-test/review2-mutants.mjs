#!/usr/bin/env node
// Review 2: runs the mutants of review2-mutants.json. For each, the research folders this folder
// reads are copied into a temporary repo (imd-flop linked, not copied), the one change is made
// there, and a set of tests runs on the copy: --tests builder (every *.test.mjs that is not review*)
// or --tests review2 (review2-*.test.mjs). A mutant is killed when a test that passes on the copy
// without the change fails with it. For a pasted file the builder's two sha256 binding tests do not
// count. The worktree is never changed. No network.
//   node review2-mutants.mjs --tests builder|review2 [--jobs <n>]
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, REPO, loadPlan } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (f, d) => (argv.indexOf(`--${f}`) >= 0 ? argv[argv.indexOf(`--${f}`) + 1] : d);
const which = opt("tests", "builder"), jobs = Number(opt("jobs", 4));
const pick = which === "review2" ? (f) => f.startsWith("review2-") : (f) => !f.startsWith("review");
const mutants = JSON.parse(readFileSync(join(HERE, "review2-mutants.json"), "utf8"));
for (const m of mutants) if (readFileSync(join(HERE, m.file), "utf8").split(m.find).length !== 2) throw new Error(`${m.id}: the find text does not occur exactly once in ${m.file}`);
const PASTED = ["pane-runner.js", "explorer-reader.js"];
const BINDING = [/^R1: plan\.md holds every block plan\.mjs prints/, /^P6 P8: the README says who carries the batch out/];
const plan = loadPlan();
const dirs = new Set(["research/2026-11-12-encoder-devnet-test", "research/2026-11-12-session-rerun-1014020", "research/2026-11-11-session-deny-list", ...Object.values(plan.files).map((f) => f.split("/").slice(0, 2).join("/"))]);

const run = (cwd) => new Promise((resolve) => {
  const p = spawn(process.execPath, ["--test", "--test-reporter=tap", ...readdirSync(cwd).filter((f) => f.endsWith(".test.mjs") && pick(f))], { cwd });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  const timer = setTimeout(() => p.kill(), 300000);
  p.on("close", () => { clearTimeout(timer); resolve(new Set([...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((x) => x[1]))); });
});
async function one(m) {
  const root = mkdtempSync(join(tmpdir(), "review2-mutant-"));
  try {
    for (const d of dirs) cpSync(join(REPO, d), join(root, d), { recursive: true, filter: (s) => !s.includes("/signed") });
    symlinkSync(join(REPO, "imd-flop"), join(root, "imd-flop"));
    const dir = join(root, "research/2026-11-12-encoder-devnet-test");
    if (m.file) { const p = join(dir, m.file); writeFileSync(p, readFileSync(p, "utf8").replace(m.find, m.replace)); }
    return await run(dir);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const base = await one({ id: "baseline" });
console.log(JSON.stringify({ tests: which, baseline_failing: base.size }));
const rows = [];
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < mutants.length) {
    const m = mutants[next++];
    const failed = [...(await one(m))].filter((n) => !base.has(n) && !(PASTED.includes(m.file) && BINDING.some((b) => b.test(n))));
    const row = { id: m.id, killed: failed.length > 0, by: failed.slice(0, 1) };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}));
console.log(JSON.stringify({ tests: which, mutants: rows.length, killed: rows.filter((r) => r.killed).length, alive: rows.filter((r) => !r.killed).map((r) => r.id).sort() }));
