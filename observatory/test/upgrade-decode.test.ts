// The boundary rule on the third recording: a block is in the encoding of the runtime that executed
// it. The runtime of each block is chosen by runtimeOfBlock (src/scale/block.ts) from the block's own
// System.LastRuntimeUpgrade, and its metadata is found on the tape by the sha256 that runtime's
// REVIEWED line names: never the version or the metadata read at the block itself, which answer for
// the next block. Every expected value comes from research/2026-11-12-runtime-upgrade/results.json or
// from the reference decoder (polkadot-api, tests only).
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type BlockEvents, decodeBlockEvents, runtimeOfBlock } from "../src/scale/block.js";
import type { Decoded } from "../src/scale/decode.js";
import { type Metadata, parseMetadata } from "../src/scale/metadata.js";
import { REVIEWED, type ReviewedShape } from "../src/scale/shape.js";
import { plain } from "./helpers/plain.js";
import { recordedUpgrade } from "./helpers/recorded-upgrade.js";
import { type Block, UPGRADE_BLOCKS } from "./helpers/requests/list-3.js";

const U = recordedUpgrade();
const RESULTS = JSON.parse(readFileSync(new URL("../../research/2026-11-12-runtime-upgrade/results.json", import.meta.url), "utf8"));
const [BEFORE, CARRIES, FIRST, LATER] = UPGRADE_BLOCKS;
const shapeOf = (r: ReviewedShape | undefined) => readFileSync(new URL(`../${r?.shapeFile}`, import.meta.url), "utf8");

/** The REVIEWED line runtimeOfBlock chooses for a block, from its own LastRuntimeUpgrade. */
function runtimeAt(b: Block): ReviewedShape {
  const r = runtimeOfBlock(U.upgradeOf(b));
  if (!r.found) throw new Error(r.refused);
  return r.reviewed;
}
/** A block's events through the door, with the runtime chosen for it and that runtime's metadata found on the tape. */
function eventsAt(b: Block, over: Partial<Parameters<typeof decodeBlockEvents>[0]> = {}): BlockEvents {
  const r = runtimeAt(b);
  return decodeBlockEvents({ specName: r.specName, specVersion: r.specVersion, metadata: U.metadataBySha(r.metadataSha256), lastRuntimeUpgrade: U.upgradeOf(b), shapeText: shapeOf(r), events: U.eventsOf(b), ...over });
}
const decoded = (e: BlockEvents) => {
  if (!e.decoded) throw new Error(e.refused);
  return e;
};
/** A decoded value in the form results.json writes it: a variant without fields as its name, a variant with fields as an object of its name. */
function asWritten(v: Decoded): unknown {
  if (Array.isArray(v)) return v.map(asWritten);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, Decoded>;
    if (Object.keys(o).length === 2 && typeof o.variant === "string" && "fields" in o && (o.fields === null || (typeof o.fields === "object" && !Array.isArray(o.fields) && Object.keys(o.fields as object).length === 0))) return o.variant;
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, asWritten(x)]));
  }
  return v;
}

describe("the block that carries the upgrade, 3528528, read by the runtime that executed it", () => {
  it("is chosen to be read by the old runtime, whose metadata is the one recorded at its parent 3528527, not the one recorded at the block", () => {
    const r = runtimeAt(CARRIES);
    expect(r).toEqual(REVIEWED.at(0));
    expect(U.metadataBySha(r.metadataSha256)).toEqual(U.metadataAt(BEFORE));
    expect(U.metadataBySha(r.metadataSha256)).not.toEqual(U.metadataAt(CARRIES));
    expect(U.versionOf(CARRIES).specVersion).toBe(REVIEWED.at(1)?.specVersion);
  });

  it("decodes to the last byte: 64 events, counted by event as the lab's reads count them", () => {
    const e = decoded(eventsAt(CARRIES));
    expect(e.reviewed).toEqual(REVIEWED.at(0));
    expect(e.events).toHaveLength(64);
    const counts: Record<string, number> = {};
    for (const x of e.events) counts[`${x.pallet}.${x.event}`] = (counts[`${x.pallet}.${x.event}`] ?? 0) + 1;
    expect(counts).toEqual(RESULTS.upgrade_block.event_counts);
  });

  it("holds the five events of extrinsic 2 the lab's reads give, field for field, System.CodeUpdated with the code hash among them", () => {
    const e = decoded(eventsAt(CARRIES));
    const ext = RESULTS.upgrade_block.extrinsic_index as number;
    const of2 = e.events.filter((x) => JSON.stringify(x.phase) === JSON.stringify({ variant: "ApplyExtrinsic", fields: ext }));
    expect(of2.map((x) => ({ index: x.index, event: `${x.pallet}.${x.event}`, fields: asWritten(x.fields) }))).toEqual(RESULTS.upgrade_block.events_of_extrinsic_2);
    const code = of2.find((x) => x.event === "CodeUpdated");
    expect((code?.fields as { hash: string }).hash).toBe(RESULTS.boundary[1].code.storage_hash);
  });

  it("is refused given the new runtime and its metadata, since its own LastRuntimeUpgrade names the old one", () => {
    const n = REVIEWED.at(1) as ReviewedShape;
    const r = eventsAt(CARRIES, { specName: n.specName, specVersion: n.specVersion, metadata: U.metadataBySha(n.metadataSha256), shapeText: shapeOf(n) });
    expect(r).toEqual({ decoded: false, refused: `not decoded: the block's LastRuntimeUpgrade names spec ${REVIEWED.at(0)?.specName} ${REVIEWED.at(0)?.specVersion}, not ${n.specName} ${n.specVersion}` });
    // results.json recorded the refusal as it was before 1014020 was a reviewed line; that is history.
    expect(RESULTS.upgrade_block.pairings_the_decoder_refuses[0].answer).toBe(`not decoded: spec ${n.specName} ${n.specVersion} is not a reviewed shape`);
  });

  it("is refused given the old runtime with the LastRuntimeUpgrade of the next block, in the words the lab's reads recorded", () => {
    const r = eventsAt(CARRIES, { lastRuntimeUpgrade: U.upgradeOf(FIRST) });
    expect(r).toEqual({ decoded: false, refused: RESULTS.upgrade_block.pairings_the_decoder_refuses[1].answer });
  });
});

describe("the blocks of the new runtime, 3528529 and 3530299", () => {
  const REF = new Map<string, { md: Metadata; builder: ReturnType<typeof getDynamicBuilder> }>();
  const refOf = (r: ReviewedShape) => {
    const known = REF.get(r.metadataSha256);
    if (known) return known;
    const bytes = U.metadataBySha(r.metadataSha256);
    const made = { md: parseMetadata(bytes), builder: getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(bytes)))) };
    REF.set(r.metadataSha256, made);
    return made;
  };

  it("are chosen to be read by the new runtime, whose metadata is the one recorded at 3528528", () => {
    for (const b of [FIRST, LATER]) {
      const r = runtimeAt(b);
      expect(r, b).toEqual(REVIEWED.at(1));
      expect(U.metadataBySha(r.metadataSha256), b).toEqual(U.metadataAt(CARRIES));
    }
  });

  it("decode to the last byte under the new runtime, of the sizes the lab's reads give", () => {
    const sizes = [RESULTS.boundary[2].events.bytes, RESULTS.a_later_block_of_the_new_spec.events.bytes];
    expect([FIRST, LATER].map((b) => U.eventsOf(b).length)).toEqual(sizes);
    for (const b of [FIRST, LATER]) {
      const e = decoded(eventsAt(b));
      expect(e.reviewed, b).toEqual(REVIEWED.at(1));
      expect(e.events.length, b).toBeGreaterThan(0);
    }
  });

  it("agree with the reference decoder event by event, on the new metadata, and are refused under the old runtime", () => {
    for (const b of [FIRST, LATER]) {
      const r = runtimeAt(b);
      const { md, builder } = refOf(r);
      const ours = decoded(eventsAt(b)).events;
      const ref = builder.buildStorage("System", "Events").value.dec(U.eventsOf(b).slice()) as { phase: unknown; event: { type: string; value: { type: string; value: unknown } }; topics: unknown }[];
      expect(ours.length, b).toBe(ref.length);
      const sys = md.pallets.find((p) => p.name === "System")?.storage?.entries.find((e) => e.name === "Events")?.value ?? -1;
      const seq = md.types.at(sys)?.def;
      const record = seq?.kind === "sequence" ? seq.type : -1;
      const rec = md.types.at(record)?.def;
      const ft = rec?.kind === "composite" ? Object.fromEntries(rec.fields.map((f) => [f.name, f.type])) : {};
      ours.forEach((o, i) => {
        const f = ref[i];
        expect([o.pallet, o.event], `${b} event ${i}`).toEqual([f?.event.type, f?.event.value.type]);
        expect(o.event, `${b} event ${i}`).not.toBe("ExtrinsicFailed");
        const ourRecord = { phase: o.phase, event: { variant: o.pallet, fields: { variant: o.event, fields: o.fields } }, topics: o.topics };
        expect(plain(md, "ours", record, ourRecord), `${b} event ${i}`).toEqual(plain(md, "reference", record, f));
        expect(plain(md, "ours", ft.phase ?? -1, o.phase)).toEqual(plain(md, "reference", ft.phase ?? -1, f?.phase));
      });
      const old = REVIEWED.at(0) as ReviewedShape;
      expect(eventsAt(b, { specName: old.specName, specVersion: old.specVersion, metadata: U.metadataBySha(old.metadataSha256), shapeText: shapeOf(old) })).toEqual({ decoded: false, refused: `not decoded: the block's LastRuntimeUpgrade names spec ${r.specName} ${r.specVersion}, not ${old.specName} ${old.specVersion}` });
    }
  });
});

describe("the block before the upgrade, 3528527", () => {
  it("is read by the old runtime with the metadata recorded at it, and decodes to the last byte, as the reference reads it", () => {
    const r = runtimeAt(BEFORE);
    expect(r).toEqual(REVIEWED.at(0));
    const e = decoded(eventsAt(BEFORE));
    const builder = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(U.metadataBySha(r.metadataSha256)))));
    const ref = builder.buildStorage("System", "Events").value.dec(U.eventsOf(BEFORE).slice()) as { event: { type: string; value: { type: string } } }[];
    expect(e.events.map((x) => [x.pallet, x.event])).toEqual(ref.map((x) => [x.event.type, x.event.value.type]));
  });
});
