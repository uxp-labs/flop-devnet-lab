#!/usr/bin/env node
// Reviewer's mutant runner: for each entry of review-mutants.json, copies the research folders this
// folder reads into a temporary repo (imd-flop linked, not copied), applies the one change there,
// and runs the builder's tests and the reviewer's tests on the copy. The worktree is never changed.
// Usage: node review-mutants.mjs [<temp parent>]. No network.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE, REPO, loadPlan } from "./lib.mjs";

const mutants = JSON.parse(readFileSync(join(HERE, "review-mutants.json"), "utf8"));
const plan = loadPlan();
const dirs = new Set(["research/2026-11-12-encoder-devnet-test", "research/2026-11-12-session-rerun-1014020", "research/2026-11-11-session-deny-list", ...Object.values(plan.files).map((f) => f.split("/").slice(0, 2).join("/"))]);
const run = (cwd, files) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd, encoding: "utf8", timeout: 120000 });
/** The names of the failing tests, so a reviewer test that already fails on the reviewed commit does not count as a kill. */
const failing = (r) => new Set([...r.stdout.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((x) => x[1]));
const newFails = (r, base) => [...failing(r)].filter((n) => !base.has(n));
const out = [];
let base = null;
for (const m of [{ id: "baseline" }, ...mutants]) {
  const root = mkdtempSync(join(process.argv[2] ?? tmpdir(), "review-mutant-"));
  for (const d of dirs) cpSync(join(REPO, d), join(root, d), { recursive: true, filter: (s) => !s.includes("/signed") });
  symlinkSync(join(REPO, "imd-flop"), join(root, "imd-flop"));
  const dir = join(root, "research/2026-11-12-encoder-devnet-test");
  if (m.file) {
    const p = join(dir, m.file), text = readFileSync(p, "utf8");
    if (text.split(m.find).length !== 2) throw new Error(`${m.id}: find text does not occur exactly once`);
    writeFileSync(p, text.replace(m.find, m.replace));
  }
  const tests = readdirSync(dir).filter((f) => f.endsWith(".test.mjs"));
  const builder = run(dir, tests.filter((f) => !f.startsWith("review-")));
  const review = run(dir, tests.filter((f) => f.startsWith("review-")));
  if (!base) { base = { builder: failing(builder), review: failing(review) }; console.log(JSON.stringify({ id: "baseline", builder_failing: base.builder.size, review_failing: base.review.size })); rmSync(root, { recursive: true, force: true }); continue; }
  const row = { id: m.id, killed_by_builder: newFails(builder, base.builder).length > 0, killed_by_review: newFails(review, base.review).length > 0, by: [...newFails(builder, base.builder), ...newFails(review, base.review)].slice(0, 2) };
  out.push(row);
  console.log(JSON.stringify(row));
  rmSync(root, { recursive: true, force: true });
}
