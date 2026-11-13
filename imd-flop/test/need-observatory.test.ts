/**
 * The P2 fix round, rule X10: imd-flop says what to do when the observatory is not built. The function that decides,
 * scripts/need-observatory.mjs needObservatory, is called with a temporary folder that lacks the door's built files
 * and with one that holds them. package.json runs the script as prebuild and pretest.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD, NEEDED, needObservatory, OBSERVATORY } from "../scripts/need-observatory.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const made: string[] = [];
const folder = (files: readonly string[]): string => {
  const d = mkdtempSync(join(tmpdir(), "need-observatory-"));
  made.push(d);
  for (const f of files) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), "");
  }
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("X10: need-observatory", () => {
  it("needs the door's built file and its declarations, and names the command that builds them", () => {
    expect([...NEEDED]).toEqual(["dist/scale/block.js", "dist/scale/block.d.ts"]);
    expect(BUILD).toBe("cd ../observatory && npm ci && npm run build");
  });

  it("a folder that lacks both: one line that names both and the command", () => {
    const r = needObservatory(folder([]));
    expect(r.missing).toEqual(["dist/scale/block.js", "dist/scale/block.d.ts"]);
    expect(r.line).toBe("imd-flop needs the observatory built first: ../observatory/dist/scale/block.js and ../observatory/dist/scale/block.d.ts missing; run: cd ../observatory && npm ci && npm run build");
    expect(r.line).not.toContain("\n");
  });

  it("a folder that lacks the declarations alone: the line names only them", () => {
    const r = needObservatory(folder(["dist/scale/block.js"]));
    expect(r.missing).toEqual(["dist/scale/block.d.ts"]);
    expect(r.line).toBe("imd-flop needs the observatory built first: ../observatory/dist/scale/block.d.ts missing; run: cd ../observatory && npm ci && npm run build");
  });

  it("a folder that holds both: nothing missing, no line", () => {
    expect(needObservatory(folder(["dist/scale/block.js", "dist/scale/block.d.ts"]))).toEqual({ missing: [], line: null });
  });

  it("the folder it checks is the observatory beside imd-flop, found from the script's place", () => {
    expect(join(OBSERVATORY)).toBe(join(PKG, "..", "observatory", "/"));
  });

  it("package.json runs it as prebuild and pretest", () => {
    const scripts = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).scripts;
    expect(scripts.prebuild).toBe("node scripts/need-observatory.mjs");
    expect(scripts.pretest).toBe("node scripts/need-observatory.mjs");
  });
});
