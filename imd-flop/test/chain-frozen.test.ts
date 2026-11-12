/**
 * P3 fix round, rule H7: everything src/chain exports is frozen where it is defined. Each file is imported
 * first and alone, in a fresh module graph, and a write to each of its exported objects and arrays, at any
 * depth, throws: a change of a field, a new field and a delete.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PKG } from "./lib/chain-fixtures.js";

const DIR = join(PKG, "src", "chain");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

/** Every object reachable from `value`, with its path. Byte arrays are skipped: they cannot be frozen. */
function objects(value: unknown, path: string, out: [string, object][] = [], seen = new Set<object>()): [string, object][] {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || seen.has(value)) return out;
  seen.add(value);
  out.push([path, value]);
  for (const [k, v] of Object.entries(value)) objects(v, `${path}.${k}`, out, seen);
  return out;
}

/** The writes that must throw on a frozen object. Returns the ones that did not. */
function writable(o: object): string[] {
  const r = o as Record<string, unknown>;
  const open: string[] = [];
  const keys = Object.keys(r);
  const tries: [string, () => void][] = [
    ["add a field", () => void (r.__h7_new = 1)],
    ...(keys.length > 0 ? ([["change a field", () => void (r[keys[0]] = null)], ["delete a field", () => void delete r[keys[0]]]] as [string, () => void][]) : []),
    ...(Array.isArray(o) ? ([["push", () => void (o as unknown[]).push(1)]] as [string, () => void][]) : []),
  ];
  for (const [what, write] of tries) {
    try {
      write();
      open.push(what);
    } catch {
      // frozen: the write throws
    }
  }
  return open;
}

describe("H7: every exported object of src/chain is frozen at its definition", () => {
  it("the files of src/chain are the ones this test walks", () => {
    expect(FILES).toEqual(["calls.ts", "describe.ts", "era.ts", "errors.ts", "extrinsic.ts", "fields.ts", "freeze.ts", "reader.ts", "runtimes.ts", "scale.ts", "shape.ts", "table.ts"]);
  });

  for (const file of FILES) {
    it(`${file}, imported first and alone: a write to each exported object throws`, async () => {
      vi.resetModules();
      const mod = (await import(join(DIR, file.replace(/\.ts$/, ".js")))) as Record<string, unknown>;
      const open: string[] = [];
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === "function") continue;
        for (const [path, o] of objects(value, name)) for (const w of writable(o)) open.push(`${path}: ${w}`);
      }
      vi.resetModules();
      expect(open).toEqual([]);
    });
  }

  it("control: the check finds a write to an object that is not frozen", () => {
    expect(writable({ a: 1 })).toEqual(["add a field", "change a field", "delete a field"]);
    expect(objects({ a: { b: [1] } }, "x").map(([p]) => p)).toEqual(["x", "x.a", "x.a.b"]);
  });

  it("the lead's finding: INNER_CALLS.force_open cannot be set to null", async () => {
    const { INNER_CALLS } = await import("../src/chain/calls.js");
    expect(() => {
      (INNER_CALLS as Record<string, unknown>).force_open = null;
    }).toThrow(TypeError);
    expect(INNER_CALLS.force_open).toBe("escrow");
  });
});
