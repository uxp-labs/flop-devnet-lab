// Hostile bytes, seeded (test/helpers/random.ts): every prefix and every single bit flip of the real
// values, random bytes, lengths and counts that claim more than the input holds, nesting past
// MAX_DEPTH, and metadata whose types refer to themselves. Every failure must be a ScaleError,
// never another exception and never a hang, and every decode must stay inside its bound on work:
// valueBudget(bytes) steps, one for each type it visits (src/scale/decode.ts).
import { describe, expect, it } from "vitest";
import { MAX_DEPTH, type Decoded, decodeAt, decodeValue, decoding, valueBudget } from "../src/scale/decode.js";
import { decodeEvents } from "../src/scale/events.js";
import { type Metadata, parseMetadata } from "../src/scale/metadata.js";
import { MAX_INPUT_BYTES, ScaleError } from "../src/scale/reader.js";
import { deriveShape, typeName } from "../src/scale/shape.js";
import { storageKey } from "../src/scale/storage-key.js";
import { seeded } from "./helpers/random.js";
import { recorded } from "./helpers/recorded.js";
import { bytes, cat, compact, def, metadata, u8 } from "./helpers/scale-write.js";

const R = recorded();
const MD = parseMetadata(R.metadata);
const system = MD.pallets.find((p) => p.name === "System");
const EVENTS = system?.storage?.entries.find((e) => e.name === "Events")?.value ?? -1;
const LRU = system?.storage?.entries.find((e) => e.name === "LastRuntimeUpgrade")?.value ?? -1;
const LONG = 120_000;

/** What the fuzz saw: how many cases, how many decoded and refused, and the most work one took. */
interface Tally {
  cases: number;
  decoded: number;
  refused: number;
  maxSteps: number;
  /** The most steps one decode took over its bound, in thousandths: never above 1000. */
  maxPerMille: number;
}
const tally = (): Tally => ({ cases: 0, decoded: 0, refused: 0, maxSteps: 0, maxPerMille: 0 });

/**
 * One decode of type id over the bytes, as decodeValue does it but counting its steps. Anything
 * thrown that is not a ScaleError fails the test; so does a decode past its bound.
 */
function decodeCounted(t: Tally, md: Metadata, id: number, b: Uint8Array): Decoded | undefined {
  t.cases++;
  const d = decoding(md, b);
  const bound = valueBudget(b.length);
  try {
    const v = decodeAt(d, id);
    d.r.end();
    t.decoded++;
    return v;
  } catch (e) {
    if (!(e instanceof ScaleError)) throw new Error(`not a ScaleError at ${b.length} bytes: ${String(e)}`);
    t.refused++;
    return undefined;
  } finally {
    const steps = bound - Math.max(d.budget.left, 0);
    expect(steps).toBeLessThanOrEqual(bound);
    t.maxSteps = Math.max(t.maxSteps, steps);
    t.maxPerMille = Math.max(t.maxPerMille, Math.floor((1000 * steps) / bound));
  }
}

/** A call that must either return or throw a ScaleError, nothing else. */
function onlyScaleError(f: () => unknown): "returned" | "refused" {
  try {
    f();
    return "returned";
  } catch (e) {
    if (e instanceof ScaleError) return "refused";
    throw e;
  }
}

describe("truncation: every prefix of every real value", () => {
  it(
    "refuses every prefix of each of the twelve System.Events values short of its whole, as a ScaleError, inside the bound",
    () => {
      const t = tally();
      for (const b of R.blocks) for (let n = 0; n <= b.events.length; n++) decodeCounted(t, MD, EVENTS, b.events.subarray(0, n));
      // Only the twelve whole values decode: each begins with a count of records, and a prefix
      // always holds fewer than that count claims.
      expect(t).toEqual({ cases: 9824, decoded: 12, refused: 9812, maxSteps: 419, maxPerMille: 25 });
      for (const b of R.blocks) for (let n = 0; n < b.events.length; n++) expect(onlyScaleError(() => decodeEvents(MD, b.events.subarray(0, n)))).toBe("refused");
    },
    LONG,
  );

  it("refuses every prefix of System.LastRuntimeUpgrade at each block short of its whole", () => {
    const t = tally();
    for (const b of R.blocks) for (let n = 0; n <= b.lastRuntimeUpgrade.length; n++) decodeCounted(t, MD, LRU, b.lastRuntimeUpgrade.subarray(0, n));
    expect(t).toEqual({ cases: 216, decoded: 12, refused: 204, maxSteps: 5, maxPerMille: 4 });
  });

  it(
    "refuses 400 prefixes of the metadata (the first and last 100 and 200 seeded between), and parses only the whole",
    () => {
      const rand = seeded(482132);
      const n = R.metadata.length;
      const cuts = [...Array.from({ length: 100 }, (_v, i) => i), ...Array.from({ length: 100 }, (_v, i) => n - 1 - i), ...Array.from({ length: 200 }, () => 100 + rand.int(n - 200))];
      expect(cuts.length).toBe(400);
      for (const c of cuts) expect(onlyScaleError(() => parseMetadata(R.metadata.subarray(0, c))), `cut at ${c}`).toBe("refused");
      expect(onlyScaleError(() => parseMetadata(R.metadata))).toBe("returned");
    },
    LONG,
  );
});

describe("single bit flips across every real value", () => {
  it(
    "flips every bit of each System.Events value, 78496 cases: each decodes or is refused as a ScaleError, inside the bound",
    () => {
      const t = tally();
      for (const b of R.blocks) {
        const c = b.events.slice();
        for (let bit = 0; bit < c.length * 8; bit++) {
          const i = bit >> 3;
          const was = c.at(i) ?? 0;
          c.set([was ^ (1 << (bit & 7))], i);
          decodeCounted(t, MD, EVENTS, c);
          c.set([was], i);
        }
      }
      // Most flips land in an amount, an id or a hash, and still decode: a flip changes a value,
      // and nothing in the bytes says which value was meant.
      expect(t).toEqual({ cases: 78496, decoded: 71689, refused: 6807, maxSteps: 421, maxPerMille: 23 });
    },
    LONG,
  );

  it("flips every bit of System.LastRuntimeUpgrade at each block", () => {
    const t = tally();
    for (const b of R.blocks) {
      for (let bit = 0; bit < b.lastRuntimeUpgrade.length * 8; bit++) {
        const c = b.lastRuntimeUpgrade.slice();
        c.set([(c.at(bit >> 3) ?? 0) ^ (1 << (bit & 7))], bit >> 3);
        decodeCounted(t, MD, LRU, c);
      }
    }
    expect(t).toEqual({ cases: 1632, decoded: 1368, refused: 264, maxSteps: 5, maxPerMille: 4 });
  });

  it(
    "flips 300 seeded bits of the metadata: each parses or is refused as a ScaleError, and the shape of a parse is derived or refused",
    () => {
      const rand = seeded(1014014);
      const seen = { returned: 0, refused: 0 };
      for (let k = 0; k < 300; k++) {
        const c = R.metadata.slice();
        const bit = rand.int(c.length * 8);
        c.set([(c.at(bit >> 3) ?? 0) ^ (1 << (bit & 7))], bit >> 3);
        let md: Metadata | undefined;
        const r = onlyScaleError(() => {
          md = parseMetadata(c);
        });
        seen[r]++;
        if (md !== undefined) {
          const m = md;
          onlyScaleError(() => deriveShape(m));
          onlyScaleError(() => decodeEvents(m, R.blocks.at(4)?.events ?? new Uint8Array()));
        }
      }
      expect(seen).toEqual({ returned: 240, refused: 60 });
    },
    LONG,
  );
});

describe("random bytes", () => {
  it(
    "decodes 3000 random byte strings of 0 to 255 bytes as System.Events and as 3000 random types of the metadata",
    () => {
      const rand = seeded(20261111);
      const ev = tally();
      const any = tally();
      for (let k = 0; k < 3000; k++) decodeCounted(ev, MD, EVENTS, rand.bytes(rand.int(256)));
      for (let k = 0; k < 3000; k++) decodeCounted(any, MD, rand.int(MD.types.length), rand.bytes(rand.int(256)));
      expect({ ev, any }).toEqual({
        ev: { cases: 3000, decoded: 0, refused: 3000, maxSteps: 5, maxPerMille: 3 },
        any: { cases: 3000, decoded: 2, refused: 2998, maxSteps: 61, maxPerMille: 23 },
      });
    },
    LONG,
  );

  it("parses 2000 random metadata blobs, magic and version 14 then random bytes, refusing each as a ScaleError", () => {
    const rand = seeded(14);
    let refused = 0;
    for (let k = 0; k < 2000; k++) if (onlyScaleError(() => parseMetadata(cat(bytes(0x6d, 0x65, 0x74, 0x61, 14), rand.bytes(rand.int(512))))) === "refused") refused++;
    expect(refused).toBe(2000);
  });
});

describe("lengths and counts that claim more than the input holds", () => {
  const small = parseMetadata(metadata([{ def: def.primitive("u8") }, { def: def.sequence(0) }, { def: def.sequence(3) }, { def: def.primitive("str") }, { def: def.primitive("u128") }, { def: def.compact(4) }], []));
  it.each([
    ["a list of 2^30 records in 4 bytes", MD, EVENTS, cat(compact(1n << 30n), bytes(1, 2, 3, 4)), "type 19, a length at byte 0: 1073741824 cannot fit in the 4 bytes left"],
    ["a byte vector of 2^29 bytes in 3", small, 1, cat(compact(1n << 29n), bytes(1, 2, 3)), "type 1, a length at byte 0: 536870912 cannot fit in the 3 bytes left"],
    ["a list of strings claiming 2^60", small, 2, cat(compact(1n << 60n), bytes(0)), "type 2, a length at byte 0: 1152921504606846976 cannot fit in the 1 bytes left"],
    ["a string of 63 bytes in 1", small, 3, cat(compact(63), bytes(0x41)), "type 3, a str at byte 0: 63 cannot fit in the 1 bytes left"],
    ["a compact claiming 67 bytes in 2", small, 5, bytes(0xff, 0), "type 5, a Compact<u128> at byte 1: needs 67 bytes, 1 left"],
    ["a compact too wide for its u128", small, 5, cat(u8(((17 - 4) << 2) | 3), new Uint8Array(16), u8(1)), "type 5, a Compact<u128> at byte 0: 340282366920938463463374607431768211456 does not fit a u128"],
  ])("refuses %s before reading anything for it", (_what, md, id, b, says) => {
    const t = tally();
    let msg = "";
    try {
      decodeCounted(t, md, id, b);
      const d = decoding(md, b);
      decodeAt(d, id);
      d.r.end();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(says);
    expect(t.maxSteps).toBeLessThanOrEqual(2);
  });

  it("refuses metadata that claims 2^32 types, or a pallet of 2^30 storage entries, in a few bytes", () => {
    expect(() => parseMetadata(cat(bytes(0x6d, 0x65, 0x74, 0x61, 14), compact((1n << 32n) - 1n), bytes(0, 0)))).toThrow(new ScaleError("the types at byte 5: 4294967295 cannot fit in the 2 bytes left"));
    const head = metadata([{ def: def.primitive("u8") }], []).subarray(0, 12);
    expect(onlyScaleError(() => parseMetadata(cat(head, compact(1), compact(1), u8(65), u8(1), compact(1), u8(65), compact(1n << 30n))))).toBe("refused");
  });
});

describe("the size caps", () => {
  it("refuses metadata, a value and System.Events of more than 16 MiB before reading a byte, and takes 16 MiB exactly as far as it reads", () => {
    const over = new Uint8Array(MAX_INPUT_BYTES + 1);
    expect(MAX_INPUT_BYTES).toBe(16777216);
    expect(() => parseMetadata(over)).toThrow(new ScaleError("the metadata is 16777217 bytes, more than the 16777216 this decoder reads"));
    expect(() => decodeValue(MD, EVENTS, over)).toThrow(new ScaleError("the value is 16777217 bytes, more than the 16777216 this decoder reads"));
    expect(() => decodeEvents(MD, over)).toThrow(new ScaleError("System.Events is 16777217 bytes, more than the 16777216 this decoder reads"));
    // At the cap the size is not what refuses: the bytes are read, and refused for what they hold.
    const at = new Uint8Array(MAX_INPUT_BYTES);
    expect(() => parseMetadata(at)).toThrow(new ScaleError("not metadata: the first four bytes are 0x00000000, not 0x6d657461 (meta)"));
    expect(() => decodeValue(MD, EVENTS, at)).toThrow(/ends at byte 1, 16777215 bytes before the end$/);
  });
});

describe("the bound on work", () => {
  it("stops a value that would take a million steps from 1000 bytes at its bound of 9024 steps", () => {
    // [[Unit; 1000]; 1000]: every element fits the bytes left, since a unit takes none.
    const md = parseMetadata(metadata([{ path: ["Unit"], def: def.composite([]) }, { def: def.array(1000, 0) }, { def: def.array(1000, 1) }], []));
    const t = tally();
    decodeCounted(t, md, 2, new Uint8Array(1000));
    expect(valueBudget(1000)).toBe(9024);
    expect(t).toEqual({ cases: 1, decoded: 0, refused: 1, maxSteps: 9024, maxPerMille: 1000 });
  });
});

describe("nesting and self reference", () => {
  // Type 0 refers to itself four ways: a field, a list, an Option and a compact of one field.
  const SELF = parseMetadata(
    metadata(
      [
        { path: ["Loop"], def: def.composite([{ name: "next", type: 0 }]) }, // 0 Loop { next: Loop }
        { def: def.sequence(1) }, // 1 Vec<itself>
        { path: ["Option"], def: def.variant([{ name: "None", index: 0 }, { name: "Some", index: 1, fields: [{ type: 2 }] }]) }, // 2 Option<itself>
        { path: ["Wrap"], def: def.composite([{ type: 4 }]) }, // 3 Wrap(Compact<Wrap>)
        { def: def.compact(3) }, // 4
        { def: def.tuple([5]) }, // 5 (itself,)
      ],
      [{ name: "System", index: 0, entries: [{ name: "Events", plain: 1 }] }],
    ),
  );

  it.each([
    ["a field of itself, from no bytes", 0, new Uint8Array()],
    ["a list of itself, one element deep each level", 1, new Uint8Array(64).fill(4)],
    ["an Option of itself, Some at every level", 2, new Uint8Array(64).fill(1)],
    ["a compact of one field of itself", 3, new Uint8Array(8)],
    ["a tuple of itself", 5, new Uint8Array()],
  ])(`refuses %s, past ${MAX_DEPTH} levels, as a ScaleError inside the bound`, (_what, id, b) => {
    const t = tally();
    decodeCounted(t, SELF, id, b);
    expect(t.refused).toBe(1);
    expect(t.maxSteps).toBeLessThanOrEqual(MAX_DEPTH + 1);
  });

  it("refuses the same metadata everywhere else it is read: events, the shape, type names and storage keys", () => {
    expect(onlyScaleError(() => decodeEvents(SELF, new Uint8Array(64).fill(4)))).toBe("refused");
    expect(onlyScaleError(() => deriveShape(SELF))).toBe("refused");
    expect([0, 2, 3, 4].map((id) => typeName(SELF, id))).toEqual(["Loop#0", "Option#2", "Wrap#3", "Compact<Wrap#3>"]);
    for (const id of [1, 5]) expect(onlyScaleError(() => typeName(SELF, id))).toBe("refused");
    expect(onlyScaleError(() => storageKey(SELF, "System", "Events", []))).toBe("returned");
  });
});
