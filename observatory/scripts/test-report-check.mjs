#!/usr/bin/env node
// The test report read once more: every test file ran, and every test in it ran and passed.
// vitest exits 0 when a test is skipped, left as a todo, or shut out by a .only elsewhere, so its
// exit code alone cannot show that the tests ran (round 7 review I5).
//
// Usage: node scripts/test-report-check.mjs <vitest.json> --expect-files N
// One test may skip by design: the page file whose name is not valid UTF-8 needs a filesystem
// that accepts such a name, which stock macOS does not. On Linux, which accepts any name, it must
// run, so there no skip at all is allowed. Each file must run exactly the tests
// test/test-counts.json pins, by number and by a digest of their names, so a test removed or
// renamed shows (round 8 review I5, round 9 review I5); adding or renaming a test means updating
// its file's entry there. A status cannot show a test written to pass when its body fails
// (it.fails) or a table with no rows (it.each([]), it.for([])), so the test sources are read for
// those. A table held in a variable, and a test that returns before its assertion, are not seen.
// The rules are then run on doctored copies of the report (one test skipped, one left as a todo,
// one file missing, one test removed, one renamed), each of which must fail.
// Prints a JSON array of {check, outcome}; exit 1 unless every check passes.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--"));
const at = args.indexOf("--expect-files");
const expectFiles = at >= 0 ? Number(args[at + 1]) : NaN;
const PLATFORM_SKIPS = [/a page file whose name is not valid UTF-8 is a page error/];
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(pkg, "test");
const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
/** One file's pinned entry: its number of tests and a digest of their full names, sorted. */
function entryOf(f) {
  const tests = Array.isArray(f.assertionResults) ? f.assertionResults : [];
  const names = tests.map((t) => String(t.fullName ?? t.title ?? "")).sort();
  return { tests: tests.length, names: createHash("sha256").update(names.join("\n")).digest("hex") };
}
let pinned = null;
try {
  pinned = JSON.parse(readFileSync(join(testDir, "test-counts.json"), "utf8"));
} catch {
  pinned = null;
}

/** The rules over one report: a list of [check, pass, detail]. */
function evaluate(r) {
  const files = Array.isArray(r.testResults) ? r.testResults : [];
  const tests = files.flatMap((f) => (Array.isArray(f.assertionResults) ? f.assertionResults : []));
  const notPassed = tests.filter((t) => t.status !== "passed");
  const allowed = (t) => process.platform !== "linux" && t.status === "skipped" && PLATFORM_SKIPS.some((re) => re.test(String(t.fullName ?? t.title ?? "")));
  const counts = Object.fromEntries(files.map((f) => [relative(testDir, String(f.name ?? "")).split(sep).join("/"), entryOf(f)]));
  const same = (a, b) => a !== undefined && b !== undefined && a.tests === b.tests && a.names === b.names;
  const differ = pinned === null ? ["test/test-counts.json cannot be read"] : [...new Set([...Object.keys(counts), ...Object.keys(pinned)])].filter((k) => !same(counts[k], pinned[k])).map((k) => `${k}: ran ${JSON.stringify(counts[k] ?? null)}, pinned ${JSON.stringify(pinned[k] ?? null)}`);
  return [
    [`every test file ran (${expectFiles})`, Number.isInteger(expectFiles) && files.length === expectFiles, `${files.length} files in the report`],
    ["each test file ran exactly the tests test/test-counts.json pins", pinned !== null && canon(counts) === canon(pinned), differ.slice(0, 5).join("; ")],
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
    "one test removed from a file": (r) => {
      r.testResults[0].assertionResults.pop();
      r.numTotalTests -= 1;
      r.numPassedTests -= 1;
    },
    "one test renamed": (r) => {
      const t = r.testResults[0].assertionResults[0];
      t.fullName = `${t.fullName ?? t.title} (renamed)`;
      t.title = `${t.title} (renamed)`;
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
// The test sources: no test passes on a failure, and no table of cases is empty.
{
  const RISKY = [
    [/\.\s*fails\b|\[\s*["'`]fails["'`]\s*\]/, "a test written to pass when its body fails (.fails)"],
    [/\.\s*(?:each|for)\s*\(\s*\[\s*\]\s*\)/, "a table of cases with no rows (.each([]) or .for([]))"],
  ];
  const sources = readdirSync(testDir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).sort();
  const found = sources.flatMap((f) => RISKY.filter(([re]) => re.test(readFileSync(join(testDir, f), "utf8"))).map(([, what]) => `${f}: ${what}`));
  record("no test source holds a test that passes on failure or a table with no rows", sources.length > 0 && found.length === 0, found.join("; ") || "no test sources found");
  const bites = ["it.fails('x', () => {});", "it.each([])('x', () => {});", "describe.each( [ ] )('x', () => {});", "it.for([])('x', () => {});", 't["fails"]("x", () => {});'].every((t) => RISKY.some(([re]) => re.test(t)));
  record("the source rule catches .fails, a fails key and an empty .each or .for table", bites, "a sample passed the source rule");
}
console.log(JSON.stringify(results, null, 2));
// exitCode, not exit(): a caller may read this report through a pipe, where a write is
// asynchronous and exit() could cut it short (round 9 review L7).
process.exitCode = results.every((x) => x.outcome === "pass") ? 0 : 1;
