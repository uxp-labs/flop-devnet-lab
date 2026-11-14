// Review o1 (round 33), attack 8: the one exception to the ban on module mocks (promise P9). The
// scan is a closure inside a test of test/guard.test.ts, so these tests take its committed lines
// (from "const ways = [" to the end of loadsSecondGuard), drop the two type annotations, and run
// them as they are on planted texts. Every planted text is built from pieces, as guard.test.ts
// builds its own, so this file does not match the scan itself. Nothing here reads the network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(new URL("./guard.test.ts", import.meta.url), "utf8");
const start = SRC.indexOf("    const ways = [");
const end = SRC.indexOf("      return false;\n    };\n", start);
const body = SRC.slice(start, end + "      return false;\n    };\n".length).replace("(file: string, text: string): boolean =>", "(file, text) =>");
// biome-ignore lint/security/noGlobalEval: the committed scan's own lines, run as written
const loadsSecondGuard = new Function(`${body}\nreturn loadsSecondGuard;`)() as (file: string, text: string) => boolean;

const EXCEPTED = "shape-pin-derived.test.ts";
const VI = "vi";
const MOCK = `${VI}.mock`;
const META = '"../src/scale/metadata.js"';
const ALLOWED = `${MOCK}(${META}, async (importOriginal) => {\n  const real = await importOriginal();\n  return real;\n});\n`;

describe("review o1: the scan of the one allowed module mock (P9)", () => {
  it("HOLDS: the lines taken are the committed scan, and they agree with its own planted samples", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(loadsSecondGuard(EXCEPTED, ALLOWED)).toBe(false);
    expect(loadsSecondGuard(EXCEPTED, ALLOWED + ALLOWED)).toBe(true);
    expect(loadsSecondGuard("shape.test.ts", ALLOWED)).toBe(true);
    expect(loadsSecondGuard(EXCEPTED, `${MOCK}("../src/scale/shape.js", async (importOriginal) => importOriginal());\n`)).toBe(true);
    expect(loadsSecondGuard(EXCEPTED, readFileSync(new URL(`./${EXCEPTED}`, import.meta.url), "utf8"))).toBe(false);
  });

  it("HOLDS: the hoisted helper and a plain import of the guard are not a second copy and pass, as they should", () => {
    expect(loadsSecondGuard(EXCEPTED, `${ALLOWED}const c = ${VI}.hoisted(() => ({ on: false }));\nimport { guardRpc } from "../src/guard.js";\n`)).toBe(false);
  });

  it("DEFECT O1-4: in the excepted file the target is checked as text anywhere, so a comment meets it while the one call, written with a space, mocks another module", () => {
    const planted = `// ${MOCK}(${META}, is the one allowed form\n${VI} .mock("../src/scale/shape.js", async (importOriginal) => importOriginal());\n`;
    expect(loadsSecondGuard(EXCEPTED, planted)).toBe(true);
  });

  it("DEFECT O1-5: RULES.md section 4 says the test holds that the import-actual helper is banned in the excepted file too, so the factory's own argument is the only way to the real module", () => {
    // Changed by the fixer: the expectation is what RULES.md now says. A factory that ignores its own
    // argument is not claimed to be caught; the way around the argument is.
    const planted = `${MOCK}(${META}, async () => ${VI}.importActual(${META}));\n`;
    expect(loadsSecondGuard(EXCEPTED, planted)).toBe(true);
  });

  it("DEFECT O1-6 (on main too): an alias of vi, vi[\"mock\"], a line break inside the mock call, or the guard's query string built in two pieces passes in every file", () => {
    const plants = [
      `const v = ${VI};\nv.mock("../src/${"guard"}.js", () => ({}));\n`,
      `${VI}["mock"]("../src/${"guard"}.js", () => ({}));\n`,
      `${VI}\n  .mock("../src/${"guard"}.js", () => ({}));\n`,
    ];
    const passed = plants.filter((p) => !loadsSecondGuard("shape.test.ts", p) || !loadsSecondGuard(EXCEPTED, ALLOWED + p));
    expect(passed).toEqual([]);
  });

  it("HOLDS: the guard's query string built in two pieces in a dynamic import is not caught by a text scan; RULES.md section 4 says the scan catches the plain spellings and a diff that hides one is for the review", () => {
    // Changed by the fixer: this plant was the fourth of the DEFECT O1-6 list; no text scan can hold it.
    const plant = `await import("../src/${"guard"}" + ".js?again");\n`;
    expect(loadsSecondGuard("shape.test.ts", plant)).toBe(false);
  });
});
