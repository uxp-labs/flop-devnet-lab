// Differential tests: the observatory's decoder against the reference, polkadot-api (a dev
// dependency for tests only; the source scan keeps it out of src). The recorded metadata is parsed
// by both and compared field by field, and every recorded value is decoded by both and compared in
// one plain form (test/helpers/plain.ts).
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import { decodeValue } from "../src/scale/decode.js";
import { type Metadata, parseMetadata } from "../src/scale/metadata.js";
import { toHex } from "../src/scale/reader.js";
import { storageKey } from "../src/scale/storage-key.js";
import { plain } from "./helpers/plain.js";
import { EVENTS_KEY, LAST_RUNTIME_UPGRADE_KEY, hexBytes, recorded } from "./helpers/recorded.js";

const R = recorded();
const OURS = parseMetadata(R.metadata);
const REF = decAnyMetadata(R.metadata);
const BUILDER = getDynamicBuilder(getLookupFn(unifyMetadata(REF)));
const CHANNEL = "0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7";

// The reference's metadata V14, written in the observatory's own form, so the two parses can be
// compared whole. Only the spelling differs: a None is undefined there and null here, a hasher is
// Blake2128Concat there and Blake2_128Concat here, a fallback or constant is hex there.
type RefV14 = Extract<ReturnType<typeof decAnyMetadata>["metadata"], { tag: "v14" }>["value"];
const HASHER: Record<string, string> = {
  Blake2128: "Blake2_128",
  Blake2256: "Blake2_256",
  Blake2128Concat: "Blake2_128Concat",
  Twox128: "Twox128",
  Twox256: "Twox256",
  Twox64Concat: "Twox64Concat",
  Identity: "Identity",
};
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const field = (f: { name?: string; type: number; typeName?: string; docs: string[] }) => ({ name: orNull(f.name), type: f.type, typeName: orNull(f.typeName), docs: f.docs });
function defOf(d: RefV14["lookup"][number]["def"]) {
  switch (d.tag) {
    case "composite":
      return { kind: "composite", fields: d.value.map(field) };
    case "variant":
      return { kind: "variant", variants: d.value.map((v) => ({ name: v.name, fields: v.fields.map(field), index: v.index, docs: v.docs })) };
    case "sequence":
      return { kind: "sequence", type: d.value };
    case "array":
      return { kind: "array", len: d.value.len, type: d.value.type };
    case "tuple":
      return { kind: "tuple", types: d.value };
    case "primitive":
      return { kind: "primitive", primitive: d.value.tag };
    case "compact":
      return { kind: "compact", type: d.value };
    case "bitSequence":
      return { kind: "bitSequence", store: d.value.bitStoreType, order: d.value.bitOrderType };
  }
}
function fromReference(m: RefV14): unknown {
  return {
    version: 14,
    types: m.lookup.map((t) => ({ id: t.id, path: t.path, params: t.params.map((p) => ({ name: p.name, type: orNull(p.type) })), def: defOf(t.def), docs: t.docs })),
    pallets: m.pallets.map((p) => ({
      name: p.name,
      index: p.index,
      storage:
        p.storage === undefined
          ? null
          : {
              prefix: p.storage.prefix,
              entries: p.storage.items.map((e) => ({
                name: e.name,
                modifier: e.modifier === 0 ? "Optional" : "Default",
                hashers: e.type.tag === "map" ? e.type.value.hashers.map((h) => HASHER[h.tag]) : [],
                key: e.type.tag === "map" ? e.type.value.key : null,
                value: e.type.tag === "map" ? e.type.value.value : e.type.value,
                fallback: e.fallback,
                docs: e.docs,
              })),
            },
      calls: orNull(p.calls),
      event: orNull(p.events),
      error: orNull(p.errors),
      constants: p.constants.map((c) => ({ name: c.name, type: c.type, value: c.value, docs: c.docs })),
    })),
    extrinsic: m.extrinsic,
    runtimeType: m.type,
  };
}
/** Our parse with every byte string as hex, the reference's spelling of them. */
function oursAsHex(m: Metadata): unknown {
  return {
    ...m,
    pallets: m.pallets.map((p) => ({
      ...p,
      storage: p.storage === null ? null : { ...p.storage, entries: p.storage.entries.map((e) => ({ ...e, fallback: toHex(e.fallback) })) },
      constants: p.constants.map((c) => ({ ...c, value: toHex(c.value) })),
    })),
  };
}

describe("the recorded metadata, parsed by both", () => {
  it("is version 14 to both, and both read the same 887 types, 62 pallets, extrinsic and runtime type, every field and doc", () => {
    expect(REF.metadata.tag).toBe("v14");
    if (REF.metadata.tag !== "v14") return;
    expect(OURS.types.length).toBe(887);
    expect(OURS.pallets.length).toBe(62);
    // Compared whole: the reference's pallets carry an empty docs list V14 does not have.
    expect(REF.metadata.value.pallets.every((p) => Array.isArray(p.docs) && p.docs.length === 0)).toBe(true);
    expect(oursAsHex(OURS)).toEqual(fromReference(REF.metadata.value));
  });
});

describe("every recorded value, decoded by both", () => {
  it("decodes System.Events of all twelve blocks to the same values", () => {
    const events = OURS.pallets.find((p) => p.name === "System")?.storage?.entries.find((e) => e.name === "Events")?.value ?? -1;
    const codec = BUILDER.buildStorage("System", "Events").value;
    let n = 0;
    for (const b of R.blocks) {
      const ours = plain(OURS, "ours", events, decodeValue(OURS, events, b.events));
      const ref = plain(OURS, "reference", events, codec.dec(b.events));
      expect(ours, `block ${b.number}`).toEqual(ref);
      n += (ours as unknown[]).length;
    }
    expect(n).toBe(190);
  });

  it("tells one changed field apart: a bit flipped in Settled's miner_paid at block 3479299 shows there and nowhere else", () => {
    const events = OURS.pallets.find((p) => p.name === "System")?.storage?.entries.find((e) => e.name === "Events")?.value ?? -1;
    const b = R.blocks.find((x) => x.number === 3479299);
    const bytes = b?.events.slice() ?? new Uint8Array();
    // Offset 888 holds 0x67 0x17 (ComputeChannel, Settled), then the channel id, then miner_paid.
    expect(toHex(bytes.subarray(888, 890))).toBe("0x6717");
    bytes.set([(bytes.at(922) ?? 0) ^ 1], 922);
    const ours = plain(OURS, "ours", events, decodeValue(OURS, events, bytes)) as { event: unknown }[];
    const ref = plain(OURS, "reference", events, BUILDER.buildStorage("System", "Events").value.dec(b?.events.slice() ?? new Uint8Array())) as { event: unknown }[];
    expect(ours.length).toBe(ref.length);
    const differ = ours.map((e, i) => JSON.stringify(e) !== JSON.stringify(ref.at(i))).flatMap((d, i) => (d ? [i] : []));
    expect(differ).toEqual([16]);
    expect(JSON.stringify(ours.at(16))).toContain('"miner_paid":"112860000000000003"');
  });

  it("decodes System.LastRuntimeUpgrade at all twelve blocks to the same values", () => {
    const lru = OURS.pallets.find((p) => p.name === "System")?.storage?.entries.find((e) => e.name === "LastRuntimeUpgrade")?.value ?? -1;
    const codec = BUILDER.buildStorage("System", "LastRuntimeUpgrade").value;
    for (const b of R.blocks) expect(plain(OURS, "ours", lru, decodeValue(OURS, lru, b.lastRuntimeUpgrade))).toEqual(plain(OURS, "reference", lru, codec.dec(b.lastRuntimeUpgrade)));
  });

  it("decodes every constant of every pallet to the same values", () => {
    let n = 0;
    for (const p of OURS.pallets) {
      for (const c of p.constants) {
        // A copy: our constant is a view into the metadata bytes, and the reference reads a view
        // from the start of the buffer under it, not from the view's own offset.
        const ref = BUILDER.buildConstant(p.name, c.name).dec(c.value.slice());
        expect(plain(OURS, "ours", c.type, decodeValue(OURS, c.type, c.value)), `${p.name}.${c.name}`).toEqual(plain(OURS, "reference", c.type, ref));
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
  });

  it("builds the same storage keys as the reference for System.Events, System.LastRuntimeUpgrade and ComputeChannel.Channels", () => {
    expect(BUILDER.buildStorage("System", "Events").keys.enc()).toBe(EVENTS_KEY);
    expect(BUILDER.buildStorage("System", "LastRuntimeUpgrade").keys.enc()).toBe(LAST_RUNTIME_UPGRADE_KEY);
    expect(toHex(storageKey(OURS, "ComputeChannel", "Channels", [hexBytes(CHANNEL)]))).toBe(BUILDER.buildStorage("ComputeChannel", "Channels").keys.enc(CHANNEL));
  });
});
