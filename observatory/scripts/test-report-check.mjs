#!/usr/bin/env node
// The test report read once more: every test file ran, and every test in it ran and passed.
// vitest exits 0 when a test is skipped, left as a todo, or shut out by a .only elsewhere, so its
// exit code alone cannot show that the tests ran (round 7 review I5).
//
// Usage: node scripts/test-report-check.mjs <vitest.json> --expect-files N
// One test may skip by design: the page file whose name is not valid UTF-8 needs a filesystem
// that accepts such a name, which stock macOS does not. On Linux, which accepts any name, it must
// run, so there no skip at all is allowed. The rules are then run on doctored copies of the
// report (one test skipped, one left as a todo, one file missing), each of which must fail.
// Prints a JSON array of {check, outcome}; exit 1 unless every check passes.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--"));
const at = args.indexOf("--expect-files");
const expectFiles = at >= 0 ? Number(args[at + 1]) : NaN;
const PLATFORM_SKIPS = [/a page file whose name is not valid UTF-8 is a page error/];

/** The rules over one report: a list of [check, pass, detail]. */
function evaluate(r) {
  const files = Array.isArray(r.testResults) ? r.testResults : [];
  const tests = files.flatMap((f) => (Array.isArray(f.assertionResults) ? f.assertionResults : []));
  const notPassed = tests.filter((t) => t.status !== "passed");
  const allowed = (t) => process.platform !== "linux" && t.status === "skipped" && PLATFORM_SKIPS.some((re) => re.test(String(t.fullName ?? t.title ?? "")));
  return [
    [`every test file ran (${expectFiles})`, Number.isInteger(expectFiles) && files.length === expectFiles, `${files.length} files in the report`],
    ["the report counts every test it lists", r.numTotalTests === tests.length && tests.length > 0, `numTotalTests ${r.numTotalTests}, listed ${tests.length}`],
    ["no test failed", r.success === true && r.numFailedTests === 0 && !notPassed.some((t) => t.status === "failed"), `${r.numFailedTests} failed`],
    [
      "no test was skipped, left as a todo or shut out by a .only",
      notPassed.every(allowed) && (r.numPendingTests ?? 0) === notPassed.filter(allowed).length && (r.numTodoTests ?? 0) === 0,
      notPassed.filter((t) => !allowed(t)).slice(0, 5).map((t) => `${t.status}: ${t.fullName ?? t.title}`).join("; ") || `pending ${r.numPendingTests}, todo ${r.numTodoTests}`,
    ],
  ];
}

const results = [];
const record = (check, pass, detail) => results.push({ check, outcome: pass ? "pass" : "fail", ...(pass ? {} : { detail }) });
let report = null;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  record("the vitest report can be read", false, String(e?.message ?? e));
}
if (report) {
  for (const [check, pass, detail] of evaluate(report)) record(check, pass, detail);
  // The rules bite: each doctored copy must fail at least one of them.
  const doctored = {
    "one test skipped": (r) => {
      r.testResults[0].assertionResults[0].status = "skipped";
      r.numPendingTests = (r.numPendingTests ?? 0) + 1;
      r.numPassedTests -= 1;
    },
    "one test left as a todo": (r) => {
      r.testResults[0].assertionResults[0].status = "todo";
      r.numTodoTests = (r.numTodoTests ?? 0) + 1;
      r.numPassedTests -= 1;
    },
    "one test file missing": (r) => {
      const gone = r.testResults.pop();
      r.numTotalTests -= gone.assertionResults.length;
      r.numPassedTests -= gone.assertionResults.length;
    },
  };
  for (const [name, edit] of Object.entries(doctored)) {
    const copy = JSON.parse(JSON.stringify(report));
    if (!copy.testResults?.[0]?.assertionResults?.[0]) {
      record(`the rules fail a report with ${name}`, false, "the report has no test to doctor");
      continue;
    }
    edit(copy);
    record(`the rules fail a report with ${name}`, evaluate(copy).some(([, pass]) => !pass), "every rule passed the doctored report");
  }
}
console.log(JSON.stringify(results, null, 2));
process.exit(results.every((x) => x.outcome === "pass") ? 0 : 1);
