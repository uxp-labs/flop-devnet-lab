#!/usr/bin/env node
// Review only (test/review-decoder.test.ts names the defects). Runs the real scripts/source-scan.mjs,
// unchanged, on a throwaway copy of the package whose src holds one more module, a sample, at
// src/scale/sample.ts, and reports whether the scan let the sample pass. Vitest blocks the native
// parser the scan needs (process.dlopen), so this runs with plain node:
//   node test/helpers/review-scan-misses.mjs
// Each DEFECT line below is a form that reaches a clock, a timer or stdout from a pure folder and
// that the scan passes today. It exits 0 while every DEFECT sample still passes the scan and every
// CONTROL sample is still caught, so it fails once the scan is fixed (or if the harness breaks).
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MISSES = [
  ["DEFECT 9a: a clock through Event.timeStamp", "export const now = (): number => new Event(\"x\").timeStamp;"],
  ["DEFECT 9b: a clock through Intl.DateTimeFormat", "export const today = (): string => new Intl.DateTimeFormat(\"en\", { dateStyle: \"full\" }).format();"],
  ["DEFECT 9c: a timer through AbortSignal.timeout", "export const later = (): AbortSignal => AbortSignal.timeout(10);"],
  ["DEFECT 9d: a timer through Atomics.waitAsync", "export const wait = (): unknown => Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);"],
  ["DEFECT 9e: stdout and a clock through console.time", "export function t(): void { console.time(\"a\"); console.timeEnd(\"a\"); }"],
  ["DEFECT 9f: Math.random by destructuring", "const { random: r } = Math; export const pick = (): number => r();"],
];
const CONTROLS = [
  ["CONTROL: Date.now is caught", "export const now = (): number => Date.now();"],
  ["CONTROL: Math.random is caught", "export const pick = (): number => Math.random();"],
  ["HELD: a dynamic import", "export const m = (): unknown => import(\"node:fs\");"],
  ["HELD: createRequire", "import { createRequire } from \"node:module\"; export const r = createRequire(\"/\");"],
  ["HELD: globalThis", "export const g = (): unknown => globalThis;"],
  ["HELD: Reflect", "export const g = (o: object): unknown => Reflect.ownKeys(o);"],
  ["HELD: another node:crypto member", "import { randomInt } from \"node:crypto\"; export const r = randomInt;"],
  ["HELD: a re-export of node:fs", "export { readFileSync } from \"node:fs\";"],
  ["HELD: a path that leaves the pure folder and comes back", "import { own } from \"../hash/../own.js\"; export const o = own;"],
  ["HELD: a type only import from outside", "import type { Status } from \"../types.js\"; export type S = Status;"],
  ["HELD: the web crypto global", "export const c = (b: Uint8Array): unknown => crypto.getRandomValues(b);"],
];

function scanWith(sample) {
  const box = mkdtempSync(join(tmpdir(), "review-scan-"));
  try {
    cpSync(join(pkg, "src"), join(box, "src"), { recursive: true });
    cpSync(join(pkg, "scripts"), join(box, "scripts"), { recursive: true });
    symlinkSync(join(pkg, "node_modules"), join(box, "node_modules"));
    writeFileSync(join(box, "src", "scale", "sample.ts"), `${sample}\n`);
    const out = spawnSync(process.execPath, [join(box, "scripts", "source-scan.mjs")], { encoding: "utf8", maxBuffer: 64 << 20 });
    const report = JSON.parse(out.stdout);
    const line = report.find((r) => r.check === "src/scale/sample.ts passes the syntax tree scan");
    if (line === undefined) throw new Error("the scan did not read the sample");
    return line;
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

let wrong = 0;
for (const [name, code] of MISSES) {
  const r = scanWith(code);
  const ok = r.outcome === "pass";
  if (!ok) wrong++;
  console.log(`${ok ? "still missed" : "now caught  "}  ${name}${ok ? "" : `: ${r.stderr}`}`);
}
for (const [name, code] of CONTROLS) {
  const r = scanWith(code);
  const ok = r.outcome === "fail";
  if (!ok) wrong++;
  console.log(`${ok ? "caught      " : "NOT caught  "}  ${name}${ok ? `: ${r.stderr}` : ""}`);
}
process.exitCode = wrong === 0 ? 0 : 1;
