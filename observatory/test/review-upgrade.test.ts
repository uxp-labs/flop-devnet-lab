// Independent review of the second runtime (spec 1014020), round 23. Each DEFECT test asserts what
// should hold and fails on the branch as it is; each HELD test passed under attack. Not in
// test/test-counts.json on purpose: the builder adds it when fixing.
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { decodeBlockEvents, decodeStorageValue, runtimeOfBlock } from "../src/scale/block.js";
import { decodeValue } from "../src/scale/decode.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { MAX_INPUT_BYTES, ScaleError, fromHex, toHex } from "../src/scale/reader.js";
import { REVIEWED, type ReviewedShape, pinShape } from "../src/scale/shape.js";
import { shapeDiff } from "../scripts/shape-diff.mjs";
import { plain } from "./helpers/plain.js";
import { recordedUpgrade } from "./helpers/recorded-upgrade.js";
import { keyBytes } from "./helpers/requests/core.js";
import { ACROSS, RECORDS, UPGRADE_BLOCKS } from "./helpers/requests/list-3.js";
import { bytes, cat, compact, str } from "./helpers/scale-write.js";

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const U = recordedUpgrade();
const [OLD, NEW] = REVIEWED as [ReviewedShape, ReviewedShape];
const text = (r: ReviewedShape) => readFileSync(new URL(`../${r.shapeFile}`, import.meta.url), "utf8");
const OLD_TEXT = text(OLD);
const NEW_TEXT = text(NEW);
const OLD_MD = U.metadataBySha(OLD.metadataSha256);
const NEW_MD = U.metadataBySha(NEW.metadataSha256);
const [BEFORE, CARRIES, FIRST, LATER] = UPGRADE_BLOCKS;
const SAVED = REVIEWED.map((r) => ({ ...r }));
afterEach(() => {
  // Undo any write a test made through an answer, so one test never changes the next.
  (REVIEWED as ReviewedShape[]).length = SAVED.length;
  SAVED.forEach((s, i) => Object.assign(REVIEWED[i] as ReviewedShape, s));
});
const found = (b: unknown) => {
  const r = runtimeOfBlock(b as Uint8Array);
  return r.found ? `${r.reviewed.specName} ${r.reviewed.specVersion}` : r.refused;
};

describe("A. runtimeOfBlock under attack", () => {
  const good = U.upgradeOf(BEFORE);
  const NAME = OLD.specName;
  const v = OLD.specVersion;

  it("HELD: every odd input ends in a refusal with a text of ours, never another exception", () => {
    class Sub extends Uint8Array {
      findLastIndex(): number {
        throw new Error("theirs");
      }
      set(): void {
        throw new Error("theirs");
      }
    }
    const sub = new Sub(good.length);
    Uint8Array.prototype.set.call(sub, good);
    const detached = new Uint8Array(good);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const trap = new Proxy(good, { getPrototypeOf: () => { throw new Error("theirs"); } });
    const proto = new Proxy(good, { get: () => { throw new Error("theirs"); } });
    const ours = /^no reviewed runtime: /;
    for (const x of [trap, proto, detached, new Uint8Array(MAX_INPUT_BYTES + 1), new Uint16Array(4), new DataView(new ArrayBuffer(4)), good.buffer, Symbol("x"), 1n, () => good]) {
      expect(() => runtimeOfBlock(x as never)).not.toThrow();
      expect(found(x)).toMatch(ours);
    }
    // A subclass is bytes: its own methods are never asked, so it reads as the real record.
    expect(found(sub)).toBe(`${NAME} ${v}`);
    expect(found(detached)).toBe("no reviewed runtime: the LastRuntimeUpgrade is not bytes");
    expect(found(new Uint8Array(MAX_INPUT_BYTES + 1))).toBe(`no reviewed runtime: the LastRuntimeUpgrade is ${MAX_INPUT_BYTES + 1} bytes, more than the ${MAX_INPUT_BYTES} this decoder reads`);
  });

  it("HELD: a name that differs from tzkv-runtime by case, a NUL, a combining mark, a look alike letter or a BOM is no reviewed line", () => {
    for (const n of ["Tzkv-runtime", "TZKV-RUNTIME", `${NAME}\u0000`, `\u0000${NAME}`, `tzkv-runtimé`, "tzkv‐runtime", "tzkv-runtimе", "tzkv-runтime", `${NAME} `, `﻿${NAME}`]) {
      expect(found(cat(compact(v), str(n))), JSON.stringify(n)).toBe(`no reviewed runtime: the block's LastRuntimeUpgrade names spec ${JSON.stringify(n)} ${v}, which no reviewed line names`);
    }
    // 256 characters of four bytes each: 1024 bytes, 512 UTF-16 units, refused by the length rule.
    expect(found(cat(compact(v), str("\u{1f600}".repeat(129))))).toBe("no reviewed runtime: the spec name is longer than 256 characters");
    expect(found(cat(compact(0xffffffff), str(NAME)))).toMatch(/names spec "tzkv-runtime" 4294967295, which no reviewed line names$/);
  });

  it("HELD: runtimeOfBlock and the pin agree on every single byte change, cut and extension of the four recorded records", () => {
    const shapes = new Map([[OLD.specVersion, { md: OLD_MD, text: OLD_TEXT }], [NEW.specVersion, { md: NEW_MD, text: NEW_TEXT }]]);
    let tried = 0;
    let pinnedCount = 0;
    const check = (lru: Uint8Array) => {
      const r = runtimeOfBlock(lru);
      for (const line of [OLD, NEW]) {
        const s = shapes.get(line.specVersion) as { md: Uint8Array; text: string };
        const p = pinShape({ specName: line.specName, specVersion: line.specVersion, metadata: s.md, shapeText: s.text, lastRuntimeUpgrade: lru });
        const says = r.found && r.reviewed.specVersion === line.specVersion;
        expect(p.pinned, `${toHex(lru)} under ${line.specVersion}`).toBe(says);
        if (p.pinned) pinnedCount++;
      }
      tried++;
    };
    // The two distinct records of the four blocks (3528527 and 3528528 hold the same bytes, so do 3528529 and 3530299).
    const distinct = [...new Map(UPGRADE_BLOCKS.map((b) => [toHex(U.upgradeOf(b)), U.upgradeOf(b)])).values()];
    expect(distinct).toHaveLength(2);
    for (const lru of distinct) {
      check(lru);
      for (let i = 0; i < lru.length; i++) check(lru.subarray(0, i));
      check(cat(lru, bytes(0)));
      for (let i = 0; i < lru.length; i++) for (const f of [(x: number) => x ^ 1, (x: number) => x ^ 0x80, () => 0, () => 0xff]) {
        const m = lru.slice();
        m.set([f(m.at(i) as number)], i);
        check(m);
      }
    }
    expect(tried).toBeGreaterThan(150);
    // Each record pins once, and once more where a byte set to 0 was already 0 (the fourth byte of each).
    expect(pinnedCount).toBe(4);
  }, 600_000);
});

describe("B. the pin hands out the REVIEWED line itself", () => {
  it("DEFECT 1 (high): a write through a door's answer makes a later call pin a pairing nobody reviewed", () => {
    // A first honest call: block 3528527 under the old runtime.
    const honest = decodeBlockEvents({ specName: OLD.specName, specVersion: OLD.specVersion, metadata: OLD_MD, shapeText: OLD_TEXT, lastRuntimeUpgrade: U.upgradeOf(BEFORE), events: U.eventsOf(BEFORE) });
    if (!honest.decoded) throw new Error(honest.refused);
    // A write through its answer: the old line now names the new runtime's metadata and shape.
    const w = honest.reviewed as { metadataSha256: string; metadataBytes: number; shapeSha256: string; shapeFile: string };
    try {
      w.metadataSha256 = NEW.metadataSha256;
      w.metadataBytes = NEW.metadataBytes;
      w.shapeSha256 = NEW.shapeSha256;
    } catch {
      // A frozen answer refuses the write: that is what should hold.
    }
    // A second call: spec 1014014 with the 1014020 metadata and shape, a pairing that must be refused.
    const mixed = decodeBlockEvents({ specName: OLD.specName, specVersion: OLD.specVersion, metadata: NEW_MD, shapeText: NEW_TEXT, lastRuntimeUpgrade: U.upgradeOf(BEFORE), events: U.eventsOf(BEFORE) });
    expect(mixed.decoded ? `decoded ${mixed.events.length} events of 3528527 with the 1014020 metadata as spec 1014014` : "refused").toBe("refused");
    expect(Object.isFrozen(REVIEWED) && REVIEWED.every((r) => Object.isFrozen(r))).toBe(true);
  });

  it("DEFECT 1 (high), the same through decodeStorageValue and pinShape: the answer is the line, not a copy", () => {
    const r = U.reads.find((x) => x.block === BEFORE && x.answer !== null && x.read.entry === "Channels");
    if (r === undefined) throw new Error("no read");
    const v = decodeStorageValue({ specName: OLD.specName, specVersion: OLD.specVersion, metadata: OLD_MD, shapeText: OLD_TEXT, lastRuntimeUpgrade: U.upgradeOf(BEFORE), pallet: r.read.pallet, entry: r.read.entry, keys: keyBytes(U.inputs, r.read), key: fromHex(r.key), answer: r.answer });
    if (!v.decoded) throw new Error(v.refused);
    expect(v.reviewed === REVIEWED.at(0)).toBe(false);
    const p = pinShape({ specName: NEW.specName, specVersion: NEW.specVersion, metadata: NEW_MD, shapeText: NEW_TEXT, lastRuntimeUpgrade: U.upgradeOf(LATER) });
    expect(p.pinned && p.reviewed === REVIEWED.at(1)).toBe(false);
  });
});

/** The four recorded LastRuntimeUpgrade values and the runtime that executed each block. */
const LRU = UPGRADE_BLOCKS.map((b, i) => ({ block: b, bytes: U.upgradeOf(b), runtime: i < 2 ? OLD : NEW }));
const ROWS = [OLD, NEW].flatMap((spec) => [OLD, NEW].flatMap((md) => [OLD, NEW].flatMap((shape) => LRU.map((l) => ({ spec, md, shape, l })))));
const truth = (x: (typeof ROWS)[number]) => x.spec === x.md && x.md === x.shape && x.l.runtime === x.spec;
const pinIn = (x: (typeof ROWS)[number]) => ({ specName: x.spec.specName, specVersion: x.spec.specVersion, metadata: x.md === OLD ? OLD_MD : NEW_MD, shapeText: x.shape === OLD ? OLD_TEXT : NEW_TEXT, lastRuntimeUpgrade: x.l.bytes });
/** The reason the pin must give for a row, by the first check it fails, in the pin's order. */
const reason = (x: (typeof ROWS)[number]) => {
  const m = x.md === OLD ? OLD_MD : NEW_MD;
  if (x.md !== x.spec) return `the metadata for spec ${x.spec.specVersion} is ${m.length} bytes with sha256 ${sha256(m)}, not the reviewed ${x.spec.metadataBytes} bytes with sha256 ${x.spec.metadataSha256}`;
  if (x.shape !== x.spec) return `the shape file given is not the reviewed ${x.spec.shapeFile}`;
  return `the block's LastRuntimeUpgrade names spec ${x.l.runtime.specName} ${x.l.runtime.specVersion}, not ${x.spec.specName} ${x.spec.specVersion}`;
};

describe("C. every pairing of spec, metadata, shape file and LastRuntimeUpgrade", () => {
  it("HELD: of 32 rows through pinShape only the 4 true rows pin, and each mixed row is refused for the first thing that is wrong in it", () => {
    expect(ROWS).toHaveLength(32);
    expect(ROWS.filter(truth)).toHaveLength(4);
    for (const x of ROWS) {
      const p = pinShape(pinIn(x));
      const label = `${x.spec.specVersion} md ${x.md.specVersion} shape ${x.shape.specVersion} at ${x.l.block}`;
      if (truth(x)) expect(p.pinned ? p.reviewed : p.refused, label).toEqual(x.spec);
      else expect(p.pinned ? "pinned" : p.refused, label).toBe(reason(x));
    }
  });

  it("HELD: the same 32 rows through decodeBlockEvents and decodeStorageValue", () => {
    const read = (b: string) => U.reads.find((y) => y.block === b && y.read.entry === "Channels" && y.answer !== null);
    for (const x of ROWS) {
      const e = decodeBlockEvents({ ...pinIn(x), events: U.eventsOf(x.l.block) });
      const label = `${x.spec.specVersion} md ${x.md.specVersion} shape ${x.shape.specVersion} at ${x.l.block}`;
      if (truth(x)) expect(e.decoded, label).toBe(true);
      else expect(e.decoded ? "decoded" : e.refused, label).toBe(`not decoded: ${reason(x)}`);
      const r = read(x.l.block) ?? read(ACROSS[0]);
      if (r === undefined) throw new Error("no read");
      // A read of block 3528527 or 3530299 at its own block; at the other two, the 3528527 read with that block's LastRuntimeUpgrade.
      const s = decodeStorageValue({ ...pinIn(x), pallet: r.read.pallet, entry: r.read.entry, keys: keyBytes(U.inputs, r.read), key: fromHex(r.key), answer: r.answer });
      if (truth(x)) expect(s.decoded, label).toBe(true);
      else expect(s.decoded ? "decoded" : s.refused, label).toBe(`not decoded: ${reason(x)}`);
    }
  });
});
