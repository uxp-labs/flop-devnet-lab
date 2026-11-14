/**
 * T1: the package is built once per run, by test/global-setup.ts, before any worker starts. No test file
 * builds it and none writes, removes or renames a path under dist/, because other workers start child
 * processes from dist/ at the same time and a half written file fails them. This test reads the test
 * files and holds that rule. Its patterns are built from pieces so this file does not match itself.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PKG = join(import.meta.dirname, "..");
const TEST_DIR = join(PKG, "test");
const SETUP = "test/global-setup.ts";

const COMPILER = "ts" + "c";
const CONFIG = "ts" + "config";
const NO_EMIT = "--no" + "Emit";
const DIR = "di" + "st";

// A line that starts the compiler on the package's config: the compiler named, a config or -p given, no --noEmit.
const compilerWord = new RegExp(`["'\`/]${COMPILER}["'\`\\s]`);
const configGiven = new RegExp(`${CONFIG}|["'\`]-p["'\`]`);
// The package's own build script started from a test.
const npmBuildArray = new RegExp(`["'\`]npm["'\`]\\s*,\\s*\\[[^\\]\\n]*["'\`]build["'\`]`);
const npmBuildExec = new RegExp(`\\bexec(?:Sync)?\\(\\s*["'\`][^"'\`\\n]*npm run build`);

// Calls that write, remove, rename or otherwise change a path.
const MUTATORS = ["write", "append", "rm", "rmdir", "unlink", "rename", "copyFile", "cp", "mkdir", "truncate", "symlink", "link", "createWriteStream", "utimes", "mkdtemp", "ftruncate", "lchown", "chmod", "chown"];
const mutatorCall = new RegExp(`\\b(${MUTATORS.join("|")})(?:File|Sync|FileSync|Dir|DirSync)?\\s*\\(`, "g");
// Shell tools given a path under dist.
const shellTool = new RegExp(`["'\`](?:rm|mv|cp|rmdir|touch|tee|ln|install|rsync)["'\`]\\s*,[^\\n]*\\b${DIR}\\b`);
const distWord = new RegExp(`\\b${DIR}\\b`);

/** The text of each of the first two arguments of the call whose "(" is at open, nesting and strings respected. */
function firstArgs(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    }
    if (c === "," && depth === 0) {
      args.push(cur);
      cur = "";
      if (args.length === 2) return args;
      continue;
    }
    cur += c;
  }
  args.push(cur);
  return args;
}

export function compilerRuns(text: string): string[] {
  return text.split("\n").filter((l) => {
    if (l.includes(NO_EMIT)) return false;
    return (compilerWord.test(l) && configGiven.test(l)) || npmBuildArray.test(l) || npmBuildExec.test(l);
  });
}

export function distWrites(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(mutatorCall)) {
    const open = m.index! + m[0].length - 1;
    // only the path arguments: the first, and the second of rename, copy and link calls
    const args = firstArgs(text, open);
    const paths = /rename|cp|copyFile|symlink|link/.test(m[1]!) ? args.slice(0, 2) : args.slice(0, 1);
    if (paths.some((a) => distWord.test(a))) found.push(m[0] + args.join(",").trim().slice(0, 80));
  }
  for (const l of text.split("\n")) if (shellTool.test(l)) found.push(l.trim().slice(0, 80));
  return found;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
const FILES = walk(TEST_DIR).map((f) => ({ rel: relative(PKG, f), text: readFileSync(f, "utf8") }));

describe("T1: one build before the workers, no test writes the built folder", () => {
  it("the scan reads this suite's files", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.map((f) => f.rel)).toContain(SETUP);
    expect(FILES.map((f) => f.rel)).toContain("test/one-build.test.ts");
  });

  it("R1: vitest.config.ts names the global setup, which builds with the package's own config", () => {
    const config = readFileSync(join(PKG, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/globalSetup:\s*\[\s*"test\/global-setup\.ts"\s*\]/);
    const setup = FILES.find((f) => f.rel === SETUP)!.text;
    expect(compilerRuns(setup).length).toBeGreaterThan(0);
  });

  it("R2: no test file but the global setup starts the compiler on the package's config", () => {
    const hits = FILES.filter((f) => f.rel !== SETUP).flatMap((f) => compilerRuns(f.text).map((l) => `${f.rel}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });

  it("R2: no test file writes, removes or renames a path under the built folder", () => {
    const hits = FILES.flatMap((f) => distWrites(f.text).map((l) => `${f.rel}: ${l}`));
    expect(hits).toEqual([]);
  });

  it("R3: package.json's test script does not build", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test"]).toBe("vitest run");
  });

  describe("the scan catches planted samples and lets a read only run pass", () => {
    const buildLine = `execFileSync("npx", ["${COMPILER}", "-p", "${CONFIG}.json"], { cwd: root });`;
    const buildViaTool = `execFileSync(join(PKG, "node_modules", ".bin", "${COMPILER}"), ["-p", "${CONFIG}.json"], { cwd: PKG });`;
    const buildViaNpm = `execFileSync("n${"pm"}", ["run", "bui${"ld"}"], { cwd: root });`;
    const noEmitLine = `execFileSync(tool, ["--ignoreConfig", "${NO_EMIT}", "--strict", file], { cwd: PKG });`;
    const writeIn = `writeFile${"Sync"}(join(root, "${DIR}", "cli.js"), "x");`;
    const writeInMulti = `append${"FileSync"}(\n  join(root,\n "${DIR}", "a.js"), "x");`;
    const removeOf = `rm${"Sync"}(join(root, "${DIR}"), { recursive: true });`;
    const renameOf = `rename${"Sync"}(join(root, "x.js"), join(root, "${DIR}", "x.js"));`;
    const shellRemove = `execFileSync("rm", ["-rf", join(root, "${DIR}")]);`;
    const readOnly = `const m = await import(join(root, "${DIR}", "cli.js")); writeFile${"Sync"}(join(home, "x"), \`import "\${join(root, "${DIR}", "y.js")}"\`);`;

    it("an in-test build is caught", () => {
      for (const s of [buildLine, buildViaTool, buildViaNpm]) expect(compilerRuns(s)).toHaveLength(1);
    });
    it("a run that writes nothing passes", () => {
      expect(compilerRuns(noEmitLine)).toEqual([]);
    });
    it("a write under the built folder is caught", () => {
      for (const s of [writeIn, writeInMulti, removeOf, renameOf, shellRemove]) expect(distWrites(s)).toHaveLength(1);
    });
    it("reading the built folder, or naming it inside a script text written elsewhere, passes", () => {
      expect(distWrites(readOnly)).toEqual([]);
    });
  });
});
