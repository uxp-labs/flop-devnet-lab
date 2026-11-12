// The check's typecheck step sees the tests as well as src (review round 28, N3), while its build
// step still emits src only. The two configurations and the two step lines are read as text: a
// test cannot run tsc, since the harness blocks child processes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const CHECK = read("scripts/check.sh");
const PACKAGE = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const BUILD_CONFIG = JSON.parse(read("tsconfig.json")) as { include: string[]; compilerOptions: Record<string, unknown> };
const CHECK_CONFIG = JSON.parse(read("tsconfig.check.json")) as { extends: string; include: string[]; compilerOptions: Record<string, unknown> };

/** The command of the one `step <name> ...` line of check.sh, or every match when there is not exactly one. */
function stepCommand(name: string): string | string[] {
  const lines = CHECK.split("\n").filter((l) => l.startsWith(`step ${name} `));
  return lines.length === 1 ? (lines[0] as string).slice(`step ${name} `.length) : lines;
}

describe("the typecheck step covers src and test, the build step emits src only (round 28, N3)", () => {
  it("the typecheck configuration extends the build one, emits nothing and includes exactly src and test", () => {
    expect(CHECK_CONFIG.extends).toBe("./tsconfig.json");
    expect(CHECK_CONFIG.compilerOptions.noEmit).toBe(true);
    expect([...CHECK_CONFIG.include].sort()).toEqual(["src", "test"]);
  });

  it("the build configuration still includes src only", () => {
    expect(BUILD_CONFIG.include).toEqual(["src"]);
    expect(BUILD_CONFIG.compilerOptions.noEmit).toBeUndefined();
  });

  it("check.sh's typecheck step runs the typecheck configuration and its build step the build one", () => {
    expect(stepCommand("typecheck")).toBe("npx --no-install tsc -p tsconfig.check.json");
    expect(stepCommand("build")).toBe("npx --no-install tsc -p tsconfig.json");
  });

  it("npm run typecheck runs the same configuration as the check", () => {
    expect(PACKAGE.scripts.typecheck).toBe("tsc -p tsconfig.check.json");
    expect(PACKAGE.scripts.build).toBe("tsc -p tsconfig.json");
  });
});
