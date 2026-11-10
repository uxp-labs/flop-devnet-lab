// The attempts journal (RULES.md section 4): src/guard.ts tells listeners about every attempt and
// reset the moment it happens, test/setup.ts writes each one to OBS_ATTEMPTS_FILE, and
// scripts/attempts-check.mjs fails whatever no afterAll could see.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkJournal } from "../scripts/attempts-check.mjs";
import { type AttemptEvent, attemptLog, guardRpc, onAttempt, resetAttempts } from "../src/guard.js";

type Problem = { problem: string; file?: string; line?: number };
const check = (lines: object[], expectFiles: number | null = null) =>
  checkJournal(lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""), expectFiles) as {
    events: number;
    attempts: number;
    files_checked: number;
    problems: Problem[];
  };
const A = { kind: "network", what: "fetch https://canary.invalid/", at: "2026-11-10T00:00:00.000Z" };
const at = (run: string, file = "test/x.test.ts") => ({
  attempt: { run, file, event: "attempt", attempt: A },
  reset: (cleared: number) => ({ run, file, event: "reset", cleared }),
  checked: (left: number) => ({ run, file, event: "checked", left }),
});

describe("onAttempt hears every attempt and reset the moment it happens", () => {
  it("calls a listener synchronously with the attempt, then with the reset and its count", () => {
    const heard: AttemptEvent[] = [];
    const remove = onAttempt((e) => heard.push(e));
    try {
      expect(() => guardRpc("author_submitExtrinsic")).toThrow();
      expect(heard).toMatchObject([{ type: "attempt", attempt: { kind: "rpc-write", what: "rpc author_submitExtrinsic" } }]);
      resetAttempts();
      expect(heard.at(-1)).toEqual({ type: "reset", cleared: 1 });
    } finally {
      remove();
    }
    expect(() => guardRpc("author_rotateKeys")).toThrow();
    resetAttempts();
    expect(heard).toHaveLength(2);
  });

  it("is written to the journal on disk by test/setup.ts, attempt and reset alike", () => {
    const journal = process.env.OBS_ATTEMPTS_FILE;
    expect(journal).toBeTruthy();
    const what = `rpc author_journalProbe${Date.now()}${Math.random().toString(16).slice(2)}`;
    expect(() => guardRpc(what.slice(4))).toThrow();
    expect(attemptLog()).toHaveLength(1);
    resetAttempts();
    const mine = readFileSync(journal as string, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { run: string; file: string; event: string; attempt?: { what: string }; cleared?: number });
    const i = mine.findIndex((e) => e.event === "attempt" && e.attempt?.what === what);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(mine[i]).toMatchObject({ file: "test/attempts-check.test.ts" });
    const after = mine.slice(i + 1).find((e) => e.run === mine[i]!.run);
    expect(after).toMatchObject({ event: "reset", cleared: 1 });
  });
});

describe("checkJournal", () => {
  it("passes a journal where every attempt was cleared before its file's final check", () => {
    const a = at("r1");
    const b = at("r2", "test/y.test.ts");
    const r = check([a.attempt, b.attempt, a.reset(1), a.attempt, a.attempt, b.reset(1), a.reset(2), a.checked(0), b.checked(0)], 2);
    expect(r).toEqual({ events: 9, attempts: 4, files_checked: 2, problems: [] });
  });

  it("fails an attempt still in the log at the final check", () => {
    const a = at("r1");
    expect(check([a.attempt, a.checked(1)]).problems).toMatchObject([{ problem: "attempt left in the log at the final check", line: 2 }]);
  });

  it("fails an attempt made after its file's final check, from a timer say", () => {
    const a = at("r1");
    expect(check([a.checked(0), a.attempt]).problems).toMatchObject([{ problem: "attempt after the file's final check", line: 2 }]);
  });

  it("fails a reset made after the final check, even one that clears a late attempt", () => {
    const a = at("r1");
    expect(check([a.checked(0), a.attempt, a.reset(1)]).problems.map((p) => p.problem)).toEqual([
      "attempt after the file's final check",
      "reset after the file's final check",
    ]);
  });

  it("fails a reset or a final check whose count disagrees with the journal, which means a lost attempt", () => {
    const a = at("r1");
    expect(check([a.reset(1), a.checked(0)]).problems).toMatchObject([{ problem: "a reset cleared 1 attempts, but 0 were journaled" }]);
    expect(check([a.checked(2)]).problems).toMatchObject([{ problem: "the final check saw 2 attempts, but 0 were journaled" }]);
  });

  it("fails an attempt in a file that never reached its final check", () => {
    expect(check([at("r1").attempt]).problems).toMatchObject([{ problem: "attempt in a file that never reached its final check" }]);
  });

  it("keeps each file's run separate: one file's reset never clears another's attempt", () => {
    const a = at("r1");
    const b = at("r2", "test/y.test.ts");
    expect(check([a.attempt, b.reset(0), a.checked(1), b.checked(0)]).problems).toMatchObject([
      { problem: "attempt left in the log at the final check", file: "test/x.test.ts" },
    ]);
  });

  it("fails a line that is not a journal event", () => {
    const r = checkJournal('{"run":"r1","file":"test/x.test.ts","event":"checked","left":0}\nnot json\n{"run":"r1","event":"attempt"}\n') as { problems: Problem[] };
    expect(r.problems).toMatchObject([
      { line: 2, problem: "not a journal event" },
      { line: 3, problem: "not a journal event" },
    ]);
  });

  it("with an expected number of test files, fails when fewer reached their final check", () => {
    const a = at("r1");
    expect(check([a.checked(0)], 2).problems).toMatchObject([{ problem: "1 test files reached their final check, expected 2" }]);
    expect(check([], 1).problems).toMatchObject([{ problem: "0 test files reached their final check, expected 1" }]);
    expect(check([a.checked(0)], 1).problems).toEqual([]);
  });

  it("counts a file once, and fails one that reached its final check in two runs, so another file's missing check shows (sixth rerun U7)", () => {
    const a1 = at("r1", "test/a.test.ts");
    const a2 = at("r2", "test/a.test.ts");
    const r = check([a1.checked(0), a2.checked(0), at("r3", "test/b.test.ts").attempt], 2);
    expect(r.files_checked).toBe(1);
    expect(r.problems).toMatchObject([
      { file: "test/b.test.ts", problem: "attempt in a file that never reached its final check" },
      { file: "test/a.test.ts", problem: "the file reached its final check in 2 runs" },
      { problem: "1 test files reached their final check, expected 2" },
    ]);
  });
});
