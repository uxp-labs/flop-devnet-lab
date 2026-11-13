// A shape of decoder-shape@2 is refused by everything that reads a shape (round 29, rule A4), with
// words that name both formats: the pin and the doors through it, the shape diff, and the shape
// writer's compare. The @2 files are the two shape files as main held them before round 29
// (fixtures/shapes-at-2, taken from git history), their sha256 in that folder's SHA256SUMS.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeBlockEvents } from "../src/scale/block.js";
import { REVIEWED, SHAPE_SCHEMA, pinShape, schemaNamed } from "../src/scale/shape.js";
import { readShape } from "../scripts/shape-diff.mjs";
import { recordedUpgrade } from "./helpers/recorded-upgrade.js";
import { UPGRADE_BLOCKS } from "./helpers/requests/list-3.js";
import { derivedShapeFile, writeShapeMain } from "./helpers/shape-file.js";

const OLD_SCHEMA = "flop-observatory/decoder-shape@2";
const FIXTURE = new URL("../fixtures/shapes-at-2/", import.meta.url);
const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");
const SUMS = new Map(
  readFileSync(new URL("SHA256SUMS", FIXTURE), "utf8")
    .trim()
    .split("\n")
    .map((l) => {
      const [h, f] = l.split(/\s+/);
      return [String(f), String(h)];
    }),
);
const U = recordedUpgrade();
const [BEFORE, , , LATER] = UPGRADE_BLOCKS;
/** Each reviewed line, its @2 file's text, and a block of its runtime. */
const LINES = REVIEWED.map((r) => {
  const name = r.shapeFile.replace(/^shapes\//, "");
  return { r, name, old: readFileSync(new URL(name, FIXTURE), "utf8"), current: readFileSync(new URL(`../${r.shapeFile}`, import.meta.url), "utf8"), block: r.specVersion === 1014014 ? BEFORE : LATER };
});
const BOTH = `: it is ${OLD_SCHEMA}, not ${SHAPE_SCHEMA}`;

describe("a shape of decoder-shape@2", () => {
  it("is what the fixture holds: the two files of the @2 form, by the sha256 its SHA256SUMS gives, the 1014014 one the sha256 the runtime upgrade record names", () => {
    expect(SHAPE_SCHEMA).toBe("flop-observatory/decoder-shape@3");
    expect([...SUMS.keys()].filter((f) => f.startsWith("tzkv-runtime-")).sort()).toEqual(LINES.map((l) => l.name).sort());
    for (const l of LINES) {
      expect(sha256(l.old), l.name).toBe(SUMS.get(l.name));
      expect(JSON.parse(l.old).schema, l.name).toBe(OLD_SCHEMA);
      expect(schemaNamed(l.old), l.name).toBe(OLD_SCHEMA);
    }
    const record = readFileSync(new URL("../../research/2026-11-12-runtime-upgrade/results.json", import.meta.url), "utf8");
    expect(record).toContain(`"shape_sha256": "${SUMS.get("tzkv-runtime-1014014.json")}"`);
  });

  it("is named by no reviewed line: no line holds an old sha256", () => {
    for (const l of LINES) expect(REVIEWED.map((r) => r.shapeSha256), l.name).not.toContain(SUMS.get(l.name));
  });

  it.each(LINES.map((l) => [l.r.specVersion, l] as const))("is refused by the pin and the events door for spec %i, the old bytes and the current file with the old schema, naming both formats", (_spec, l) => {
    const input = { specName: l.r.specName, specVersion: l.r.specVersion, metadata: U.metadataBySha(l.r.metadataSha256), lastRuntimeUpgrade: U.upgradeOf(l.block) };
    const said = `the shape file given is not the reviewed ${l.r.shapeFile}${BOTH}`;
    const relabelled = l.current.replace(`"schema": "${SHAPE_SCHEMA}"`, `"schema": "${OLD_SCHEMA}"`);
    expect(relabelled).not.toBe(l.current);
    for (const shapeText of [l.old, relabelled]) {
      const p = pinShape({ ...input, shapeText });
      expect(p.pinned ? "pinned" : p.refused).toBe(said);
      expect(decodeBlockEvents({ ...input, shapeText, events: U.eventsOf(l.block) })).toEqual({ decoded: false, refused: `not decoded: ${said}` });
    }
    // The current file is pinned, and a refusal of a current file one byte off names no format.
    const p = pinShape({ ...input, shapeText: l.current });
    expect(p.pinned).toBe(true);
    const q = pinShape({ ...input, shapeText: `${l.current} ` });
    expect(q.pinned ? "pinned" : q.refused).toBe(`the shape file given is not the reviewed ${l.r.shapeFile}`);
  });

  it("is refused by the shape diff, naming both formats", () => {
    for (const l of LINES) expect(() => readShape(l.old, l.name)).toThrow(`${l.name}: the schema is "${OLD_SCHEMA}", not ${SHAPE_SCHEMA}`);
  });

  it("differs, by the shape writer's compare, from what it derives, naming both formats; it writes nothing", () => {
    for (const l of LINES) {
      const written: string[] = [];
      const r = writeShapeMain(["--spec", String(l.r.specVersion)], { read: () => l.old, write: (f) => written.push(f), derive: derivedShapeFile });
      expect(r).toEqual({ code: 1, stdout: `${l.r.shapeFile} differs from the shape derived from the reviewed metadata of spec ${l.r.specVersion}${BOTH}\n`, stderr: "" });
      expect(written).toEqual([]);
    }
  });

  it("names a schema only from the top level line shapeText writes for it", () => {
    expect(schemaNamed('{\n  "schema": "x@1",\n  "types": {}\n}\n')).toBe("x@1");
    expect(schemaNamed('{\n    "schema": "x@1",\n}\n')).toBeNull();
    expect(schemaNamed('{"schema":"x@1"}')).toBeNull();
    expect(schemaNamed(`{\n  "schema": "${"a".repeat(129)}",\n}`)).toBeNull();
  });
});
