#!/usr/bin/env node
// Proves the mutation runner itself classifies correctly, so its "killed" can be trusted.
// Four throwaway mutants go through scripts/mutate.mjs:
//   a real bug               must be "killed"
//   an equivalent change     must be "survived" (an untyped cast changes nothing at run time)
//   a syntax error           must be "load-error", never a kill
//   a missing test file      must be "invalid"
// The runner must also exit 1, because three of the four are not kills.
// Two more checks prove the copy the runner works in:
//   in a throwaway git repo, the copy holds exactly the tracked files: an untracked file is left
//   out, a tracked file deleted from the working tree is listed as missing, a link stays a link
//   when git cannot list the files, the runner reports "setup-failed" as JSON and exits 1
// Exit 0 only when every outcome is the expected one.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTracked } from "./tracked.mjs";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mutants = [
  {
    id: "canary-real-bug",
    expect: "killed",
    file: "src/guard.ts",
    find: "if (!READ_ONLY_RPC_METHODS.has(method)) {",
    replace: "if (false) {",
    test: "test/guard.test.ts",
    why: "lets every RPC write through",
  },
  {
    id: "canary-equivalent",
    expect: "survived",
    file: "src/guard.ts",
    find: "const attempts: Attempt[] = [];",
    replace: "const attempts: Attempt[] = [] as Attempt[];",
    test: "test/guard.test.ts",
    why: "a type cast that changes nothing at run time",
  },
  {
    id: "canary-syntax-error",
    expect: "load-error",
    file: "src/guard.ts",
    find: "export function resetAttempts(): void {",
    replace: "export function resetAttempts(): void {{",
    test: "test/guard.test.ts",
    why: "breaks loading only",
  },
  {
    id: "canary-missing-test",
    expect: "invalid",
    file: "src/guard.ts",
    find: "export function refuseSpend(what: string): never {",
    replace: "export function refuseSpend(what: string): never {\n  void 0;",
    test: "test/no-such-file.test.ts",
    why: "names a test file that does not exist",
  },
];

const work = mkdtempSync(join(tmpdir(), "obs-mutate-canary-"));
const file = join(work, "mutants.json");
writeFileSync(file, JSON.stringify(mutants.map(({ expect: _e, ...m }) => m), null, 2));
const r = spawnSync("node", [join(pkg, "scripts", "mutate.mjs"), file], { cwd: pkg, encoding: "utf8" });
rmSync(work, { recursive: true, force: true });

let report = null;
try {
  report = JSON.parse(r.stdout);
} catch {
  report = null;
}
const results = mutants.map((m) => {
  const got = report?.results?.find((x) => x.id === m.id)?.outcome ?? "missing";
  return { mutant: m.id, expected: m.expect, got, outcome: got === m.expect ? "classified-right" : "classified-wrong" };
});
const runnerExit = { check: "runner exits 1 when a mutant is not killed", expected: 1, got: r.status };
const controls = { control_before: report?.control_before?.outcome ?? "missing", control_after: report?.control_after?.outcome ?? "missing" };

// The copy: exactly the tracked files, in a throwaway repo with one of each kind of entry.
function copyCheck() {
  const box = mkdtempSync(join(tmpdir(), "obs-copy-canary-"));
  try {
    const src = join(box, "repo");
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "tracked.txt"), "tracked\n");
    writeFileSync(join(src, "sub", "deleted.txt"), "soon gone\n");
    symlinkSync("tracked.txt", join(src, "link.txt"));
    writeFileSync(join(src, "untracked.txt"), "never copied\n");
    const git = (...a) => spawnSync("git", ["-C", src, ...a], { encoding: "utf8" });
    if (git("init", "-q").status !== 0 || git("add", "tracked.txt", "sub/deleted.txt", "link.txt").status !== 0) {
      return { check: "copy holds exactly the tracked files", outcome: "could-not-set-up" };
    }
    rmSync(join(src, "sub", "deleted.txt"));
    const dest = join(box, "copy");
    const got = copyTracked(src, dest);
    const walk = (d) => readdirSync(d).flatMap((n) => (lstatSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(dest, join(d, n))]));
    const files = walk(dest).sort();
    const pass =
      JSON.stringify(files) === JSON.stringify(["link.txt", "tracked.txt"]) &&
      lstatSync(join(dest, "link.txt")).isSymbolicLink() &&
      readlinkSync(join(dest, "link.txt")) === "tracked.txt" &&
      readFileSync(join(dest, "tracked.txt"), "utf8") === "tracked\n" &&
      !existsSync(join(dest, "untracked.txt")) &&
      JSON.stringify(got.missing) === JSON.stringify(["sub/deleted.txt"]) &&
      got.tracked === 3 &&
      got.copied === 2;
    return { check: "copy holds exactly the tracked files", files, missing: got.missing, outcome: pass ? "copied-right" : "copied-wrong" };
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}
const copy = copyCheck();

// A copy that cannot be made is a structured setup failure, never a crash or a result.
const box = mkdtempSync(join(tmpdir(), "obs-setup-canary-"));
const one = join(box, "mutants.json");
writeFileSync(one, JSON.stringify([{ ...mutants[0], expect: undefined }].map(({ expect: _e, ...m }) => m)));
const f = spawnSync("node", [join(pkg, "scripts", "mutate.mjs"), one], { cwd: pkg, encoding: "utf8", env: { ...process.env, GIT_DIR: join(box, "no-such-git") } });
rmSync(box, { recursive: true, force: true });
let failed = null;
try {
  failed = JSON.parse(f.stdout);
} catch {
  failed = null;
}
const setupFailure = {
  check: "a copy that cannot be made is reported as setup-failed, exit 1",
  exit: f.status,
  outcome:
    f.status === 1 && failed?.copy?.outcome === "setup-failed" && failed?.summary?.setup === "setup-failed" && failed?.results?.length === 0
      ? "reported-right"
      : "reported-wrong",
};

const ok =
  results.every((x) => x.outcome === "classified-right") &&
  r.status === 1 &&
  controls.control_before === "control-pass" &&
  controls.control_after === "control-pass" &&
  copy.outcome === "copied-right" &&
  setupFailure.outcome === "reported-right";
console.log(JSON.stringify({ results, runner_exit: runnerExit, ...controls, copy, setup_failure: setupFailure }, null, 2));
process.exit(ok ? 0 : 1);
