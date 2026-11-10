#!/usr/bin/env node
// Proves the mutation runner itself classifies correctly, so its "killed" can be trusted.
// Four throwaway mutants go through scripts/mutate.mjs:
//   a real bug               must be "killed"
//   an equivalent change     must be "survived" (an untyped cast changes nothing at run time)
//   a syntax error           must be "load-error", never a kill
//   a missing test file      must be "invalid"
// The runner must also exit 1, because three of the four are not kills.
// Exit 0 only when every outcome is the expected one.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const ok =
  results.every((x) => x.outcome === "classified-right") &&
  r.status === 1 &&
  controls.control_before === "control-pass" &&
  controls.control_after === "control-pass";
console.log(JSON.stringify({ results, runner_exit: runnerExit, ...controls }, null, 2));
process.exit(ok ? 0 : 1);
