// What scripts/mutate.mjs writes to stderr when its result is not a pass (review round 28, N2):
// at most 20 lines, the summary, both controls with a failed one's first failing test, and every
// mutant that was not killed. scripts/mutate-canary.mjs shows mutate.mjs writes them, and only then.
import { describe, expect, it } from "vitest";
import { WHY_LINES, WHY_WIDTH, firstFailingOf, whyNotPass } from "../scripts/mutate-why.mjs";

const summary = { mutants: 3, killed: 1, survived: 1, load_error: 1, invalid: 0, other: 0, setup: "setup-pass" };
const pass = { outcome: "control-pass" };
const fail = { outcome: "control-fail" };
const results = [
  { id: "a-killed", outcome: "killed" },
  { id: "b-lives", outcome: "survived" },
  { id: "c-breaks", outcome: "load-error" },
];

describe("whyNotPass: the stderr lines of a mutation run that is not a pass (round 28, N2)", () => {
  it("gives the summary, both controls and every mutant not killed with its outcome, in that order", () => {
    expect(whyNotPass({ summary, control_before: pass, control_after: pass, results })).toEqual([
      "mutants not a pass: 3 mutants, 1 killed, 1 survived, 1 load errors, 0 invalid, 0 other, setup-pass",
      "control before: control-pass",
      "control after: control-pass",
      "not killed: b-lives survived",
      "not killed: c-breaks load-error",
    ]);
  });

  it("names the first failing test of a failed control, and says a control that did not run", () => {
    const lines = whyNotPass({ summary, control_before: fail, control_after: null, results: [] }, { before: "test/x.test.ts > a test: expected 1 to be 2" });
    expect(lines.slice(1)).toEqual(["control before: control-fail, first failing test: test/x.test.ts > a test: expected 1 to be 2", "control after: not-run"]);
    expect(whyNotPass({ summary, control_before: fail, control_after: fail, results: [] }).slice(1)).toEqual(["control before: control-fail, first failing test: none named", "control after: control-fail, first failing test: none named"]);
  });

  it("never writes more than 20 lines: past them, how many more mutants were not killed", () => {
    expect(WHY_LINES).toBe(20);
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, outcome: "survived" }));
    const lines = whyNotPass({ summary, control_before: pass, control_after: pass, results: many });
    expect(lines).toHaveLength(20);
    expect(lines.slice(3, 5)).toEqual(["not killed: m0 survived", "not killed: m1 survived"]);
    expect(lines.at(-2)).toBe("not killed: m15 survived");
    expect(lines.at(-1)).toBe("and 14 more not killed");
    // Exactly as many as fit: no "more" line.
    const fit = whyNotPass({ summary, control_before: pass, control_after: pass, results: many.slice(0, 17) });
    expect(fit).toHaveLength(20);
    expect(fit.at(-1)).toBe("not killed: m16 survived");
  });

  it("cuts each line at 300 characters", () => {
    expect(WHY_WIDTH).toBe(300);
    const lines = whyNotPass({ summary, control_before: fail, control_after: pass, results: [{ id: "x".repeat(400), outcome: "survived" }] }, { before: "y".repeat(400) });
    expect(lines.map((l) => l.length)).toEqual([lines[0]?.length, 300, "control after: control-pass".length, 300]);
    expect(lines[1]).toBe(`control before: control-fail, first failing test: ${"y".repeat(300 - "control before: control-fail, first failing test: ".length)}`);
  });
});

describe("firstFailingOf: a failed control's first failing test (round 28, N2)", () => {
  const run = { exit: 1, tail: "" };
  const file = (name: string, failed: string[], firstFailure = "", message = "") => ({ file: name, failed, firstFailure, message });

  it("names the first failing file, its first failed test and its first failure", () => {
    expect(firstFailingOf(run, [file("test/a.test.ts", ["A > one", "A > two"], "expected 1 to be 2"), file("test/b.test.ts", ["B > one"], "x")], [])).toBe("test/a.test.ts > A > one: expected 1 to be 2");
  });

  it("gives the file's message when no test in it failed, as for a file that failed to load", () => {
    expect(firstFailingOf(run, [file("test/a.test.ts", [], "", "SyntaxError: Unexpected token")], [])).toBe("test/a.test.ts > no test failed in the file: SyntaxError: Unexpected token");
  });

  it("says why none is named: a timeout, no report (with the last line of output), a file that did not run, or the exit", () => {
    expect(firstFailingOf({ ...run, timeout: true }, [], [])).toBe("none: the run timed out");
    expect(firstFailingOf({ ...run, noReport: true, tail: "first\nError: no such file\n\n" }, [], [])).toBe("none: no report (Error: no such file)");
    expect(firstFailingOf(run, [], ["test/c.test.ts"])).toBe("none: test/c.test.ts did not run");
    expect(firstFailingOf({ exit: 2, tail: "" }, [], [])).toBe("none: exit 2");
  });
});
