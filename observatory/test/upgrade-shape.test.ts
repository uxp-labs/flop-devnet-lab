// The reviewed shape of spec 1014020 (shapes/tzkv-runtime-1014020.json, the second line of REVIEWED
// in src/scale/shape.ts): derived by deriveShape from the metadata the third recording holds at
// block 3528528, the block that carries the upgrade, whose metadata answers for the next block, and
// derived a second way from the reference decoder's own parse of the same bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMetadata } from "../src/scale/metadata.js";
import { REVIEWED, STATED_ENTRIES, deriveShape, pinShape, shapeText } from "../src/scale/shape.js";
import { recordedUpgrade } from "./helpers/recorded-upgrade.js";
import { referenceShape } from "./helpers/reference-shape.js";
import { UPGRADE_BLOCKS } from "./helpers/requests/list-3.js";
import { shapeDiff, shapeDiffText } from "../scripts/shape-diff.mjs";

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const U = recordedUpgrade();
const RESULTS = JSON.parse(readFileSync(new URL("../../research/2026-11-12-runtime-upgrade/results.json", import.meta.url), "utf8"));
const [BEFORE, CARRIES, FIRST, LATER] = UPGRADE_BLOCKS;
const NEW = REVIEWED.at(1);
const OLD = REVIEWED.at(0);
const META = U.metadataAt(CARRIES);
const SHAPE = readFileSync(new URL(`../${NEW?.shapeFile}`, import.meta.url), "utf8");
const OLD_SHAPE = readFileSync(new URL(`../${OLD?.shapeFile}`, import.meta.url), "utf8");

describe("the reviewed shape of spec 1014020", () => {
  it("is the second line of REVIEWED: the spec the new runtime names, the metadata recorded at 3528528 and in the lab's reads by length and sha256, and the committed file by sha256", () => {
    expect(REVIEWED).toHaveLength(2);
    expect(NEW).toEqual({
      specName: U.versionOf(FIRST).specName,
      specVersion: U.versionOf(FIRST).specVersion,
      metadataSha256: RESULTS.boundary[1].metadata.sha256,
      metadataBytes: RESULTS.boundary[1].metadata.bytes,
      shapeFile: "shapes/tzkv-runtime-1014020.json",
      shapeSha256: sha256(SHAPE),
    });
    expect([META.length, sha256(META)]).toEqual([NEW?.metadataBytes, NEW?.metadataSha256]);
    expect(NEW?.specVersion).toBe(RESULTS.boundary[2].last_runtime_upgrade.spec_version);
  });

  it("is, byte for byte, the shape deriveShape gives the recorded metadata, which the strict parser reads whole", () => {
    expect(shapeText(deriveShape(parseMetadata(META)))).toBe(SHAPE);
  });

  it("is the shape derived again from the reference decoder's own parse with an independent namer", () => {
    const mine = referenceShape(META);
    expect(Object.keys(mine.types).length).toBe(469);
    expect([mine.spec_name, mine.spec_version]).toEqual([NEW?.specName, NEW?.specVersion]);
    expect(mine).toEqual(JSON.parse(SHAPE));
  });

  it("states the same pallets and the same six entries as spec 1014014's shape", () => {
    const s = JSON.parse(SHAPE);
    const o = JSON.parse(OLD_SHAPE);
    expect(Object.keys(s)).toEqual(Object.keys(o));
    for (const k of ["system", "compute_channel", "flop_session_keys"]) expect(Object.keys(s[k]), k).toEqual(Object.keys(o[k]));
    expect(STATED_ENTRIES).toHaveLength(6);
    const md = parseMetadata(META);
    for (const [p, e] of STATED_ENTRIES) expect(md.pallets.find((x) => x.name === p)?.storage?.entries.some((x) => x.name === e), `${p}.${e}`).toBe(true);
  });

  it("pins a block of the new runtime with its metadata, and refuses the new metadata under the old spec's line", () => {
    const base = { specName: String(NEW?.specName), specVersion: Number(NEW?.specVersion), metadata: META, lastRuntimeUpgrade: U.upgradeOf(LATER), shapeText: SHAPE };
    const p = pinShape(base);
    expect(p.pinned ? p.reviewed : p.refused).toEqual(NEW);
    const q = pinShape({ ...base, specVersion: Number(OLD?.specVersion), shapeText: OLD_SHAPE });
    expect(q.pinned ? "pinned" : q.refused).toBe(`the metadata for spec ${OLD?.specVersion} is ${META.length} bytes with sha256 ${sha256(META)}, not the reviewed ${OLD?.metadataBytes} bytes with sha256 ${OLD?.metadataSha256}`);
    const r = pinShape({ ...base, lastRuntimeUpgrade: U.upgradeOf(BEFORE) });
    expect(r.pinned ? "pinned" : r.refused).toBe(`the block's LastRuntimeUpgrade names spec ${OLD?.specName} ${OLD?.specVersion}, not ${NEW?.specName} ${NEW?.specVersion}`);
  });
});

/** A copy of a shape whose every type id is moved by an offset: the same types, renumbered. */
const renumbered = (text: string, by: number) => JSON.parse(text.replace(/#(\d+)/g, (_m, n) => `#${Number(n) + by}`));

describe("the shape diff, scripts/shape-diff.mjs", () => {
  const DIFF = readFileSync(new URL("../shapes/diff-tzkv-runtime-1014014-1014020.txt", import.meta.url), "utf8");

  it("gives, run again, the committed diff of 1014014 against 1014020 byte for byte: plain lines, sorted, no dashes", () => {
    expect(shapeDiffText(OLD_SHAPE, SHAPE)).toBe(DIFF);
    const lines = DIFF.split("\n").slice(0, -1);
    expect(lines).toEqual([...lines].sort());
    for (const l of lines) expect(l, l).toMatch(/^[^\u0000-\u001f\u007f]+$/);
    for (const l of lines) expect(l, l).not.toMatch(/[\u2010-\u2015]| - /);
    expect(lines).toContain("FlopSessionKeys: no difference in what the shapes state");
  });

  it("says a shape has no difference from itself, and from itself with every type id renumbered: ids alone are no difference", () => {
    const none = ["ComputeChannel: no difference in what the shapes state", "FlopSessionKeys: no difference in what the shapes state", "System: no difference in what the shapes state"];
    expect(shapeDiff(JSON.parse(SHAPE), JSON.parse(SHAPE))).toEqual(none);
    expect(shapeDiff(JSON.parse(SHAPE), renumbered(SHAPE, 1000))).toEqual(none);
    expect(shapeDiff(JSON.parse(OLD_SHAPE), renumbered(SHAPE, 7))).toEqual(shapeDiff(JSON.parse(OLD_SHAPE), JSON.parse(SHAPE)));
  });

  it("reports a difference when one field's type is changed in a copy, where the field is", () => {
    const copy = JSON.parse(SHAPE);
    const spent = copy.types[copy.flop_session_keys.sessions.value].fields.find((f: { name: string }) => f.name === "spent");
    expect(spent.type).toBe("u128");
    spent.type = "u64";
    expect(shapeDiff(JSON.parse(SHAPE), copy)).toEqual([
      "ComputeChannel: no difference in what the shapes state",
      "FlopSessionKeys.Sessions value.spent: type was u128, now u64",
      "System: no difference in what the shapes state",
    ]);
  });
});
