// Decoding by type (src/scale/decode.ts): each form decided by the type, never by the value, each
// limit a refusal, and real values from the recording decoded whole.
import { describe, expect, it } from "vitest";
import { MAX_DEPTH, decodeValue, valueBudget } from "../src/scale/decode.js";
import { type Metadata, parseMetadata } from "../src/scale/metadata.js";
import { ScaleError } from "../src/scale/reader.js";
import { recorded } from "./helpers/recorded.js";
import { type TypeSpec, bool, bytes, cat, compact, def, le, metadata, str, u8, u32 } from "./helpers/scale-write.js";

const PRIMS = ["bool", "char", "str", "u8", "u16", "u32", "u64", "u128", "u256", "i8", "i16", "i32", "i64", "i128", "i256"] as const;
/** Types 0 to 14 are the primitives in order; the rest are built on them. */
const T = Object.fromEntries(PRIMS.map((p, i) => [p, i])) as Record<(typeof PRIMS)[number], number>;
const TYPES: TypeSpec[] = [
  ...PRIMS.map((p) => ({ def: def.primitive(p) })),
  { def: def.array(32, T.u8) }, // 15 [u8; 32]
  { path: ["primitive_types", "H256"], def: def.composite([{ type: 15 }]) }, // 16 H256
  { def: def.sequence(T.u8) }, // 17 Vec<u8>
  { def: def.sequence(T.u32) }, // 18 Vec<u32>
  { def: def.array(2, T.u16) }, // 19 [u16; 2]
  { def: def.tuple([T.u8, T.u64]) }, // 20 (u8, u64)
  { def: def.tuple([]) }, // 21 ()
  { def: def.compact(T.u32) }, // 22 Compact<u32>
  { def: def.compact(T.u128) }, // 23 Compact<u128>
  { path: ["Perbill"], def: def.composite([{ type: T.u32 }]) }, // 24 Perbill(u32)
  { def: def.compact(24) }, // 25 Compact<Perbill>
  { path: ["Point"], def: def.composite([{ name: "x", type: T.i32 }, { name: "y", type: T.u128 }]) }, // 26
  { path: ["Pair"], def: def.composite([{ type: T.u8 }, { type: T.bool }]) }, // 27
  { path: ["Unit"], def: def.composite([]) }, // 28
  { path: ["Option"], params: [{ name: "T", type: T.u64 }], def: def.variant([{ name: "None", index: 0 }, { name: "Some", index: 1, fields: [{ type: T.u64 }] }]) }, // 29
  { path: ["Event"], def: def.variant([{ name: "Moved", index: 4, fields: [{ name: "who", type: 16 }, { name: "to", type: 26 }] }, { name: "Two", index: 9, fields: [{ type: T.u8 }, { type: T.u8 }] }]) }, // 30
  { path: ["Deep"], def: def.composite([{ name: "next", type: 32 }]) }, // 31 Deep { next: Option<Deep> }
  { path: ["Option"], params: [{ name: "T", type: 31 }], def: def.variant([{ name: "None", index: 0 }, { name: "Some", index: 1, fields: [{ type: 31 }] }]) }, // 32
  { def: def.sequence(28) }, // 33 Vec<Unit>
  { def: def.array(1000, 28) }, // 34 [Unit; 1000]
  { def: def.array(1000, 34) }, // 35 [[Unit; 1000]; 1000]
  { path: ["bitvec", "order", "Lsb0"], def: def.composite([]) }, // 36
  { def: def.bitSequence(T.u8, 36) }, // 37
  { def: def.compact(T.u8) }, // 38 Compact<u8>
  { def: def.compact(26) }, // 39 Compact<Point>: not read
  { path: ["Named"], def: def.composite([{ name: "v", type: T.u32 }]) }, // 40
  { def: def.compact(40) }, // 41 Compact<Named>
];
const MD: Metadata = parseMetadata(metadata(TYPES, []));
const dec = (id: number, b: Uint8Array) => decodeValue(MD, id, b);
const refusal = (id: number, b: Uint8Array): string => {
  try {
    dec(id, b);
  } catch (e) {
    if (e instanceof ScaleError) return e.message;
    throw e;
  }
  throw new Error("decoded, not refused");
};
const H = `0x${"ab".repeat(32)}`;
const hb = () => new Uint8Array(32).fill(0xab);

describe("integers: the type decides the form", () => {
  it("gives u8 to u32 and i8 to i32 as numbers", () => {
    expect(dec(T.u8, u8(255))).toBe(255);
    expect(dec(T.u16, le(65535, 2))).toBe(65535);
    expect(dec(T.u32, le(0xffffffff, 4))).toBe(4294967295);
    expect(dec(T.i8, u8(0x80))).toBe(-128);
    expect(dec(T.i32, le(-2, 4))).toBe(-2);
  });

  it("gives every u64, u128, u256, i64, i128 and i256 as a decimal string, however small", () => {
    expect(dec(T.u64, le(5, 8))).toBe("5");
    expect(dec(T.u64, le(0, 8))).toBe("0");
    expect(dec(T.u128, le(112860000000000002n, 16))).toBe("112860000000000002");
    expect(dec(T.u256, le((1n << 256n) - 1n, 32))).toBe(((1n << 256n) - 1n).toString());
    expect(dec(T.i64, le(-5, 8))).toBe("-5");
    expect(dec(T.i128, le(-(1n << 127n), 16))).toBe((-(1n << 127n)).toString());
    expect(dec(T.i256, le(-1, 32))).toBe("-1");
  });

  it("reads a compact as its type, refusing one that does not fit it", () => {
    expect(dec(22, compact(1014014))).toBe(1014014);
    expect(dec(23, compact(1n << 100n))).toBe((1n << 100n).toString());
    expect(dec(23, compact(7))).toBe("7");
    expect(dec(25, compact(500000000))).toBe(500000000);
    expect(dec(41, compact(3))).toEqual({ v: 3 });
    expect(refusal(38, compact(256))).toBe("type 38, a Compact<u8> at byte 0: 256 does not fit a u8");
    expect(refusal(22, compact(1n << 32n))).toBe("type 22, a Compact<u32> at byte 0: 4294967296 does not fit a u32");
    expect(refusal(39, compact(1))).toBe("type 39: a compact of type 26 (Point) is not read, only of an unsigned integer or one field around one");
  });
});

describe("the other forms", () => {
  it("gives bools, chars and strings", () => {
    expect(dec(T.bool, bool(true))).toBe(true);
    expect(dec(T.char, u32(0x1f642))).toBe("\u{1f642}");
    expect(refusal(T.char, u32(0xd800))).toBe("type 1, a char at byte 0: 55296 is no Unicode scalar value");
    expect(dec(T.str, str("tzkv-runtime"))).toBe("tzkv-runtime");
  });

  it("gives byte arrays and byte vectors as hex, and an H256 as hex through its one unnamed field", () => {
    expect(dec(15, hb())).toBe(H);
    expect(dec(16, hb())).toBe(H);
    expect(dec(17, cat(compact(3), bytes(1, 2, 255)))).toBe("0x0102ff");
    expect(dec(17, compact(0))).toBe("0x");
  });

  it("gives other sequences, arrays and tuples as lists, and the empty tuple as null", () => {
    expect(dec(18, cat(compact(2), u32(7), u32(8)))).toEqual([7, 8]);
    expect(dec(19, cat(le(1, 2), le(2, 2)))).toEqual([1, 2]);
    expect(dec(20, cat(u8(1), le(2, 8)))).toEqual([1, "2"]);
    expect(dec(21, new Uint8Array())).toBe(null);
  });

  it("gives named fields as an object, several unnamed as a list, and none as null", () => {
    expect(dec(26, cat(le(-3, 4), le(9, 16)))).toEqual({ x: -3, y: "9" });
    expect(dec(27, cat(u8(1), bool(false)))).toEqual([1, false]);
    expect(dec(28, new Uint8Array())).toBe(null);
  });

  it("gives a variant as its name and its fields, Option included", () => {
    expect(dec(29, u8(0))).toEqual({ variant: "None", fields: null });
    expect(dec(29, cat(u8(1), le(6, 8)))).toEqual({ variant: "Some", fields: "6" });
    expect(dec(30, cat(u8(4), hb(), le(1, 4), le(2, 16)))).toEqual({ variant: "Moved", fields: { who: H, to: { x: 1, y: "2" } } });
    expect(dec(30, cat(u8(9), u8(1), u8(2)))).toEqual({ variant: "Two", fields: [1, 2] });
  });

  it("keeps a field named after an inherited property as data", () => {
    const md = parseMetadata(metadata([{ def: def.primitive("u8") }, { def: def.composite([{ name: "__proto__", type: 0 }, { name: "constructor", type: 0 }]) }], []));
    const v = decodeValue(md, 1, bytes(1, 2)) as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(["__proto__", "constructor"]);
    expect(JSON.stringify(v)).toBe('{"__proto__":1,"constructor":2}');
  });
});

describe("limits and refusals", () => {
  it("refuses a variant index that is none of the type's", () => {
    expect(refusal(30, u8(5))).toBe("type 30 (Event) at byte 0: 5 is not the index of one of its variants");
  });

  it(`refuses a type nested deeper than ${MAX_DEPTH} levels, and reads one just inside`, () => {
    // Deep { next: Option<Deep> }: each Some adds two levels.
    const nest = (n: number) => cat(...new Array(n).fill(u8(1)), u8(0));
    expect(() => dec(31, nest(14))).not.toThrow();
    expect(refusal(31, nest(16))).toBe(`type 31 (Deep) nests deeper than ${MAX_DEPTH} levels`);
  });

  it("refuses a sequence or an array of more elements than bytes left, whatever the element type", () => {
    expect(refusal(18, cat(compact(5), u32(1)))).toBe("type 18, a length at byte 0: 5 cannot fit in the 4 bytes left");
    expect(dec(33, compact(0))).toEqual([]);
    expect(refusal(33, cat(compact(2), bytes(0)))).toBe("type 33, a length at byte 0: 2 cannot fit in the 1 bytes left");
    expect(refusal(34, new Uint8Array(10))).toBe("type 34 at byte 0: 1000 elements cannot fit in the 10 bytes left");
  });

  it("refuses to build more than 1024 values and 8 a byte, so no value of few bytes takes long", () => {
    expect(valueBudget(0)).toBe(1024);
    expect(valueBudget(100)).toBe(1824);
    // A thousand units fit in a thousand bytes left, and a million would take far longer than their bytes.
    expect(refusal(35, new Uint8Array(1000))).toMatch(/^type 28 \(Unit\) at byte 0: more values than the bytes can hold \(at most 1024 and 8 a byte\)$/);
  });

  it("refuses a bit sequence, which it does not read", () => {
    expect(refusal(37, cat(compact(8), u8(0xff)))).toBe("type 37: a bit sequence, which this decoder does not read");
  });

  it("refuses a value that does not end exactly at the end of its bytes, and one cut short", () => {
    expect(refusal(T.u32, le(1, 5))).toBe("type 5 ends at byte 4, 1 bytes before the end");
    expect(refusal(26, le(1, 4))).toBe("type 7, a u128 at byte 4: needs 16 bytes, 0 left");
    expect(refusal(99, u8(0))).toBe("type 99 does not exist");
    // at() would read -1 as the last type: an id below 0 names nothing, in the refusal too.
    expect(refusal(-1, u8(0))).toBe("type -1 does not exist");
    expect(refusal(1.5, u8(0))).toBe("type 1.5 does not exist");
  });
});

describe("real values from the recording", () => {
  const r = recorded();
  const md = parseMetadata(r.metadata);
  const sys = md.pallets.find((p) => p.name === "System");
  const entry = (name: string) => sys?.storage?.entries.find((e) => e.name === name);

  it("decodes System.LastRuntimeUpgrade at every block as spec 1014014 of tzkv-runtime", () => {
    const lru = entry("LastRuntimeUpgrade");
    for (const b of r.blocks) expect(decodeValue(md, lru?.value as number, b.lastRuntimeUpgrade)).toEqual({ spec_version: 1014014, spec_name: "tzkv-runtime" });
  });

  it("decodes the System.Version constant to what state_getRuntimeVersion answered at the same block, its apis in another order", () => {
    const c = sys?.constants.find((x) => x.name === "Version");
    const v = decodeValue(md, c?.type as number, c?.value as Uint8Array) as Record<string, unknown>;
    const rv = r.runtimeVersion;
    // The node lists the same 17 apis in another order than the constant holds them.
    const sorted = (a: unknown) => [...(a as [string, number][])].sort(([x], [y]) => (x < y ? -1 : 1));
    expect(sorted(v.apis)).toEqual(sorted(rv.apis));
    expect(v.apis).not.toEqual(rv.apis);
    expect({ ...v, apis: null }).toEqual({
      spec_name: rv.specName,
      impl_name: rv.implName,
      authoring_version: rv.authoringVersion,
      spec_version: rv.specVersion,
      impl_version: rv.implVersion,
      apis: null,
      transaction_version: rv.transactionVersion,
      system_version: rv.systemVersion ?? rv.stateVersion,
    });
  });

  it("decodes each of the twelve System.Events values whole, to its last byte", () => {
    const ev = entry("Events");
    for (const b of r.blocks) {
      const v = decodeValue(md, ev?.value as number, b.events);
      expect(Array.isArray(v), `block ${b.number}`).toBe(true);
    }
  });
});
