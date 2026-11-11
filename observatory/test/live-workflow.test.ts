// The live workflow read as data: what it may do, and the things it must never do. This holds its
// text to the rules RULES.md sections 4 and 7 and the README give it. The publish job's two shell
// steps are also run, against a local bare repository, in test/publish-shell.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PUBLISHED_FILES } from "../src/published.js";

const WORKFLOWS = new URL("../../.github/workflows/", import.meta.url);
const text = readFileSync(new URL("observatory-live.yml", WORKFLOWS), "utf8");
/** The workflow without its comment lines, which say in words what it never does. */
const body = text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
const wf = parse(text) as Record<string, unknown>;
const check = parse(readFileSync(new URL("observatory-check.yml", WORKFLOWS), "utf8")) as Record<string, unknown>;

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; "working-directory"?: string };
const jobs = wf.jobs as Record<string, Record<string, unknown>>;
const job = jobs.live as Record<string, unknown>;
const steps = job.steps as Step[];
/** The text of the workflow outside the publish job, without its comment lines. */
const publishAt = text.indexOf("\n  publish:\n");
const unpublished = (publishAt < 0 ? text : text.slice(0, publishAt)).split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
const checkSteps = ((check.jobs as Record<string, Record<string, unknown>>).check as { steps: Step[] }).steps;

/** The live source files: a push that changes one gives a live smoke run. */
const LIVE_FILES = ["transport", "tape", "net", "net-root", "rpc-head", "live-source", "live-run", "live-bin", "run-command", "sums", "history", "store"].map((f) => `observatory/src/${f}.ts`);

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
    expect(steps.map((s) => s.uses ?? s.id ?? s.run)).toEqual([
      "actions/checkout@v4",
      "data",
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "npm ci --ignore-scripts --no-audit --no-fund",
      "npm run build",
      'node dist/live-bin.js --out "$RUNNER_TEMP/observatory-live" --log "$GITHUB_WORKSPACE/observatory-data/log" --source-sha "$GITHUB_SHA"',
      "actions/upload-artifact@v4",
    ]);
    expect(steps.at(0)?.with).toEqual({ "persist-credentials": false });
    expect(steps.at(3)?.with).toEqual({ "node-version": "22.23.4" });
    expect(steps.at(3)?.with).toEqual(checkSteps.find((s) => s.uses?.startsWith("actions/setup-node"))?.with);
    // Every action this workflow uses is pinned as the offline check pins it.
    const pinned = new Set(checkSteps.map((s) => s.uses).filter((u) => u !== undefined));
    for (const s of steps) if (s.uses !== undefined) expect(pinned, s.uses).toContain(s.uses);
  });

  it("checks out the published log read only, without credentials, and a missing branch is a first run", () => {
    const find = steps.at(1) as Step;
    const data = steps.at(2) as Step;
    const read = steps.at(6) as Step;
    expect(find.run).toMatch(/^set -euo pipefail\n/);
    // Asked of the server by name, with no token: exit 2 means no such branch.
    expect(find.run).toContain('git ls-remote --exit-code "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git" refs/heads/observatory-data >/dev/null || found=$?');
    expect(find.run).toContain('elif [ "$found" -eq 2 ]; then\n  echo "::notice::observatory-data does not exist yet, so this is a first run"\n  echo "found=false" >>"$GITHUB_OUTPUT"');
    // Anything else is an error, never a first run.
    expect(find.run).toContain('else\n  echo "::error::cannot read observatory-data"\n  exit 1\nfi');
    expect(data.if).toBe("${{ steps.data.outputs.found == 'true' }}");
    expect(data.with).toEqual({ ref: "observatory-data", path: "observatory-data", "persist-credentials": false });
    // The command reads the log/ folder of that checkout; a folder that is not there is a first run.
    expect(read.run).toContain('--log "$GITHUB_WORKSPACE/observatory-data/log"');
    expect(read["working-directory"]).toBe("observatory");
    // Every checkout keeps no credentials.
    for (const s of steps.filter((x) => x.uses?.startsWith("actions/checkout"))) expect(s.with?.["persist-credentials"]).toBe(false);
  });

  it("uploads the output folder, also when the command failed", () => {
    const up = steps.at(-1) as Step;
    expect(up.if).toBe("${{ !cancelled() }}");
    expect(up.with?.path).toBe("${{ runner.temp }}/observatory-live");
    expect(up.with?.["if-no-files-found"]).toBe("error");
  });

  it("never uses a secret, a cache, pull_request_target, a push, an issue or a comment, and never sends anything itself", () => {
    expect(body).not.toMatch(/secrets/);
    expect(body).not.toMatch(/pull_request_target|actions\/cache|\bcache\b/);
    expect(body).not.toMatch(/\bgh\s|curl|wget|issues|comments|POST/);
    // The publish job is the one part that pushes and holds a token; the tests below hold it.
    expect(unpublished).toContain("\n  live:\n");
    expect(unpublished).not.toMatch(/github\.token|GITHUB_TOKEN|git push|write/);
    for (const s of steps) expect(Object.keys(s).sort(), s.name).not.toContain("env");
  });
});

const publish = (jobs.publish ?? {}) as Record<string, unknown>;
const pubSteps = (publish.steps ?? []) as Step[];
/** Shell text without its comment lines. */
const code = (s: string | undefined) => (s ?? "").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
/** The publish job's shell lines, without comments. */
const shell = code(pubSteps.map((s) => s.run ?? "").join("\n"));
const REF = "refs/heads/observatory-data";

/** The publish job's condition as a function of what GitHub gives it. */
function condition(): (c: { cancelled: boolean; ref: string; result: string; artifactId: string }) => boolean {
  const expr = String(publish.if ?? "")
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/!cancelled\(\)/g, "!c.cancelled")
    .replace(/github\.ref\b/g, "c.ref")
    .replace(/needs\.live\.result\b/g, "c.result")
    .replace(/needs\.live\.outputs\.artifact-id\b/g, "c.artifactId")
    .replace(/==/g, "===")
    .replace(/!===/g, "!==");
  // Nothing but those four names, quoted words and logic: no other context is read.
  expect(expr.replace(/'[^']*'/g, "").replace(/c\.(cancelled|ref|result|artifactId)/g, "")).toMatch(/^[\s()!&|=]*$/);
  return new Function("c", `return (${expr});`) as (c: { cancelled: boolean; ref: string; result: string; artifactId: string }) => boolean;
}

describe("the publish job", () => {
  it("is the only job besides the live job, and the only one that may write, and only contents", () => {
    expect(Object.keys(jobs)).toEqual(["live", "publish"]);
    expect(publish.permissions).toEqual({ contents: "write" });
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(steps.at(0)?.with).toEqual({ "persist-credentials": false });
    expect(publish.needs).toBe("live");
  });

  it("knows the live job uploaded its folder by the upload's artifact id, and nothing else", () => {
    expect(job.outputs).toEqual({ "artifact-id": "${{ steps.upload.outputs.artifact-id }}" });
    expect(steps.at(-1)?.id).toBe("upload");
  });

  it("runs for main only, when the live job uploaded its folder, also when the live run exited 3, never when cancelled", () => {
    const run = condition();
    const main = { cancelled: false, ref: "refs/heads/main", result: "success", artifactId: "123" };
    expect(run(main)).toBe(true);
    // Exit 3 (a reset signal) fails the live step, so the live job's result is failure.
    expect(run({ ...main, result: "failure" })).toBe(true);
    expect(run({ ...main, ref: "refs/heads/claude/observatory-publish" })).toBe(false);
    expect(run({ ...main, ref: "refs/heads/observatory-data" })).toBe(false);
    expect(run({ ...main, ref: "refs/tags/main" })).toBe(false);
    expect(run({ ...main, cancelled: true })).toBe(false);
    expect(run({ ...main, result: "cancelled" })).toBe(false);
    expect(run({ ...main, result: "skipped" })).toBe(false);
    expect(run({ ...main, artifactId: "" })).toBe(false);
    expect(run({ ...main, result: "failure", artifactId: "" })).toBe(false);
    // The same for schedule, dispatch and push: the condition never reads the event.
    expect(String(publish.if)).not.toMatch(/event/);
  });

  it("runs no code from the repository: no checkout, no install, no build, no node, no script", () => {
    expect(pubSteps.map((s) => s.uses ?? s.name)).toEqual(["actions/download-artifact@v4", "Check the files against SHA256SUMS", "Publish to observatory-data"]);
    expect(JSON.stringify(publish)).not.toMatch(/checkout|setup-node|working-directory/);
    // No command that runs code, and no path into a checkout: the only folders are the runner's.
    expect(shell).not.toMatch(/\b(npm|npx|node|yarn|pnpm|tsc|python3?|bash|sh|source|eval|exec)\s|(^|[\s"'])\.{1,2}\/|GITHUB_WORKSPACE|github\.workspace/m);
  });

  it("downloads this run's artifact, by the id the live job gave, into a fixed folder", () => {
    expect(pubSteps.at(0)?.with).toEqual({ "artifact-ids": "${{ needs.live.outputs.artifact-id }}", "merge-multiple": true, path: "${{ runner.temp }}/reading" });
  });

  it("pins its action the way the live job pins its own", () => {
    const upload = steps.at(-1)?.uses as string;
    const download = pubSteps.at(0)?.uses as string;
    expect(download.split("@")).toEqual(["actions/download-artifact", upload.split("@")[1]]);
    expect(upload).toBe("actions/upload-artifact@v4");
  });

  it("checks SHA256SUMS against the files, from a fixed list of names, before any git command", () => {
    const check = pubSteps.at(1) as Step;
    const push = pubSteps.at(2) as Step;
    expect(check.id).toBe("check");
    expect(check.run).not.toMatch(/\bgit\b/);
    // The names come from one fixed list, the same the reader contract holds.
    expect(check.run).toContain(`files=(${PUBLISHED_FILES.join(" ")})\n`);
    expect(push.run).toContain(`files=(${PUBLISHED_FILES.join(" ")} SHA256SUMS)\n`);
    expect(check.run).toContain('sha256sum -- "${present[@]}" | cmp -s - SHA256SUMS');
    expect(check.run).toContain('[ "$(find . -mindepth 1 -printf x | wc -c)" -eq "$((${#present[@]} + 1))" ]');
    expect(check.run).toMatch(/^set -euo pipefail\n/);
    expect(push.if).toBe("${{ steps.check.outputs.publish == 'true' }}");
    // Every read of what a file holds comes after the sums.
    const lines = code(check.run);
    const reads = ["jq ", "date ", "wc -l", "tail ", "cat ", "grep "].map((w) => lines.indexOf(w)).filter((i) => i >= 0);
    expect(reads.length).toBeGreaterThan(0);
    expect(lines.indexOf("cmp -s - SHA256SUMS")).toBeGreaterThan(0);
    expect(lines.indexOf("cmp -s - SHA256SUMS")).toBeLessThan(Math.min(...reads));
  });

  it("takes no value from the reading into a shell command but through quoted variables the check validated", () => {
    for (const s of pubSteps) expect(s.run ?? "", s.name).not.toContain("${{");
    const push = pubSteps.at(2) as Step;
    expect(push.env).toEqual({
      PUSH_TOKEN: "${{ github.token }}",
      OBSERVED_AT: "${{ steps.check.outputs.observed_at }}",
      SNAPSHOT_HASH: "${{ steps.check.outputs.snapshot_hash }}",
      DAY: "${{ steps.check.outputs.day }}",
      PREV_HASH: "${{ steps.check.outputs.prev_hash }}",
      EXIT_CODE: "${{ steps.check.outputs.exit_code }}",
    });
    for (const v of ["OBSERVED_AT", "SNAPSHOT_HASH", "DAY", "PREV_HASH", "EXIT_CODE", "PUSH_TOKEN"]) {
      // Each one only inside double quotes.
      const bare = shell.split("\n").filter((l) => l.replace(/"[^"]*"/g, "").includes(`$${v}`));
      expect(bare, v).toEqual([]);
    }
    const check = pubSteps.at(1)?.run ?? "";
    expect(check).toContain('[[ "$observed_at" =~ $iso ]]');
    expect(check).toContain('[[ "$hash" =~ $hex ]]');
    expect(check).toContain('[[ "$day" =~ $ymd ]]');
    expect(check).toContain('[[ "$seq" =~ ^(0|[1-9][0-9]{0,15})$ ]]');
    expect(check).toContain('{ [[ "$prev" =~ $hex ]] || { [ "$prev" = null ] && [ "$seq" = 0 ]; }; } || fail');
    // The token is in the publish step's env and nowhere else.
    expect(text.split("github.token").length).toBe(2);
  });

  it("appends a line only when it follows the branch's last line, read from the files alone, and pushes nothing otherwise", () => {
    const check = code(pubSteps.at(1)?.run);
    const push = code(pubSteps.at(2)?.run);
    // The line appended is the snapshot's, and it names the line it follows.
    expect(check).toContain(`[ "$(jq -r '.hash' snapshots.jsonl)" = "$hash" ] || fail "snapshots.jsonl holds another snapshot"`);
    expect(check).toContain(`prev="$(jq -r '.prev_hash' snapshots.jsonl)"`);
    // The branch's last line: the last line of the last day file, in byte order.
    expect(push).toContain("export LC_ALL=C\n");
    expect(push).toContain('for f in log/*.jsonl; do if [ -f "$f" ]; then lastday="$f"; fi; done');
    expect(push).toContain(`last="$(tail -n 1 -- "$lastday" | jq -r '.hash')"`);
    expect(push).toContain("[[ \"$last\" =~ ^[0-9a-f]{64}$ ]] || {");
    // No day file at all: only a line that starts a log may be appended.
    expect(push).toMatch(/^\s*last=null$/m);
    const refuse = 'if [ "$PREV_HASH" != "$last" ]; then';
    const day = 'if [[ "log/$DAY.jsonl" < "$lastday" ]]; then';
    const append = 'cat -- "$reading/snapshots.jsonl" >>"log/$DAY.jsonl"';
    const laid = 'for f in "${files[@]}"; do cp -- "$reading/$f" "latest/$f"; done';
    for (const t of [refuse, day]) {
      const at = push.indexOf(t);
      expect(at, t).toBeGreaterThan(0);
      // Each refusal fails the job before anything is laid down, so nothing is committed or pushed.
      const block = push.slice(at).split("\n");
      expect(block.slice(0, block.findIndex((l) => l.trim() === "fi")).map((l) => l.trim()), t).toContain("exit 1");
      expect(at, t).toBeLessThan(push.indexOf(laid));
      expect(at, t).toBeLessThan(push.indexOf(append));
    }
    expect(push.indexOf(append)).toBeLessThan(push.indexOf("git commit"));
    // A reading already in the day's log is not laid down again: latest/ may hold a newer one.
    const again = 'if [ -f "log/$DAY.jsonl" ] && grep -qxF -f "$reading/snapshots.jsonl" "log/$DAY.jsonl"; then return 0; fi';
    expect(push).toContain(again);
    expect(push.indexOf(again)).toBeLessThan(push.indexOf(refuse));
  });

  it("refuses a fetched branch that holds anything but plain files, from its tree alone, before anything is read or written", () => {
    const push = code(pubSteps.at(2)?.run);
    const tree = 'tree="$(git ls-tree -r --full-tree HEAD)"';
    const reset = "git reset -q --hard FETCH_HEAD";
    const at = push.indexOf(tree);
    expect(at).toBeGreaterThan(push.indexOf(reset));
    const block = push.slice(at).split("\n");
    const end = block.findIndex((l) => l.trim() === "fi");
    expect(block[1]).toMatch(/^\s*if \[ -n "\$tree" \] && grep -qv '.*' <<<"\$tree"; then$/);
    expect(block.slice(0, end).map((l) => l.trim())).toContain("exit 1");
    // Before the rerun check, the last line, and anything laid down.
    for (const later of ['grep -qxF -f "$reading/snapshots.jsonl"', "for f in log/*.jsonl", "rm -rf latest", "git commit"]) expect(at, later).toBeLessThan(push.indexOf(later));
  });

  it("lays out latest/, log/<UTC date>.jsonl and README.md, and nothing else", () => {
    const push = pubSteps.at(2)?.run ?? "";
    expect(push).toContain("rm -rf latest\n");
    expect(push).toContain('for f in "${files[@]}"; do cp -- "$reading/$f" "latest/$f"; done');
    expect(push).toContain('cat -- "$reading/snapshots.jsonl" >>"log/$DAY.jsonl"');
    expect(push).toContain("if [ ! -f README.md ]; then");
    expect(push).toContain("git add -A -- latest log README.md");
  });

  it("pushes with one explicit refspec to the data branch only, never forces, and retries once", () => {
    const pushes = shell.split("\n").filter((l) => /\bgit\b.*\bpush\b/.test(l)).map((l) => l.trim());
    expect(pushes).toEqual([`if git push "$remote" ${REF}:${REF}; then exit 0; fi`, `git push "$remote" ${REF}:${REF}`]);
    expect(text).not.toMatch(/--force|--mirror|--all\b|--tags|--delete|--prune|\+refs\/|push -f|\s-f\s.*push/);
    // A fresh fetch of the branch for each try, and two tries at most.
    expect(shell.match(/^prepare \d$/gm)).toEqual(["prepare 1", "prepare 2"]);
    expect(shell).toContain(`git ls-remote --exit-code "$remote" ${REF}`);
    expect(shell).toContain(`git fetch -q --depth=1 "$remote" ${REF}`);
    // A branch that does not exist starts as an orphan: a new repository on it, no parent.
    expect(shell).toContain('git init -q -b observatory-data "$work"');
  });

  it("commits as the GitHub Actions bot, with the reading's observed_at and snapshot hash", () => {
    expect(shell).toContain('git config user.name "github-actions[bot]"');
    expect(shell).toContain('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
    expect(shell).toContain('git commit -q -m "observatory-data: reading at $OBSERVED_AT" -m "snapshot $SNAPSHOT_HASH"');
  });

  it("leaves the run red when the live job failed: nothing continues on error", () => {
    expect(text).not.toMatch(/continue-on-error/);
  });
});
