// Review of decoder-shape@3 (round 29), attack 5 and 9 in imd-flop: the key table script given a
// shape file of the @2 form (observatory/fixtures/shapes-at-2/), and the key table derived again.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUT, SOURCES, deriveKeyTable, deriveRuntime, renderKeyTable } from "../scripts/read-key-table.mjs";

describe("review shape 3: imd-flop and the @2 form", () => {
  it("read-key-table refuses the @2 file of 1014020, naming both formats", () => {
    const src = { ...SOURCES[0], shapeFile: "fixtures/shapes-at-2/tzkv-runtime-1014020.json" };
    expect(() => deriveRuntime(src)).toThrow('read-key-table: fixtures/shapes-at-2/tzkv-runtime-1014020.json is "flop-observatory/decoder-shape@2", not decoder-shape@3');
  });

  it("the key table derived again from the @3 file is the committed file byte for byte", () => {
    expect(renderKeyTable(deriveKeyTable())).toBe(readFileSync(OUT, "utf8"));
  });
});
