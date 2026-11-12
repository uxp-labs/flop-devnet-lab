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

describe("D. the shape diff script against hand made pairs", () => {
  const changed = (f: (c: any) => void) => {
    const c = JSON.parse(NEW_TEXT);
    f(c);
    return shapeDiff(JSON.parse(NEW_TEXT), c).filter((l: string) => !l.endsWith(": no difference in what the shapes state"));
  };
  const ty = (c: any, n: string) => c.types[n];

  it("HELD: each change that alters decoding prints a line that names where it is, and a change of ids alone prints none", () => {
    const s = JSON.parse(NEW_TEXT);
    const channel = s.compute_channel.channels.value as string;
    const sla = ty(s, channel).fields.find((f: { name: string }) => f.name === "sla").type as string;
    const state = ty(s, channel).fields.find((f: { name: string }) => f.name === "state").type as string;
    const cases: [string, (c: any) => void, RegExp][] = [
      ["a field renamed", (c) => { ty(c, c.flop_session_keys.sessions.value).fields.find((f: { name: string }) => f.name === "spent").name = "spend"; }, /^FlopSessionKeys\.Sessions value: fields were/],
      ["two same typed fields swapped", (c) => { const f = ty(c, channel).fields; [f[0], f[1]] = [f[1], f[0]]; }, /^ComputeChannel\.Channels value: fields were \(agent: AccountId32, miner/],
      ["a type changed deep inside", (c) => { ty(c, sla).fields[0].type = "u64"; }, /^ComputeChannel\.Channels value\.sla\.max_turns: type was u32, now u64$/],
      ["a variant index moved", (c) => { ty(c, state).variants[3].index = 4; }, /moved from index 3 to index 4$/],
      ["a variant removed", (c) => { ty(c, state).variants.pop(); }, /value\.state: variant PendingAck removed/],
      ["an event removed", (c) => { c.compute_channel.events.pop(); }, /^ComputeChannel events: event \w+ removed/],
      ["a hasher changed", (c) => { c.compute_channel.channels.hashers = ["Twox64Concat"]; }, /^ComputeChannel\.Channels hashers:/],
      ["a modifier changed", (c) => { c.compute_channel.channels.modifier = "Default"; }, /^ComputeChannel\.Channels modifier:/],
      ["default bytes changed", (c) => { c.flop_session_keys.sessions.default = "0x01"; }, /^FlopSessionKeys\.Sessions default bytes:/],
      ["a storage prefix changed", (c) => { c.system.storage_prefix = "Sys"; }, /^System storage prefix:/],
      ["a pallet index changed", (c) => { c.compute_channel.index += 1; }, /^ComputeChannel index:/],
      ["a key type changed to another 32 byte type", (c) => { c.compute_channel.channels.key = "AccountId32#0"; }, /^ComputeChannel\.Channels key: type was H256, now AccountId32$/],
      ["the System.Version type changed", (c) => { ty(c, c.system.version).fields[1].type = "u64"; }, /^System\.Version\.impl_name:/],
      ["a type reachable only from LastRuntimeUpgrade", (c) => { ty(c, c.system.last_runtime_upgrade.value).fields[0].type = "u32"; }, /^System\.LastRuntimeUpgrade value\.spec_version: type was Compact<u32>, now u32$/],
      ["a tuple key part changed", (c) => { ty(c, c.flop_session_keys.sessions.key).types[1] = "H256#13"; }, /^FlopSessionKeys\.Sessions key\.1:/],
    ];
    for (const [what, f, line] of cases) {
      const lines = changed(f);
      expect(lines.length, what).toBeGreaterThan(0);
      expect(lines.some((l: string) => line.test(l)), `${what}: ${lines.slice(0, 3).join(" | ")}`).toBe(true);
    }
    expect(changed(() => {})).toEqual([]);
  });

  /** A shape whose SessionNonces value is a type that refers to itself, holding a field of type w. */
  const recursive = (w: string) => {
    const c = JSON.parse(NEW_TEXT);
    c.types["Rec#9999"] = { kind: "composite", path: ["x", "Rec"], fields: [{ name: "v", type: w }, { name: "next", type: "Option<Rec#9999>#9998" }] };
    c.types["Option<Rec#9999>#9998"] = { kind: "variant", path: ["Option"], variants: [{ index: 0, name: "None", fields: [] }, { index: 1, name: "Some", fields: [{ name: null, type: "Rec#9999" }] }] };
    c.flop_session_keys.session_nonces.value = "Rec#9999";
    return c;
  };

  it("HELD: a type that refers to itself and did not change ends with no line", () => {
    expect(shapeDiff(recursive("u32"), recursive("u32")).filter((l: string) => !l.endsWith("no difference in what the shapes state"))).toEqual([]);
  });

  it("DEFECT 2 (low): a change inside a type that refers to itself never ends: the diff overflows the stack", () => {
    let out: string[] | string;
    try {
      out = shapeDiff(recursive("u32"), recursive("u64"));
    } catch (e) {
      out = `threw ${(e as Error).constructor.name}: ${(e as Error).message}`;
    }
    expect(out).toContain("FlopSessionKeys.SessionNonces value.v: type was u32, now u64");
  });

  it("DEFECT 3 (low): a shape file of another format version is compared without a word, and one that lacks a stated pallet throws a TypeError", () => {
    const other = JSON.parse(NEW_TEXT);
    other.schema = "flop-observatory/decoder-shape@3";
    const lines = shapeDiff(JSON.parse(NEW_TEXT), other);
    expect(lines.some((l: string) => l.includes("schema") || l.includes("decoder-shape@3")), lines.join(" | ")).toBe(true);
    const old = JSON.parse(NEW_TEXT);
    old.schema = "flop-observatory/decoder-shape@1";
    delete old.flop_session_keys;
    let said: string;
    try {
      said = shapeDiff(old, JSON.parse(NEW_TEXT)).join(" | ");
    } catch (e) {
      said = `${(e as Error).constructor.name}: ${(e as Error).message}`;
    }
    expect(said).not.toMatch(/^TypeError/);
  });
});
