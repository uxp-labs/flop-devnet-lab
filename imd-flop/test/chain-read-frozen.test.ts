/**
 * Piece A1, F3 (audit finding 3, for chain-read): everything src/chain-read exports is frozen where it is defined,
 * functions and classes with their prototypes, objects and arrays at any depth. Each file is imported first and
 * alone, in a fresh module graph, and walked with the frozen walk of test/lib/frozen-walk.ts.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PKG } from "./lib/chain-fixtures.js";
import { problems } from "./lib/frozen-walk.js";

const DIR = join(PKG, "src", "chain-read");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

describe("F3: every export of src/chain-read is frozen at its definition", () => {
  it("the files of src/chain-read are the ones this test walks", () => {
    expect(FILES).toEqual(["bytes.ts", "cross-check.ts", "door.ts", "key-table-types.ts", "key-table.ts", "keys.ts", "node.ts", "read.ts", "result.ts", "session-state.ts", "shape-file.ts"]);
  });

  for (const file of FILES) {
    it(`${file}, imported first and alone: every export, and what it holds`, async () => {
      vi.resetModules();
      const mod = (await import(join(DIR, file.replace(/\.ts$/, ".js")))) as Record<string, unknown>;
      const open: string[] = [];
      for (const [name, value] of Object.entries(mod)) open.push(...problems(value, `${file}:${name}`));
      vi.resetModules();
      expect(open).toEqual([]);
    });
  }

  it("a function of chain-read cannot be changed or given a property", async () => {
    const result = await import("../src/chain-read/result.js");
    expect(() => {
      (result.unknown as unknown as { raw: number }).raw = 1;
    }).toThrow(TypeError);
    expect(Object.getOwnPropertyNames(result.unknown).sort()).toEqual(["length", "name"]);
  });
});
