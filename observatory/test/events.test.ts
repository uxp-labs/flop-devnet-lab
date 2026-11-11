// The events of a block (src/scale/events.ts): System.Events of all twelve recorded blocks decoded
// with the recorded metadata, to the last byte, and the compute channel events of one channel held
// to the numbers the lead read by hand from the raw bytes on Nov 11. Real data from one RPC
// endpoint: evidence for the decoder, never proof of chain state (RULES.md section 8).
import { describe, expect, it } from "vitest";
import { decodeValue } from "../src/scale/decode.js";
import { type BlockEvent, decodeEvents } from "../src/scale/events.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { ScaleError } from "../src/scale/reader.js";
import { recorded } from "./helpers/recorded.js";
import { type PalletSpec, type TypeSpec, bytes, cat, compact, def, metadata, u8 } from "./helpers/scale-write.js";

const R = recorded();
const MD = parseMetadata(R.metadata);
const SIZES = [2226, 550, 624, 484, 1119, 538, 535, 579, 535, 749, 784, 1089];
const COUNTS = [39, 12, 13, 10, 20, 11, 12, 12, 12, 13, 16, 20];
const CHANNEL = "0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7";
const SETTLED_BLOCK = 3479299;
const SETTLED_HASH = "0xeba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e";
const byBlock = new Map(R.blocks.map((b) => [b.number, decodeEvents(MD, b.events)]));
const at = (n: number): BlockEvent[] => byBlock.get(n) ?? [];
const of = (n: number, event: string) => at(n).filter((e) => e.pallet === "ComputeChannel" && e.event === event && (e.fields as Record<string, unknown>).channel_id === CHANNEL);
const refusal = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof ScaleError) return e.message;
    throw e;
  }
  throw new Error("decoded, not refused");
};

/** Every number in a decoded value, so none can be a float or past 2^53. */
function numbers(v: unknown): number[] {
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) return v.flatMap(numbers);
  if (v !== null && typeof v === "object") return Object.values(v).flatMap(numbers);
  return [];
}

describe("System.Events of the twelve recorded blocks", () => {
  it("decodes each, of the recorded sizes, to its last byte, with the type the metadata states", () => {
    expect(R.blocks.map((b) => b.events.length)).toEqual(SIZES);
    expect(R.blocks.map((b) => at(b.number).length)).toEqual(COUNTS);
    // The decoder refuses a value that does not end exactly at the end of its bytes.
    for (const b of R.blocks) expect(() => decodeEvents(MD, cat(b.events, bytes(0))), `block ${b.number}`).toThrow(/bytes before the end/);
  });

  it("gives every event its pallet name and index, its name and variant index, named fields (null when it has none) and its phase", () => {
    for (const b of R.blocks) {
      for (const e of at(b.number)) {
        const p = MD.pallets.find((x) => x.name === e.pallet);
        expect(p?.index, `${b.number} ${e.pallet}`).toBe(e.palletIndex);
        const variants = MD.types.at(p?.event ?? -1)?.def;
        expect(variants?.kind === "variant" && variants.variants.find((v) => v.name === e.event)?.index).toBe(e.eventIndex);
        const none = e.fields === null && (variants?.kind !== "variant" || variants.variants.find((v) => v.name === e.event)?.fields.length === 0);
        expect(none || (typeof e.fields === "object" && e.fields !== null && !Array.isArray(e.fields)), `${e.pallet}.${e.event} has named fields or none`).toBe(true);
        expect(["ApplyExtrinsic", "Finalization", "Initialization"]).toContain((e.phase as { variant: string }).variant);
      }
      expect(at(b.number).map((e) => e.index)).toEqual(at(b.number).map((_e, i) => i));
    }
  });

  it("gives every integer above u32 as a decimal string, so no number is a float or past 2^53", () => {
    for (const b of R.blocks) for (const n of numbers(at(b.number))) expect(Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff, String(n)).toBe(true);
    const [settled] = of(SETTLED_BLOCK, "Settled");
    expect(typeof (settled?.fields as Record<string, unknown>).miner_paid).toBe("string");
    expect(typeof (settled?.fields as Record<string, unknown>).aggregate_gn).toBe("string");
  });
});

describe(`block ${SETTLED_BLOCK}: the channel ${CHANNEL.slice(0, 10)}... settled, as read by hand`, () => {
  it("is the block the lead read, at the hash the recording holds", () => {
    expect(R.blocks.find((b) => b.number === SETTLED_BLOCK)?.hash).toBe(SETTLED_HASH);
    expect(MD.pallets.find((p) => p.index === 103)?.name).toBe("ComputeChannel");
  });

  it("holds Settled, variant 23 of pallet 103: miner paid 112860000000000002, burned 0, aggregate 38, cooperative", () => {
    const s = of(SETTLED_BLOCK, "Settled");
    expect(s.length).toBe(1);
    expect(s.at(0)).toMatchObject({ pallet: "ComputeChannel", palletIndex: 103, event: "Settled", eventIndex: 23, phase: { variant: "ApplyExtrinsic", fields: 3 } });
    expect(s.at(0)?.fields).toEqual({ channel_id: CHANNEL, miner_paid: "112860000000000002", burned: "0", aggregate_gn: "38", cooperative: true });
  });

  it("holds AuditFeeEarmarked, variant 48, for the same channel: 1140000000000000, just before Settled", () => {
    const a = of(SETTLED_BLOCK, "AuditFeeEarmarked");
    expect(a.length).toBe(1);
    expect(a.at(0)).toMatchObject({ palletIndex: 103, eventIndex: 48, fields: { channel_id: CHANNEL, amount: "1140000000000000" } });
    expect(a.at(0)?.index).toBe((of(SETTLED_BLOCK, "Settled").at(0)?.index ?? 0) - 1);
  });

  it("is the only block of the twelve with a Settled for this channel, and the escrow topped up to 114000000000000002 in block 3479245", () => {
    expect(R.blocks.filter((b) => of(b.number, "Settled").length > 0).map((b) => b.number)).toEqual([SETTLED_BLOCK]);
    const tops = R.blocks.flatMap((b) => of(b.number, "EscrowToppedUp").map((e) => ({ block: b.number, ...e })));
    expect(tops.length).toBe(1);
    expect(tops.at(0)).toMatchObject({ block: 3479245, palletIndex: 103, eventIndex: 22, fields: { channel_id: CHANNEL, added: "114000000000000001", total: "114000000000000002" } });
  });

  it("conserves the escrow: the total topped up is miner paid, plus burned, plus the audit fee", () => {
    const total = BigInt((of(3479245, "EscrowToppedUp").at(0)?.fields as Record<string, string>).total ?? "x");
    const s = of(SETTLED_BLOCK, "Settled").at(0)?.fields as Record<string, string>;
    const fee = BigInt((of(SETTLED_BLOCK, "AuditFeeEarmarked").at(0)?.fields as Record<string, string>).amount ?? "x");
    expect(total).toBe(114000000000000002n);
    expect(BigInt(s.miner_paid ?? "x") + BigInt(s.burned ?? "x") + fee).toBe(total);
  });
});

describe("refusals: the metadata must say what the events rely on", () => {
  // A small runtime: System at 0 with Events, and pallet A at 5 with one event.
  const types = (outer: Uint8Array, record?: Uint8Array): TypeSpec[] => [
    { def: def.primitive("u8") }, // 0
    { path: ["Phase"], def: def.variant([{ name: "Initialization", index: 2 }]) }, // 1
    { path: ["a", "Event"], def: def.variant([{ name: "Ping", index: 3, fields: [{ name: "n", type: 0 }] }]) }, // 2
    { path: ["RuntimeEvent"], def: outer }, // 3
    { def: def.sequence(7) }, // 4 topics
    { path: ["EventRecord"], def: record ?? def.composite([{ name: "phase", type: 1 }, { name: "event", type: 3 }, { name: "topics", type: 4 }]) }, // 5
    { def: def.sequence(5) }, // 6
    { path: ["H256"], def: def.composite([{ type: 8 }]) }, // 7
    { def: def.array(32, 0) }, // 8
  ];
  const pallets = (aIndex = 5): PalletSpec[] => [
    { name: "System", index: 0, entries: [{ name: "Events", plain: 6 }] },
    { name: "A", index: aIndex, event: 2 },
  ];
  const good = () => def.variant([{ name: "A", index: 5, fields: [{ type: 2 }] }]);
  const one = cat(compact(1), u8(2), u8(5), u8(3), u8(9), compact(0));

  it("decodes a well formed small runtime", () => {
    expect(decodeEvents(parseMetadata(metadata(types(good()), pallets())), one)).toEqual([
      { index: 0, phase: { variant: "Initialization", fields: null }, pallet: "A", palletIndex: 5, event: "Ping", eventIndex: 3, fields: { n: 9 }, topics: [] },
    ]);
  });

  it.each([
    ["an enum variant at another index than its pallet", () => metadata(types(good()), pallets(6)), "the event enum puts pallet A at 5, and the pallet is at 6"],
    ["an enum variant that names no pallet", () => metadata(types(def.variant([{ name: "B", index: 5, fields: [{ type: 2 }] }])), pallets()), 'the event enum names "B", which is no pallet'],
    ["an enum variant holding another type than the pallet's events", () => metadata(types(def.variant([{ name: "A", index: 5, fields: [{ type: 0 }] }])), pallets()), "the event enum's variant A does not hold exactly that pallet's event type"],
    ["an event that is no enum", () => metadata(types(def.composite([{ type: 2 }])), pallets()), "the event of an event record is not an enum of pallets"],
    ["a record without topics", () => metadata(types(good(), def.composite([{ name: "phase", type: 1 }, { name: "event", type: 3 }])), pallets()), "an event record of System.Events does not have exactly the fields phase, event and topics"],
    ["no System.Events", () => metadata(types(good()), [{ name: "System", index: 0, entries: [{ name: "Other", plain: 6 }] }, { name: "A", index: 5, event: 2 }]), 'pallet System has no storage entry "Events"'],
  ])("refuses %s, before reading a byte", (_what, make, says) => {
    expect(refusal(() => decodeEvents(parseMetadata(make()), one))).toBe(says);
  });

  it("decodes with the value type the metadata names: the same bytes under the record type alone are refused", () => {
    const md = parseMetadata(metadata(types(good()), pallets()));
    expect(refusal(() => decodeValue(md, 5, one))).toMatch(/^type 1 \(Phase\) at byte 0: 4 is not the index of one of its variants$/);
  });
});
