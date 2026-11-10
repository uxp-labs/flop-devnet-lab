// The shared strict readings (src/strict.ts): RULES.md 3.1 clause 14 and section 1.1.
import { describe, expect, it } from "vitest";
import { MAX_NESTING, duplicateKey, isSafeInt, nestingDepth, parseZoned, secondsBetween } from "../src/strict.js";

describe("isSafeInt (clause 14)", () => {
  it.each([
    [0, true],
    [-3, true],
    [9007199254740991, true],
    [-9007199254740991, true],
    [9007199254740992, false],
    [-9007199254740992, false],
    [1.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [true, false],
    ["1", false],
    [null, false],
  ])("%s is %s", (v, want) => {
    expect(isSafeInt(v)).toBe(want);
  });

  it("judges by value: JSON 1.0 is the integer 1", () => {
    expect(isSafeInt(JSON.parse("1.0"))).toBe(true);
  });
});

describe("parseZoned (RULES 1.1)", () => {
  const at = (iso: string) => Date.UTC(...(iso.match(/\d+/g)!.slice(0, 6).map(Number) as [number, number, number, number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number, number, number, number]);

  it("reads Z and offset times as the same instant", () => {
    expect(parseZoned("2026-11-09T23:47:41Z")).toBe(at("2026-11-09T23:47:41"));
    expect(parseZoned("2026-11-09T18:47:41-05:00")).toBe(at("2026-11-09T23:47:41"));
    expect(parseZoned("2026-11-10T05:17:41+05:30")).toBe(at("2026-11-09T23:47:41"));
    expect(parseZoned("2026-11-09T23:47Z")).toBe(at("2026-11-09T23:47:00"));
    expect(parseZoned("2026-11-09T23:47:41.5Z")).toBe(at("2026-11-09T23:47:41") + 500);
  });

  it("accepts a real leap day and rejects one that does not exist", () => {
    expect(parseZoned("2024-02-29T00:00:00Z")).toBe(at("2024-02-29T00:00:00"));
    expect(parseZoned("2026-02-29T00:00:00Z")).toBeNull();
    expect(parseZoned("1900-02-29T00:00:00Z")).toBeNull();
    expect(parseZoned("2000-02-29T00:00:00Z")).toBe(at("2000-02-29T00:00:00"));
  });

  it.each([
    "2026-11-31T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-11-00T00:00:00Z",
    "2026-11-09T24:00:00Z",
    "2026-11-09T23:60:00Z",
    "2026-11-09T23:59:60Z",
    "2026-11-09T23:47:41+24:00",
    "2026-11-09T23:47:41+05:60",
  ])("never rolls an impossible time over: %s does not parse", (t) => {
    expect(Number.isNaN(Date.parse(t)) || Date.parse(t) !== null).toBe(true);
    expect(parseZoned(t)).toBeNull();
  });

  it.each(["2026-11-09T23:47:41", "2026-11-09 23:47:41Z", "yesterday", "", "1794268061000"])("needs ISO 8601 with a zone: %s does not parse", (t) => {
    expect(parseZoned(t)).toBeNull();
  });

  it("is never fooled by a non-string", () => {
    expect(parseZoned(1794268061000)).toBeNull();
    expect(parseZoned(null)).toBeNull();
    expect(parseZoned(new Date())).toBeNull();
  });

  it("reads years below 100 as written, never as 19xx", () => {
    expect(new Date(parseZoned("0050-01-01T00:00:00Z") as number).getUTCFullYear()).toBe(50);
  });

  it("gives ages in seconds, null when either time does not parse", () => {
    expect(secondsBetween("2026-11-09T23:45:53Z", "2026-11-09T23:47:53Z")).toBe(120);
    expect(secondsBetween("2026-11-31T00:00:00Z", "2026-12-01T00:00:30Z")).toBeNull();
    expect(secondsBetween("2026-11-09T23:47:53Z", "2026-11-09T23:47:52Z")).toBe(-1);
  });
});

describe("duplicateKey (clause 12: one value per key)", () => {
  it.each([
    ['{"a": 1, "a": 2}', "a"],
    ['{"a": 1, "b": {"c": 1, "c": 2}}', "c"],
    ['[{"x": 1}, {"y": 1, "y": 2}]', "y"],
    ['{"a": 1, "\\u0061": 2}', "a"],
    ['{"page": 0, "events": [], "page": 1}', "page"],
    ['{"q\\"": 1, "q\\"": 2}', 'q"'],
  ])("finds the repeated key in %s", (text, key) => {
    expect(() => JSON.parse(text)).not.toThrow();
    expect(duplicateKey(text)).toBe(key);
  });

  it.each([
    '{"a": 1, "b": 2}',
    '[{"a": 1}, {"a": 2}]',
    '{"a": {"b": 1}, "b": 2}',
    '{"a": "a", "b": ["a", "b", {"a": 1}]}',
    '{"a": "}, \\"a\\": {", "b": 1}',
    '{"a": 1, "\\u0062": 2}',
    "[]",
    "{}",
    '"a"',
    "7",
  ])("finds none in %s: the same key in sibling or nested objects, as a value, or inside a string", (text) => {
    expect(() => JSON.parse(text)).not.toThrow();
    expect(duplicateKey(text)).toBeNull();
  });
});

describe("nestingDepth (clause 12: at most 64 levels, checked before parsing)", () => {
  it.each([
    ["7", 0],
    ["[]", 1],
    ["{}", 1],
    ['{"a": [{"b": 1}]}', 3],
    ['["[[[", "{{{"]', 1],
    ['["\\"[[", 1]', 1],
    ["[[[", 3],
    ["[".repeat(65) + "]".repeat(65), 65],
  ])("%s nests %s deep, brackets inside strings not counted", (text, depth) => {
    expect(nestingDepth(text)).toBe(depth);
  });
  it("the limit is 64", () => {
    expect(MAX_NESTING).toBe(64);
  });
});

