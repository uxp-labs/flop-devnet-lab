/**
 * Review of P2 (reviewer, not the builder): attack F (the frozen tables, R8) and attack G (the packaging, R9).
 *
 * Which test is which:
 *  - "DEFECT ..." tests state the promise and FAIL on fcf75d0.
 *  - "HOLDS ..." tests pass on fcf75d0.
 *
 * Module names are resolved from imd-flop's own package (createRequire at this file), as door.ts and shape-file.ts
 * resolve them. Nothing is imported from the observatory but through those two files.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { KEY_TABLE } from "../src/chain-read/key-table.js";
import { CAPS, READ_METHODS } from "../src/chain-read/node.js";
import { CIRCUIT_BREAKER_FIELDS, SESSION_FIELDS, SESSION_NONCE_TYPE } from "../src/chain-read/session-state.js";
import { shapeFileText } from "../src/chain-read/shape-file.js";

const require = createRequire(import.meta.url);

function deeplyFrozen(v: unknown, path = "$"): string[] {
  if (v === null || typeof v !== "object") return [];
  const out = Object.isFrozen(v) ? [] : [path];
  for (const [k, x] of Object.entries(v)) out.push(...deeplyFrozen(x, `${path}.${k}`));
  return out;
}

describe("F: the frozen tables", () => {
  it("HOLDS CAPS, KEY_TABLE, SESSION_FIELDS, CIRCUIT_BREAKER_FIELDS and SESSION_NONCE_TYPE are frozen all the way down", () => {
    for (const [name, t] of Object.entries({ CAPS, KEY_TABLE, SESSION_FIELDS, CIRCUIT_BREAKER_FIELDS, SESSION_NONCE_TYPE })) expect([name, deeplyFrozen(t)]).toEqual([name, []]);
  });

  it("HOLDS a write to a frozen table throws in a module (strict mode) and changes nothing", () => {
    const before = KEY_TABLE.runtimes[0]?.entries.sessions.entryPart;
    expect(() => {
      (KEY_TABLE.runtimes[0] as any).entries.sessions.entryPart = "0x00";
    }).toThrow(TypeError);
    expect(KEY_TABLE.runtimes[0]?.entries.sessions.entryPart).toBe(before);
  });

  it("DEFECT READ_METHODS is frozen, so no code at run time can add a method to the list of the five (fails on fcf75d0)", () => {
    // READ_METHODS is `[...] as const`: read only by type, an ordinary array at run time.
    expect(Object.isFrozen(READ_METHODS)).toBe(true);
  });
});

describe("G: what imd-flop can resolve of the observatory", () => {
  const OUT = [
    "flop-observatory",
    "flop-observatory/package.json",
    "flop-observatory/dist/cli.js",
    "flop-observatory/scale/shape",
    "flop-observatory/dist/scale/shape.js",
    "flop-observatory/scale/block.js",
    "flop-observatory/shapes/../package.json",
    "flop-observatory/shapes/%2e%2e/package.json",
    "flop-observatory/shapes/%2E%2E/package.json",
    "flop-observatory/shapes/..%2fpackage.json",
    "flop-observatory/shapes/sub/../../package.json",
    "flop-observatory/shapes/node_modules/x.json",
    `flop-observatory/${(KEY_TABLE.runtimes[0]?.shapeFile as string).replace("shapes/", "SHAPES/")}`,
  ];
  for (const s of OUT) {
    it(`HOLDS ${s} does not resolve`, () => {
      expect(() => require.resolve(s)).toThrow();
    });
  }

  it("HOLDS the door and a shape file named by the key table resolve", () => {
    expect(require.resolve("flop-observatory/scale/block")).toMatch(/observatory\/dist\/scale\/block\.js$/);
    const shape = KEY_TABLE.runtimes[0]?.shapeFile as string;
    expect(require.resolve(`flop-observatory/${shape}`)).toMatch(new RegExp(`observatory/${shape.replace(/\./g, "\\.")}$`));
  });

  it("HOLDS shapeFileText refuses names that leave the folder, and every refusal is unknown", () => {
    for (const n of ["shapes/../package.json", "shapes/..json", "shapes/a/b.json", "../package.json", "shapes/%2e%2e.json", "shapes/x.json\n", "SHAPES/x.json", "shapes/.json", `shapes/${"a".repeat(5000)}x/.json`, "shapes/x.JSON"]) {
      expect([n.slice(0, 40), shapeFileText(n).kind]).toEqual([n.slice(0, 40), "unknown"]);
    }
  });

  it("HOLDS a shape file name that is well formed but not in the package is unknown", () => {
    expect(shapeFileText("shapes/not-a-reviewed-shape.json").kind).toBe("unknown");
  });
});
