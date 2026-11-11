import { describe, expect, it } from "vitest";
import { canon, canonHash } from "../src/canon.js";

// The reference from IMD's API reference ("canonical JSON: sorted keys, no whitespace, integers only, no undefined").
const reference = (v: any): string => // eslint-disable-line @typescript-eslint/no-explicit-any
  v === null ? "null" : Array.isArray(v) ? `[${v.map(reference).join(",")}]` : typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${reference(v[k])}`).join(",")}}` : JSON.stringify(v);

describe("canonical JSON", () => {
  const samples: unknown[] = [
    null,
    true,
    false,
    0,
    -7,
    Number.MAX_SAFE_INTEGER,
    "",
    'quote " and \\ and \n line',
    "ünïcödé ✓",
    [],
    {},
    [1, [2, [3, { z: 1, a: [null, "x"] }]]],
    { b: 1, a: 2, "": 3, B: 4, "a b": 5, 10: "ten", 9: "nine" },
    { x402Version: 2, payload: { signature: "0xab", permit2Authorization: { nonce: "12", from: "0xF39f", witness: { validAfter: "0", to: "0x4E0f" } } } },
  ];
  it("writes exactly what IMD's reference writes", () => {
    for (const s of samples) expect(canon(s)).toBe(reference(s));
  });
  it("does not depend on the order keys were written in", () => {
    expect(canon({ a: 1, b: { d: 1, c: 2 } })).toBe(canon({ b: { c: 2, d: 1 }, a: 1 }));
    expect(canon({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("holds no whitespace", () => {
    expect(canon({ a: [1, { b: "c d" }] })).toBe('{"a":[1,{"b":"c d"}]}');
  });
  it("refuses a value outside the definition instead of hashing something else", () => {
    for (const bad of [undefined, 1.5, NaN, Infinity, 2 ** 53, 10n, () => 1, Symbol("s"), { a: undefined }, [1.5], { a: { b: 10n } }]) {
      expect(() => canon(bad), String(bad)).toThrow(TypeError);
    }
  });
  it("hashes the canonical text with SHA-256", () => {
    // sha256 of the seven bytes {"a":1}
    expect(canonHash({ a: 1 })).toBe("0x015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
    expect(canonHash({ b: 1, a: 2 })).toBe(canonHash({ a: 2, b: 1 }));
  });
});
