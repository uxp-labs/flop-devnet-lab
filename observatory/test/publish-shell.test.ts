// The publish job's shell, run (memory review). test/live-workflow.test.ts reads the workflow as
// text; this runs the two run: blocks of the publish job, "Check the files against SHA256SUMS" and
// "Publish to observatory-data", taken out of .github/workflows/observatory-live.yml by step name
// when the test runs, so it always runs what the workflow holds. There is no copy of the shell here.
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
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readHistory } from "../src/history.js";
import { EXIT, runLive } from "../src/live-run.js";
import { PUBLISHED_FILES } from "../src/published.js";
import { logLine } from "../src/store.js";
import { TapeTransport } from "../src/tape.js";
import type { Transport } from "../src/transport.js";
import type { Snapshot } from "../src/types.js";
import { runShell } from "./setup.js";

const TOOLS = ["bash", "git", "jq", "sha256sum", "base64", "find", "date"];
const REF = "refs/heads/observatory-data";
const REPOSITORY = "uxp-labs/flop-devnet-lab";
const ARTIFACT = [...PUBLISHED_FILES, "SHA256SUMS"];

// ---- The two steps, from the workflow as it is.
type Step = { name?: string; id?: string; run?: string; if?: string; env?: Record<string, string> };
const workflow = parse(readFileSync(new URL("../../.github/workflows/observatory-live.yml", import.meta.url), "utf8")) as { jobs: Record<string, { steps: Step[] }> };
function step(name: string): Step {
  const found = (workflow.jobs.publish?.steps ?? []).filter((s) => s.name === name);
  if (found.length !== 1 || typeof found[0]?.run !== "string") throw new Error(`the publish job holds no one run: step named ${JSON.stringify(name)}`);
  return found[0];
}
const CHECK = step("Check the files against SHA256SUMS");
const PUBLISH = step("Publish to observatory-data");

// ---- Readings, made by the repo's own code.
const FIXTURES = new URL("../fixtures/", import.meta.url);
const fixture = (dir: string, name: string) => readFileSync(new URL(`${dir}/${name}`, FIXTURES), "utf8");
const CLOCK = () => "2026-11-11T09:00:00.000Z";
const DAY = 86_400;

/** A tape that says it is the network, as the live one does, with every time it gives moved by seconds. */
function live(dir: string, seconds = 0): Transport {
  const inner = TapeTransport.parse(fixture(dir, "tape.jsonl"), `tape:${dir}`);
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
function seed(files: Record<string, string>, links: Record<string, string> = {}, remove: string[] = []): void {
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
  const temp = next("runner");
  const reading = join(temp, "reading");
  mkdirSync(reading, { recursive: true });
  for (const f of readdirSync(r.out)) copyFileSync(join(r.out, f), join(reading, f));
  tamper(reading);
  const base = { HOME: temp, RUNNER_TEMP: temp, GITHUB_RUN_ID: "4242", GITHUB_SHA: "c".repeat(40) };
  writeFileSync(join(temp, "check.sh"), CHECK.run as string);
  const checkOut = join(temp, "output-check");
  const check = runShell(["-e", join(temp, "check.sh")], { ...base, GITHUB_OUTPUT: checkOut }, temp);
  const outputs = outputsOf(checkOut);
  if (check.status !== 0) return { check, outputs, publish: null };
  if (PUBLISH.if !== "${{ steps.check.outputs.publish == 'true' }}") throw new Error(`the publish step's condition is not the one this test evaluates: ${PUBLISH.if}`);
  if (outputs.publish !== "true") return { check, outputs, publish: null };
  const env: Record<string, string> = { ...base, GITHUB_OUTPUT: join(temp, "output-publish"), GITHUB_SERVER_URL: `file://${server()}`, GITHUB_REPOSITORY: REPOSITORY };
  for (const [k, v] of Object.entries(PUBLISH.env ?? {})) {
    const m = /^\$\{\{ (?:(github\.token)|steps\.check\.outputs\.([a-z_]+)) \}\}$/.exec(v);
    if (m === null) throw new Error(`the publish step's env ${k} is ${v}, which this test does not know how to give`);
    env[k] = m[1] !== undefined ? "test-token" : (outputs[m[2] as string] ?? "");
  }
  writeFileSync(join(temp, "publish.sh"), PUBLISH.run as string);
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

  it("a refused push is fetched again and tried once more", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    // The server refuses the first push it is given, then takes the next.
    const hook = join(bare(), "hooks", "pre-receive");
    writeFileSync(hook, `#!/usr/bin/env bash\nif [ ! -e "${join(box, "refused-once")}" ]; then : >"${join(box, "refused-once")}"; echo refused >&2; exit 1; fi\n`);
    chmodSync(hook, 0o755);
    const j = publishJob(r1);
    published(j);
    expect(j.publish?.stdout).toContain("the push was refused; fetching observatory-data again and trying once more");
    expect(branch().log).toEqual({ "2026-11-11.jsonl": dayFile(r1) });
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

// Open defects found by the memory review. Each test pins what the code does today, which is wrong,
// so the suite stays green while the defect is open; it fails once the defect is fixed, and is then
// turned round to assert the fix. (scripts/test-report-check.mjs refuses a test that passes on
// failure, so these assert the defective behaviour itself.)
describe("open defects (memory review)", () => {
  it("DEFECT 1: a day file with no line is read as part of the log by the live run, which writes a truthful snapshot, and refused by the publish job, every run", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    seed({ "log/2026-11-12.jsonl": "" });
    const before = branch();
    for (const tape of ["published-2026-11-11-0823", "memory-rpc-down"]) {
      const log = checkout();
      const h = readHistory(log);
      // The live run builds on it: "read", exit 0, a line that follows the last line.
      expect([h.state, h.files]).toEqual(["read", ["2026-11-11.jsonl", "2026-11-12.jsonl"]]);
      const r = await read(live(tape), log);
      expect([r.code, r.snapshot?.prev_hash]).toEqual([EXIT.ok, r1.snapshot?.hash]);
      // The publish job reads the last line of the last day file, finds none, and fails.
      refusedAtPublish(publishJob(r), /the last line of the published log holds no hash/);
      expect(branch()).toEqual(before);
    }
  });

  it("DEFECT 2: a day file on the branch that is a link into latest/ makes the job push a latest/ that is not the reading and no line in log/", async () => {
    const r1 = await read(live("published-2026-11-11-0808"), checkout());
    published(publishJob(r1));
    // The live run reads the branch as the job left it.
    const r2 = await read(live("published-2026-11-11-0823"), checkout());
    expect([r2.code, r2.snapshot?.prev_hash]).toEqual([EXIT.ok, r1.snapshot?.hash]);
    // Then a commit not made by the job replaces the day file with a link to latest/snapshots.jsonl,
    // whose one line is the same last line. The live run would refuse that log; the job reads it.
    seed({}, { "log/2026-11-11.jsonl": "../latest/snapshots.jsonl" });
    const linked = branch();
    const j = publishJob(r2);
    published(j);
    const b = branch();
    // Pushed: a new commit whose day file is still the link, with no line added to the log ...
    expect(b.parents).toEqual([linked.commit]);
    expect(git("--git-dir", bare(), "ls-tree", REF, "log/2026-11-11.jsonl").split(/\s/)[0]).toBe("120000");
    // ... and a latest/snapshots.jsonl that holds the reading's line twice, so latest/ fails its own sums.
    expect(b.latest["snapshots.jsonl"]).toBe(logLine(r2.snapshot as Snapshot).repeat(2));
    expect(b.latest["snapshots.jsonl"]).not.toBe(filesOf(r2)["snapshots.jsonl"]);
  });

  it("DEFECT 3: after a line dated past the clock, the next run does not build on the branch and publish: every later run is refused until the clock passes that day", async () => {
    const ahead = await read(live("published-2026-11-11-0808", DAY), checkout());
    published(publishJob(ahead));
    const before = branch();
    for (const tape of ["published-2026-11-11-0823", "memory-changed-hash", "memory-other-genesis"]) {
      const r = await read(live(tape), checkout());
      expect(r.snapshot?.prev_hash).toBe(ahead.snapshot?.hash);
      refusedAtPublish(publishJob(r), /the reading's UTC day is before the log's last day file/);
      expect(branch()).toEqual(before);
    }
  });
});
