#!/usr/bin/env node
// Mutation check: proves the tests catch the failures they claim to catch.
//
// Each mutants/<module>.json is an array of
//   { "id", "file", "find", "replace", "test", "why" }
// with "file" and "test" relative to the observatory package. "test" is a vitest file, or an
// end to end check script (scripts/*.mjs that prints a JSON array of {check, outcome}), which the
// runner runs on a fresh build of the copy: the command line and the MCP binary are mutated
// that way, since no unit test drives them.
//
// 1. Copy the repo layout the tests read into one temp directory: every file git tracks, in the
//    observatory package and its sibling folders (interfaces/, imd-flop/ and the rest), and
//    nothing untracked (scripts/tracked.mjs). node_modules is linked, not copied. If the copy
//    cannot be made, the report says "setup-failed" and nothing else runs.
// 2. Control: run every named test file in that copy, unmutated. Every file must pass. If the
//    control fails, no kill counts, because a failure could come from the copy, not the mutant.
// 3. Each mutant: apply the one exact replacement ("find" must occur exactly once), run the named
//    test file with the JSON reporter, then restore the file. "killed" means at least one test
//    failed, or the read-only harness failed the file for a leftover attempt. A file that fails
//    only to load (a syntax error, a missing file) is "load-error", never a kill.
// 4. Control again, to prove every file was restored.
//
// Usage: node scripts/mutate.mjs [mutants/escrow.json ...]   (default: all mutants/*.json)
// Prints one JSON object. Exit 1 if a control fails, any mutant is not killed, or there are none.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTracked } from "./tracked.mjs";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = dirname(pkg);
const pkgName = basename(pkg);
const HARNESS_ERROR = /unexpected network, write, sign or spend attempts/;
const TIMEOUT_MS = 180_000;

const args = process.argv.slice(2);
const files = args.length
  ? args
  : readdirSync(join(pkg, "mutants"))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join("mutants", f));

// By its real path: vitest reports test files by real path, so a temp folder reached through a
// link (stock macOS) would otherwise turn every file name into a path that matches nothing.
const work = realpathSync(mkdtempSync(join(tmpdir(), "obs-mutate-")));
const copy = join(work, "repo");
const copyPkg = join(copy, pkgName);
const clean = (s) => String(s ?? "").split(copy).join("<copy>").split(work).join("<work>");

/** Runs vitest on the given test files in the copy. Returns a summary built from the JSON report. */
function runVitest(tests, label) {
  const out = join(work, `${label}.json`);
  rmSync(out, { force: true });
  const r = spawnSync("npx", ["--no-install", "vitest", "run", ...tests, "--reporter=json", `--outputFile=${out}`], {
    cwd: copyPkg,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, OBS_ATTEMPTS_FILE: "" },
  });
  const tail = clean(((r.stdout ?? "") + (r.stderr ?? "")).split("\n").slice(-8).join("\n"));
  if (r.error && r.error.code === "ETIMEDOUT") return { exit: null, timeout: true, files: [], tail };
  let report = null;
  try {
    report = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    report = null;
  }
  if (!report) return { exit: r.status, files: [], noReport: true, tail };
  const perFile = (report.testResults ?? []).map((f) => {
    const asserts = f.assertionResults ?? [];
    const failed = asserts.filter((a) => a.status === "failed");
    return {
      file: relative(copyPkg, f.name),
      status: f.status,
      tests: asserts.length,
      failed: failed.map((a) => a.fullName ?? a.title),
      firstFailure: clean((failed[0]?.failureMessages?.[0] ?? "").split("\n")[0]).slice(0, 240),
      message: clean(f.message ?? "").split("\n")[0].slice(0, 240),
    };
  });
  return { exit: r.status, files: perFile, tail };
}

const isScript = (t) => t.startsWith("scripts/") && t.endsWith(".mjs");

/** Builds the copy and runs one end to end check script. Same summary shape as runVitest. */
function runScript(test) {
  const build = spawnSync("npx", ["--no-install", "tsc", "-p", "tsconfig.json"], { cwd: copyPkg, encoding: "utf8", timeout: TIMEOUT_MS });
  if (build.status !== 0) {
    const tail = clean(((build.stdout ?? "") + (build.stderr ?? "")).split("\n").slice(-8).join("\n"));
    return { exit: build.status, files: [{ file: test, status: "failed", tests: 0, failed: [], firstFailure: "", message: `build failed: ${tail}` }], tail };
  }
  const r = spawnSync("node", [test], { cwd: copyPkg, encoding: "utf8", timeout: TIMEOUT_MS });
  const tail = clean(((r.stdout ?? "") + (r.stderr ?? "")).split("\n").slice(-8).join("\n"));
  if (r.error && r.error.code === "ETIMEDOUT") return { exit: null, timeout: true, files: [], tail };
  let checks = null;
  try {
    checks = JSON.parse(r.stdout);
  } catch {
    checks = null;
  }
  if (!Array.isArray(checks) || checks.length === 0) return { exit: r.status, files: [], noReport: true, tail };
  const failed = checks.filter((c) => c.outcome !== "pass");
  return {
    exit: r.status,
    files: [
      {
        file: test,
        status: failed.length === 0 && r.status === 0 ? "passed" : "failed",
        tests: checks.length,
        failed: failed.map((c) => c.check),
        firstFailure: clean(String(failed[0]?.stderr ?? "")).slice(0, 240),
        message: "",
      },
    ],
    tail,
  };
}

/** Runs vitest on the vitest files and each script on its own, and merges the per-file results. */
function runTests(tests, label) {
  const unit = tests.filter((t) => !isScript(t));
  const runs = [...(unit.length ? [runVitest(unit, label)] : []), ...tests.filter(isScript).map((t) => runScript(t))];
  return {
    exit: runs.every((x) => x.exit === 0) ? 0 : (runs.find((x) => x.exit !== 0)?.exit ?? null),
    timeout: runs.some((x) => x.timeout),
    noReport: runs.some((x) => x.noReport),
    files: runs.flatMap((x) => x.files),
    tail: runs.map((x) => x.tail).join("\n"),
  };
}

function setup() {
  const copied = copyTracked(repo, copy);
  symlinkSync(join(pkg, "node_modules"), join(copyPkg, "node_modules"));
  return copied;
}

function control(tests, label) {
  const run = runTests(tests, label);
  const missing = tests.filter((t) => !run.files.some((f) => f.file === t));
  const failing = run.files.filter((f) => f.status !== "passed" || f.failed.length > 0 || f.tests === 0);
  // A control that ran no test file shows nothing passing, so it fails.
  const pass = tests.length > 0 && !run.timeout && !run.noReport && run.exit === 0 && missing.length === 0 && failing.length === 0;
  return {
    outcome: pass ? "control-pass" : "control-fail",
    exit: run.exit,
    files: run.files.map((f) => ({ file: f.file, status: f.status, tests: f.tests, failed: f.failed.length })),
    missing,
    detail: pass ? undefined : failing.map((f) => `${f.file}: ${f.firstFailure || f.message}`).concat(run.timeout ? ["timeout"] : [], run.noReport ? [run.tail] : []),
  };
}

const mutants = [];
const problems = [];
const ids = new Set();
for (const f of files) {
  const list = JSON.parse(readFileSync(resolve(pkg, f), "utf8"));
  for (const m of list) {
    // "replace" may be empty (a deletion); everything else must be a non-empty string.
    const bad = ["id", "file", "find", "replace", "test", "why"].filter((k) => typeof m[k] !== "string" || (m[k] === "" && k !== "replace"));
    if (bad.length) problems.push({ id: m.id ?? null, source: f, outcome: "invalid", detail: `missing ${bad.join(", ")}` });
    else if (ids.has(m.id)) problems.push({ id: m.id, source: f, outcome: "invalid", detail: "duplicate id" });
    else mutants.push({ ...m, source: f });
    if (typeof m.id === "string") ids.add(m.id);
  }
}

const results = [...problems];
let bad = problems.length;
// A run that tests nothing proves nothing (Fable review L9): no mutants at all fails.
if (mutants.length === 0) {
  results.push({ id: null, source: files.join(", ") || null, outcome: "no-mutants", detail: "the mutant files hold no mutant" });
  bad++;
}
let before = null;
let after = null;
let copied = null;
let setupFailure = null;
try {
  try {
    copied = setup();
  } catch (e) {
    setupFailure = e instanceof Error ? e.message : String(e);
  }
  if (setupFailure !== null) {
    bad++;
    throw new Error("setup failed");
  }
  // A mutant naming a test file that does not exist is reported invalid below; the control
  // runs every named test file that does exist.
  const tests = [...new Set(mutants.map((m) => m.test))].filter((t) => existsSync(join(copyPkg, t))).sort();
  before = control(tests, "control-before");
  if (before.outcome !== "control-pass") bad++;
  for (const m of mutants) {
    const base = { id: m.id, source: m.source, file: m.file, test: m.test, why: m.why };
    const target = join(copyPkg, m.file);
    if (!existsSync(target)) {
      results.push({ ...base, outcome: "invalid", detail: "file not found" });
      bad++;
      continue;
    }
    if (!existsSync(join(copyPkg, m.test))) {
      results.push({ ...base, outcome: "invalid", detail: "test file not found" });
      bad++;
      continue;
    }
    const original = readFileSync(target, "utf8");
    const count = original.split(m.find).length - 1;
    if (count !== 1) {
      results.push({ ...base, outcome: "invalid", detail: `find matches ${count} times` });
      bad++;
      continue;
    }
    let run;
    try {
      // A function replacer, so "$&" and its kin in a mutant are written as they are, never substituted.
      writeFileSync(target, original.replace(m.find, () => m.replace));
      run = runTests([m.test], "mutant");
    } finally {
      writeFileSync(target, original);
    }
    const file = run.files.find((x) => x.file === m.test);
    let outcome;
    let detail;
    if (run.timeout) {
      outcome = "timeout";
      detail = `no result within ${TIMEOUT_MS / 1000}s`;
    } else if (!file) {
      outcome = "error";
      detail = run.tail;
    } else if (file.failed.length > 0) {
      outcome = "killed";
    } else if (file.status === "failed" && HARNESS_ERROR.test(file.message)) {
      outcome = "killed";
      detail = "the read-only harness failed the file for a leftover attempt";
    } else if (file.status === "failed") {
      outcome = "load-error";
      detail = file.message;
    } else {
      outcome = "survived";
    }
    if (outcome !== "killed") bad++;
    results.push({
      ...base,
      outcome,
      exit: run.exit,
      caught_by: outcome === "killed" ? file.failed.slice(0, 3) : undefined,
      first_failure: outcome === "killed" ? file.firstFailure || undefined : undefined,
      detail,
    });
  }
  after = control(tests, "control-after");
  if (after.outcome !== "control-pass") bad++;
} catch (e) {
  if (setupFailure === null) throw e;
} finally {
  rmSync(work, { recursive: true, force: true });
}

const count = (o) => results.filter((r) => r.outcome === o).length;
const summary = {
  mutants: results.filter((r) => r.outcome !== "no-mutants").length,
  killed: count("killed"),
  survived: count("survived"),
  load_error: count("load-error"),
  invalid: count("invalid"),
  other: results.length - count("killed") - count("survived") - count("load-error") - count("invalid"),
  setup: setupFailure === null ? "setup-pass" : "setup-failed",
  control_before: before?.outcome ?? "not-run",
  control_after: after?.outcome ?? "not-run",
};
const copyReport = setupFailure === null ? { outcome: "setup-pass", ...copied } : { outcome: "setup-failed", detail: clean(setupFailure) };
console.log(JSON.stringify({ copy: copyReport, control_before: before, control_after: after, summary, results }, null, 2));
// exitCode, not exit(): a caller may read this report through a pipe, where a write is
// asynchronous and exit() could cut it short (round 9 review L7).
process.exitCode = bad ? 1 : 0;
