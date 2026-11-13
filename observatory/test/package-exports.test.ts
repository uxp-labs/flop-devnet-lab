// What this package lets another package import (P2, rule A3 and A4; plan decision S5): the decoder's
// one door, src/scale/block.ts as built to dist/scale/, and the shape files, and nothing else. imd-flop
// reaches the decoder through a file:../observatory dependency, so this map is the whole of what it can
// reach. package.json and tsconfig.json are read as text: a test cannot run tsc or npm.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const PACKAGE = JSON.parse(read("package.json")) as Record<string, unknown>;
const BUILD_CONFIG = JSON.parse(read("tsconfig.json")) as { compilerOptions: Record<string, unknown> };

describe("the package exports the door and the shape files only (P2 A3, A4)", () => {
  it("the exports map is exactly ./scale/block and ./shapes/*.json", () => {
    expect(PACKAGE.exports).toStrictEqual({
      "./scale/block": { types: "./dist/scale/block.d.ts", default: "./dist/scale/block.js" },
      "./shapes/*.json": "./shapes/*.json",
    });
  });

  it("the package names no main, module or types entry beside the map", () => {
    for (const k of ["main", "module", "types", "typings", "browser"]) expect(PACKAGE[k]).toBeUndefined();
  });

  it("the door the map names is the door of RULES.md section 9, src/scale/block.ts", () => {
    const door = (PACKAGE.exports as Record<string, { default: string }>)["./scale/block"]?.default;
    expect(door).toBe("./dist/scale/block.js");
    expect(read("src/scale/block.ts")).toMatch(/^\/\/ The one way real chain data is decoded \(RULES\.md section 9\)/);
  });

  it("the build emits declarations, so the door's types reach the package that imports it", () => {
    expect(BUILD_CONFIG.compilerOptions.declaration).toBe(true);
  });
});
