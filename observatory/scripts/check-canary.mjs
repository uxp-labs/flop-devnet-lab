#!/usr/bin/env node
// Check canary: proves scripts/check-lib.sh, the step runner, signal handling and finalize of
// scripts/check.sh, reports a run that did not finish as not finished. A cut run must never read
// as a pass with a digest.
//
// It never runs the real check.sh and never touches a real evidence folder. It writes a small
// driver into a temporary folder that sets the few variables check.sh sets, sources the library
// and runs two or three steps of its own, with an evidence folder of its own. Cases:
//   cut-SIGTERM, cut-SIGINT, cut-SIGHUP  a step signals the driver (its process id is passed to
//       the step, so nothing waits on a timing guess) while a child of the step sleeps: the run
//       must say NOT FINISHED, report finished: no (stopped during step cut by SIG...), exit 128
//       plus the signal's number, list the step as cut in steps.tsv and no step after it, give no
//       digest, and leave neither the step nor its child running, within seconds
//   cut-between-steps  after a step, the driver starts a job of its own in a group of its own and
//       signals itself with SIGTERM before its next step: finished: no (stopped after step first
//       by SIGTERM), exit 143, only the first step in steps.tsv, no digest, the job not running
//   early-exit, early-exit-no-step  an exit 0 before the last step: not finished, exit 1, no digest
//   empty-outputs   a finished run with no output file: finished: yes, digest none
//   failing-step    a finished run with a failing step: exit 1, finished: yes
//   passing         a finished run, every step passing: exit 0, finished: yes, and the digest this
//       script computes itself from the output files
// Then tampered copies of the library, each one named find and replace that must occur exactly
// once, at least one for each of the rules C1 to C4 (REVIEW-LOG round 27). Each must make at least
// one case fail. A tampered copy that passes every case fails the canary and is named.
//
// Each case has a hard limit of 20 seconds; past it the driver is stopped by its process id and
// the case fails. Processes the case's step recorded are stopped by their id once the case is
// over, and counted as left if they were still running. The temporary folder is removed on every
// path.
//
// Usage: node scripts/check-canary.mjs [--lib <file>]
// With --lib, the cases run against that library only, with no tampered copies (to show them
// failing on another library, such as the logic before round 27).
// One JSON document on stdout. Exit 0 only when every case passes and every tampered copy is caught.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARY = join(pkg, "scripts", "check-lib.sh");
const LIMIT_MS = 20_000;
const PROMPT_MS = 10_000;
const SIGNALS = { HUP: 1, INT: 2, TERM: 15 };
const SHA = "canary";
const RUN = "run";

const args = process.argv.slice(2);
const libAt = args.indexOf("--lib");
const otherLib = libAt >= 0 ? resolve(args[libAt + 1] ?? "") : null;
if (libAt >= 0 && (!args[libAt + 1] || !existsSync(otherLib))) {
  console.error("usage: check-canary.mjs [--lib <file>]");
  process.exit(2);
}

const work = realpathSync(mkdtempSync(join(tmpdir(), "obs-check-canary-")));
const cleanup = () => rmSync(work, { recursive: true, force: true });
for (const [name, num] of Object.entries(SIGNALS)) {
  process.on(`SIG${name}`, () => {
    cleanup();
    process.exit(128 + num);
  });
}

// ---- The driver and the step that cuts it.
const DRIVER = join(work, "driver.sh");
const CUT_STEP = join(work, "cut-step.sh");
writeFileSync(
  DRIVER,
  `set -u
box="$1"
lib="$2"
kase="$3"
evidence="$box/evidence"
mkdir -p "$evidence/outputs"
source_sha=${SHA}
git_branch=canary
dirty=no
runner=canary
run_id=${RUN}
started_utc=2026-01-01T00:00:00Z
CANARY_DRIVER_PID=$$
CANARY_BOX="$box"
export CANARY_DRIVER_PID CANARY_BOX
. "$lib"
put_output() { mkdir -p "$evidence/outputs/$1" && printf '%s\\n' "$2" >"$evidence/outputs/$1/$2.txt"; }
case "$kase" in
  cut-SIG*)
    put_output a one
    step first true
    step cut bash "${CUT_STEP}" "\${kase#cut-SIG}"
    step last true
    ;;
  cut-between-steps)
    put_output a one
    step first true
    set -m
    sleep 300 >/dev/null 2>&1 </dev/null &
    printf '%s\n' "$!" >"$box/pids"
    set +m
    kill -TERM $$
    step last true
    ;;
  early-exit)
    put_output a one
    step first true
    exit 0
    ;;
  early-exit-no-step)
    exit 0
    ;;
  empty-outputs)
    step first true
    step last true
    ;;
  failing-step)
    put_output a one
    step first true
    step bad false
    step last true
    ;;
  passing)
    put_output a one
    put_output b two
    step first true
    step last true
    ;;
esac
finish
`,
);
// The step: a child that would sleep for minutes, both ids written down, then the driver signalled.
writeFileSync(
  CUT_STEP,
  `sleep 300 &
printf '%s %s\\n' "$$" "$!" >"$CANARY_BOX/pids"
kill -"$1" "$CANARY_DRIVER_PID"
wait
`,
);

// ---- Reading a run.
function running(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // A zombie has ended; it only waits to be reaped.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

/** The outputs digest, computed here: sha256 over `sha256sum` lines of every file, sorted bytewise. */
function ownDigest(dir) {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(`./${relative(dir, p)}`);
    }
  };
  walk(dir);
  if (files.length === 0) return "none";
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const lines = files.map((f) => `${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}  ${f}\n`).join("");
  return createHash("sha256").update(lines).digest("hex");
}

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const lines = (t) => (t === null ? null : t.replace(/\n$/, "").split("\n"));

let serial = 0;
function runCase(kase, lib) {
  const box = join(work, `${kase}-${++serial}`);
  mkdirSync(box);
  const started = Date.now();
  const r = spawnSync("bash", [DRIVER, box, lib, kase], { cwd: pkg, encoding: "utf8", timeout: LIMIT_MS, killSignal: "SIGKILL" });
  const ms = Date.now() - started;
  const problems = [];
  if (r.error?.code === "ETIMEDOUT") problems.push(`past the ${LIMIT_MS / 1000} s limit: the driver was stopped by its process id`);
  else if (r.error) problems.push(`the driver did not run: ${r.error.message}`);

  // Every process the step recorded is stopped here by its id, and counted if it was still running.
  const pids = (read(join(box, "pids")) ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
  const left = pids.filter(running);
  for (const pid of left) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  const ev = join(box, "evidence");
  const out = lines(r.stdout ?? "") ?? [];
  const report = lines(read(join(ev, "report.txt")));
  const steps = lines(read(join(ev, "steps.tsv")));
  const node = report?.find((l) => l.startsWith("node: "))?.slice("node: ".length) ?? "?";
  const want = (what, got, expected) => {
    if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
  };
  // The three lines from overall_exit on, in their order.
  const verdict = () => {
    const at = report?.findIndex((l) => l.startsWith("overall_exit: ")) ?? -1;
    return at < 0 ? null : report.slice(at, at + 3);
  };
  const tsv = (name, cmd, code) => `${name}\t${cmd}\t${code}`;
  const evidenceLine = `evidence: check-runs/${SHA}/${RUN}`;

  const notFinished = (words, code, stepLines) => {
    want("exit status", r.status, code);
    want("last two printed lines", out.slice(-2), [`${evidenceLine} (NOT FINISHED: ${words}, exit ${code})`, "outputs digest: none (the run did not finish)"]);
    want("report.txt from overall_exit", verdict(), [`overall_exit: ${code}`, `finished: no (${words})`, "outputs_digest: none (the run did not finish)"]);
    want("steps.tsv", steps, stepLines);
  };
  const finished = (code, digest, stepLines) => {
    want("exit status", r.status, code);
    want("last two printed lines", out.slice(-2), [`${evidenceLine} (overall exit ${code})`, `outputs digest: ${digest} (node ${node})`]);
    want("report.txt from overall_exit", verdict(), [`overall_exit: ${code}`, "finished: yes", `outputs_digest: ${digest} (node ${node}; it holds for this Node version only)`]);
    want("steps.tsv", steps, stepLines);
  };

  if (kase.startsWith("cut-SIG")) {
    const sig = kase.slice("cut-SIG".length);
    notFinished(`stopped during step cut by SIG${sig}`, 128 + SIGNALS[sig], [tsv("first", "true", 0), tsv("cut", `bash ${CUT_STEP} ${sig}`, `cut by SIG${sig}`)]);
    if (pids.length !== 2) problems.push(`the step wrote ${pids.length} process ids, want 2`);
    if (left.length > 0) problems.push(`processes of the step still running after the run: ${left.join(", ")}`);
    if (ms > PROMPT_MS) problems.push(`took ${ms} ms, more than ${PROMPT_MS} ms`);
  } else if (kase === "cut-between-steps") {
    notFinished("stopped after step first by SIGTERM", 143, [tsv("first", "true", 0)]);
    if (pids.length !== 1) problems.push(`the driver wrote ${pids.length} process ids, want 1`);
    if (left.length > 0) problems.push(`the driver's own job still running after the run: ${left.join(", ")}`);
    if (ms > PROMPT_MS) problems.push(`took ${ms} ms, more than ${PROMPT_MS} ms`);
  } else if (kase === "early-exit") {
    notFinished("the script ended before its last step, after step first", 1, [tsv("first", "true", 0)]);
  } else if (kase === "early-exit-no-step") {
    notFinished("the script ended before its last step, after step none", 1, null);
  } else if (kase === "empty-outputs") {
    finished(0, "none", [tsv("first", "true", 0), tsv("last", "true", 0)]);
  } else if (kase === "failing-step") {
    finished(1, ownDigest(join(ev, "outputs")), [tsv("first", "true", 0), tsv("bad", "false", 1), tsv("last", "true", 0)]);
  } else if (kase === "passing") {
    const digest = ownDigest(join(ev, "outputs"));
    if (!/^[0-9a-f]{64}$/.test(digest)) problems.push(`the canary's own digest is ${digest}, want 64 hex digits`);
    finished(0, digest, [tsv("first", "true", 0), tsv("last", "true", 0)]);
  }
  return { case: kase, exit: r.status, ms, left: left.length, outcome: problems.length === 0 ? "pass" : "fail", problems };
}

const CASES = ["cut-SIGTERM", "cut-SIGINT", "cut-SIGHUP", "cut-between-steps", "early-exit", "early-exit-no-step", "empty-outputs", "failing-step", "passing"];

// ---- Tampered copies of the library: one find and replace each, the find occurring exactly once.
const TAMPERS = [
  { id: "verdict-starts-finished", rule: "C1", find: "check_finished=no\n", replace: "check_finished=yes\n", why: "every run reads as finished" },
  { id: "finished-line-dropped", rule: "C1", find: '    echo "$finished_line"\n', replace: "", why: "report.txt never says whether the run finished" },
  { id: "term-not-trapped", rule: "C2", find: "trap 'check_cut TERM' TERM\n", replace: "", why: "SIGTERM ends the script with no cut handling" },
  { id: "int-not-trapped", rule: "C2", find: "trap 'check_cut INT' INT\n", replace: "", why: "SIGINT ends the script with no cut handling" },
  { id: "hup-not-trapped", rule: "C2", find: "trap 'check_cut HUP' HUP\n", replace: "", why: "SIGHUP ends the script with no cut handling" },
  { id: "stray-job-not-stopped", rule: "C2", find: '  for job in $(jobs -pr); do check_stop_tree "$job"; done\n', replace: '  if [ -n "$check_step_pid" ]; then check_stop_tree "$check_step_pid"; fi\n', why: "a job started before its id was recorded keeps running" },
  { id: "tree-not-stopped", rule: "C2", find: "check_stop_tree() {\n", replace: "check_stop_tree() {\n  return 0\n", why: "the cut step and its children keep running" },
  { id: "only-direct-child-stopped", rule: "C2", find: 'kill "-$1" -- "-$2" 2>/dev/null', replace: 'kill "-$1" -- "$2" 2>/dev/null', why: "the step's children outlive it" },
  { id: "cut-step-not-written", rule: "C2", find: '    printf \'%s\\t%s\\t%s\\n\' "$check_step_name" "$check_step_cmd" "cut by SIG$sig" >>"$evidence/steps.tsv"\n', replace: "", why: "steps.tsv has no line for the step that was running" },
  { id: "cut-exit-not-128-plus", rule: "C2", find: 'overall=$((128 + $(kill -l "$sig")))', replace: "overall=1", why: "a cut run exits 1, not 128 plus the signal" },
  { id: "early-exit-keeps-zero", rule: "C3", find: '    if [ "$status" -eq 0 ]; then status=1; fi\n', replace: "", why: "an early exit 0 reads as exit 0" },
  { id: "empty-folder-hashed", rule: "C4", find: '  if [ -z "$files" ]; then\n    echo none\n    return 0\n  fi\n', replace: "", why: "an empty outputs folder gets the sha256 of empty input" },
  { id: "unfinished-run-digested", rule: "C4", find: '    digest_line="none (the run did not finish)"\n', replace: '    digest_line="$(check_outputs_digest) (node $node_v; it holds for this Node version only)"\n', why: "a run that did not finish gets a digest" },
];

let report;
let ok;
try {
  if (otherLib) {
    const cases = CASES.map((c) => runCase(c, otherLib));
    ok = cases.every((c) => c.outcome === "pass");
    report = { library: otherLib, cases, summary: { cases: cases.length, failing: cases.filter((c) => c.outcome !== "pass").length } };
  } else {
    const cases = CASES.map((c) => runCase(c, LIBRARY));
    const text = readFileSync(LIBRARY, "utf8");
    const tampers = TAMPERS.map((t) => {
      const count = text.split(t.find).length - 1;
      if (count !== 1) return { tamper: t.id, rule: t.rule, why: t.why, outcome: "invalid", detail: `find matches ${count} times` };
      const copy = join(work, `tampered-${t.id}.sh`);
      writeFileSync(copy, text.replace(t.find, () => t.replace));
      // The cases in order, until one fails: that one caught the tampered copy.
      for (const c of CASES) {
        const r = runCase(c, copy);
        if (r.outcome !== "pass") return { tamper: t.id, rule: t.rule, why: t.why, outcome: "caught", caught_by: c, problems: r.problems };
      }
      return { tamper: t.id, rule: t.rule, why: t.why, outcome: "missed" };
    });
    const rules = ["C1", "C2", "C3", "C4"].filter((rule) => !tampers.some((t) => t.rule === rule && t.outcome === "caught"));
    ok = cases.every((c) => c.outcome === "pass") && tampers.every((t) => t.outcome === "caught") && rules.length === 0;
    report = {
      library: relative(pkg, LIBRARY),
      cases,
      tampers,
      summary: {
        cases: cases.length,
        cases_passing: cases.filter((c) => c.outcome === "pass").length,
        tampers: tampers.length,
        tampers_caught: tampers.filter((t) => t.outcome === "caught").length,
        missed: tampers.filter((t) => t.outcome !== "caught").map((t) => t.tamper),
        rules_without_a_caught_tamper: rules,
      },
    };
  }
} finally {
  cleanup();
}
console.log(JSON.stringify(report, null, 2));
// exitCode, not exit(): a caller may read this report through a pipe, where a write is
// asynchronous and exit() could cut it short (round 9 review L7).
process.exitCode = ok ? 0 : 1;
