#!/usr/bin/env node
// Checks the attempts journal that test/setup.ts writes (RULES.md section 4).
//
// Each line is one event from one test file's run, written the moment it happened: an attempt,
// a reset of the log, or the file's final check. The problems:
//   - an attempt still in the log at its file's final check (that file's afterAll fails too)
//   - anything after a file's final check: an attempt or a reset made once the hooks are done,
//     from a timer for instance, which no afterAll can see
//   - a reset or a final check whose count disagrees with the attempts journaled before it,
//     which would mean the journal lost an attempt
//   - an attempt in a file that never reached its final check
//   - a file that reached its final check in more than one run
//   - a line that is not a journal event
// With --expect-files N, exactly N distinct test files must have reached their final check.
//
// Usage: node scripts/attempts-check.mjs <journal> [--unexpected <file>] [--expect-files N]
// Prints a JSON summary. Writes the problems to --unexpected only when there are any.
// Exit 1 on any problem. test/global-setup.ts calls checkJournal() after every vitest run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EVENTS = new Set(["attempt", "reset", "checked"]);

/**
 * Checks journal text. Returns counts and every problem found, oldest first.
 * @param {string} text
 * @param {number | null} [expectFiles]
 */
export function checkJournal(text, expectFiles = null) {
  const runs = new Map();
  const problems = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let attempts = 0;
  lines.forEach((line, i) => {
    const at = { line: i + 1 };
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      problems.push({ ...at, problem: "not a journal event" });
      return;
    }
    if (!e || typeof e !== "object" || typeof e.run !== "string" || typeof e.file !== "string" || !EVENTS.has(e.event)) {
      problems.push({ ...at, problem: "not a journal event" });
      return;
    }
    let r = runs.get(e.run);
    if (!r) {
      r = { file: e.file, pending: [], checked: false };
      runs.set(e.run, r);
    }
    if (e.event === "attempt") attempts++;
    if (r.checked) {
      problems.push({ ...at, file: e.file, problem: `${e.event} after the file's final check`, attempt: e.attempt });
      return;
    }
    if (e.event === "attempt") {
      r.pending.push(e.attempt);
    } else if (e.event === "reset") {
      if (e.cleared !== r.pending.length) {
        problems.push({ ...at, file: e.file, problem: `a reset cleared ${String(e.cleared)} attempts, but ${r.pending.length} were journaled` });
      }
      r.pending = [];
    } else {
      r.checked = true;
      if (e.left !== r.pending.length) {
        problems.push({ ...at, file: e.file, problem: `the final check saw ${String(e.left)} attempts, but ${r.pending.length} were journaled` });
      }
      for (const a of r.pending) problems.push({ ...at, file: e.file, problem: "attempt left in the log at the final check", attempt: a });
      r.pending = [];
    }
  });
  for (const r of runs.values()) {
    if (!r.checked) for (const a of r.pending) problems.push({ file: r.file, problem: "attempt in a file that never reached its final check", attempt: a });
  }
  // A file counts once, however many runs name it: one run of the tests runs each file once, so a
  // file that reached its final check in two runs is a journal no single run wrote (sixth rerun U7).
  const checkedRuns = [...runs.values()].filter((r) => r.checked);
  const files = new Set(checkedRuns.map((r) => r.file));
  for (const f of files) {
    const n = checkedRuns.filter((r) => r.file === f).length;
    if (n > 1) problems.push({ file: f, problem: `the file reached its final check in ${n} runs` });
  }
  const filesChecked = files.size;
  if (expectFiles !== null && filesChecked !== expectFiles) {
    problems.push({ problem: `${filesChecked} test files reached their final check, expected ${expectFiles}` });
  }
  return { events: lines.length, attempts, files_checked: filesChecked, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const journal = args[0];
  const opt = (name) => {
    const i = args.indexOf(name);
    return i > 0 ? args[i + 1] : undefined;
  };
  const expectRaw = opt("--expect-files");
  const expectFiles = expectRaw === undefined ? null : Number(expectRaw);
  if (!journal || (expectRaw !== undefined && !Number.isSafeInteger(expectFiles))) {
    console.error("usage: node scripts/attempts-check.mjs <journal> [--unexpected <file>] [--expect-files N]");
    process.exit(2);
  }
  const text = existsSync(journal) ? readFileSync(journal, "utf8") : "";
  const result = checkJournal(text, expectFiles);
  const out = opt("--unexpected");
  if (out && result.problems.length > 0) writeFileSync(out, result.problems.map((p) => JSON.stringify(p)).join("\n") + "\n");
  console.log(JSON.stringify({ journal_present: existsSync(journal), ...result }, null, 2));
  // exitCode, not exit(): a caller may read this report through a pipe, where a write is
  // asynchronous and exit() could cut it short (round 9 review L7).
  process.exitCode = result.problems.length > 0 ? 1 : 0;
}
