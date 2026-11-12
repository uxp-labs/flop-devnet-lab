// An independent review of the decoder (src/scale, src/hash; RULES.md section 9), written by a
// reviewer who wrote none of it. Three kinds of test:
//   DEFECT n   asserts today's wrong behaviour, so it passes now and fails once the defect is fixed;
//   GAP n      asserts behaviour that is right today but that a behaviour changing mutant breaks
//              while every author test still passes (the mutants are in test/helpers/review-mutants.json);
//   HELD       an attack that failed: the decoder kept its promise.
// Timing claims are measured ratios between two sizes, the fastest of several runs, with wide margins.
// DEFECT 9 (the source scan) is proved outside vitest by test/helpers/review-scan-misses.mjs, since
// vitest blocks the native parser the scan needs.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { blake2b as nobleBlake2b } from "@noble/hashes/blake2.js";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { Blake2128, Blake2128Concat, Blake2256, Twox128, Twox256, Twox64Concat, decAnyMetadata, metadata as metadataCodec, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import { blake2b } from "../src/hash/blake2b.js";
import { xxhash64 } from "../src/hash/xxhash64.js";
import { decodeBlockEvents } from "../src/scale/block.js";
import { decodeValue, typeLabel } from "../src/scale/decode.js";
import { decodeEvents } from "../src/scale/events.js";
import { type Metadata, parseMetadata } from "../src/scale/metadata.js";
import { ScaleError, toHex } from "../src/scale/reader.js";
import { MAX_NAME_LENGTH, MAX_SHAPE_CHARS, MAX_SHAPE_STEPS, type PinInput, deriveShape, namer, pinShape, shapeText, typeName } from "../src/scale/shape.js";
import { hashKeyPart, storageKey } from "../src/scale/storage-key.js";
import { plain } from "./helpers/plain.js";
import { seeded } from "./helpers/random.js";
import { recorded } from "./helpers/recorded.js";
import { referenceShape } from "./helpers/reference-shape.js";
import { TooDeep, writer } from "./helpers/review-gen.js";
import { type PalletSpec, type TypeSpec, bytes, cat, compact, def, metadata, str, typeEntry, u32, u8, vec } from "./helpers/scale-write.js";

const R = recorded();
const MD = parseMetadata(R.metadata);
const REF = decAnyMetadata(R.metadata);
const BUILDER = getDynamicBuilder(getLookupFn(unifyMetadata(REF)));
const SHAPE = readFileSync(new URL("../shapes/tzkv-runtime-1014014.json", import.meta.url), "utf8");
const BLOCK = R.blocks.at(4);

/** What a call threw: its class name and message, or "returned" when it returned. */
function thrown(f: () => unknown): { cls: string; message: string } {
  try {
    f();
  } catch (e) {
    return { cls: e instanceof ScaleError ? "ScaleError" : (e as Error).constructor.name, message: (e as Error).message };
  }
  return { cls: "returned", message: "" };
}

/** The fastest of runs timings of f, in milliseconds. */
function fastest(f: () => unknown, runs = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

/** The recorded metadata through the reference's own codec, changed by edit, written again. */
type V14 = { lookup: { id: number; path: string[]; params: unknown[]; def: { tag: string; value: unknown }; docs: string[] }[] };
function edited(edit: (v: V14) => void): Uint8Array {
  const m = metadataCodec.dec(R.metadata);
  edit((m.metadata as unknown as { value: V14 }).value);
  return metadataCodec.enc(m);
}
const idOf = (pred: (t: Metadata["types"][number]) => boolean): number => {
  const t = MD.types.find(pred);
  if (t === undefined) throw new Error("no such type in the recorded metadata");
  return t.id;
};
const U128 = idOf((t) => t.def.kind === "primitive" && t.def.primitive === "u128");
const BYTES20 = idOf((t) => t.def.kind === "array" && t.def.len === 20 && MD.types.at(t.def.type)?.def.kind === "primitive");
const PRECISION = idOf((t) => t.path.at(-1) === "ModelPrecision");
const SLA = idOf((t) => t.path.at(-1) === "Sla");
const H256 = idOf((t) => t.path.at(-1) === "H256");

/**
 * A small metadata with what deriveShape and decodeEvents look for: System (a Version constant,
 * Events, LastRuntimeUpgrade), ComputeChannel (its event enum, Channels) and FlopSessionKeys
 * (Sessions, SessionNonces, CircuitBreakers). The event enum has one
 * event E, whose fields are given; extra types follow from id 12.
 */
function shapeMetadata(o: { eventFields?: { name: string; type: number }[]; record?: { name: string; type: number }[]; extra?: TypeSpec[]; constants?: { name: string; type: number; value: Uint8Array }[]; sessionKeys?: string[]; sessionFallback?: Uint8Array }): Uint8Array {
  const types: TypeSpec[] = [
    { def: def.primitive("u8") }, // 0
    { def: def.primitive("str") }, // 1
    { def: def.primitive("u32") }, // 2
    { path: ["RuntimeVersion"], def: def.composite([{ name: "spec_name", type: 1 }, { name: "spec_version", type: 2 }]) }, // 3
    { def: def.tuple([]) }, // 4
    { path: ["EventRecord"], def: def.composite(o.record ?? [{ name: "phase", type: 4 }, { name: "event", type: 7 }, { name: "topics", type: 4 }]) }, // 5
    { def: def.sequence(5) }, // 6
    { path: ["RuntimeEvent"], def: def.variant([{ name: "ComputeChannel", index: 1, fields: [{ type: 8 }] }]) }, // 7
    { path: ["Event"], def: def.variant([{ name: "E", index: 0, fields: o.eventFields ?? [] }]) }, // 8
    { path: ["LastRuntimeUpgradeInfo"], def: def.composite([{ name: "spec_version", type: 2 }, { name: "spec_name", type: 1 }]) }, // 9
    { path: ["Channel"], def: def.composite([{ name: "state", type: 11 }]) }, // 10
    { path: ["ChannelState"], def: def.variant([{ name: "Open", index: 0 }]) }, // 11
    ...(o.extra ?? []),
  ];
  const pallets: PalletSpec[] = [
    {
      name: "System",
      index: 0,
      entries: [{ name: "Events", plain: 6 }, { name: "LastRuntimeUpgrade", plain: 9 }],
      constants: o.constants ?? [{ name: "Version", type: 3, value: cat(str("tzkv-runtime"), u32(1014014)) }],
    },
    { name: "ComputeChannel", index: 1, event: 8, entries: [{ name: "Channels", map: { hashers: ["Blake2_128Concat"], key: 0, value: 10 } }] },
    {
      name: "FlopSessionKeys",
      index: 2,
      entries: (o.sessionKeys ?? ["Sessions", "SessionNonces", "CircuitBreakers"]).map((name) => ({ name, map: { hashers: ["Blake2_128Concat"], key: 0, value: 2 }, ...(name === "Sessions" && o.sessionFallback ? { fallback: o.sessionFallback } : {}) })),
    },
  ];
  return metadata(types, pallets);
}

describe("crashes that are not a ScaleError", () => {
  it("review defect 1, fixed: typeName refuses with a ScaleError, not a RangeError, a name past its length on 2.2 MB of metadata: one long path part named 250 times", () => {
    const md = parseMetadata(metadata([{ path: ["a".repeat(2_200_000)], def: def.tuple([]) }, { def: def.tuple(new Array(250).fill(0)) }], []));
    expect(thrown(() => typeName(md, 1))).toEqual({ cls: "ScaleError", message: `the name of type 0 is longer than ${MAX_NAME_LENGTH} characters` });
  });

  it("review defect 1, fixed: a name below the string limit is refused too once it passes the stated length, as soon as it does", () => {
    const md = parseMetadata(metadata([{ path: ["a".repeat(100)], def: def.tuple([]) }, { def: def.tuple(new Array(250).fill(0)) }], []));
    expect(thrown(() => typeName(md, 1))).toEqual({ cls: "ScaleError", message: `the name of type 1 is longer than ${MAX_NAME_LENGTH} characters` });
    const ok = parseMetadata(metadata([{ path: ["a".repeat(100)], def: def.tuple([]) }, { def: def.tuple(new Array(10).fill(0)) }], []));
    expect(typeName(ok, 1).length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it("review defect 1, fixed: deriveShape refuses the same name through an event field of that type with a ScaleError", () => {
    const b = shapeMetadata({ eventFields: [{ name: "x", type: 13 }], extra: [{ path: ["a".repeat(2_200_000)], def: def.tuple([]) }, { def: def.tuple(new Array(250).fill(12)) }] });
    expect(thrown(() => deriveShape(parseMetadata(b)))).toEqual({ cls: "ScaleError", message: `the name of type 12 is longer than ${MAX_NAME_LENGTH} characters` });
  });

  it("review defect 1, fixed: one deriveShape has one budget of steps and characters, and the real shape uses a small part of it", () => {
    const n = namer(MD);
    deriveShape(MD, n);
    const steps = MAX_SHAPE_STEPS - n.steps.left;
    const chars = MAX_SHAPE_CHARS - n.chars.left;
    expect({ steps, chars }).toEqual({ steps: 9733, chars: 18449 });
    // Past either budget, a ScaleError.
    const tight = namer(MD);
    tight.steps.left = 100;
    expect(thrown(() => deriveShape(MD, tight)).message).toMatch(/^the shape takes more than 1000000 steps, at type -?\d+$/);
    const few = namer(MD);
    few.chars.left = 100;
    expect(thrown(() => deriveShape(MD, few)).message).toBe("the shape writes more than 4000000 characters of names and paths");
  });

  it("review defect 10, fixed: the hashes refuse an out of range digest length or seed with a RangeError, a caller's mistake, and hashKeyPart refuses a hasher it does not know with a ScaleError", () => {
    expect(thrown(() => blake2b(new Uint8Array(), 0)).cls).toBe("RangeError");
    expect(thrown(() => blake2b(new Uint8Array(), 65)).cls).toBe("RangeError");
    expect(thrown(() => xxhash64(new Uint8Array(), 1n << 64n)).cls).toBe("RangeError");
    expect(thrown(() => xxhash64(new Uint8Array(), -1n)).cls).toBe("RangeError");
    expect(thrown(() => hashKeyPart("Blake2_512" as never, new Uint8Array([1])))).toEqual({ cls: "ScaleError", message: '"Blake2_512" is no storage hasher' });
  });
});

describe("work that is not bounded by a constant a step", () => {
  // A tuple type with a path of N empty parts (one byte each), visited L times by a value of L bytes.
  const pathCase = (n: number, l: number) => {
    const md = parseMetadata(metadata([{ path: new Array(n).fill(""), def: def.tuple([]) }, { def: def.primitive("u8") }, { def: def.array(l, 0) }, { def: def.array(l, 1) }, { def: def.tuple([2, 3]) }], []));
    const b = new Uint8Array(l);
    return () => decodeValue(md, 4, b);
  };

  it("review defect 2, fixed: decodeValue's time grows with the value, not with the product of a type's path and the value: 4 times each takes well under 16 times", () => {
    const small = fastest(pathCase(5_000, 400), 5);
    const large = fastest(pathCase(20_000, 1_600), 3);
    // The product would be about 16; linear in what is read is about 4.
    expect(large / small).toBeLessThan(8);
  });

  it("review defect 2, fixed: a type's path is not read on a step that succeeds, only for a refusal", () => {
    const md = parseMetadata(metadata([{ path: ["P"], def: def.primitive("bool") }, { def: def.array(50, 0) }], []));
    const reads = { n: 0 };
    const t = md.types.at(0) as Metadata["types"][number];
    const path = t.path;
    Object.defineProperty(t, "path", {
      get() {
        reads.n++;
        return path;
      },
    });
    expect(decodeValue(md, 1, new Uint8Array(50))).toEqual(new Array(50).fill(false));
    expect(reads.n).toBe(0);
    expect(thrown(() => decodeValue(md, 1, cat(new Uint8Array(49), u8(2)))).message).toBe("type 0 (P), a bool at byte 49: 2 is neither 0 nor 1");
    expect(reads.n).toBeGreaterThan(0);
  });

  it("review defect 2, fixed: the value of 1600 bytes and 20000 bytes of metadata decodes, and a refusal shows at most 120 characters of the path", () => {
    expect(pathCase(20_000, 1_600)()).toEqual([Array(1_600).fill(null), `0x${"00".repeat(1_600)}`]);
    const md = parseMetadata(metadata([{ path: ["a".repeat(100_000), "b"], def: def.primitive("bool") }], []));
    const r = thrown(() => decodeValue(md, 0, bytes(2)));
    expect(r).toEqual({ cls: "ScaleError", message: `type 0 (${"a".repeat(120)}...), a bool at byte 0: 2 is neither 0 nor 1` });
    expect(typeLabel(parseMetadata(metadata([{ path: ["x", "y"], def: def.primitive("bool") }], [])), 0)).toBe("type 0 (x::y)");
  });

  // An event of F fields, each of a type with P type parameters of no type (3 bytes each).
  const paramCase = (f: number, p: number) => {
    const md = parseMetadata(
      shapeMetadata({
        eventFields: Array.from({ length: f }, (_, i) => ({ name: `f${i}`, type: 12 })),
        extra: [{ path: ["P"], params: Array.from({ length: p }, () => ({ name: "T", type: null })), def: def.tuple([]) }],
      }),
    );
    return () => deriveShape(md);
  };

  it("review defect 3, fixed: deriveShape is linear: 4 times an event's fields and a type's parameters takes well under 16 times the time", () => {
    const small = fastest(paramCase(500, 2_000), 5);
    const large = fastest(paramCase(2_000, 8_000), 3);
    // The product would be about 16; each name built once, and each parameter one step, is about 4.
    expect(large / small).toBeLessThan(8);
  });

  it("review defect 3, fixed: and its steps grow by the same factor as its size, each parameter and each field one step", () => {
    const steps = (f: number, p: number) => {
      const md = parseMetadata(
        shapeMetadata({ eventFields: Array.from({ length: f }, (_, i) => ({ name: `f${i}`, type: 12 })), extra: [{ path: ["P"], params: Array.from({ length: p }, () => ({ name: "T", type: null })), def: def.tuple([]) }] }),
      );
      const n = namer(md);
      deriveShape(md, n);
      return MAX_SHAPE_STEPS - n.steps.left;
    };
    const a = steps(500, 2_000);
    const b = steps(2_000, 8_000);
    expect(b / a).toBeGreaterThan(3.9);
    expect(b / a).toBeLessThan(4.1);
  });

  it("HELD: parseMetadata is linear: 4 times the fields takes about 4 times the time, not 16", () => {
    const blob = (n: number) => metadata([{ def: def.primitive("u8") }, { def: def.composite(Array.from({ length: n }, () => ({ type: 0 }))) }], []);
    const a = blob(20_000);
    const b = blob(80_000);
    const ta = fastest(() => parseMetadata(a), 5);
    const tb = fastest(() => parseMetadata(b), 3);
    expect(tb / ta).toBeLessThan(10);
  });
});

describe("values decoded wrong, or valid values refused", () => {
  it("review defect 4, fixed: Compact<()> (type 73, MultiAddress::Index in this runtime) is null from no bytes, as the reference reads it", () => {
    const c = MD.types.at(73)?.def;
    expect(c).toEqual({ kind: "compact", type: 36 });
    expect(MD.types.at(36)?.def).toEqual({ kind: "tuple", types: [] });
    expect(BUILDER.buildDefinition(73).dec(new Uint8Array())).toBeUndefined();
    expect(BUILDER.buildDefinition(73).enc(undefined).length).toBe(0);
    expect(decodeValue(MD, 73, new Uint8Array())).toBe(null);
    expect(thrown(() => decodeValue(MD, 73, bytes(0))).cls).toBe("ScaleError");
    // MultiAddress::Index(Compact<()>) is variant 1 of type 72: one byte, valid, read.
    const multi = idOf((t) => t.path.at(-1) === "MultiAddress");
    expect(BUILDER.buildDefinition(multi).dec(bytes(1))).toEqual({ type: "Index", value: undefined });
    expect(decodeValue(MD, multi, bytes(1))).toEqual({ variant: "Index", fields: null });
  });

  it("review defect 5, fixed: decodeEvents refuses a record of the two fields event and 'phase,topics': it must hold exactly phase, event and topics", () => {
    const md = parseMetadata(shapeMetadata({ record: [{ name: "event", type: 7 }, { name: "phase,topics", type: 2 }] }));
    const b = cat(compact(1), u8(1), u8(0), u32(7));
    expect(decodeValue(md, 6, b)).toEqual([{ event: { variant: "ComputeChannel", fields: { variant: "E", fields: null } }, "phase,topics": 7 }]);
    expect(thrown(() => decodeEvents(md, b))).toEqual({ cls: "ScaleError", message: "an event record of System.Events does not have exactly the fields phase, event and topics" });
  });

  it("storage round: deriveShape refuses metadata without a FlopSessionKeys pallet or one of its three entries, with a ScaleError naming it", () => {
    expect(() => deriveShape(parseMetadata(shapeMetadata({})))).not.toThrow();
    const noPallet = parseMetadata(shapeMetadata({})).pallets.filter((p) => p.name !== "FlopSessionKeys");
    expect(thrown(() => deriveShape({ ...parseMetadata(shapeMetadata({})), pallets: noPallet }))).toEqual({ cls: "ScaleError", message: "the metadata has no FlopSessionKeys pallet" });
    for (const missing of ["Sessions", "SessionNonces", "CircuitBreakers"]) {
      const md = parseMetadata(shapeMetadata({ sessionKeys: ["Sessions", "SessionNonces", "CircuitBreakers"].filter((e) => e !== missing) }));
      expect(thrown(() => deriveShape(md))).toEqual({ cls: "ScaleError", message: `pallet FlopSessionKeys has no storage entry ${JSON.stringify(missing)}` });
    }
  });

  it("review round 20: the shape states an Optional entry's default as the metadata gives it, also when it is not 0x00", () => {
    const md = parseMetadata(shapeMetadata({ sessionFallback: new Uint8Array([1, 2, 3, 4]) }));
    const sessions = md.pallets.find((p) => p.name === "FlopSessionKeys")?.storage?.entries.find((e) => e.name === "Sessions");
    expect(sessions?.modifier).toBe("Optional");
    const shape = JSON.parse(shapeText(deriveShape(md)));
    expect(shape.flop_session_keys.sessions.default).toBe("0x01020304");
    expect(shape.flop_session_keys.session_nonces.default).toBe("0x");
  });

  it("review defect 8, fixed: two constants of one name in a pallet are refused, so deriveShape never reads the spec from one of two", () => {
    const b = shapeMetadata({
      constants: [
        { name: "Version", type: 3, value: cat(str("other-runtime"), u32(1)) },
        { name: "Version", type: 3, value: cat(str("tzkv-runtime"), u32(1014014)) },
      ],
    });
    expect(thrown(() => parseMetadata(b))).toEqual({ cls: "ScaleError", message: 'pallet System: the constant "Version" is named twice' });
  });

  it("review defect 8, fixed: a signed extension listed twice, and two pallets of one storage prefix, are refused; the recorded metadata still parses", () => {
    const ext = cat(bytes(0x6d, 0x65, 0x74, 0x61, 14), vec([typeEntry(0, { def: def.primitive("u8") })]), vec([]), compact(0), u8(4), vec([cat(str("CheckNonce"), compact(0), compact(0)), cat(str("CheckNonce"), compact(0), compact(0))]), compact(0));
    expect(thrown(() => parseMetadata(ext))).toEqual({ cls: "ScaleError", message: "the signed extension CheckNonce is listed twice" });
    const shared = metadata([{ def: def.primitive("u8") }], [{ name: "A", index: 0, prefix: "S", entries: [{ name: "X", plain: 0 }] }, { name: "B", index: 1, prefix: "S", entries: [{ name: "Y", plain: 0 }] }]);
    expect(thrown(() => parseMetadata(shared))).toEqual({ cls: "ScaleError", message: 'pallets A and B share the storage prefix "S", so their keys would be one' });
    expect(thrown(() => parseMetadata(R.metadata)).cls).toBe("returned");
  });

  it("review defect 12, fixed: the plain form holds our side to the number or string rule: a u64 given as a number, or a u32 as a string, fails", () => {
    const u64 = idOf((t) => t.def.kind === "primitive" && t.def.primitive === "u64");
    const u32id = idOf((t) => t.def.kind === "primitive" && t.def.primitive === "u32");
    expect(thrown(() => plain(MD, "ours", u64, 5)).message).toBe("ours: a u64 is a decimal string, not: 5");
    expect(thrown(() => plain(MD, "ours", u32id, "5")).message).toBe('ours: a u32 is a number, not: "5"');
    expect(thrown(() => plain(MD, "ours", u64, "05")).cls).toBe("Error");
    expect(plain(MD, "ours", u64, "5")).toBe("5");
    expect(plain(MD, "ours", u32id, 5)).toBe("5");
    // The reference side keeps its own form: a bigint or a number at any width.
    expect(plain(MD, "reference", u64, 5n)).toBe("5");
  });

  it("HELD: on the recorded metadata, random valid values of every type decode as the reference decodes them, ours refusing none, but for a leading BOM", () => {
    const w = writer(MD, 7);
    const tally = { same: 0, differ: 0, bom: 0, oursOnly: 0 };
    for (const t of MD.types) {
      let codec: { dec: (b: Uint8Array) => unknown };
      try {
        codec = BUILDER.buildDefinition(t.id);
      } catch {
        continue;
      }
      for (let i = 0; i < 6; i++) {
        let b: Uint8Array;
        try {
          b = w.value(t.id);
        } catch (e) {
          if (e instanceof TooDeep) break;
          throw e;
        }
        // Ours refuses no valid value: the only kind it does not read, a bit sequence, is not in
        // this metadata.
        const ours: unknown = decodeValue(MD, t.id, b);
        let ref: unknown;
        try {
          ref = codec.dec(b.slice());
        } catch {
          // The reference cannot build ModuleError's [u8; 4] decoder ("innerDecoder is not a function").
          tally.oursOnly++;
          continue;
        }
        let po: string;
        let pr: string;
        try {
          po = JSON.stringify(plain(MD, "ours", t.id, ours));
          pr = JSON.stringify(plain(MD, "reference", t.id, ref));
        } catch {
          // The reference flattens Digest's logs and ModuleError; plain cannot read those.
          continue;
        }
        if (po === pr) tally.same++;
        else if (po.includes("\ufeff") && po.replaceAll("\ufeff", "") === pr.replaceAll("\ufeff", "")) tally.bom++;
        else tally.differ++;
      }
    }
    expect(tally.differ).toBe(0);
    expect(tally.same).toBeGreaterThan(4000);
    // Ours keeps a leading U+FEFF of a str, as Rust does; the reference's TextDecoder drops it.
    expect(tally.bom).toBeGreaterThan(0);
  });

  it("HELD: mutated values (a bit flipped, cut short, a byte added) are never accepted by ours and read differently by the reference", () => {
    const w = writer(MD, 11);
    let compared = 0;
    for (const t of MD.types) {
      let codec: { dec: (b: Uint8Array) => unknown };
      try {
        codec = BUILDER.buildDefinition(t.id);
      } catch {
        continue;
      }
      for (let i = 0; i < 8; i++) {
        let b: Uint8Array;
        try {
          b = w.value(t.id);
        } catch (e) {
          if (e instanceof TooDeep) break;
          throw e;
        }
        const k = w.rnd.int(3);
        let m = b.slice();
        if (k === 0 && m.length > 0) m.set([(m.at(w.rnd.int(m.length)) ?? 0) ^ (1 << w.rnd.int(8))], w.rnd.int(m.length));
        else if (k === 1 && m.length > 0) m = m.subarray(0, w.rnd.int(m.length));
        else m = cat(m, u8(w.rnd.int(256)));
        let ours: unknown;
        try {
          ours = decodeValue(MD, t.id, m);
        } catch (e) {
          if (!(e instanceof ScaleError)) throw e;
          continue;
        }
        let ref: unknown;
        try {
          ref = codec.dec(m.slice());
        } catch {
          continue;
        }
        try {
          const po = JSON.stringify(plain(MD, "ours", t.id, ours));
          const pr = JSON.stringify(plain(MD, "reference", t.id, ref));
          expect(po.replaceAll("\ufeff", ""), `type ${t.id}`).toBe(pr.replaceAll("\ufeff", ""));
          compared++;
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("reference:")) continue;
          throw e;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });
});

describe("the shape pin", () => {
  // The names swapped have the same length, so the metadata keeps its length too.
  const SWAPPED = edited((v) => {
    const vs = v.lookup[PRECISION]?.def.value as { name: string }[];
    const a = vs.at(0) as { name: string };
    const b = vs.at(4) as { name: string };
    [a.name, b.name] = [b.name, a.name];
  });

  const H160 = edited((v) => {
    const t = v.lookup[H256];
    if (t) t.def = { tag: "composite", value: [{ type: BYTES20, typeName: "[u8; 20]", docs: [] }] };
  });
  const SLA128 = edited((v) => {
    const f = (v.lookup[SLA]?.def.value as { type: number }[]).at(0);
    if (f) f.type = U128;
  });

  it("review defect 7, fixed: the shape changes when ModelPrecision's variants, H256's bytes or Sla's fields change, each where that type is described", () => {
    expect(SWAPPED.length).toBe(R.metadata.length);
    const real = JSON.parse(SHAPE);
    const changed = (b: Uint8Array) => JSON.parse(shapeText(deriveShape(parseMetadata(b))));
    for (const b of [SWAPPED, H160, SLA128]) {
      expect(toHex(b)).not.toBe(toHex(R.metadata));
      expect(shapeText(deriveShape(parseMetadata(b)))).not.toBe(SHAPE);
    }
    const swapped = changed(SWAPPED).types["ModelPrecision#246"].variants.map((x: { index: number; name: string }) => `${x.index} ${x.name}`);
    expect(swapped).toEqual(["0 INT4", "1 FP16", "2 BF16", "3 INT8", "4 FP32", "5 Mixed"]);
    expect(changed(H160).types["H256#13"].fields).toEqual([{ name: null, type: "[u8; 20]" }]);
    expect(real.types["H256#13"].fields).toEqual([{ name: null, type: "[u8; 32]" }]);
    expect(changed(SLA128).types["Sla<u32>#294"].fields.at(0)).toEqual({ name: "max_turns", type: "u128" });
    // And the pin refuses each, at the metadata's sha256 before anything is parsed.
    for (const b of [SWAPPED, H160, SLA128]) expect(pinShape({ specName: "tzkv-runtime", specVersion: 1014014, metadata: b, lastRuntimeUpgrade: BLOCK?.lastRuntimeUpgrade ?? new Uint8Array(), shapeText: SHAPE }).pinned).toBe(false);
  });

  it("review defect 6, fixed: pinShape and decodeBlockEvents read input.metadata once, so a getter cannot hand the hash one value and the parser another", () => {
    const tricky = (first: Uint8Array, later: Uint8Array) => {
      const seen = { reads: 0 };
      const input = {
        specName: "tzkv-runtime",
        specVersion: 1014014,
        lastRuntimeUpgrade: BLOCK?.lastRuntimeUpgrade ?? new Uint8Array(),
        shapeText: SHAPE,
        events: BLOCK?.events ?? new Uint8Array(),
        get metadata() {
          seen.reads++;
          return seen.reads === 1 ? first : later;
        },
      } as PinInput & { events: Uint8Array };
      return { input, seen };
    };
    // The reviewed bytes first, other bytes after: the one read is the reviewed bytes, and what is
    // parsed is what was hashed.
    const a = tricky(R.metadata, SWAPPED);
    const out = decodeBlockEvents(a.input);
    expect(a.seen.reads).toBe(1);
    expect(out.decoded).toBe(true);
    // Other bytes first: refused, whatever comes after.
    const b = tricky(SWAPPED, R.metadata);
    expect(decodeBlockEvents(b.input).decoded).toBe(false);
    expect(b.seen.reads).toBe(1);
    const c = tricky(SWAPPED, R.metadata);
    expect(pinShape(c.input).pinned).toBe(false);
    expect(c.seen.reads).toBe(1);
    // pinShape on its own too: it parses the one copy it hashed.
    const d = tricky(R.metadata, SWAPPED);
    expect(pinShape(d.input).pinned).toBe(true);
    expect(d.seen.reads).toBe(1);
  });

  it("review defect 6, fixed: the bytes are copied, so a caller who changes its buffer after the call changes nothing pinned", () => {
    const meta = R.metadata.slice();
    const p = pinShape({ specName: "tzkv-runtime", specVersion: 1014014, metadata: meta, lastRuntimeUpgrade: BLOCK?.lastRuntimeUpgrade ?? new Uint8Array(), shapeText: SHAPE });
    expect(p.pinned).toBe(true);
    meta.fill(0);
    // The parsed constants are views into the bytes parsed: those must be the copy, not the caller's.
    const v = p.pinned ? p.metadata.pallets.find((x) => x.name === "System")?.constants.find((c) => c.name === "Version") : undefined;
    expect(v !== undefined && p.pinned ? decodeValue(p.metadata, v.type, v.value) : null).toMatchObject({ spec_name: "tzkv-runtime", spec_version: 1014014 });
    expect(decodeBlockEvents({ specName: "tzkv-runtime", specVersion: 1014014, metadata: "0x" as never, lastRuntimeUpgrade: new Uint8Array(), shapeText: SHAPE, events: new Uint8Array() })).toEqual({ decoded: false, refused: "not decoded: the metadata is not bytes" });
  });

  it("HELD: the whole shape file, its type closure included, derived again from the reference's own parse with an independent namer, equals the file", () => {
    const mine = referenceShape(R.metadata);
    expect(Object.keys(mine.types).length).toBe(469);
    expect(mine.flop_session_keys.index).toBe(94);
    expect(mine.compute_channel.events.length).toBe(60);
    expect(mine.compute_channel.index).toBe(103);
    expect(mine).toEqual(JSON.parse(SHAPE));
  });

  it("HELD: a LastRuntimeUpgrade whose spec name has a leading BOM, or a trailing byte, is refused", () => {
    const lru = BLOCK?.lastRuntimeUpgrade ?? new Uint8Array();
    const base: PinInput = { specName: "tzkv-runtime", specVersion: 1014014, metadata: R.metadata, lastRuntimeUpgrade: lru, shapeText: SHAPE };
    expect(pinShape(base).pinned).toBe(true);
    const lruId = MD.pallets.find((p) => p.name === "System")?.storage?.entries.find((e) => e.name === "LastRuntimeUpgrade")?.value ?? -1;
    const v = decodeValue(MD, lruId, lru) as { spec_version: number; spec_name: string };
    const bom = cat(compact(v.spec_version), str(`\ufeff${v.spec_name}`));
    expect(pinShape({ ...base, lastRuntimeUpgrade: bom }).pinned).toBe(false);
    expect(pinShape({ ...base, lastRuntimeUpgrade: cat(lru, u8(0)) }).pinned).toBe(false);
  });
});

describe("JSON and object safety", () => {
  const md = parseMetadata(
    metadata(
      [
        { def: def.primitive("u8") }, // 0
        { def: def.composite([{ name: "__proto__", type: 0 }, { name: "constructor", type: 0 }, { name: "toString", type: 0 }, { name: "hasOwnProperty", type: 0 }]) }, // 1
        { def: def.variant([{ name: "__proto__", index: 0, fields: [{ name: "__proto__", type: 0 }] }]) }, // 2
        { def: def.primitive("char") }, // 3
        { def: def.primitive("str") }, // 4
        { def: def.primitive("i8") }, // 5
      ],
      [],
    ),
  );

  it("HELD: fields and variants named __proto__, constructor, toString and hasOwnProperty are own data, kept by JSON", () => {
    const v = decodeValue(md, 1, bytes(1, 2, 3, 4)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(["__proto__", "constructor", "toString", "hasOwnProperty"]);
    expect(JSON.parse(JSON.stringify(v))).toEqual(JSON.parse('{"__proto__":1,"constructor":2,"toString":3,"hasOwnProperty":4}'));
    const w = decodeValue(md, 2, bytes(0, 9));
    expect(JSON.stringify(w)).toBe('{"variant":"__proto__","fields":{"__proto__":9}}');
  });

  it("HELD: a char past U+10FFFF or a surrogate, and a str of CESU surrogates or an overlong form, are refused; i8 zero is not negative zero", () => {
    for (const c of [0xd800, 0xdbff, 0xdc00, 0xdfff, 0x110000, 0xffffffff]) expect(thrown(() => decodeValue(md, 3, u32(c))).cls).toBe("ScaleError");
    expect(decodeValue(md, 3, u32(0x10ffff))).toBe("\u{10ffff}");
    expect(thrown(() => decodeValue(md, 4, bytes(12, 0xed, 0xa0, 0x80))).cls).toBe("ScaleError");
    expect(thrown(() => decodeValue(md, 4, bytes(8, 0xc0, 0x80))).cls).toBe("ScaleError");
    expect(Object.is(decodeValue(md, 5, bytes(0)), 0)).toBe(true);
  });

  it("review defect 11, fixed: a field or variant named by digits alone is refused, so JavaScript never reorders a decoded object's keys", () => {
    const fields = metadata([{ def: def.primitive("u8") }, { def: def.composite([{ name: "b", type: 0 }, { name: "1", type: 0 }, { name: "0", type: 0 }]) }], []);
    expect(thrown(() => parseMetadata(fields))).toEqual({ cls: "ScaleError", message: 'type 1: the field name "1" is all digits, which no Rust name is' });
    const variants = metadata([{ def: def.variant([{ name: "7", index: 0 }]) }], []);
    expect(thrown(() => parseMetadata(variants))).toEqual({ cls: "ScaleError", message: 'type 0: the variant name "7" is all digits, which no Rust name is' });
    // A name with a digit in it is fine, and keeps its place.
    const mixed = parseMetadata(metadata([{ def: def.primitive("u8") }, { def: def.composite([{ name: "b", type: 0 }, { name: "a1", type: 0 }]) }], []));
    expect(JSON.stringify(decodeValue(mixed, 1, bytes(7, 8)))).toBe('{"b":7,"a1":8}');
  });
});

describe("compact and integer edges", () => {
  const widths = ["u8", "u16", "u32", "u64", "u128", "u256"] as const;
  const md = parseMetadata(metadata([...widths.map((w) => ({ def: def.primitive(w) })), ...widths.map((_, i) => ({ def: def.compact(i) }))], []));
  it("HELD: every compact width takes its maximum and refuses one more, each in its shortest form", () => {
    widths.forEach((w, i) => {
      const max = (1n << BigInt(8 * 2 ** i)) - 1n;
      const v = decodeValue(md, 6 + i, compact(max));
      expect(String(v)).toBe(max.toString());
      expect(typeof v).toBe(i < 3 ? "number" : "string");
      expect(thrown(() => decodeValue(md, 6 + i, compact(max + 1n))).cls, w).toBe("ScaleError");
    });
    // The big integer mode at every byte count from 4 to 67: shortest only.
    for (let n = 4; n <= 67; n++) {
      const top = cat(u8(((n - 4) << 2) | 3), new Uint8Array(n - 1), u8(n === 4 ? 0x40 : 1));
      const zero = cat(u8(((n - 4) << 2) | 3), new Uint8Array(n - 1).fill(1), u8(0));
      const r = thrown(() => decodeValue(md, 11, top));
      if (n <= 32) expect(r.cls, `n ${n}`).toBe("returned");
      else expect(r.cls, `n ${n}`).toBe("ScaleError");
      expect(thrown(() => decodeValue(md, 11, zero)).cls).toBe("ScaleError");
    }
  });
});

describe("hashes and storage keys", () => {
  it("HELD: BLAKE2b at every output size 1 to 64 and xxHash64 at seeds 0 to 3, on every length 0 to 300, equal noble, node and the reference", () => {
    const r = seeded(9);
    const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
    let n = 0;
    for (let len = 0; len <= 300; len++) {
      const b = r.bytes(len);
      for (let out = 1; out <= 64; out++) if (!same(blake2b(b, out), nobleBlake2b(b, { dkLen: out }))) throw new Error(`blake2b ${len} ${out}`);
      expect(same(blake2b(b, 64), createHash("blake2b512").update(b).digest())).toBe(true);
      expect(same(blake2b(b, 16), Blake2128(b))).toBe(true);
      expect(same(blake2b(b, 32), Blake2256(b))).toBe(true);
      expect(same(hashKeyPart("Blake2_128Concat", b), Blake2128Concat(b))).toBe(true);
      expect(same(hashKeyPart("Twox128", b), Twox128(b))).toBe(true);
      expect(same(hashKeyPart("Twox256", b), Twox256(b))).toBe(true);
      expect(same(hashKeyPart("Twox64Concat", b), Twox64Concat(b))).toBe(true);
      // A view at an odd offset hashes as its own bytes.
      const view = cat(u8(0xaa), b, u8(0xbb)).subarray(1, 1 + len);
      expect(same(hashKeyPart("Twox64Concat", view), Twox64Concat(b))).toBe(true);
      expect(same(blake2b(view, 16), Blake2128(b))).toBe(true);
      n++;
    }
    expect(n).toBe(301);
  }, 60_000);

  it("HELD: storage keys equal the reference for every plain entry and every map of one or two keys in the recorded metadata", () => {
    const w = writer(MD, 3);
    const count = { 0: 0, 1: 0, 2: 0 } as Record<number, number>;
    for (const p of MD.pallets) {
      for (const e of p.storage?.entries ?? []) {
        const st = BUILDER.buildStorage(p.name, e.name);
        const kd = e.key === null ? undefined : MD.types.at(e.key)?.def;
        const types = e.key === null ? [] : e.hashers.length === 1 ? [e.key] : kd?.kind === "tuple" ? kd.types : [];
        for (let i = 0; i < 3; i++) {
          let keys: Uint8Array[];
          try {
            keys = types.map((t) => w.value(t));
          } catch (x) {
            if (x instanceof TooDeep) break;
            throw x;
          }
          const args = types.map((t, j) => BUILDER.buildDefinition(t).dec((keys.at(j) as Uint8Array).slice()));
          expect(toHex(storageKey(MD, p.name, e.name, keys)), `${p.name}.${e.name}`).toBe(st.keys.enc(...args));
          count[types.length] = (count[types.length] ?? 0) + 1;
        }
      }
    }
    expect(count[0]).toBeGreaterThan(500);
    expect(count[1]).toBeGreaterThan(500);
    expect(count[2]).toBeGreaterThan(50);
  });
});

describe("gaps: right today, but a mutant the author's tests miss would break it", () => {
  it("GAP 1: the chars U+DFFF (last surrogate) and U+110000 are refused as a ScaleError (mutants rv-decode-surrogate-low-edge, rv-decode-char-top-edge)", () => {
    const md = parseMetadata(metadata([{ def: def.primitive("char") }], []));
    expect(thrown(() => decodeValue(md, 0, u32(0xdfff))).cls).toBe("ScaleError");
    expect(thrown(() => decodeValue(md, 0, u32(0x110000))).cls).toBe("ScaleError");
  });

  it("GAP 2: a type parameter that names no type is refused (mutant rv-metadata-param-dangling)", () => {
    expect(thrown(() => parseMetadata(metadata([{ path: ["X"], params: [{ name: "T", type: 9 }], def: def.primitive("u8") }], []))).cls).toBe("ScaleError");
  });

  it("GAP 3: a signed extension whose additional type names no type is refused (mutant rv-metadata-extension-dangling)", () => {
    const b = cat(bytes(0x6d, 0x65, 0x74, 0x61, 14), vec([typeEntry(0, { def: def.primitive("u8") })]), vec([]), compact(0), u8(4), vec([cat(str("CheckNonce"), compact(0), compact(5))]), compact(0));
    expect(thrown(() => parseMetadata(b)).cls).toBe("ScaleError");
  });

  it("GAP 4: a storage modifier of 2 is refused (mutant rv-metadata-modifier)", () => {
    const b = metadata([{ def: def.primitive("u8") }], [{ name: "P", index: 0, entries: [{ name: "E", plain: 0, modifier: 2 as 1 }] }]);
    expect(thrown(() => parseMetadata(b)).cls).toBe("ScaleError");
  });

  it("GAP 5: a name of exactly 256 types is given and one of 257 is refused (mutant rv-shape-name-steps-off-by-one)", () => {
    const md = parseMetadata(metadata([{ path: ["A"], def: def.tuple([]) }, { def: def.tuple(new Array(255).fill(0)) }, { def: def.tuple(new Array(256).fill(0)) }], []));
    expect(thrown(() => typeName(md, 1)).cls).toBe("returned");
    expect(thrown(() => typeName(md, 2)).cls).toBe("ScaleError");
  });

  it("GAP 6: a named field around a pallet's events in the event enum is refused (mutant rv-events-unnamed-wrapper)", () => {
    const md = parseMetadata(
      metadata(
        [
          { def: def.primitive("u8") },
          { def: def.tuple([]) },
          { def: def.composite([{ name: "phase", type: 1 }, { name: "event", type: 4 }, { name: "topics", type: 1 }]) },
          { def: def.sequence(2) },
          { def: def.variant([{ name: "C", index: 1, fields: [{ name: "inner", type: 5 }] }]) },
          { def: def.variant([{ name: "E", index: 0 }]) },
        ],
        [{ name: "System", index: 0, entries: [{ name: "Events", plain: 3 }] }, { name: "C", index: 1, event: 5 }],
      ),
    );
    expect(thrown(() => decodeEvents(md, compact(0))).cls).toBe("ScaleError");
  });
});
