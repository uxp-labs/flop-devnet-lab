// The record workflow read as data: what it may do, and the things it must never do. This holds its
// text to the rules RULES.md sections 4 and 8 and the README give it. The publish job's two shell
// steps are also run, against a local bare repository, in test/publish-shell.test.ts, beside the
// live workflow's.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { RECORDING_FILES } from "../src/recording.js";

const WORKFLOWS = new URL("../../.github/workflows/", import.meta.url);
const text = readFileSync(new URL("observatory-record.yml", WORKFLOWS), "utf8");
const wf = parse(text) as Record<string, unknown>;
const live = parse(readFileSync(new URL("observatory-live.yml", WORKFLOWS), "utf8")) as Record<string, unknown>;
const check = parse(readFileSync(new URL("observatory-check.yml", WORKFLOWS), "utf8")) as Record<string, unknown>;

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; "working-directory"?: string };
type Job = Record<string, unknown> & { steps: Step[] };
const jobs = wf.jobs as Record<string, Job>;
const job = jobs.record as Job;
const steps = job.steps;
const liveJobs = live.jobs as Record<string, Job>;
const checkSteps = ((check.jobs as Record<string, Job>).check as Job).steps;
/** Text without its comment lines. */
const code = (s: string | undefined) => (s ?? "").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
const body = code(text);
const publishAt = text.indexOf("\n  publish:\n");
const unpublished = code(publishAt < 0 ? text : text.slice(0, publishAt));
const REF = "refs/heads/observatory-data";

/** The record sources: a push that changes one gives a smoke run. */
const RECORD_MODULES = ["feed", "files", "guard", "net", "net-root", "own", "record-bin", "record-run", "requests", "run-command", "store", "strict", "sums", "tape", "transport", "types"];
const RECORD_FILES = RECORD_MODULES.map((f) => `observatory/src/${f}.ts`);

describe("the record workflow", () => {
  it("runs by hand, and on a push that changes it, the request list or a record source file", () => {
    expect(wf.on).toEqual({ workflow_dispatch: null, push: { paths: [".github/workflows/observatory-record.yml", "observatory/recordings/requests.json", ...RECORD_FILES] } });
  });

  it("names every src module the record command is built from, by its imports, and no other", () => {
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const src = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
      for (const m of src.matchAll(/^import [^;]*? from "\.\/([a-z-]+)\.js";$/gm)) visit(m[1] as string);
    };
    visit("record-bin");
    expect([...seen].sort()).toEqual(RECORD_MODULES);
  });

  it("may read the repository and nothing else, in one group that never cancels a run", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(wf.concurrency).toEqual({ group: "observatory-record", "cancel-in-progress": false });
    expect(job["timeout-minutes"]).toBe(25);
  });

  it("checks out without credentials, on the live job's and the offline check's Node version, and installs as the live job does", () => {
    expect(steps.map((s) => s.uses ?? s.run)).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "npm ci --ignore-scripts --no-audit --no-fund",
      "npm run build",
      'node dist/record-bin.js --requests recordings/requests.json --out "$RUNNER_TEMP/observatory-record" --source-sha "$GITHUB_SHA"',
      "actions/upload-artifact@v4",
    ]);
    expect(steps.at(0)?.with).toEqual({ "persist-credentials": false });
    const liveSteps = (liveJobs.live as Job).steps;
    expect(steps.at(1)?.with).toEqual(liveSteps.find((s) => s.uses === "actions/setup-node@v4")?.with);
    expect(steps.at(1)?.with).toEqual(checkSteps.find((s) => s.uses?.startsWith("actions/setup-node"))?.with);
    for (const s of steps.slice(2, 5)) expect(s["working-directory"]).toBe("observatory");
    expect(liveSteps.map((s) => s.run)).toContain(steps.at(2)?.run);
    const pinned = new Set(checkSteps.map((s) => s.uses).filter((u) => u !== undefined));
    for (const s of [...steps, ...(jobs.publish as Job).steps]) if (s.uses !== undefined && s.uses !== "actions/download-artifact@v4") expect(pinned, s.uses).toContain(s.uses);
  });

  it("uploads the output folder, also when the command failed, and says by its id that it did", () => {
    const up = steps.at(-1) as Step;
    expect(up.id).toBe("upload");
    expect(up.if).toBe("${{ !cancelled() }}");
    expect(up.with).toEqual({ name: "observatory-record-${{ github.run_id }}-${{ github.run_attempt }}", path: "${{ runner.temp }}/observatory-record", "retention-days": 14, "if-no-files-found": "error" });
    expect(job.outputs).toEqual({ "artifact-id": "${{ steps.upload.outputs.artifact-id }}" });
  });

  it("never uses a secret, a cache, pull_request_target, an issue or a comment, and the record job never pushes or holds a token", () => {
    expect(body).not.toMatch(/secrets/);
    expect(body).not.toMatch(/pull_request_target|actions\/cache|\bcache\b/);
    expect(body).not.toMatch(/\bgh\s|curl|wget|issues|comments|POST/);
    expect(unpublished).toContain("\n  record:\n");
    expect(unpublished).not.toMatch(/github\.token|GITHUB_TOKEN|git push|write/);
    for (const s of steps) expect(Object.keys(s).sort(), s.name).not.toContain("env");
    expect(text).not.toMatch(/continue-on-error/);
  });
});

const publish = jobs.publish as Job;
const pubSteps = publish.steps;
const shell = code(pubSteps.map((s) => s.run ?? "").join("\n"));

/** The publish job's condition as a function of what GitHub gives it. */
function condition(): (c: { ref: string; result: string; artifactId: string }) => boolean {
  const expr = String(publish.if ?? "")
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/github\.ref\b/g, "c.ref")
    .replace(/needs\.record\.result\b/g, "c.result")
    .replace(/needs\.record\.outputs\.artifact-id\b/g, "c.artifactId")
    .replace(/==/g, "===")
    .replace(/!===/g, "!==");
  // Nothing but those three names, quoted words and logic: no other context, and no status
  // function, so GitHub's own success() holds too.
  expect(expr.replace(/'[^']*'/g, "").replace(/c\.(ref|result|artifactId)/g, "")).toMatch(/^[\s()!&|=]*$/);
  return new Function("c", `return (${expr});`) as (c: { ref: string; result: string; artifactId: string }) => boolean;
}

describe("the publish job", () => {
  it("is the only job besides the record job, and may write contents only", () => {
    expect(Object.keys(jobs)).toEqual(["record", "publish"]);
    expect(publish.permissions).toEqual({ contents: "write" });
    expect(publish.needs).toBe("record");
  });

  it("is, with the live workflow's publish job, the only job in the repository that may write anything", () => {
    const writers: string[] = [];
    for (const f of readdirSync(WORKFLOWS).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort()) {
      const w = parse(readFileSync(new URL(f, WORKFLOWS), "utf8")) as { permissions?: unknown; jobs: Record<string, { permissions?: unknown }> };
      const writes = (p: unknown) => p === "write-all" || (p !== null && typeof p === "object" && Object.values(p).includes("write"));
      expect(writes(w.permissions) || w.permissions === undefined ? f : null, `${f} sets read permissions at the top`).toBeNull();
      for (const [name, j] of Object.entries(w.jobs)) if (writes(j.permissions)) writers.push(`${f} ${name} ${JSON.stringify(j.permissions)}`);
    }
    expect(writers).toEqual(['observatory-live.yml publish {"contents":"write"}', 'observatory-record.yml publish {"contents":"write"}']);
  });

  it("runs for main only, when the record job exited 0 and uploaded its folder", () => {
    const run = condition();
    const main = { ref: "refs/heads/main", result: "success", artifactId: "123" };
    expect(run(main)).toBe(true);
    expect(run({ ...main, result: "failure" })).toBe(false);
    expect(run({ ...main, result: "cancelled" })).toBe(false);
    expect(run({ ...main, result: "skipped" })).toBe(false);
    expect(run({ ...main, artifactId: "" })).toBe(false);
    expect(run({ ...main, ref: "refs/heads/claude/observatory-record" })).toBe(false);
    expect(run({ ...main, ref: "refs/heads/observatory-data" })).toBe(false);
    expect(run({ ...main, ref: "refs/tags/main" })).toBe(false);
    expect(String(publish.if)).not.toMatch(/event|always\(\)|failure\(\)|cancelled\(\)/);
  });

  it("runs no code from the repository: no checkout, no install, no build, no node, no script", () => {
    expect(pubSteps.map((s) => s.uses ?? s.name)).toEqual(["actions/download-artifact@v4", "Check the files against SHA256SUMS", "Publish to observatory-data"]);
    expect(JSON.stringify(publish)).not.toMatch(/checkout|setup-node|working-directory/);
    expect(shell).not.toMatch(/\b(npm|npx|node|yarn|pnpm|tsc|python3?|bash|sh|source|eval|exec|date)\s|(^|[\s"'])\.{1,2}\/|GITHUB_WORKSPACE|github\.workspace/m);
  });

  it("downloads this run's artifact, by the id the record job gave, into a fixed folder, with the live job's pinned action", () => {
    expect(pubSteps.at(0)?.with).toEqual({ "artifact-ids": "${{ needs.record.outputs.artifact-id }}", "merge-multiple": true, path: "${{ runner.temp }}/recording" });
    expect(pubSteps.at(0)?.uses).toBe((liveJobs.publish as Job).steps.at(0)?.uses);
  });

  it("checks the artifact holds exactly the recording's files, and SHA256SUMS against them, before anything reads a file or runs git", () => {
    const c = pubSteps.at(1) as Step;
    expect(c.id).toBe("check");
    expect(c.run).toMatch(/^set -euo pipefail\n/);
    expect(c.run).not.toMatch(/\bgit\b/);
    expect(c.run).toContain(`files=(${RECORDING_FILES.join(" ")})\n`);
    expect(pubSteps.at(2)?.run).toContain(`files=(${RECORDING_FILES.join(" ")} SHA256SUMS)\n`);
    expect(c.run).toContain('sha256sum -- "${files[@]}" | cmp -s - SHA256SUMS || fail "a file differs from SHA256SUMS"');
    expect(c.run).toContain('[ "$(find . -mindepth 1 -printf x | wc -c)" -eq "$((${#files[@]} + 1))" ]');
    const lines = code(c.run);
    const sums = lines.indexOf("cmp -s - SHA256SUMS");
    const reads = ["jq ", "cat ", "grep ", "head ", "tail "].map((w) => lines.indexOf(w)).filter((i) => i >= 0);
    expect(reads.length).toBeGreaterThan(0);
    expect(sums).toBeGreaterThan(0);
    expect(sums).toBeLessThan(Math.min(...reads));
    expect(c.run).toContain(`jq -e '.exit_code == 0' run.json >/dev/null || fail`);
  });

  it("builds the recording's id from validated values only, and takes every value into the shell through quoted variables", () => {
    const c = pubSteps.at(1)?.run ?? "";
    expect(c).toContain("utc='^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\\.[0-9]{3}Z$'");
    expect(c).toContain('[[ "$started_at" =~ $utc ]] || fail');
    expect(c).toContain('stamp="${BASH_REMATCH[1]}${BASH_REMATCH[2]}${BASH_REMATCH[3]}${BASH_REMATCH[4]}${BASH_REMATCH[5]}${BASH_REMATCH[6]}"');
    expect(c).toContain('[[ "$list_sha" =~ ^[0-9a-f]{64}$ ]] || fail');
    expect(c).toContain('id="$stamp-${list_sha:0:16}"');
    expect(c).toContain('[[ "$id" =~ ^[0-9]{14}-[0-9a-f]{16}$ ]] || fail');
    for (const s of pubSteps) expect(s.run ?? "", s.name).not.toContain("${{");
    const push = pubSteps.at(2) as Step;
    expect(push.env).toEqual({
      PUSH_TOKEN: "${{ github.token }}",
      RECORDING_ID: "${{ steps.check.outputs.id }}",
      STARTED_AT: "${{ steps.check.outputs.started_at }}",
      REQUEST_LIST_SHA256: "${{ steps.check.outputs.request_list_sha256 }}",
      ASKED: "${{ steps.check.outputs.asked }}",
      ANSWERED: "${{ steps.check.outputs.answered }}",
      FAILED: "${{ steps.check.outputs.failed }}",
    });
    for (const v of Object.keys(push.env ?? {})) {
      const bare = shell.split("\n").filter((l) => l.replace(/"[^"]*"/g, "").includes(`$${v}`));
      expect(bare, v).toEqual([]);
    }
    // Checked again where it names the one path written.
    expect(push.run).toContain('[[ "$RECORDING_ID" =~ ^[0-9]{14}-[0-9a-f]{16}$ ]] || {');
    expect(push.run).toContain('dest="recordings/$RECORDING_ID"\n');
    expect(text.split("github.token").length).toBe(2);
  });

  it("refuses a fetched branch that holds anything but plain files with the live job's own check, before anything is read or written", () => {
    const push = code(pubSteps.at(2)?.run);
    const livePush = code((liveJobs.publish as Job).steps.at(2)?.run);
    const block = (s: string) => {
      const from = s.indexOf('if [ "$found" -eq 0 ]; then');
      return from < 0 ? "" : s.slice(from, s.indexOf("changed=no", from));
    };
    expect(block(push).length).toBeGreaterThan(200);
    expect(block(push)).toBe(block(livePush));
    expect(push.indexOf('tree="$(git ls-tree -r --full-tree HEAD)"')).toBeLessThan(push.indexOf('if [ -e "$dest" ]'));
  });

  it("writes recordings/<id>/ only, and only when nothing is at that path", () => {
    const push = code(pubSteps.at(2)?.run);
    const immutable = 'if [ -e "$dest" ]; then return 0; fi';
    expect(push).toContain(immutable);
    for (const later of ['mkdir -p -- "$dest"', 'for f in "${files[@]}"; do cp -- "$recording/$f" "$dest/$f"; done', 'git add -- "$dest"', "git commit"]) {
      expect(push.indexOf(later), later).toBeGreaterThan(push.indexOf(immutable));
    }
    expect(push).toContain('echo "observatory-data already holds $dest, and a recording is immutable: nothing is changed"');
    // Nothing else is laid down, staged or removed.
    expect(push).not.toMatch(/latest|\blog\/|README|rm -|git rm|git add -A|git add \.|>>|mv /);
    expect(push.match(/\bgit add\b.*/g)).toEqual(['git add -- "$dest"']);
  });

  it("pushes with one explicit refspec to the data branch only, never forces, and retries once on a fresh fetch", () => {
    const pushes = shell.split("\n").filter((l) => /\bgit\b.*\bpush\b/.test(l)).map((l) => l.trim());
    expect(pushes).toEqual([`if git push "$remote" ${REF}:${REF}; then exit 0; fi`, `git push "$remote" ${REF}:${REF}`]);
    expect(text).not.toMatch(/--force|--mirror|--all\b|--tags|--delete|--prune|\+refs\/|push -f|\s-f\s.*push/);
    expect(shell.match(/^prepare \d$/gm)).toEqual(["prepare 1", "prepare 2"]);
    expect(shell).toContain(`git fetch -q --depth=1 "$remote" ${REF}`);
    expect(shell).toContain('git init -q -b observatory-data "$work"');
  });

  it("commits as the GitHub Actions bot, naming the recording, its start, its list and its counts", () => {
    expect(shell).toContain('git config user.name "github-actions[bot]"');
    expect(shell).toContain('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
    expect(shell).toContain('git commit -q -m "observatory-data: recording $RECORDING_ID" -m "started $STARTED_AT, request list $REQUEST_LIST_SHA256"');
  });

  it("shares no concurrency group with the live workflow's publish job: their pushes are kept apart by fast forwards and one retry", () => {
    expect(publish.concurrency).toBeUndefined();
    expect((liveJobs.publish as Job).concurrency).toBeUndefined();
    expect(live.concurrency).toEqual({ group: "observatory-live", "cancel-in-progress": false });
    expect(wf.concurrency).not.toEqual(live.concurrency);
  });
});
