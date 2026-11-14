/**
 * Piece A1, M5: the one shared freeze helper, src/freeze.ts. It imports nothing; deepFreeze freezes every object and
 * array it reaches and leaves byte arrays as they are; freezeFunction freezes a function, its own prototype
 * object and the methods and accessors on both; and both are frozen.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deepFreeze, freezeFunction } from "../src/freeze.js";
import { PKG } from "./lib/chain-fixtures.js";

const TEXT = readFileSync(join(PKG, "src", "freeze.ts"), "utf8");

describe("M5: src/freeze.ts", () => {
  it("imports nothing, statically, dynamically or by require", () => {
    const forms = /\bimport\b|\brequire\s*\(|\bexport\s+(?:\*|\{[^}]*\})\s*from\b/;
    for (const s of [`import x from "y";`, `import("y")`, `require("y")`, `export * from "y";`, `export { a } from "y";`]) expect(forms.test(s), s).toBe(true);
    expect(forms.test(TEXT)).toBe(false);
  });

  it("exports exactly deepFreeze and freezeFunction", async () => {
    const mod = (await import("../src/freeze.js")) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual(["deepFreeze", "freezeFunction"]);
  });

  it("deepFreeze freezes every object and array it reaches and returns its argument", () => {
    const v = { a: { b: [1, { c: 2 }] }, d: [[3]] };
    expect(deepFreeze(v)).toBe(v);
    for (const o of [v, v.a, v.a.b, v.a.b[1], v.d, v.d[0]]) expect(Object.isFrozen(o)).toBe(true);
  });

  it("deepFreeze leaves a byte array as it is, inside an object too, and hands back a primitive unchanged", () => {
    const bytes = new Uint8Array([1, 2]);
    const v = deepFreeze({ bytes });
    expect(Object.isFrozen(v)).toBe(true);
    expect(v.bytes).toBe(bytes);
    bytes[0] = 9;
    expect(bytes[0]).toBe(9);
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze("x")).toBe("x");
  });

  it("freezeFunction freezes a function and its own prototype object, and returns it", () => {
    function f() {}
    expect(freezeFunction(f)).toBe(f);
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.prototype)).toBe(true);
    class C {
      m() {
        return 1;
      }
    }
    freezeFunction(C);
    expect(Object.isFrozen(C)).toBe(true);
    expect(Object.isFrozen(C.prototype)).toBe(true);
    const arrow = () => 1;
    expect(freezeFunction(arrow)).toBe(arrow);
    expect(Object.isFrozen(arrow)).toBe(true);
  });

  it("freezeFunction also freezes a class's method, static method, getter, setter and symbol keyed method, and nothing deeper", () => {
    const sym = Symbol("m");
    const held = () => 2;
    class C {
      static s() {
        return 1;
      }
      static get sg() {
        return 1;
      }
      static helper = held;
      m() {
        return 1;
      }
      get g() {
        return 1;
      }
      set g(_v: number) {}
      [sym]() {
        return 1;
      }
    }
    freezeFunction(C);
    const proto = C.prototype as unknown as Record<PropertyKey, unknown>;
    const acc = Object.getOwnPropertyDescriptor(C.prototype, "g")!;
    const staticAcc = Object.getOwnPropertyDescriptor(C, "sg")!;
    const fns: [string, unknown][] = [
      ["method", proto.m],
      ["static method", C.s],
      ["symbol keyed method", proto[sym]],
      ["getter", acc.get],
      ["setter", acc.set],
      ["static getter", staticAcc.get],
      ["static field holding a function", C.helper],
    ];
    for (const [what, fn] of fns) expect([what, Object.isFrozen(fn)]).toEqual([what, true]);
    // One level: a property hung on a frozen method is refused, and what the functions hold is not walked into.
    expect(() => Object.defineProperty(proto.m, "x", { value: 1 })).toThrow();
    const inner = { k: 1 };
    function holder() {}
    holder.inner = inner;
    freezeFunction(holder);
    expect(Object.isFrozen(inner)).toBe(false);
  });

  it("both are frozen, and so are their prototype objects", () => {
    for (const f of [deepFreeze, freezeFunction] as Function[]) {
      expect(Object.isFrozen(f)).toBe(true);
      const proto = Object.getOwnPropertyDescriptor(f, "prototype")?.value as unknown;
      expect(typeof proto === "object" && proto !== null && Object.isFrozen(proto)).toBe(true);
    }
  });
});
