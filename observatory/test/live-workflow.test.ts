// The live workflow read as data: what it may do, and the things it must never do. No test can run
// it; this holds its text to the rules RULES.md section 4 and the README give it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOWS = new URL("../../.github/workflows/", import.meta.url);
const text = readFileSync(new URL("observatory-live.yml", WORKFLOWS), "utf8");
/** The workflow without its comment lines, which say in words what it never does. */
const body = text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
const wf = parse(text) as Record<string, unknown>;
const check = parse(readFileSync(new URL("observatory-check.yml", WORKFLOWS), "utf8")) as Record<string, unknown>;

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; "working-directory"?: string };
const job = (wf.jobs as Record<string, Record<string, unknown>>).live as Record<string, unknown>;
const steps = job.steps as Step[];
const checkSteps = ((check.jobs as Record<string, Record<string, unknown>>).check as { steps: Step[] }).steps;

/** The live source files: a push that changes one gives a live smoke run. */
const LIVE_FILES = ["transport", "tape", "net", "rpc-head", "live-source", "live-run", "live-bin"].map((f) => `observatory/src/${f}.ts`);

describe("the live workflow", () => {
  it("runs on its schedule, by hand, and on a push that changes it or a live source file", () => {
    expect(wf.on).toEqual({
      schedule: [{ cron: "7,37 * * * *" }],
      workflow_dispatch: null,
      push: { paths: [".github/workflows/observatory-live.yml", ...LIVE_FILES] },
    });
  });

  it("may read the repository and nothing else, in one group that never cancels a run, for at most 12 minutes", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(wf.concurrency).toEqual({ group: "observatory-live", "cancel-in-progress": false });
    expect(job["timeout-minutes"]).toBe(12);
  });

  it("checks out without credentials, on the offline check's Node version and pinned actions", () => {
    expect(steps.map((s) => s.uses ?? s.run)).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "npm ci --ignore-scripts --no-audit --no-fund",
      "npm run build",
      'node dist/live-bin.js --out "$RUNNER_TEMP/observatory-live" --source-sha "$GITHUB_SHA"',
      "actions/upload-artifact@v4",
    ]);
    expect(steps.at(0)?.with).toEqual({ "persist-credentials": false });
    expect(steps.at(1)?.with).toEqual({ "node-version": "22.23.4" });
    expect(steps.at(1)?.with).toEqual(checkSteps.find((s) => s.uses?.startsWith("actions/setup-node"))?.with);
    // Every action this workflow uses is pinned as the offline check pins it.
    const pinned = new Set(checkSteps.map((s) => s.uses).filter((u) => u !== undefined));
    for (const s of steps) if (s.uses !== undefined) expect(pinned, s.uses).toContain(s.uses);
  });

  it("uploads the output folder, also when the command failed", () => {
    const up = steps.at(-1) as Step;
    expect(up.if).toBe("${{ !cancelled() }}");
    expect(up.with?.path).toBe("${{ runner.temp }}/observatory-live");
    expect(up.with?.["if-no-files-found"]).toBe("error");
  });

  it("never uses a secret, a cache, pull_request_target, a push, an issue or a comment, and never sends anything itself", () => {
    expect(body).not.toMatch(/secrets|github\.token|GITHUB_TOKEN/);
    expect(body).not.toMatch(/pull_request_target|actions\/cache|\bcache\b/);
    expect(body).not.toMatch(/git push|\bgh\s|curl|wget|issues|comments|POST|write/);
    for (const s of steps) expect(Object.keys(s).sort(), s.name).not.toContain("env");
  });
});
