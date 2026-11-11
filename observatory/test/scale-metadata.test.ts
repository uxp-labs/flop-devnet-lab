// The metadata V14 parser (src/scale/metadata.ts): strict, whole, and only version 14. Real
// metadata from the recording, and synthetic metadata from test/helpers/scale-write.ts for each
// type definition kind and each refusal.
import { describe, expect, it } from "vitest";
import { type Metadata, parseMetadata } from "../src/scale/metadata.js";
import { ScaleError } from "../src/scale/reader.js";
import { recorded } from "./helpers/recorded.js";
import { type PalletSpec, type TypeSpec, bytes, cat, def, metadata } from "./helpers/scale-write.js";

const REAL = recorded().metadata;

/** Every type definition kind once, and a pallet with a plain and a map entry, a constant and its type ids. */
const ALL_KINDS: TypeSpec[] = [
  { def: def.primitive("u8") }, // 0
  { path: ["H256"], def: def.composite([{ type: 2 }]) }, // 1
  { def: def.array(32, 0) }, // 2
  { def: def.sequence(0) }, // 3
  { def: def.tuple([0, 5]) }, // 4
  { def: def.primitive("u128") }, // 5
  { def: def.compact(5) }, // 6
  { path: ["Event"], def: def.variant([{ name: "A", index: 0, fields: [{ name: "id", type: 1, typeName: "H256" }] }, { name: "B", index: 3 }]) }, // 7
  { path: ["bitvec", "order", "Lsb0"], def: def.composite([]) }, // 8
  { def: def.bitSequence(0, 8) }, // 9
  { path: ["Option"], params: [{ name: "T", type: 5 }, { name: "U", type: null }], def: def.variant([{ name: "None", index: 0 }, { name: "Some", index: 1, fields: [{ type: 5 }] }]) }, // 10
];
const ALL_PALLETS: PalletSpec[] = [
  {
    name: "Things",
    index: 7,
    entries: [
      { name: "Count", plain: 5, modifier: 1, fallback: bytes(...new Array(16).fill(0)) },
      { name: "ById", map: { hashers: ["Blake2_128Concat"], key: 1, value: 5 } },
      { name: "ByPair", map: { hashers: ["Twox64Concat", "Identity"], key: 4, value: 9 } },
    ],
    event: 7,
    calls: 7,
    error: 7,
    constants: [{ name: "Max", type: 5, value: bytes(...new Array(16).fill(1)) }],
  },
];
const parse = (b: Uint8Array) => parseMetadata(b);
const refusal = (b: Uint8Array): string => {
  try {
    parseMetadata(b);
  } catch (e) {
    if (e instanceof ScaleError) return e.message;
    throw e;
  }
  throw new Error("parsed, not refused");
};

describe("the recorded metadata", () => {
  it("parses whole, all 482132 bytes, as version 14", () => {
    const m = parse(REAL);
    expect(m.version).toBe(14);
    expect(m.types.length).toBeGreaterThan(800);
    expect(m.types.every((t, i) => t.id === i)).toBe(true);
  });

  it("names each pallet with its index, and ComputeChannel is pallet 103 with 63 storage entries", () => {
    const m = parse(REAL);
    const cc = m.pallets.find((p) => p.name === "ComputeChannel");
    expect(cc?.index).toBe(103);
    expect(cc?.storage?.prefix).toBe("ComputeChannel");
    expect(cc?.storage?.entries.length).toBe(63);
    expect(m.pallets.find((p) => p.name === "System")?.index).toBe(0);
    expect(new Set(m.pallets.map((p) => p.index)).size).toBe(m.pallets.length);
  });

  it("refuses the metadata cut by one byte, or with one byte more", () => {
    // The runtime type is the last value, a compact of two bytes: cut by one, it is cut short.
    expect(refusal(REAL.subarray(0, REAL.length - 1))).toBe("the runtime type at byte 482130: needs 2 bytes, 1 left");
    expect(refusal(cat(REAL, bytes(0)))).toBe("the metadata ends at byte 482132, 1 bytes before the end");
  });
});

describe("the structure, every kind", () => {
  it("reads every type definition kind, with paths, params, fields and variants", () => {
    const m: Metadata = parse(metadata(ALL_KINDS, ALL_PALLETS));
    expect(m.types.map((t) => t.def.kind)).toEqual(["primitive", "composite", "array", "sequence", "tuple", "primitive", "compact", "variant", "composite", "bitSequence", "variant"]);
    expect(m.types.at(1)).toEqual({ id: 1, path: ["H256"], params: [], def: { kind: "composite", fields: [{ name: null, type: 2, typeName: null, docs: [] }] }, docs: [] });
    expect(m.types.at(2)?.def).toEqual({ kind: "array", len: 32, type: 0 });
    expect(m.types.at(4)?.def).toEqual({ kind: "tuple", types: [0, 5] });
    expect(m.types.at(9)?.def).toEqual({ kind: "bitSequence", store: 0, order: 8 });
    expect(m.types.at(10)?.params).toEqual([{ name: "T", type: 5 }, { name: "U", type: null }]);
    expect(m.types.at(7)?.def).toEqual({
      kind: "variant",
      variants: [
        { name: "A", index: 0, fields: [{ name: "id", type: 1, typeName: "H256", docs: [] }], docs: [] },
        { name: "B", index: 3, fields: [], docs: [] },
      ],
    });
  });

  it("reads each pallet: storage with modifiers, hashers, keys and values, calls, event, error and constants", () => {
    const [p] = parse(metadata(ALL_KINDS, ALL_PALLETS)).pallets;
    expect(p).toMatchObject({ name: "Things", index: 7, calls: 7, event: 7, error: 7 });
    expect(p?.storage?.entries.map((e) => [e.name, e.modifier, e.hashers, e.key, e.value])).toEqual([
      ["Count", "Default", [], null, 5],
      ["ById", "Optional", ["Blake2_128Concat"], 1, 5],
      ["ByPair", "Optional", ["Twox64Concat", "Identity"], 4, 9],
    ]);
    expect(Buffer.from(p?.storage?.entries.at(0)?.fallback ?? []).toString("hex")).toBe("00".repeat(16));
    expect(p?.constants.map((c) => [c.name, c.type, Buffer.from(c.value).toString("hex")])).toEqual([["Max", 5, "01".repeat(16)]]);
  });

  it("reads the extrinsic section and the runtime type", () => {
    const m = parse(metadata(ALL_KINDS, ALL_PALLETS, { type: 3, version: 4 }, 7));
    expect(m.extrinsic).toEqual({ type: 3, version: 4, signedExtensions: [{ identifier: "CheckNonce", type: 0, additionalSigned: 0 }] });
    expect(m.runtimeType).toBe(7);
  });
});

describe("refusals", () => {
  const ok = () => metadata(ALL_KINDS, ALL_PALLETS);
  it("refuses another magic, and any version but 14, saying which version it met", () => {
    expect(refusal(cat(bytes(0x6d, 0x65, 0x74, 0x62), ok().subarray(4)))).toBe("not metadata: the first four bytes are 0x6d657462, not 0x6d657461 (meta)");
    for (const v of [13, 15, 16, 0]) expect(refusal(metadata(ALL_KINDS, ALL_PALLETS, undefined, 0, v))).toBe(`metadata version ${v}: this parser reads version 14 only`);
    expect(refusal(bytes(0x6d, 0x65))).toMatch(/^the magic at byte 0: needs 4 bytes, 2 left$/);
  });

  it.each([
    ["a type whose id is not its place", () => metadata([{ def: def.primitive("u8") }, { def: def.primitive("u8") }], []).fill(8, 6, 7), "type 0 has id 2: ids must count from 0 in order"],
    ["a type that names a type that does not exist", () => metadata([{ def: def.sequence(9) }], []), "type 0 names type 9, which does not exist"],
    ["a pallet that names a type that does not exist", () => metadata(ALL_KINDS, [{ ...(ALL_PALLETS.at(0) as PalletSpec), event: 99 }]), "pallet Things names type 99, which does not exist"],
    ["the runtime type out of range", () => metadata(ALL_KINDS, ALL_PALLETS, undefined, 50), "the runtime type names type 50, which does not exist"],
    ["a composite mixing named and unnamed fields", () => metadata([{ def: def.primitive("u8") }, { def: def.composite([{ name: "a", type: 0 }, { type: 0 }]) }], []), "type 1: fields are either all named or all unnamed"],
    ["a composite naming one field twice", () => metadata([{ def: def.primitive("u8") }, { def: def.composite([{ name: "a", type: 0 }, { name: "a", type: 0 }]) }], []), 'type 1: the field "a" is named twice'],
    ["a variant index used twice", () => metadata([{ def: def.variant([{ name: "A", index: 1 }, { name: "B", index: 1 }]) }], []), "type 0: the variant index 1 is used twice"],
    ["a variant name used twice", () => metadata([{ def: def.variant([{ name: "A", index: 1 }, { name: "A", index: 2 }]) }], []), 'type 0: the variant "A" is named twice'],
    ["an unknown type definition kind", () => cat(metadata([], []).subarray(0, 5), bytes(4, 0, 0, 0, 8)), "type 0: 8 is no type definition kind"],
    ["an unknown primitive", () => cat(metadata([], []).subarray(0, 5), bytes(4, 0, 0, 0, 5, 15)), "type 0: 15 is no primitive"],
    ["two pallets with one index", () => metadata(ALL_KINDS, [ALL_PALLETS.at(0) as PalletSpec, { name: "Other", index: 7 }]), "pallet Other has the index 7 of another pallet"],
    ["two pallets with one name", () => metadata(ALL_KINDS, [ALL_PALLETS.at(0) as PalletSpec, { name: "Things", index: 8 }]), "the pallet name Things is used twice"],
    ["a map of two hashers whose key is no pair", () => metadata(ALL_KINDS, [{ name: "P", index: 1, entries: [{ name: "M", map: { hashers: ["Identity", "Identity"], key: 1, value: 0 } }] }]), "storage P.M has 2 hashers, so its key must be a tuple of 2 types"],
    ["a map with no hasher", () => metadata(ALL_KINDS, [{ name: "P", index: 1, entries: [{ name: "M", map: { hashers: [], key: 1, value: 0 } }] }]), "storage P.M is a map with no hasher"],
    ["a storage entry named twice", () => metadata(ALL_KINDS, [{ name: "P", index: 1, entries: [{ name: "M", plain: 0 }, { name: "M", plain: 0 }] }]), "storage P.M is named twice"],
  ])("refuses %s", (_what, make, says) => {
    expect(refusal(make())).toBe(says);
  });
});
