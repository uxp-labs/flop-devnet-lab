#!/usr/bin/env node
// Review 4 (list 5): runs the README mutants of review4-mutants.json in a copy of the repo that the
// caller made outside the worktree (node_modules linked). For each mutant, the one change is made in
// the copy, a set of tests of this folder runs there, and the copy is restored. The worktree is never
// changed. No network.
//   node review4-mutants.mjs <copy of the repo root> builder|review4
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const [copy, which] = process.argv.slice(2);
const dir = join(copy, "research/2026-11-12-encoder-devnet-test");
const tests = which === "review4" ? ["review4-readme.test.mjs", "review4-keys.test.mjs"] : ["results.test.mjs"];
const base = spawnSync(process.execPath, ["--test", ...tests], { cwd: dir, encoding: "utf8" });
const fails = (o) => [...o.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
const before = new Set(fails(base.stdout));
for (const m of JSON.parse(readFileSync(new URL("./review4-mutants.json", import.meta.url), "utf8"))) {
  const p = join(dir, m.file), orig = readFileSync(p, "utf8");
  if (orig.split(m.find).length !== 2) { console.log(`BADFIND ${m.id}`); continue; }
  writeFileSync(p, orig.replace(m.find, m.replace));
  try {
    const r = spawnSync(process.execPath, ["--test", ...tests], { cwd: dir, encoding: "utf8" });
    const killers = fails(r.stdout).filter((f) => !before.has(f));
    console.log(`${killers.length ? "KILLED" : "ALIVE "} ${m.id}${killers.length ? ` by ${killers[0]}` : ""}`);
  } finally { writeFileSync(p, orig); }
}
