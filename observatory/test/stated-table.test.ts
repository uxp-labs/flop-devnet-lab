// The table of what the shape states (src/scale/shape.ts STATED_TABLE, round 29): the 16 stated
// entries, in the table's order, each in both reviewed runtimes' metadata; STATED_ENTRIES derived
// from the table, so a change of the table is a change of the list; and deriveShape writing one
// entry of the shape for each line, in the section and under the key the table names.
import { describe, expect, it } from "vitest";
import { type Metadata, parseMetadata } from "../src/scale/metadata.js";
import { toHex } from "../src/scale/reader.js";
import { REVIEWED, STATED_ENTRIES, STATED_TABLE, type StatedPallet, deriveShape, statedEntriesOf, typeName } from "../src/scale/shape.js";
import { reviewedMetadata } from "./helpers/recorded-upgrade.js";

/** The 16 pairs, written out by hand in the table's order. */
const SIXTEEN = [
  ["System", "Events"],
  ["System", "LastRuntimeUpgrade"],
  ["System", "Account"],
  ["ComputeChannel", "Channels"],
  ["ComputeChannel", "FailedAcks"],
  ["ComputeChannel", "ChannelAuthoredOpenedAt"],
  ["FlopSessionKeys", "Sessions"],
  ["FlopSessionKeys", "SessionNonces"],
  ["FlopSessionKeys", "CircuitBreakers"],
  ["FlopSessionKeys", "DelegateSessions"],
  ["ModelRegistry", "Models"],
  ["ModelRegistry", "MeasuredRoots"],
  ["ModelRegistry", "AllowedDecodePolicies"],
  ["MinerStaking", "Miners"],
  ["HwCalibration", "CalibrationVersions"],
  ["HwCalibration", "LastInitialCalibration"],
];

/** What @2 states in a section beside the pallet's index, its storage prefix and its stated entries. */
const BESIDE: Record<string, string[]> = { system: ["version"], compute_channel: ["channel_states", "events"] };

/** A name in snake case: an upper case letter after the first starts a new word. */
const snake = (name: string) => name.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();

/** A plain copy of the table, which a test may change. */
const copy = (): { pallet: string; section: string; entries: { entry: string; key: string }[] }[] => JSON.parse(JSON.stringify(STATED_TABLE));

const RUNTIMES: [number, Metadata][] = REVIEWED.map((r) => [r.specVersion, parseMetadata(reviewedMetadata(r.specVersion))]);

describe("the stated table", () => {
  it("states exactly the 16 entries, in the table's order", () => {
    expect(STATED_ENTRIES).toEqual(SIXTEEN);
    expect(STATED_TABLE.map((p) => p.pallet)).toEqual(["System", "ComputeChannel", "FlopSessionKeys", "ModelRegistry", "MinerStaking", "HwCalibration"]);
  });

  it("names each section and each key by the pallet's and the entry's name in snake case", () => {
    expect(snake("ChannelAuthoredOpenedAt")).toBe("channel_authored_opened_at");
    for (const p of STATED_TABLE) {
      expect(p.section, p.pallet).toBe(snake(p.pallet));
      for (const e of p.entries) expect(e.key, `${p.pallet}.${e.entry}`).toBe(snake(e.entry));
    }
  });

  it.each(RUNTIMES)("finds each of the 16 entries in the reviewed metadata of spec %i", (_spec, md) => {
    for (const [p, e] of STATED_ENTRIES) expect(md.pallets.find((x) => x.name === p)?.storage?.entries.some((x) => x.name === e), `${p}.${e}`).toBe(true);
  });

  it("is the one source of STATED_ENTRIES: the list derived from a changed copy of the table changes with it", () => {
    expect(statedEntriesOf(STATED_TABLE)).toEqual(STATED_ENTRIES);
    const added = copy();
    added[4]?.entries.push({ entry: "TotalMiners", key: "total_miners" });
    expect(statedEntriesOf(added as StatedPallet[])).toEqual([...SIXTEEN.slice(0, 14), ["MinerStaking", "TotalMiners"], ...SIXTEEN.slice(14)]);
    const dropped = copy().filter((p) => p.pallet !== "ModelRegistry");
    expect(statedEntriesOf(dropped as StatedPallet[])).toEqual([...SIXTEEN.slice(0, 10), ...SIXTEEN.slice(13)]);
    const renamed = copy();
    const first = renamed[0]?.entries[2];
    if (first !== undefined) first.entry = "BlockHash";
    expect(statedEntriesOf(renamed as StatedPallet[]).at(2)).toEqual(["System", "BlockHash"]);
    // The list derived from any table is frozen, each pair too.
    const out = statedEntriesOf(added as StatedPallet[]);
    expect([Object.isFrozen(out), out.every(Object.isFrozen)]).toEqual([true, true]);
  });
});

describe("the shape deriveShape writes from the table", () => {
  it.each(RUNTIMES)("spec %i: one section for each pallet of the table, each holding its index, its storage prefix, the table's entries and nothing else but what @2 states beside them", (_spec, md) => {
    const s = deriveShape(md) as Record<string, Record<string, unknown>>;
    expect(Object.keys(s).sort()).toEqual(["schema", "spec_name", "spec_version", "types", ...STATED_TABLE.map((p) => p.section)].sort());
    for (const p of STATED_TABLE) {
      const pallet = md.pallets.find((x) => x.name === p.pallet);
      expect(Object.keys(s[p.section] ?? {}).sort(), p.section).toEqual(["index", "storage_prefix", ...p.entries.map((e) => e.key), ...(BESIDE[p.section] ?? [])].sort());
      expect([s[p.section]?.index, s[p.section]?.storage_prefix], p.section).toEqual([pallet?.index, pallet?.storage?.prefix]);
    }
  });

  it.each(RUNTIMES)("spec %i: each line of the table is the metadata's entry of that name, with its modifier, hashers, key, value and default bytes", (_spec, md) => {
    const s = deriveShape(md) as Record<string, Record<string, Record<string, unknown>>>;
    const types = s.types as unknown as Record<string, unknown>;
    for (const p of STATED_TABLE) {
      for (const e of p.entries) {
        const entry = md.pallets.find((x) => x.name === p.pallet)?.storage?.entries.find((x) => x.name === e.entry);
        if (entry === undefined) throw new Error(`${p.pallet}.${e.entry} is not in the metadata`);
        const stated = s[p.section]?.[e.key];
        expect(stated, `${p.pallet}.${e.entry}`).toMatchObject({
          modifier: entry.modifier,
          hashers: entry.hashers,
          key: entry.key === null ? null : typeName(md, entry.key),
          value: typeName(md, entry.value),
          default: toHex(entry.fallback),
        });
        // The key and the value are roots of the type table.
        for (const t of [stated?.key, stated?.value]) if (t !== null) expect(types[String(t)], `${p.pallet}.${e.entry} ${String(t)}`).toBeDefined();
      }
    }
  });
});
