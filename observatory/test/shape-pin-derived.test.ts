// The pin's fourth refusal (src/scale/shape.ts pinLine): the shape derived again from the metadata
// differs from the reviewed file. With the committed metadata bytes and the committed shape file the
// two sha256 checks before it hold, so no input reaches it: the derivation can differ only if the
// parse does. This file is the one test allowed a module mock (RULES.md section 4, held by
// test/guard.test.ts): src/scale/metadata.js, whose parseMetadata here answers the real parse, or,
// when a test turns the change on, the real parse with one stated detail changed, the index of the
// ComputeChannel pallet, which deriveShape writes as compute_channel.index. The bytes handed in are
// the committed bytes, unchanged. Nothing under src changes and pinLine has no seam (audit 56b900b
// note 5, the lead's rule A-12 and G2).
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseMetadata } from "../src/scale/metadata.js";
import { type PinInput, REVIEWED, deriveShape, pinShape, shapeText } from "../src/scale/shape.js";
import { recorded } from "./helpers/recorded.js";

const change = vi.hoisted(() => ({ on: false }));

vi.mock("../src/scale/metadata.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/scale/metadata.js")>();
  /** The real parse with the ComputeChannel pallet at an index no pallet of the metadata holds. */
  const changed = (md: ReturnType<typeof real.parseMetadata>) => {
    const free = Math.max(...md.pallets.map((p) => p.index)) + 1;
    return { ...md, pallets: md.pallets.map((p) => (p.name === "ComputeChannel" ? { ...p, index: free } : p)) };
  };
  return { ...real, parseMetadata: (bytes: Uint8Array) => (change.on ? changed(real.parseMetadata(bytes)) : real.parseMetadata(bytes)) };
});

const R = recorded();
const LINE = REVIEWED.at(0);
const FILE = "shapes/tzkv-runtime-1014014.json";
const SHAPE = readFileSync(new URL(`../${FILE}`, import.meta.url), "utf8");
// The committed bytes, unchanged: the first recording's metadata, the reviewed shape file, and the
// LastRuntimeUpgrade the recording read at its fifth block.
const INPUT: PinInput = {
  specName: String(R.runtimeVersion.specName),
  specVersion: Number(R.runtimeVersion.specVersion),
  metadata: R.metadata,
  lastRuntimeUpgrade: R.blocks.at(4)?.lastRuntimeUpgrade ?? new Uint8Array(),
  shapeText: SHAPE,
};
const withChange = <T>(f: () => T): T => {
  change.on = true;
  try {
    return f();
  } finally {
    change.on = false;
  }
};

describe("the pin's fourth refusal: the shape derived again from the metadata differs from the reviewed file", () => {
  it("is reached with the committed bytes: the spec is reviewed, the metadata and the shape file are the reviewed ones by sha256", () => {
    expect(LINE?.shapeFile).toBe(FILE);
    expect([INPUT.specName, INPUT.specVersion]).toEqual([LINE?.specName, LINE?.specVersion]);
    expect(R.metadata.length).toBe(LINE?.metadataBytes);
  });

  it("the control: with the real parse unchanged, the pin is accepted", () => {
    const p = pinShape(INPUT);
    expect(p.pinned).toBe(true);
    expect(p.pinned && p.reviewed).toEqual(LINE);
  });

  it("the changed detail is one deriveShape writes: the derived shape names the other index and differs from the file", () => {
    const md = withChange(() => parseMetadata(R.metadata));
    const real = parseMetadata(R.metadata);
    const at = (m: typeof md) => m.pallets.find((p) => p.name === "ComputeChannel")?.index;
    expect(at(real)).toBe(JSON.parse(SHAPE).compute_channel.index);
    expect(at(md)).not.toBe(at(real));
    expect(JSON.parse(shapeText(deriveShape(md))).compute_channel.index).toBe(at(md));
    expect(shapeText(deriveShape(md))).not.toBe(SHAPE);
  });

  it("refuses with its own words and the reviewed file's name when the parse differs, and accepts again once it does not", () => {
    const p = withChange(() => pinShape(INPUT));
    expect(p).toEqual({ pinned: false, refused: `the shape derived from the metadata differs from ${FILE}` });
    expect(pinShape(INPUT).pinned).toBe(true);
  });
});
