// The publish jobs' shell, run (memory review, and the recorder). test/live-workflow.test.ts and
// test/record-workflow.test.ts read the workflows as text; this runs the two run: blocks of each
// publish job, "Check the files against SHA256SUMS" and "Publish to observatory-data", taken out of
// .github/workflows/observatory-live.yml and .github/workflows/observatory-record.yml by step name
// when the test runs, so it always runs what the workflows hold. There is no copy of the shell here.
// It is the one test file that runs a shell (test/setup.ts runShell): both jobs push to the same
// branch, so the cases that show each leaves the other's files alone run both shells in one place.
//
// Each case builds real readings with the repo's own code (a live run over a tape, as
// test/memory.test.ts does), lays them out as the artifact download does, and runs the two steps
// with bash, with the environment and the step outputs the workflow passes them. The remote is a
// local bare repository: GITHUB_SERVER_URL is a file:// URL to a temp folder and GITHUB_REPOSITORY
// names a bare repository in it. git is limited to the file:// transport (test/setup.ts runShell),
// so nothing reaches the network. Each case asserts the exit codes, what the bare repository holds
// afterwards (the branch's commit, latest/, every line of log/) and that no other ref exists.
//
// bash, git, jq, sha256sum, base64, find and date must all be here: the offline check runs on a
// GitHub runner that has them, so a missing one fails every test in this file, never skips it.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readHistory } from "../src/history.js";
import { runLive } from "../src/live-run.js";
import { EXIT } from "../src/run-command.js";
import { PUBLISHED_FILES } from "../src/published.js";
import { logLine } from "../src/store.js";
import { sumsOf } from "../src/sums.js";
import { TapeTransport } from "../src/tape.js";
import { feedText } from "../src/feed.js";
import { runRecord } from "../src/record-run.js";
import { RECORDING_FILES } from "../src/recording.js";
import { REQUESTS_SCHEMA } from "../src/requests.js";
import { network } from "./helpers/answering.js";
import { anchoredAs } from "./helpers/tapes.js";
import type { Transport } from "../src/transport.js";
import type { Snapshot } from "../src/types.js";
import { runShell } from "./setup.js";

const TOOLS = ["bash", "git", "jq", "sha256sum", "base64", "find", "date"];
const REF = "refs/heads/observatory-data";
const REPOSITORY = "uxp-labs/flop-devnet-lab";
const ARTIFACT = [...PUBLISHED_FILES, "SHA256SUMS"];

// ---- The two steps of each publish job, from the workflows as they are.
type Step = { name?: string; id?: string; run?: string; if?: string; env?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps: Step[] }> };
const workflowOf = (file: string) => parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8")) as Workflow;
function step(name: string, workflow: Workflow = workflowOf("observatory-live.yml")): Step {
  const found = (workflow.jobs.publish?.steps ?? []).filter((s) => s.name === name);
  if (found.length !== 1 || typeof found[0]?.run !== "string") throw new Error(`the publish job holds no one run: step named ${JSON.stringify(name)}`);
  return found[0];
}
const CHECK = step("Check the files against SHA256SUMS");
const PUBLISH = step("Publish to observatory-data");
const RECORD = workflowOf("observatory-record.yml");
const RECORD_CHECK = step("Check the files against SHA256SUMS", RECORD);
const RECORD_PUBLISH = step("Publish to observatory-data", RECORD);

// ---- Readings, made by the repo's own code.
const FIXTURES = new URL("../fixtures/", import.meta.url);
const fixture = (dir: string, name: string) => readFileSync(new URL(`${dir}/${name}`, FIXTURES), "utf8");
const CLOCK = () => "2026-11-11T09:00:00.000Z";
const DAY = 86_400;

/**
 * A tape that says it is the network, as the live one does, with every time it gives moved by seconds.
 * Each tape was recorded before runs read an anchor back: on a log, the anchor is answered as the
 * fixture's own chain would answer it, synthetic (test/helpers/tapes.ts).
 */
function live(dir: string, seconds = 0): Transport {
  const inner = anchoredAs(dir, TapeTransport.parse(fixture(dir, "tape.jsonl"), `tape:${dir}`));
  return {
    trust: "trusted RPC",
    label: "rpc wss://rpc.devnet.flop.network",
    rpc: (m, p) => inner.rpc(m, p),
    httpGet: (u) => inner.httpGet(u),
    now: () => new Date(Date.parse(inner.now()) + seconds * 1000).toISOString(),
    close: () => inner.close(),
  };
}

let box: string;
let serial = 0;
const next = (what: string) => join(box, `${what}-${++serial}`);
const server = () => join(box, "server");
const bare = () => join(server(), `${REPOSITORY}.git`);
const remote = () => `file://${bare()}`;

interface Reading {
  out: string;
  code: number;
  snapshot: Snapshot | null;
}

/** One live run of a tape on the log folder given, into a new output folder. */
async function read(transport: Transport, log: string): Promise<Reading> {
  const out = next("out");
  const r = await runLive(transport, { out, log, sourceSha: "f".repeat(40), clock: CLOCK });
  return { out, code: r.code, snapshot: r.snapshot };
}

// ---- Shell and git.
/** git, run through bash, in the box. */
function git(...args: string[]): string {
  const r = runShell(["-c", 'git "$@"', "git", ...args], { HOME: box }, box);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} exited ${r.status}: ${r.error ?? r.stderr}`);
  return r.stdout;
}

/** What the live job reads: the branch checked out, or no folder when the branch does not exist. Returns the log/ folder. */
function checkout(): string {
  const dir = next("checkout");
  const found = runShell(["-c", 'git ls-remote --exit-code "$1" "$2" >/dev/null', "x", remote(), REF], { HOME: box }, box);
  if (found.status === 2) return join(dir, "log");
  if (found.status !== 0) throw new Error(`ls-remote exited ${found.status}: ${found.stderr}`);
  git("clone", "-q", "--depth", "1", "--branch", "observatory-data", remote(), dir);
  return join(dir, "log");
}

/** A commit not made by the job, on top of the branch (or an orphan): files written, links made, paths removed. */
function seed(files: Record<string, string>, links: Record<string, string> = {}, remove: string[] = [], index: (work: string) => void = () => {}): void {
  const work = next("seed");
  git("init", "-q", "-b", "observatory-data", work);
  const has = runShell(["-c", 'git ls-remote --exit-code "$1" "$2" >/dev/null', "x", remote(), REF], { HOME: box }, box).status === 0;
  if (has) {
    git("-C", work, "fetch", "-q", remote(), REF);
    git("-C", work, "reset", "-q", "--hard", "FETCH_HEAD");
  }
  for (const p of remove) rmSync(join(work, p), { recursive: true, force: true });
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(work, p, ".."), { recursive: true });
    writeFileSync(join(work, p), t);
  }
  for (const [p, target] of Object.entries(links)) {
    mkdirSync(join(work, p, ".."), { recursive: true });
    rmSync(join(work, p), { recursive: true, force: true });
    symlinkSync(target, join(work, p));
  }
  git("-C", work, "add", "-A");
  index(work);
  git("-C", work, "-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "commit", "-q", "-m", "seed");
  git("-C", work, "push", "-q", remote(), `${REF}:${REF}`);
}

interface Branch {
  refs: string[];
  commit: string | null;
  parents: string[];
  message: string;
  files: string[];
  latest: Record<string, string>;
  log: Record<string, string[]>;
}

/** What the bare repository holds. */
function branch(): Branch {
  const refs = git("--git-dir", bare(), "for-each-ref", "--format=%(refname)").split("\n").filter((l) => l !== "");
  if (!refs.includes(REF)) return { refs, commit: null, parents: [], message: "", files: [], latest: {}, log: {} };
  const commit = git("--git-dir", bare(), "rev-parse", REF).trim();
  const parents = git("--git-dir", bare(), "log", "-1", "--format=%P", REF).trim().split(" ").filter((p) => p !== "");
  const message = git("--git-dir", bare(), "log", "-1", "--format=%an <%ae>%n%B", REF).trim();
  const files = git("--git-dir", bare(), "ls-tree", "-r", "--name-only", REF).split("\n").filter((l) => l !== "");
  const show = (p: string) => git("--git-dir", bare(), "show", `${REF}:${p}`);
  const latest = Object.fromEntries(files.filter((f) => f.startsWith("latest/")).map((f) => [f.slice("latest/".length), show(f)]));
  const log = Object.fromEntries(files.filter((f) => f.startsWith("log/")).map((f) => [f.slice("log/".length), show(f).split("\n")]));
  return { refs, commit, parents, message, files, latest, log };
}

interface Job {
  check: { status: number | null; stdout: string; stderr: string };
  outputs: Record<string, string>;
  /** null when the publish step did not run: the check failed, or it said publish is not true. */
  publish: { status: number | null; stdout: string; stderr: string } | null;
}

/** GITHUB_OUTPUT as GitHub reads it: name=value lines. */
function outputsOf(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const o: Record<string, string> = {};
  for (const l of readFileSync(path, "utf8").split("\n")) {
    const at = l.indexOf("=");
    if (at > 0) o[l.slice(0, at)] = l.slice(at + 1);
  }
  return o;
}

/**
 * The publish job on a reading: the artifact as download-artifact lays it out in a fresh runner
 * temp folder, the check step, and the publish step when its condition holds, each with bash -e
 * (GitHub's default shell) and the environment the workflow gives it.
 */
function publishJob(r: Reading, tamper: (reading: string) => void = () => {}): Job {
  if (PUBLISH.if !== "${{ steps.check.outputs.publish == 'true' }}") throw new Error(`the publish step's condition is not the one this test evaluates: ${PUBLISH.if}`);
  return runJob(r.out, "reading", CHECK, PUBLISH, (o) => o.publish === "true", tamper);
}

/**
 * A publish job's two steps on an output folder laid out in the artifact folder the job downloads
 * into (folder, under the runner temp folder): the check step, then the publish step when the
 * check exited 0 and runs(outputs) holds, with the environment the workflow gives it, the env
 * values taken from the check step's outputs as GitHub would.
 */
function runJob(out: string, folder: string, checkStep: Step, publishStep: Step, runs: (outputs: Record<string, string>) => boolean, tamper: (dir: string) => void): Job {
  const temp = next("runner");
  const dir = join(temp, folder);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(out)) copyFileSync(join(out, f), join(dir, f));
  tamper(dir);
  const base = { HOME: temp, RUNNER_TEMP: temp, GITHUB_RUN_ID: "4242", GITHUB_SHA: "c".repeat(40) };
  writeFileSync(join(temp, "check.sh"), checkStep.run as string);
  const checkOut = join(temp, "output-check");
  const check = runShell(["-e", join(temp, "check.sh")], { ...base, GITHUB_OUTPUT: checkOut }, temp);
  const outputs = outputsOf(checkOut);
  if (check.status !== 0) return { check, outputs, publish: null };
  if (!runs(outputs)) return { check, outputs, publish: null };
  const env: Record<string, string> = { ...base, GITHUB_OUTPUT: join(temp, "output-publish"), GITHUB_SERVER_URL: `file://${server()}`, GITHUB_REPOSITORY: REPOSITORY };
  for (const [k, v] of Object.entries(publishStep.env ?? {})) {
    const m = /^\$\{\{ (?:(github\.token)|steps\.check\.outputs\.([a-z_0-9]+)) \}\}$/.exec(v);
    if (m === null) throw new Error(`the publish step's env ${k} is ${v}, which this test does not know how to give`);
    env[k] = m[1] !== undefined ? "test-token" : (outputs[m[2] as string] ?? "");
  }
  writeFileSync(join(temp, "publish.sh"), publishStep.run as string);
  const publish = runShell(["-e", join(temp, "publish.sh")], env, temp);
  return { check, outputs, publish };
}

const lines = (...rs: Reading[]) => rs.map((r) => logLine(r.snapshot as Snapshot).slice(0, -1));
/** A day file as git shows it: its lines, then the empty string after the last newline. */
const dayFile = (...rs: Reading[]) => [...lines(...rs), ""];
const filesOf = (r: Reading) => Object.fromEntries(ARTIFACT.map((f) => [f, readFileSync(join(r.out, f), "utf8")]));
const LAID = (days: string[]) => ["README.md", ...ARTIFACT.map((f) => `latest/${f}`).sort(), ...days.map((d) => `log/${d}`)].sort();
const said = (j: Job) => `${j.check.stdout}${j.check.stderr}${j.publish?.stdout ?? ""}${j.publish?.stderr ?? ""}`;

/** The job ran both steps and both exited 0. */
function published(j: Job): void {
  expect([j.check.status, j.publish?.status], said(j)).toEqual([0, 0]);
}
/** The publish step ran and failed, naming why. */
function refusedAtPublish(j: Job, why: RegExp): void {
  expect([j.check.status, j.publish?.status], said(j)).toEqual([0, 1]);
  expect(j.publish?.stdout).toMatch(why);
}

beforeAll(() => {
  // A clear failure, never a skip: every tool the shell needs, and bash itself.
  const r = runShell(["-c", 'for t in "$@"; do command -v "$t" >/dev/null || echo "$t"; done', "x", ...TOOLS.slice(1)], {}, tmpdir());
  if (r.error !== null || r.status !== 0) throw new Error(`the publish shell test needs bash, and it cannot be run here: ${r.error ?? r.stderr}`);
  const missing = r.stdout.split("\n").filter((l) => l !== "");
  if (missing.length > 0) throw new Error(`the publish shell test needs ${TOOLS.join(", ")}; missing here: ${missing.join(", ")}`);
});

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "obs-publish-shell-"));
  mkdirSync(server(), { recursive: true });
  git("init", "-q", "--bare", bare());
});
afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

describe("the publish shell, taken from the workflow", () => {
  it("finds both steps by name, with the check step's id and the publish step's condition this test evaluates", () => {
    expect(CHECK.id).toBe("check");
    expect(PUBLISH.if).toBe("${{ steps.check.outputs.publish == 'true' }}");
    expect(CHECK.run).toMatch(/^set -euo pipefail\n/);
    expect(PUBLISH.run).toMatch(/^set -euo pipefail\n/);
    for (const t of TOOLS) {
      const r = runShell(["-c", 'command -v "$1"', "x", t], {}, tmpdir());
      expect(r.status, t).toBe(0);
    }
  });
});

describe("the one exemption from the process block", () => {
  it("runs bash with git limited to file:// remotes, and refuses a server URL that is not file://", () => {
    expect(() => runShell(["-c", "true"], { GITHUB_SERVER_URL: "https://github.com" }, box)).toThrow("runShell: GITHUB_SERVER_URL must be a file:// URL, not https://github.com");
    // git refuses the transport before it opens any connection.
    const r = runShell(["-c", 'git ls-remote "$1"', "x", "https://example.invalid/x.git"], { HOME: box }, box);
    expect([r.status, r.stderr]).toEqual([128, "fatal: transport 'https' not allowed\n"]);
    // Nothing of the test process's environment but PATH reaches it, and git's limits are set.
    process.env.OBS_SHELL_SENTINEL = "leaked";
    try {
      const env = runShell(["-c", "env"], { HOME: box }, box).stdout.split("\n");
      expect(env.filter((l) => l.startsWith("OBS_"))).toEqual([]);
      for (const v of ["GIT_ALLOW_PROTOCOL=file", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", `HOME=${box}`]) expect(env).toContain(v);
    } finally {
      delete process.env.OBS_SHELL_SENTINEL;
    }
  });
});

describe("readings that follow the branch", () => {
  it("a first reading on no branch starts it as an orphan: latest/, one line in log/<UTC date>.jsonl and README.md", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    expect([r1.code, r1.snapshot?.seq, r1.snapshot?.prev_hash]).toEqual([EXIT.ok, 0, null]);
    const j = publishJob(r1);
    published(j);
    expect(j.outputs).toEqual({
      publish: "true",
      observed_at: r1.snapshot?.observed_at,
      snapshot_hash: r1.snapshot?.hash,
      day: "2026-11-11",
      prev_hash: "null",
      exit_code: "0",
    });
    const b = branch();
    expect(b.refs).toEqual([REF]);
    expect(b.parents).toEqual([]);
    expect(b.message).toBe(
      `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>\nobservatory-data: reading at ${r1.snapshot?.observed_at}\n\nsnapshot ${r1.snapshot?.hash}\n\nexit code 0, run 4242, revision ${"c".repeat(40)}`,
    );
    expect(b.files).toEqual(LAID(["2026-11-11.jsonl"]));
    expect(b.latest).toEqual(filesOf(r1));
    expect(b.log).toEqual({ "2026-11-11.jsonl": dayFile(r1) });
  });

  it("a second reading that follows the first is appended to the same day file, on top of the first commit", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const first = branch();
    const r2 = await read(live("published-2026-11-11-0823"), checkout());
    expect([r2.code, r2.snapshot?.seq, r2.snapshot?.prev_hash]).toEqual([EXIT.ok, 1, r1.snapshot?.hash]);
    published(publishJob(r2));
    const b = branch();
    expect(b.refs).toEqual([REF]);
    expect(b.parents).toEqual([first.commit]);
    expect(b.files).toEqual(LAID(["2026-11-11.jsonl"]));
    expect(b.latest).toEqual(filesOf(r2));
    expect(b.log).toEqual({ "2026-11-11.jsonl": dayFile(r1, r2) });
    expect(readHistory(checkout()).state).toBe("read");
  });

  it("a rerun of a published reading adds no commit and leaves latest/ as it is, also when latest/ holds a newer reading", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const r2 = await read(live("published-2026-11-11-0823"), checkout());
    published(publishJob(r2));
    const before = branch();
    for (const again of [r2, r1]) {
      const j = publishJob(again);
      published(j);
      expect(j.publish?.stdout).toContain("observatory-data already holds this reading");
      expect(branch()).toEqual(before);
    }
    expect(before.latest).toEqual(filesOf(r2));
  });

  it("a reading across a UTC day change starts a new day file, and the chain goes on across it", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const r2 = await read(live("published-2026-11-11-0823", DAY), checkout());
    expect([r2.snapshot?.observed_at.slice(0, 10), r2.snapshot?.seq, r2.snapshot?.prev_hash]).toEqual(["2026-11-12", 1, r1.snapshot?.hash]);
    const j = publishJob(r2);
    published(j);
    expect(j.outputs.day).toBe("2026-11-12");
    const b = branch();
    expect(b.refs).toEqual([REF]);
    expect(b.files).toEqual(LAID(["2026-11-11.jsonl", "2026-11-12.jsonl"]));
    expect(b.log).toEqual({ "2026-11-11.jsonl": dayFile(r1), "2026-11-12.jsonl": dayFile(r2) });
    expect(b.latest).toEqual(filesOf(r2));
    const h = readHistory(checkout());
    expect([h.state, h.files, h.snapshots.map((s) => s.hash)]).toEqual(["read", ["2026-11-11.jsonl", "2026-11-12.jsonl"], [r1.snapshot?.hash, r2.snapshot?.hash]]);
  });

  it("the real two line log from before memory, followed by a chained reading", async () => {
    const real = "published-2026-11-11-0823";
    seed({ "log/2026-11-11.jsonl": fixture(real, "log/2026-11-11.jsonl"), "README.md": "# observatory-data\n" });
    const seeded = branch();
    const realLines = fixture(real, "log/2026-11-11.jsonl").split("\n");
    expect(realLines.length).toBe(3);
    const r = await read(live("memory-rpc-down"), checkout());
    const last = JSON.parse(realLines[1] as string) as Snapshot;
    expect([r.code, r.snapshot?.seq, r.snapshot?.prev_hash]).toEqual([EXIT.ok, 1, last.hash]);
    published(publishJob(r));
    const b = branch();
    expect(b.refs).toEqual([REF]);
    expect(b.parents).toEqual([seeded.commit]);
    expect(b.log).toEqual({ "2026-11-11.jsonl": [realLines[0], realLines[1], ...dayFile(r)] });
    expect(b.latest).toEqual(filesOf(r));
    // README.md is written only when it is missing.
    expect(git("--git-dir", bare(), "show", `${REF}:README.md`)).toBe("# observatory-data\n");
    expect(readHistory(checkout()).snapshots.length).toBe(3);
  });

  it("a run that exited 3 (a reset signal) is published", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const r = await read(live("memory-other-genesis"), checkout());
    expect([r.code, r.snapshot?.seq]).toEqual([EXIT.reset, 1]);
    const j = publishJob(r);
    published(j);
    expect(j.outputs.exit_code).toBe("3");
    const b = branch();
    expect(b.log).toEqual({ "2026-11-11.jsonl": dayFile(r1, r) });
    expect(b.latest).toEqual(filesOf(r));
    expect(b.message).toContain("exit code 3, run 4242");
  });

  it("a refused push is fetched again and tried once more, on the branch as it is then", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const r2 = await read(live("published-2026-11-11-0823"), checkout());
    // The server refuses the first push, and moves the branch under it by a commit that changes
    // README.md only, so its last line stays the same. A second push of the same commit would not
    // be a fast forward: only a fresh fetch, with the reading laid on top again, is taken.
    const marker = join(box, "refused-once");
    const hook = join(bare(), "hooks", "pre-receive");
    writeFileSync(
      hook,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `if [ -e "${marker}" ]; then exit 0; fi`,
        `: >"${marker}"`,
        "unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "tip=$(git rev-parse refs/heads/observatory-data)",
        "blob=$(printf '# moved\\n' | git hash-object -w --stdin)",
        "tree=$( { git ls-tree \"$tip\" | grep -v $'\\tREADME.md$'; printf '100644 blob %s\\tREADME.md\\n' \"$blob\"; } | git mktree)",
        "c=$(GIT_AUTHOR_NAME=m GIT_AUTHOR_EMAIL=m@example.invalid GIT_COMMITTER_NAME=m GIT_COMMITTER_EMAIL=m@example.invalid git commit-tree \"$tree\" -p \"$tip\" -m moved)",
        'git update-ref refs/heads/observatory-data "$c" "$tip"',
        "echo refused >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const j = publishJob(r2);
    published(j);
    expect(j.publish?.stdout).toContain("the push was refused; fetching observatory-data again and trying once more");
    const b = branch();
    const moved = git("--git-dir", bare(), "rev-parse", `${REF}~1`).trim();
    expect(git("--git-dir", bare(), "log", "-1", "--format=%s", moved).trim()).toBe("moved");
    expect(b.parents).toEqual([moved]);
    expect(git("--git-dir", bare(), "show", `${REF}:README.md`)).toBe("# moved\n");
    expect(b.log).toEqual({ "2026-11-11.jsonl": dayFile(r1, r2) });
    expect(b.latest).toEqual(filesOf(r2));
    expect(b.refs).toEqual([REF]);
  });

  it("a push refused twice fails the job, and the branch stays as it was", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const before = branch();
    const r2 = await read(live("published-2026-11-11-0823"), checkout());
    const hook = join(bare(), "hooks", "pre-receive");
    writeFileSync(hook, "#!/usr/bin/env bash\necho refused >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const j = publishJob(r2);
    expect([j.check.status, j.publish?.status]).toEqual([0, 1]);
    expect(branch()).toEqual(before);
  });
});

describe("readings that do not follow the branch are refused, and nothing is pushed", () => {
  it("a reading built on a branch that has moved since", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const log = checkout();
    // Two runs read the same branch; the first to publish moves it.
    const a = await read(live("memory-stuck"), log);
    const b = await read(live("published-2026-11-11-0823"), log);
    expect([a.snapshot?.prev_hash, b.snapshot?.prev_hash]).toEqual([r1.snapshot?.hash, r1.snapshot?.hash]);
    published(publishJob(a));
    const moved = branch();
    refusedAtPublish(publishJob(b), /the reading follows a line that is not the last line of observatory-data/);
    expect(branch()).toEqual(moved);
    expect(moved.log).toEqual({ "2026-11-11.jsonl": dayFile(r1, a) });
  });

  it("a first run's line (seq 0) on a log that already holds lines", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const before = branch();
    const fresh = await read(live("published-2026-11-11-0823"), join(box, "no-log"));
    expect([fresh.snapshot?.seq, fresh.snapshot?.prev_hash]).toEqual([0, null]);
    refusedAtPublish(publishJob(fresh), /the reading follows a line that is not the last line of observatory-data/);
    expect(branch()).toEqual(before);
  });

  it("a reading whose UTC day is before the log's last day file", async () => {
    // A first reading a day later than the second: a clock that went back between them.
    const r1 = await read(live("published-2026-11-11-0808", DAY), checkout());
    published(publishJob(r1));
    const before = branch();
    expect(Object.keys(before.log)).toEqual(["2026-11-12.jsonl"]);
    const r2 = await read(live("published-2026-11-11-0823"), checkout());
    // The live run sees the time go back (a conflict, exit 3), and its line follows the last one.
    expect([r2.code, r2.snapshot?.prev_hash]).toEqual([EXIT.reset, r1.snapshot?.hash]);
    const j = publishJob(r2);
    expect(j.outputs.day).toBe("2026-11-11");
    refusedAtPublish(j, /the reading's UTC day is before the log's last day file/);
    expect(branch()).toEqual(before);
  });
});

describe("an artifact the check refuses: the publish step never runs and nothing is pushed", () => {
  /** A branch with one reading, and the next reading, which follows it. */
  async function onBranch(): Promise<{ before: Branch; next: Reading }> {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const next = await read(live("published-2026-11-11-0823"), checkout());
    return { before: branch(), next };
  }
  function refusedAtCheck(j: Job, why: string): void {
    expect([j.check.status, j.publish], said(j)).toEqual([1, null]);
    expect(j.check.stdout).toContain(`::error::${why}`);
    expect(j.outputs.publish).toBeUndefined();
  }

  it("an extra file, an extra hidden file, and a folder", async () => {
    const { before, next } = await onBranch();
    for (const extra of [(d: string) => writeFileSync(join(d, "notes.txt"), "x"), (d: string) => writeFileSync(join(d, ".hidden"), "x"), (d: string) => mkdirSync(join(d, "sub"))]) {
      refusedAtCheck(publishJob(next, extra), "the artifact holds something that is not on the list");
      expect(branch()).toEqual(before);
    }
  });

  it("a missing file", async () => {
    const { before, next } = await onBranch();
    refusedAtCheck(
      publishJob(next, (d) => unlinkSync(join(d, "status.json"))),
      "a file differs from SHA256SUMS",
    );
    refusedAtCheck(
      publishJob(next, (d) => unlinkSync(join(d, "SHA256SUMS"))),
      "the artifact holds no SHA256SUMS or no file it lists",
    );
    expect(branch()).toEqual(before);
  });

  it("a file that is a symlink to the same bytes", async () => {
    const { before, next } = await onBranch();
    for (const name of ["status.json", "SHA256SUMS"]) {
      const j = publishJob(next, (d) => {
        const away = join(d, "..", `away-${name}`);
        cpSync(join(d, name), away);
        unlinkSync(join(d, name));
        symlinkSync(away, join(d, name));
      });
      refusedAtCheck(j, name === "SHA256SUMS" ? "the artifact holds no SHA256SUMS or no file it lists" : "the artifact holds something that is not on the list");
      expect(branch()).toEqual(before);
    }
  });

  it.each(ARTIFACT)("a changed byte in %s", async (name) => {
    const { before, next } = await onBranch();
    const j = publishJob(next, (d) => {
      const bytes = readFileSync(join(d, name));
      const at = Math.floor(bytes.length / 2);
      bytes[at] = (bytes[at] as number) ^ 0x01;
      writeFileSync(join(d, name), bytes);
    });
    refusedAtCheck(j, "a file differs from SHA256SUMS");
    expect(branch()).toEqual(before);
  });

  it.each([
    ["an observed_at that runs on to another line", "snapshot.json", (t: string) => JSON.stringify({ ...JSON.parse(t), observed_at: `${JSON.parse(t).observed_at}\nday=../x` }), "snapshot.json holds no observed_at in the written form"],
    ["an observed_at that starts with a dash", "snapshot.json", (t: string) => JSON.stringify({ ...JSON.parse(t), observed_at: "-d now" }), "snapshot.json holds no observed_at in the written form"],
    ["a prev_hash that is null on a line with seq 1", "snapshots.jsonl", (t: string) => t.replace(/"prev_hash":"[0-9a-f]{64}"/, '"prev_hash":null'), "snapshots.jsonl holds no prev_hash in the written form"],
    ["a prev_hash that is an option", "snapshots.jsonl", (t: string) => t.replace(/"prev_hash":"[0-9a-f]{64}"/, '"prev_hash":"-rf"'), "snapshots.jsonl holds no prev_hash in the written form"],
    ["a seq with a leading zero", "snapshots.jsonl", (t: string) => t.replace(/"seq":1,/, '"seq":"01",'), "snapshots.jsonl holds no seq in the written form"],
    ["two lines in snapshots.jsonl", "snapshots.jsonl", (t: string) => t + t, "snapshots.jsonl is not one whole line"],
  ] as const)("an artifact whose SHA256SUMS was written again around %s", async (_what, name, edit, why) => {
    const { before, next } = await onBranch();
    const j = publishJob(next, (d) => {
      const was = readFileSync(join(d, name), "utf8");
      expect(edit(was)).not.toBe(was);
      writeFileSync(join(d, name), edit(was));
      writeFileSync(join(d, "SHA256SUMS"), sumsOf(PUBLISHED_FILES.map((n) => [n, readFileSync(join(d, n))] as const)));
    });
    refusedAtCheck(j, why);
    expect(branch()).toEqual(before);
  });

  it("a run.json with exit code 1 publishes nothing, and the job ends well", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const before = branch();
    // A log the live run refuses: it reads nothing, writes no snapshot and exits 1.
    const log = checkout();
    writeFileSync(join(log, "notes.txt"), "x");
    const r = await read(live("published-2026-11-11-0823"), log);
    expect([r.code, readdirSync(r.out).sort()]).toEqual([EXIT.crashed, ["SHA256SUMS", "run.json", "tape.jsonl"]]);
    const j = publishJob(r);
    expect([j.check.status, j.publish, j.outputs]).toEqual([0, null, { publish: "false" }]);
    expect(j.check.stdout).toContain("nothing is published");
    expect(branch()).toEqual(before);
  });
});

describe("a log moved aside by hand (README: to start a new log on purpose)", () => {
  it("the next run finds no log, starts at seq 0, and the job starts log/ again on top of the branch", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    seed({ "archive/log-1/2026-11-11.jsonl": dayFile(r1).join("\n") }, {}, ["log"]);
    const moved = branch();
    const r = await read(live("published-2026-11-11-0823"), checkout());
    expect([r.code, r.snapshot?.seq, r.snapshot?.prev_hash]).toEqual([EXIT.ok, 0, null]);
    published(publishJob(r));
    const b = branch();
    expect(b.parents).toEqual([moved.commit]);
    expect(b.log).toEqual({ "2026-11-11.jsonl": dayFile(r) });
    expect(b.files).toContain("archive/log-1/2026-11-11.jsonl");
  });
});

// Branch states found by the memory review: a day file with no line, entries the job never writes,
// and a last line dated after the real clock (RULES.md sections 7 and 7.1).
describe("a branch the live run or the job refuses, and a log dated past the clock", () => {
  it("a day file with no line is refused by the live run: it reads nothing, writes no snapshot, and nothing reaches the branch", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    seed({ "log/2026-11-12.jsonl": "" });
    const before = branch();
    const log = checkout();
    const h = readHistory(log);
    expect([h.state, h.detail]).toEqual(["unreadable", "2026-11-12.jsonl holds no line"]);
    const r = await read(live("published-2026-11-11-0823"), log);
    expect([r.code, r.snapshot, readdirSync(r.out).sort()]).toEqual([EXIT.crashed, null, ["SHA256SUMS", "run.json", "tape.jsonl"]]);
    const j = publishJob(r);
    expect([j.check.status, j.publish, j.outputs]).toEqual([0, null, { publish: "false" }]);
    expect(branch()).toEqual(before);
  });

  it.each([
    ["a day file that is a link into latest/", (r1: Reading) => seed({}, { "log/2026-11-11.jsonl": "../latest/snapshots.jsonl" }), "120000"],
    ["a log folder that is a link", () => seed({ "elsewhere/2026-11-11.jsonl": "x\n" }, { log: "elsewhere" }), "120000"],
    ["an executable file", () => seed({}, {}, [], (w) => git("-C", w, "update-index", "--chmod=+x", "README.md")), "100755"],
    [
      "a submodule",
      () => seed({}, {}, [], (w) => git("-C", w, "update-index", "--add", "--cacheinfo", `160000,${git("--git-dir", bare(), "rev-parse", REF).trim()},vendor`)),
      "160000",
    ],
  ] as const)("a fetched branch that holds %s is refused before anything is read or written, and nothing is pushed", async (_what, make, mode) => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    // The live run reads the branch as the job left it; then a commit not made by the job lands.
    const r2 = await read(live("published-2026-11-11-0823"), checkout());
    expect([r2.code, r2.snapshot?.prev_hash]).toEqual([EXIT.ok, r1.snapshot?.hash]);
    make(r1);
    const odd = branch();
    expect(git("--git-dir", bare(), "ls-tree", "-r", REF).split("\n").some((l) => l.startsWith(`${mode} `))).toBe(true);
    refusedAtPublish(publishJob(r2), /observatory-data holds something the job never writes/);
    expect(branch()).toEqual(odd);
    // A rerun of a published reading is refused too: the tree is checked before the log is read.
    refusedAtPublish(publishJob(r1), /observatory-data holds something the job never writes/);
    expect(branch()).toEqual(odd);
  });

  it("after a line dated past the clock, every later reading is held back by the day order check and carries a conflict, until the clock reaches that day; moving log/ aside is the way out by hand", async () => {
    const ahead = await read(live("published-2026-11-11-0808", DAY), checkout());
    published(publishJob(ahead));
    const before = branch();
    for (const tape of ["published-2026-11-11-0823", "memory-changed-hash", "memory-other-genesis"]) {
      const r = await read(live(tape), checkout());
      expect([r.code, r.snapshot?.prev_hash]).toEqual([EXIT.reset, ahead.snapshot?.hash]);
      expect(r.snapshot?.status.conflicts).toContain(`an earlier snapshot was taken at ${ahead.snapshot?.observed_at}, later than this snapshot time ${r.snapshot?.observed_at}`);
      refusedAtPublish(publishJob(r), /the reading's UTC day is before the log's last day file/);
      expect(branch()).toEqual(before);
    }
    // On that line's day, a reading still earlier than it is published, with its conflict.
    const sameDay = await read(live("published-2026-11-11-0823", DAY - 3600), checkout());
    expect([sameDay.code, sameDay.snapshot?.observed_at.slice(0, 10)]).toEqual([EXIT.reset, "2026-11-12"]);
    published(publishJob(sameDay));
    expect(branch().log).toEqual({ "2026-11-12.jsonl": dayFile(ahead, sameDay) });
    // By hand, before that: log/ moved aside, and the next run starts a new log that is published.
    seed({ "archive/log-1/2026-11-12.jsonl": dayFile(ahead, sameDay).join("\n") }, {}, ["log"]);
    const fresh = await read(live("memory-rpc-down"), checkout());
    expect([fresh.code, fresh.snapshot?.seq]).toEqual([EXIT.ok, 0]);
    published(publishJob(fresh));
    expect(branch().log).toEqual({ "2026-11-11.jsonl": dayFile(fresh) });
  });
});

// ---- The record workflow's publish job (the recorder): recordings/<id>/, immutable, beside the
// live job's latest/, log/ and README.md, each job leaving the other's files alone.

interface Recording {
  out: string;
  code: number;
  /** recordings/<id>, as the job builds it from run.json. */
  dest: string;
}

const LIST = feedText({
  schema: REQUESTS_SCHEMA,
  calls: [
    { method: "chain_getBlockHash", params: [3479329], why: "block 3479329" },
    { method: "state_getMetadata", params: [`0x${"ef".repeat(32)}`], why: "the metadata at block 3479329" },
  ],
});
const LIST_SHA = createHash("sha256").update(LIST).digest("hex");

/** One record run over the fake network, started at the time given, of the list given. */
async function recordAt(startedAt: string, list = LIST): Promise<Recording> {
  const requests = next("requests");
  writeFileSync(requests, list);
  const out = next("recording");
  const { t } = network((m) => ({ result: m === "state_getMetadata" ? "0x6d657461" : `0x${"ef".repeat(32)}` }));
  const r = await runRecord(t, { requests, out, sourceSha: "f".repeat(40), clock: () => startedAt });
  const digits = startedAt.slice(0, 19).replace(/[-T:]/g, "");
  return { out, code: r.code, dest: `recordings/${digits}-${createHash("sha256").update(list).digest("hex").slice(0, 16)}` };
}

/** The record workflow's publish job on a recording: its check step, then its publish step. */
const recordJob = (r: Recording, tamper: (dir: string) => void = () => {}): Job => {
  if (RECORD_PUBLISH.if !== undefined) throw new Error(`the record publish step has a condition this test does not evaluate: ${RECORD_PUBLISH.if}`);
  return runJob(r.out, "recording", RECORD_CHECK, RECORD_PUBLISH, () => true, tamper);
};

const RECORDED = [...RECORDING_FILES, "SHA256SUMS"];
/** Every file under recordings/ on the branch, by path, with its text. */
function recordingsOnBranch(): Record<string, string> {
  const b = branch();
  return Object.fromEntries(b.files.filter((f) => f.startsWith("recordings/")).map((f) => [f, git("--git-dir", bare(), "show", `${REF}:${f}`)]));
}
const laidAt = (r: Recording) => Object.fromEntries(RECORDED.map((f) => [`${r.dest}/${f}`, readFileSync(join(r.out, f), "utf8")]));
/** Everything on the branch but recordings/: what the live job owns. */
function liveFiles(): Record<string, string> {
  const b = branch();
  return Object.fromEntries(b.files.filter((f) => !f.startsWith("recordings/")).map((f) => [f, git("--git-dir", bare(), "show", `${REF}:${f}`)]));
}

describe("the record publish job", () => {
  it("finds both steps by name in the record workflow, each in strict mode", () => {
    expect(RECORD_CHECK.id).toBe("check");
    expect(RECORD_CHECK.run).toMatch(/^set -euo pipefail\n/);
    expect(RECORD_PUBLISH.run).toMatch(/^set -euo pipefail\n/);
  });

  it("starts the branch as an orphan holding only recordings/<id>/ when there is none, with the id built from the start time and the list's hash", async () => {
    const r = await recordAt("2026-11-11T12:34:56.789Z");
    expect([r.code, r.dest]).toEqual([EXIT.ok, `recordings/20261111123456-${LIST_SHA.slice(0, 16)}`]);
    const j = recordJob(r);
    published(j);
    expect(j.outputs).toEqual({ id: `20261111123456-${LIST_SHA.slice(0, 16)}`, started_at: "2026-11-11T12:34:56.789Z", request_list_sha256: LIST_SHA, asked: "2", answered: "2", failed: "0" });
    const b = branch();
    expect(b.refs).toEqual([REF]);
    expect(b.parents).toEqual([]);
    expect(b.files).toEqual(Object.keys(laidAt(r)).sort());
    expect(recordingsOnBranch()).toEqual(laidAt(r));
    expect(b.message).toBe(
      `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>\nobservatory-data: recording 20261111123456-${LIST_SHA.slice(0, 16)}\n\nstarted 2026-11-11T12:34:56.789Z, request list ${LIST_SHA}\n\n2 answered and 0 failed of 2 calls, run 4242, revision ${"c".repeat(40)}`,
    );
  });

  it("adds a later recording beside an earlier one, on top of its commit, and leaves the earlier one as it was", async () => {
    const r1 = await recordAt("2026-11-11T12:00:00.000Z");
    published(recordJob(r1));
    const first = branch();
    const r2 = await recordAt("2026-11-11T13:00:00.000Z");
    published(recordJob(r2));
    expect(branch().parents).toEqual([first.commit]);
    expect(recordingsOnBranch()).toEqual({ ...laidAt(r1), ...laidAt(r2) });
  });

  it("changes nothing when recordings/<id>/ is already there: the same recording again, or another one with the same id", async () => {
    const r = await recordAt("2026-11-11T12:00:00.000Z");
    published(recordJob(r));
    const before = branch();
    // Another run in the same second, of the same list, with other answers: the same id.
    const other = await recordAt("2026-11-11T12:00:00.000Z");
    writeFileSync(join(other.out, "tape.jsonl"), readFileSync(join(other.out, "tape.jsonl"), "utf8").replace("0x6d657461", "0x6d657462"));
    writeFileSync(join(other.out, "SHA256SUMS"), sumsOf(RECORDING_FILES.map((n) => [n, readFileSync(join(other.out, n))] as const)));
    for (const again of [r, other]) {
      const j = recordJob(again);
      published(j);
      expect(j.publish?.stdout).toContain(`observatory-data already holds ${r.dest}, and a recording is immutable: nothing is changed`);
      expect(branch()).toEqual(before);
      expect(recordingsOnBranch()).toEqual(laidAt(r));
    }
  });

  it("a refused push is fetched again and tried once more, on top of what the other job pushed in between", async () => {
    const r = await recordAt("2026-11-11T12:00:00.000Z");
    // The server refuses the first push and moves the branch under it by a commit of the live
    // job's kind: a new log day file. Only a fresh fetch, with the recording laid on top, is taken.
    const marker = join(box, "refused-once");
    const hook = join(bare(), "hooks", "pre-receive");
    writeFileSync(
      hook,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `if [ -e "${marker}" ]; then exit 0; fi`,
        `: >"${marker}"`,
        "unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "blob=$(printf 'a live line\\n' | git hash-object -w --stdin)",
        "sub=$(printf '100644 blob %s\\t2026-11-11.jsonl\\n' \"$blob\" | git mktree)",
        "tree=$(printf '040000 tree %s\\tlog\\n' \"$sub\" | git mktree)",
        "c=$(GIT_AUTHOR_NAME=m GIT_AUTHOR_EMAIL=m@example.invalid GIT_COMMITTER_NAME=m GIT_COMMITTER_EMAIL=m@example.invalid git commit-tree \"$tree\" -m live)",
        'git update-ref refs/heads/observatory-data "$c"',
        "echo refused >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const j = recordJob(r);
    published(j);
    expect(j.publish?.stdout).toContain("the push was refused; fetching observatory-data again and trying once more");
    const b = branch();
    expect(git("--git-dir", bare(), "log", "-1", "--format=%s", `${REF}~1`).trim()).toBe("live");
    expect(b.files).toEqual(["log/2026-11-11.jsonl", ...Object.keys(laidAt(r)).sort()]);
    expect(b.log).toEqual({ "2026-11-11.jsonl": ["a live line", ""] });
    expect(recordingsOnBranch()).toEqual(laidAt(r));
  });

  it("a push refused twice fails the job, and the branch stays as it was", async () => {
    const r1 = await recordAt("2026-11-11T12:00:00.000Z");
    published(recordJob(r1));
    const before = branch();
    const hook = join(bare(), "hooks", "pre-receive");
    writeFileSync(hook, "#!/usr/bin/env bash\necho refused >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const j = recordJob(await recordAt("2026-11-11T13:00:00.000Z"));
    expect([j.check.status, j.publish?.status]).toEqual([0, 1]);
    expect(branch()).toEqual(before);
  });

  it.each([
    ["a link", () => seed({}, { "recordings/x": "../README.md" })],
    ["an executable file", () => seed({ "notes.sh": "x" }, {}, [], (w) => git("-C", w, "update-index", "--chmod=+x", "notes.sh"))],
    ["a submodule", () => seed({}, {}, [], (w) => git("-C", w, "update-index", "--add", "--cacheinfo", `160000,${git("--git-dir", bare(), "rev-parse", REF).trim()},vendor`))],
  ] as const)("refuses a fetched branch that holds %s with the live job's own check, and pushes nothing", async (_what, make) => {
    const r1 = await recordAt("2026-11-11T12:00:00.000Z");
    published(recordJob(r1));
    make();
    const odd = branch();
    refusedAtPublish(recordJob(await recordAt("2026-11-11T13:00:00.000Z")), /observatory-data holds something the job never writes/);
    expect(branch()).toEqual(odd);
    // Also a recording already there: the tree is checked before anything on it is read.
    refusedAtPublish(recordJob(r1), /observatory-data holds something the job never writes/);
    expect(branch()).toEqual(odd);
  });

  it("fails, and pushes nothing, when recordings is a file on the branch", async () => {
    seed({ recordings: "not a folder\n" });
    const before = branch();
    const j = recordJob(await recordAt("2026-11-11T12:00:00.000Z"));
    expect([j.check.status, j.publish?.status]).toEqual([0, 1]);
    expect(branch()).toEqual(before);
  });

  it("refuses an id that is not in its form where it names the path, also when the check was passed by", async () => {
    const r = await recordAt("2026-11-11T12:00:00.000Z");
    published(recordJob(r));
    const before = branch();
    for (const id of ["../latest", "20261111120000-0123456789abcdef/../../log", "-rf", "", "20261111120000-0123456789ABCDEF", "2026111112000-0123456789abcdef", `20261111120000-0123456789abcdef\nx`]) {
      const temp = next("runner");
      mkdirSync(join(temp, "recording"), { recursive: true });
      for (const f of RECORDED) copyFileSync(join(r.out, f), join(temp, "recording", f));
      writeFileSync(join(temp, "publish.sh"), RECORD_PUBLISH.run as string);
      const env = { HOME: temp, RUNNER_TEMP: temp, GITHUB_RUN_ID: "4242", GITHUB_SHA: "c".repeat(40), GITHUB_SERVER_URL: `file://${server()}`, GITHUB_REPOSITORY: REPOSITORY, PUSH_TOKEN: "t", RECORDING_ID: id, STARTED_AT: "x", REQUEST_LIST_SHA256: "x", ASKED: "1", ANSWERED: "1", FAILED: "0" };
      const p = runShell(["-e", join(temp, "publish.sh")], env, temp);
      expect([p.status, p.stdout], JSON.stringify(id)).toEqual([1, "::error::the recording's id is not in its form\n"]);
      expect(branch()).toEqual(before);
    }
  });
});

describe("an artifact the record check refuses: the publish step never runs and nothing is pushed", () => {
  async function onBranch(): Promise<{ before: Branch; next: Recording }> {
    published(recordJob(await recordAt("2026-11-11T12:00:00.000Z")));
    return { before: branch(), next: await recordAt("2026-11-11T13:00:00.000Z") };
  }
  function refusedAtCheck(j: Job, why: string): void {
    expect([j.check.status, j.publish], said(j)).toEqual([1, null]);
    expect(j.check.stdout).toContain(`::error::${why}`);
    expect(j.outputs).toEqual({});
  }
  /** Writes a file and SHA256SUMS again around it, as a forger would. */
  const forge = (name: string, edit: (t: string) => string) => (d: string) => {
    const was = readFileSync(join(d, name), "utf8");
    expect(edit(was)).not.toBe(was);
    writeFileSync(join(d, name), edit(was));
    writeFileSync(join(d, "SHA256SUMS"), sumsOf(RECORDING_FILES.map((n) => [n, readFileSync(join(d, n))] as const)));
  };
  const runAs = (edit: (r: Record<string, unknown>) => Record<string, unknown>) => forge("run.json", (t) => `${JSON.stringify(edit(JSON.parse(t) as Record<string, unknown>), null, 2)}\n`);

  it.each([
    ["an extra file", (d: string) => writeFileSync(join(d, "notes.txt"), "x"), "the artifact holds something that is not on the list"],
    ["an extra hidden file", (d: string) => writeFileSync(join(d, ".hidden"), "x"), "the artifact holds something that is not on the list"],
    ["a folder", (d: string) => mkdirSync(join(d, "sub")), "the artifact holds something that is not on the list"],
    ["a live run's file", (d: string) => writeFileSync(join(d, "snapshot.json"), "{}"), "the artifact holds something that is not on the list"],
    ["no tape", (d: string) => unlinkSync(join(d, "tape.jsonl")), "the artifact holds no tape.jsonl as a regular file"],
    ["no SHA256SUMS", (d: string) => unlinkSync(join(d, "SHA256SUMS")), "the artifact holds no SHA256SUMS as a regular file"],
    [
      "a run.json that is a link to the same bytes",
      (d: string) => {
        cpSync(join(d, "run.json"), join(d, "..", "away.json"));
        unlinkSync(join(d, "run.json"));
        symlinkSync(join(d, "..", "away.json"), join(d, "run.json"));
      },
      "the artifact holds no run.json as a regular file",
    ],
    ["a changed byte in the tape", (d: string) => writeFileSync(join(d, "tape.jsonl"), readFileSync(join(d, "tape.jsonl"), "utf8").replace("0x6d657461", "0x6d657462")), "a file differs from SHA256SUMS"],
    ["a changed byte in run.json", (d: string) => writeFileSync(join(d, "run.json"), readFileSync(join(d, "run.json"), "utf8").replace('"answered": 2', '"answered": 3')), "a file differs from SHA256SUMS"],
    ["a run that exited 4, sums written again", runAs((r) => ({ ...r, exit_code: 4 })), "run.json does not say the run exited 0, so it is no recording"],
    ["an exit code that is a string", runAs((r) => ({ ...r, exit_code: "0" })), "run.json does not say the run exited 0, so it is no recording"],
    ["a run.json that is not JSON", forge("run.json", (t) => t.slice(1)), "run.json does not say the run exited 0, so it is no recording"],
    ["a start that runs on to another line", runAs((r) => ({ ...r, started_at: "2026-11-11T13:00:00.000Z\nid=../x" })), "run.json holds no started_at in the form the recorder writes"],
    ["a start that is an option", runAs((r) => ({ ...r, started_at: "-d now" })), "run.json holds no started_at in the form the recorder writes"],
    ["a start with an offset", runAs((r) => ({ ...r, started_at: "2026-11-11T13:00:00.000+00:00" })), "run.json holds no started_at in the form the recorder writes"],
    ["a start with no milliseconds", runAs((r) => ({ ...r, started_at: "2026-11-11T13:00:00Z" })), "run.json holds no started_at in the form the recorder writes"],
    ["a list hash that is a path", runAs((r) => ({ ...r, request_list_sha256: "../../../latest/x/../../../../../../../../../../../.." })), "run.json holds no request list sha256 in the written form"],
    ["a list hash in upper case", runAs((r) => ({ ...r, request_list_sha256: LIST_SHA.toUpperCase() })), "run.json holds no request list sha256 in the written form"],
    ["no list hash", runAs((r) => ({ ...r, request_list_sha256: null })), "run.json holds no request list sha256 in the written form"],
    ["a count with a leading zero", runAs((r) => ({ ...r, calls: { asked: "02", answered: 2, failed: 0 } })), "run.json holds no call counts in the written form"],
    ["a count that is a word", runAs((r) => ({ ...r, calls: { asked: 2, answered: "$(true)", failed: 0 } })), "run.json holds no call counts in the written form"],
  ] as const)("%s", async (_what, tamper, why) => {
    const { before, next } = await onBranch();
    refusedAtCheck(recordJob(next, tamper), why);
    expect(branch()).toEqual(before);
  });
});

describe("the two publish jobs on one branch: each leaves the other's files alone", () => {
  it("a recording on a branch the live job has published to leaves latest/, log/ and README.md byte for byte", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const r2 = await read(live("published-2026-11-11-0823"), checkout());
    published(publishJob(r2));
    const liveBefore = liveFiles();
    expect(Object.keys(liveBefore)).toEqual(LAID(["2026-11-11.jsonl"]));
    const rec = await recordAt("2026-11-11T12:00:00.000Z");
    published(recordJob(rec));
    expect(liveFiles()).toEqual(liveBefore);
    expect(recordingsOnBranch()).toEqual(laidAt(rec));
  });

  it("a live reading on a branch that holds recordings: the live run reads its log, the job's checks pass, and the recordings stay byte for byte", async () => {
    const rec1 = await recordAt("2026-11-11T07:00:00.000Z");
    published(recordJob(rec1));
    // A first live reading on a branch that holds only a recording: the log folder is not there.
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    expect([r1.code, r1.snapshot?.seq, r1.snapshot?.prev_hash]).toEqual([EXIT.ok, 0, null]);
    published(publishJob(r1));
    const rec2 = await recordAt("2026-11-11T08:15:00.000Z");
    published(recordJob(rec2));
    const recordings = recordingsOnBranch();
    expect(recordings).toEqual({ ...laidAt(rec1), ...laidAt(rec2) });
    // The next live reading follows the last line of log/ alone, through the chain check on the
    // published log and the plain files check, with the recordings on the branch.
    const log = checkout();
    expect(readHistory(log).state).toBe("read");
    const r2 = await read(live("published-2026-11-11-0823"), log);
    expect([r2.code, r2.snapshot?.seq, r2.snapshot?.prev_hash]).toEqual([EXIT.ok, 1, r1.snapshot?.hash]);
    published(publishJob(r2));
    const b = branch();
    expect(b.log).toEqual({ "2026-11-11.jsonl": dayFile(r1, r2) });
    expect(b.latest).toEqual(filesOf(r2));
    expect(recordingsOnBranch()).toEqual(recordings);
    expect(b.files).toEqual([...LAID(["2026-11-11.jsonl"]), ...Object.keys(recordings)].sort());
  });

  it("a live push refused because a recording landed in between is fetched again, and the reading laid on top of the recording", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    const r2 = await read(live("published-2026-11-11-0823"), checkout());
    // The server refuses the live job's first push, and moves the branch under it by a commit of
    // the record job's kind: one recordings/<id>/ folder added, log/ unchanged.
    const marker = join(box, "refused-once");
    const hook = join(bare(), "hooks", "pre-receive");
    writeFileSync(
      hook,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `if [ -e "${marker}" ]; then exit 0; fi`,
        `: >"${marker}"`,
        "unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "tip=$(git rev-parse refs/heads/observatory-data)",
        `export GIT_INDEX_FILE="${join(box, "hook-index")}"`,
        'git read-tree "$tip"',
        "blob=$(printf 'recorded\\n' | git hash-object -w --stdin)",
        'git update-index --add --cacheinfo "100644,$blob,recordings/20261111082000-0123456789abcdef/run.json"',
        "tree=$(git write-tree)",
        'c=$(GIT_AUTHOR_NAME=m GIT_AUTHOR_EMAIL=m@example.invalid GIT_COMMITTER_NAME=m GIT_COMMITTER_EMAIL=m@example.invalid git commit-tree "$tree" -p "$tip" -m recording)',
        'git update-ref refs/heads/observatory-data "$c" "$tip"',
        "echo refused >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(hook, 0o755);
    const j = publishJob(r2);
    published(j);
    expect(j.publish?.stdout).toContain("the push was refused; fetching observatory-data again and trying once more");
    const b = branch();
    const between = git("--git-dir", bare(), "rev-parse", `${REF}~1`).trim();
    expect(git("--git-dir", bare(), "log", "-1", "--format=%s", between).trim()).toBe("recording");
    expect(b.parents).toEqual([between]);
    expect(recordingsOnBranch()).toEqual({ "recordings/20261111082000-0123456789abcdef/run.json": "recorded\n" });
    expect(b.log).toEqual({ "2026-11-11.jsonl": dayFile(r1, r2) });
    expect(b.latest).toEqual(filesOf(r2));
  });
});
