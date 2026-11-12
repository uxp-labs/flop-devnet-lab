// No caller can change what the decoder has reviewed (review round 23, rule R1). REVIEWED, each of
// its lines, STATED_ENTRIES and each pair in it, PRIMITIVES and HASHERS are frozen when their module
// loads, and pinShape, decodeBlockEvents, decodeStorageValue and runtimeOfBlock each answer a fresh
// copy of the line. A write to every field of an answer's line, through each of the four, is
// followed by the reviewer's second call (spec 1014014 with the 1014020 metadata and shape file),
// which must be refused.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeBlockEvents, decodeStorageValue, runtimeOfBlock } from "../src/scale/block.js";
import { HASHERS, PRIMITIVES } from "../src/scale/metadata.js";
import { fromHex } from "../src/scale/reader.js";
import { REVIEWED, type ReviewedShape, STATED_ENTRIES, pinShape } from "../src/scale/shape.js";
import { recordedUpgrade } from "./helpers/recorded-upgrade.js";
import { keyBytes } from "./helpers/requests/core.js";
import { UPGRADE_BLOCKS } from "./helpers/requests/list-3.js";
import { cat, compact, str } from "./helpers/scale-write.js";

const U = recordedUpgrade();
const [OLD, NEW] = REVIEWED as [ReviewedShape, ReviewedShape];
const text = (r: ReviewedShape) => readFileSync(new URL(`../${r.shapeFile}`, import.meta.url), "utf8");
const BEFORE = UPGRADE_BLOCKS[0];
const TABLES = () => JSON.stringify({ REVIEWED, STATED_ENTRIES, PRIMITIVES, HASHERS });
const SAVED = TABLES();
const channel = U.reads.find((x) => x.block === BEFORE && x.answer !== null && x.read.entry === "Channels");
if (channel === undefined) throw new Error("no read");

/** The pin input of block 3528527 under the old runtime, or under spec 1014014 with the new runtime's metadata and shape. */
const pinIn = (mixed: boolean) => ({
  specName: OLD.specName,
  specVersion: OLD.specVersion,
  metadata: U.metadataBySha(mixed ? NEW.metadataSha256 : OLD.metadataSha256),
  shapeText: text(mixed ? NEW : OLD),
  lastRuntimeUpgrade: U.upgradeOf(BEFORE),
});
const storageIn = (mixed: boolean) => ({ ...pinIn(mixed), pallet: channel.read.pallet, entry: channel.read.entry, keys: keyBytes(U.inputs, channel.read), key: fromHex(channel.key), answer: channel.answer });

/** Each of the four functions: an honest call's answered line, and whether the mixed call is refused. */
const DOORS: [string, () => ReviewedShape, () => boolean][] = [
  [
    "pinShape",
    () => {
      const p = pinShape(pinIn(false));
      if (!p.pinned) throw new Error(p.refused);
      return p.reviewed;
    },
    () => !pinShape(pinIn(true)).pinned,
  ],
  [
    "decodeBlockEvents",
    () => {
      const e = decodeBlockEvents({ ...pinIn(false), events: U.eventsOf(BEFORE) });
      if (!e.decoded) throw new Error(e.refused);
      return e.reviewed;
    },
    () => !decodeBlockEvents({ ...pinIn(true), events: U.eventsOf(BEFORE) }).decoded,
  ],
  [
    "decodeStorageValue",
    () => {
      const v = decodeStorageValue(storageIn(false));
      if (!v.decoded) throw new Error(v.refused);
      return v.reviewed;
    },
    () => !decodeStorageValue(storageIn(true)).decoded,
  ],
  [
    "runtimeOfBlock",
    () => {
      const r = runtimeOfBlock(U.upgradeOf(BEFORE));
      if (!r.found) throw new Error(r.refused);
      return r.reviewed;
    },
    () => {
      const r = runtimeOfBlock(U.upgradeOf(BEFORE));
      return r.found && r.reviewed.metadataSha256 === OLD.metadataSha256 && r.reviewed.shapeSha256 === OLD.shapeSha256;
    },
  ],
];

describe("what the decoder has reviewed cannot be changed by a caller", () => {
  it.each(DOORS)("%s answers a fresh copy of the line: a write to every field of it is taken, and the mixed call after it is still refused", (_name, honest, refusedAfter) => {
    const line = honest();
    expect(line).toEqual(OLD);
    expect(REVIEWED.includes(line)).toBe(false);
    expect(honest()).not.toBe(line);
    line.specName = NEW.specName;
    line.specVersion = NEW.specVersion;
    line.metadataSha256 = NEW.metadataSha256;
    line.metadataBytes = NEW.metadataBytes;
    line.shapeFile = NEW.shapeFile;
    line.shapeSha256 = NEW.shapeSha256;
    expect(refusedAfter()).toBe(true);
    expect(TABLES()).toBe(SAVED);
  });

  it("hands out no table through a refusal of runtimeOfBlock: what it names is a fresh object, and a write to it changes no table and no later answer", () => {
    const named = { specName: OLD.specName, specVersion: OLD.specVersion + 1 };
    const other = cat(compact(named.specVersion), str(named.specName));
    const r = runtimeOfBlock(other);
    if (r.found || r.named === null) throw new Error("not a refusal that names a spec");
    expect(r.named).toEqual(named);
    r.named.specName = NEW.specName;
    r.named.specVersion = NEW.specVersion;
    expect(TABLES()).toBe(SAVED);
    const again = runtimeOfBlock(other);
    expect(again.found ? "found" : again.named).toEqual(named);
    expect(runtimeOfBlock(U.upgradeOf(BEFORE))).toEqual({ found: true, reviewed: OLD });
  });

  it("refuses a write through the import to REVIEWED, a line of it, STATED_ENTRIES, a pair of it, PRIMITIVES and HASHERS, and changes nothing", () => {
    const writes: [string, () => void][] = [
      ["a line's metadataSha256", () => { (REVIEWED[0] as { metadataSha256: string }).metadataSha256 = NEW.metadataSha256; }],
      ["a line's specVersion", () => { (REVIEWED[1] as { specVersion: number }).specVersion = OLD.specVersion; }],
      ["REVIEWED.push", () => { (REVIEWED as ReviewedShape[]).push({ ...NEW, specVersion: 1 }); }],
      ["REVIEWED.length", () => { (REVIEWED as ReviewedShape[]).length = 0; }],
      ["REVIEWED[0] replaced", () => { (REVIEWED as ReviewedShape[])[0] = { ...NEW, specVersion: OLD.specVersion }; }],
      ["STATED_ENTRIES.push", () => { (STATED_ENTRIES as [string, string][]).push(["Balances", "Account"]); }],
      ["a stated pair changed", () => { (STATED_ENTRIES[0] as unknown as string[])[1] = "Account"; }],
      ["HASHERS.push", () => { (HASHERS as unknown as string[]).push("Keccak256"); }],
      ["PRIMITIVES.push", () => { (PRIMITIVES as unknown as string[]).push("u512"); }],
    ];
    for (const [what, write] of writes) expect(write, what).toThrow(TypeError);
    expect([Object.isFrozen(REVIEWED), REVIEWED.every(Object.isFrozen), Object.isFrozen(STATED_ENTRIES), STATED_ENTRIES.every(Object.isFrozen), Object.isFrozen(PRIMITIVES), Object.isFrozen(HASHERS)]).toEqual([true, true, true, true, true, true]);
    expect(TABLES()).toBe(SAVED);
  });

  it("still decodes an honest call after every write above, and the mixed one is refused", () => {
    for (const [name, honest, refusedAfter] of DOORS) {
      expect(honest(), name).toEqual(OLD);
      expect(refusedAfter(), name).toBe(true);
    }
    expect(TABLES()).toBe(SAVED);
  });
});
