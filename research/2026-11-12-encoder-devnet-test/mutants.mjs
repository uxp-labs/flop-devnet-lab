#!/usr/bin/env node
// The mutants of this folder: mutants.json holds the reviewer's (R-M1 to R-M18, adapted to the
// code of the fix round, each saying so) and the fix round's own (B-*). Each entry is
// { id, file, find, replace, test, why } and, for one no test can kill, equivalent: the reason.
// For each, the research folders this folder reads are copied into a temporary repo (imd-flop
// linked, not copied), the one change is made there, and every test of the folder runs on the copy.
// A mutant is killed when a test that passes on the copy without the change fails with it. For a
// change to a file the lead pastes into the pane, the two tests that bind that file's sha256 into
// plan.md and README.md do not count as a kill: any change fails them. The worktree is never
// changed. Usage: node mutants.mjs [<temp parent>] [--jobs <n>] [--only <file>]. No network.
// Exit 0 only when every mutant is killed or listed as equivalent and an equivalent one lives.
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, REPO, loadPlan } from "./lib.mjs";

const argv = process.argv.slice(2);
const at = (f) => argv.indexOf(`--${f}`);
const jobs = at("jobs") >= 0 ? Number(argv[at("jobs") + 1]) : 4;
const only = at("only") >= 0 ? argv[at("only") + 1] : null;
const parent = argv.find((a, i) => !a.startsWith("--") && i !== at("jobs") + 1 && i !== at("only") + 1) ?? tmpdir();
const mutants = JSON.parse(readFileSync(join(HERE, "mutants.json"), "utf8")).filter((m) => !only || m.file === only);
const PASTED = ["pane-runner.js", "explorer-reader.js"];
const BINDING = [/^R1: plan\.md holds every block plan\.mjs prints/, /^P6 P8: the README says who carries the batch out/];
const plan = loadPlan();
const dirs = new Set(["research/2026-11-12-encoder-devnet-test", "research/2026-11-12-session-rerun-1014020", "research/2026-11-11-session-deny-list", ...Object.values(plan.files).map((f) => f.split("/").slice(0, 2).join("/"))]);

for (const m of mutants) {
  const text = readFileSync(join(HERE, m.file), "utf8");
  if (text.split(m.find).length !== 2) throw new Error(`${m.id}: the find text does not occur exactly once in ${m.file}`);
}

const run = (cwd) => new Promise((resolve) => {
  const tests = readdirSync(cwd).filter((f) => f.endsWith(".test.mjs"));
  const p = spawn(process.execPath, ["--test", "--test-reporter=tap", ...tests], { cwd });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  const timer = setTimeout(() => p.kill(), 300000);
  p.on("close", () => { clearTimeout(timer); resolve(new Set([...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((x) => x[1]))); });
});

async function one(m) {
  const root = mkdtempSync(join(parent, "mutant-"));
  try {
    for (const d of dirs) cpSync(join(REPO, d), join(root, d), { recursive: true, filter: (s) => !s.includes("/signed") });
    symlinkSync(join(REPO, "imd-flop"), join(root, "imd-flop"));
    const dir = join(root, "research/2026-11-12-encoder-devnet-test");
    if (m.file) {
      const p = join(dir, m.file);
      writeFileSync(p, readFileSync(p, "utf8").replace(m.find, m.replace));
    }
    return await run(dir);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const base = await one({ id: "baseline" });
console.log(JSON.stringify({ id: "baseline", failing: base.size }));
const rows = [];
let next = 0;
async function worker() {
  while (next < mutants.length) {
    const m = mutants[next++];
    const failed = [...(await one(m))].filter((n) => !base.has(n) && !(PASTED.includes(m.file) && BINDING.some((b) => b.test(n))));
    const row = { id: m.id, killed: failed.length > 0, equivalent: m.equivalent ? true : undefined, by: failed.slice(0, 2) };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
const alive = rows.filter((r) => !r.killed && !r.equivalent);
const wrongEquivalent = rows.filter((r) => r.killed && r.equivalent);
console.log(JSON.stringify({ mutants: rows.length, killed: rows.filter((r) => r.killed).length, equivalent: rows.filter((r) => r.equivalent && !r.killed).length, alive: alive.map((r) => r.id), killed_but_listed_equivalent: wrongEquivalent.map((r) => r.id), baseline_failing: base.size }));
process.exit(alive.length || wrongEquivalent.length || base.size ? 1 : 0);
