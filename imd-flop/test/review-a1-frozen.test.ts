/**
 * Review of piece A1 (reviewer, not the builder), promise P2: every function and class that src/chain,
 * src/chain-read, src/channel, src/plain-input.ts and src/freeze.ts export is frozen, with its prototype object, and
 * has no own property beyond the ones it is born with. This walk is the reviewer's own, not test/lib/frozen-walk.ts:
 * it lists the files from the folders, reads every own key (symbols and non enumerable keys too) and goes into
 * prototypes and accessors.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PKG } from "./lib/chain-fixtures.js";

const SRC = join(PKG, "src");
const FILES = [
  ...["chain", "chain-read", "channel"].flatMap((d) =>
    readdirSync(join(SRC, d))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `${d}/${f}`),
  ),
  "plain-input.ts",
  "freeze.ts",
].sort();

/** What the reviewer's walk finds open: a value not frozen, or a function with an own key it was not born with. */
function open(value: unknown, path: string, seen: Set<unknown>, out: string[], depth = 0, isProto = false): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value) || depth > 12) return;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    out.push(`${path} is a byte array, which cannot be frozen`);
    return;
  }
  if (!Object.isFrozen(value)) out.push(`${path} is not frozen`);
  if (typeof value === "function") {
    const born = ["length", "name", "prototype"];
    for (const k of Reflect.ownKeys(value)) if (typeof k !== "string" || !born.includes(k)) out.push(`${path} has an own key ${String(k)}`);
  }
  for (const k of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, k)!;
    const p = `${path}.${String(k)}`;
    // A method or a getter on an exported class's prototype is not itself an export: P2 names the functions and
    // classes exported and their prototype objects. Methods are held apart below.
    if (isProto) continue;
    if ("value" in d) {
      if (k !== "constructor") open(d.value, p, seen, out, depth + 1, typeof value === "function" && k === "prototype");
    } else {
      out.push(`${p} is an accessor`);
    }
  }
}

describe("review A1, P2: the reviewer's own walk of every export", () => {
  it("HOLDS: the files walked are every .ts file of the three folders and the two root files", () => {
    expect(FILES.length).toBe(12 + 11 + 5 + 2);
  });

  for (const file of FILES) {
    it(`HOLDS: ${file}: every export, its prototype and every object it reaches by any own key is frozen`, async () => {
      const mod = (await import(join(SRC, file.replace(/\.ts$/, ".js")))) as Record<string, unknown>;
      const out: string[] = [];
      for (const k of Object.keys(mod)) {
        const v = mod[k];
        open(v, `${file}:${k}`, new Set(), out);
        if (typeof v === "function") {
          const proto = Object.getOwnPropertyDescriptor(v, "prototype")?.value;
          if (proto && typeof proto === "object" && !Object.isFrozen(proto)) out.push(`${file}:${k}.prototype is not frozen`);
        }
      }
      expect(out).toEqual([]);
    });
  }
});

describe("review A1, P2 and P14: the methods of an exported class", () => {
  it("DEFECT RA1-4 (info): the methods of ByteReader are functions reachable from an export and are not frozen; a property can be hung on one", async () => {
    const { ByteReader } = await import("../src/chain/scale.js");
    const methods = Object.getOwnPropertyNames(ByteReader.prototype).filter((k) => {
      const d = Object.getOwnPropertyDescriptor(ByteReader.prototype, k)!;
      return k !== "constructor" && typeof d.value === "function";
    });
    expect(methods.length).toBeGreaterThan(0);
    // README "Chain encoder": everything src/chain exports is frozen, functions and classes with their prototypes.
    // What a fix must guarantee, if the lead rules it in: each method is frozen too, or the words say methods are not.
    const openMethods = methods.filter((k) => !Object.isFrozen((ByteReader.prototype as unknown as Record<string, object>)[k]));
    expect(openMethods).toEqual([]);
  });
});
