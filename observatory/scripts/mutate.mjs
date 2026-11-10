#!/usr/bin/env node
// Mutation check: proves the tests catch the failures they claim to catch.
//
// Each mutants/<module>.json is an array of
//   { "id", "file", "find", "replace", "test", "why" }
// For every mutant: copy the package to a temp dir (node_modules linked, not copied),
// apply the one exact replacement (find must occur exactly once), run the named test
// file, and expect it to FAIL. That is the "failing before the fix" half. Then every
// named test file runs on the unmutated tree and must PASS: the "passing after" half.
//
// Usage: node scripts/mutate.mjs [mutants/escrow.json ...]   (default: all mutants/*.json)
// Prints a JSON array of results. Exit 1 if any mutant survives, is invalid, or a baseline fails.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["node_modules", "check-runs", "dist", "out"]);
const args = process.argv.slice(2);
const files = args.length
  ? args
  : readdirSync(join(pkg, "mutants"))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join("mutants", f));

function runTest(dir, test) {
  const r = spawnSync("npx", ["vitest", "run", test], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, OBS_ATTEMPTS_FILE: "" },
  });
  return { code: r.status, tail: ((r.stdout ?? "") + (r.stderr ?? "")).split("\n").slice(-12).join("\n") };
}

const results = [];
let bad = 0;

for (const f of files) {
  const mutants = JSON.parse(readFileSync(resolve(pkg, f), "utf8"));
  for (const m of mutants) {
    const target = join(pkg, m.file);
    if (!existsSync(target)) {
      results.push({ id: m.id, file: m.file, test: m.test, why: m.why, outcome: "invalid", detail: "file not found" });
      bad++;
      continue;
    }
    const src = readFileSync(target, "utf8");
    const count = src.split(m.find).length - 1;
    if (count !== 1) {
      results.push({ id: m.id, file: m.file, test: m.test, why: m.why, outcome: "invalid", detail: `find matches ${count} times` });
      bad++;
      continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), "obs-mutant-"));
    cpSync(pkg, tmp, {
      recursive: true,
      filter: (p) => !relative(pkg, p).split("/").some((part) => skip.has(part)),
    });
    symlinkSync(join(pkg, "node_modules"), join(tmp, "node_modules"));
    writeFileSync(join(tmp, m.file), src.replace(m.find, m.replace));
    const run = runTest(tmp, m.test);
    rmSync(tmp, { recursive: true, force: true });
    const outcome = run.code !== 0 ? "killed" : "survived";
    if (outcome !== "killed") bad++;
    results.push({ id: m.id, file: m.file, test: m.test, why: m.why, outcome, exit: run.code, tail: outcome === "survived" ? run.tail : undefined });
  }
}

for (const test of [...new Set(results.map((r) => r.test))].sort()) {
  const run = runTest(pkg, test);
  const outcome = run.code === 0 ? "baseline-pass" : "baseline-fail";
  if (outcome !== "baseline-pass") bad++;
  results.push({ id: `baseline:${test}`, test, outcome, exit: run.code, tail: outcome === "baseline-fail" ? run.tail : undefined });
}

console.log(JSON.stringify(results, null, 2));
process.exit(bad ? 1 : 0);
