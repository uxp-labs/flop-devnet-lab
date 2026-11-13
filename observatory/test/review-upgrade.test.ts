// Independent review of the second runtime (spec 1014020), round 23, kept as its record. Each
// DEFECT test asserted what should hold and failed on the branch the review read (1e433b6); each is
// now named for the rule of the lead that fixed it, and passes. Each HELD test passed under attack.
// The HELD tests of runtimeOfBlock's odd inputs and names moved to test/block-runtime.test.ts, and
// those of the diff's hand made pairs and an unchanged recursive type to test/upgrade-shape.test.ts.
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
const found = (b: unknown) => {
  const r = runtimeOfBlock(b as Uint8Array);
  return r.found ? `${r.reviewed.specName} ${r.reviewed.specVersion}` : r.refused;
};

describe("A. runtimeOfBlock under attack", () => {
  const good = U.upgradeOf(BEFORE);
  const NAME = OLD.specName;
  const v = OLD.specVersion;

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
  it("R1, fixed (DEFECT 1, high): a write through a door's answer no longer makes a later call pin a pairing nobody reviewed", () => {
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

  it("R1, fixed (DEFECT 1, high), the same through decodeStorageValue and pinShape: the answer is a copy, not the line", () => {
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

  /** A shape whose SessionNonces value is a type that refers to itself, holding a field of type w. */
  const recursive = (w: string) => {
    const c = JSON.parse(NEW_TEXT);
    c.types["Rec#9999"] = { kind: "composite", path: ["x", "Rec"], fields: [{ name: "v", type: w }, { name: "next", type: "Option<Rec#9999>#9998" }] };
    c.types["Option<Rec#9999>#9998"] = { kind: "variant", path: ["Option"], variants: [{ index: 0, name: "None", fields: [] }, { index: 1, name: "Some", fields: [{ name: null, type: "Rec#9999" }] }] };
    c.flop_session_keys.session_nonces.value = "Rec#9999";
    return c;
  };

  it("R2, fixed (DEFECT 2, low): a change inside a type that refers to itself ends, its line printed once", () => {
    let out: string[] | string;
    try {
      out = shapeDiff(recursive("u32"), recursive("u64"));
    } catch (e) {
      out = `threw ${(e as Error).constructor.name}: ${(e as Error).message}`;
    }
    expect(out).toContain("FlopSessionKeys.SessionNonces value.v: type was u32, now u64");
  });

  it("R3, fixed (DEFECT 3, low): a shape file of another format version, and one that lacks a stated pallet, are refused in a line of the diff's own, never a TypeError", () => {
    const other = JSON.parse(NEW_TEXT);
    other.schema = "flop-observatory/decoder-shape@4";
    expect(() => shapeDiff(JSON.parse(NEW_TEXT), other)).toThrow(/schema is "flop-observatory\/decoder-shape@4"/);
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
    expect(said).toBe('ShapeRefused: the old shape: the schema is "flop-observatory/decoder-shape@1", not flop-observatory/decoder-shape@3');
  });
});

describe("E. an independent diff of the two real shapes", () => {
  /** Canonical text of a type by structure, ids dropped, a type met again on its own path written by its path. */
  const canon = (s: any) => {
    const c = (n: string, st: string[] = []): string => {
      const t = s.types[n];
      if (t === undefined) return `missing ${n.replace(/#\d+/g, "")}`;
      if (st.includes(n)) return `rec ${t.path.join("::")}`;
      const x = [...st, n];
      const f = (fs: { name: string | null; type: string }[]) => fs.map((q) => `${q.name}:${c(q.type, x)}`).join(",");
      if (t.kind === "primitive") return t.primitive;
      if (t.kind === "composite") return `${t.path.join("::")}{${f(t.fields)}}`;
      if (t.kind === "variant") return `${t.path.join("::")}<${t.variants.map((v: any) => `${v.index}:${v.name}(${f(v.fields)})`).join(";")}>`;
      if (t.kind === "sequence") return `Vec<${c(t.element, x)}>`;
      if (t.kind === "array") return `[${c(t.element, x)};${t.len}]`;
      if (t.kind === "tuple") return `(${t.types.map((y: string) => c(y, x)).join(",")})`;
      return `Compact<${c(t.type, x)}>`;
    };
    return c;
  };
  const reach = (s: any, root: string | null) => {
    const out = new Set<string>();
    if (root === null) return out;
    const c = canon(s);
    const seen = new Set<string>();
    const go = (n: string) => {
      const t = s.types[n];
      if (seen.has(n) || t === undefined) return;
      seen.add(n);
      out.add(c(n));
      const r: string[] = t.kind === "composite" ? t.fields.map((f: any) => f.type) : t.kind === "variant" ? t.variants.flatMap((v: any) => v.fields.map((f: any) => f.type)) : t.kind === "tuple" ? t.types : t.kind === "compact" ? [t.type] : t.kind === "primitive" ? [] : [t.element];
      r.forEach(go);
    };
    go(root);
    return out;
  };
  const roots = (s: any): Record<string, string | null> => {
    const out: Record<string, string | null> = { "System.Version": s.system.version };
    for (const [p, e, name] of [["system", "events", "System.Events"], ["system", "last_runtime_upgrade", "System.LastRuntimeUpgrade"], ["compute_channel", "channels", "ComputeChannel.Channels"], ["flop_session_keys", "sessions", "FlopSessionKeys.Sessions"], ["flop_session_keys", "session_nonces", "FlopSessionKeys.SessionNonces"], ["flop_session_keys", "circuit_breakers", "FlopSessionKeys.CircuitBreakers"]] as const) {
      out[`${name} value`] = s[p][e].value;
      out[`${name} key`] = s[p][e].key;
    }
    return out;
  };

  it("HELD: compared as sets of canonical types per stated root, only System.Events changed, by exactly the outer event enum, its record, the ComputeChannel and Aleph event types; nothing else the shapes state", () => {
    const a = JSON.parse(OLD_TEXT);
    const b = JSON.parse(NEW_TEXT);
    const ra = roots(a);
    const rb = roots(b);
    const changedRoots: string[] = [];
    let onlyOld: string[] = [];
    for (const k of Object.keys(ra)) {
      const A = reach(a, ra[k] ?? null);
      const B = reach(b, rb[k] ?? null);
      const old = [...A].filter((x) => !B.has(x));
      const added = [...B].filter((x) => !A.has(x));
      expect(old.length, k).toBe(added.length);
      if (old.length > 0) {
        changedRoots.push(k);
        onlyOld = old;
      }
    }
    expect(changedRoots).toEqual(["System.Events value"]);
    expect(onlyOld.map((x) => x.match(/^(Vec<)?([\w:]+)/)?.[0])).toEqual(["Vec<frame_system::EventRecord", "frame_system::EventRecord", "zkv_runtime::RuntimeEvent", "pallet_compute_channel::pallet::Event", "pallet_aleph::pallet::Event"]);
    const keep = (s: any) => JSON.stringify([["system", "compute_channel", "flop_session_keys"].map((p) => [s[p].index, s[p].storage_prefix]), s.system.events.modifier, s.system.events.default, s.compute_channel.channels.hashers, s.flop_session_keys.sessions.hashers, s.flop_session_keys.session_nonces.default]);
    expect(keep(b)).toBe(keep(a));
    // The two ComputeChannel events and the one Aleph event the six lines name, and nothing more.
    const ev = (s: any) => new Set(s.compute_channel.events.map((e: any) => `${e.index}:${e.name}(${e.fields.map((f: any) => `${f.name}:${canon(s)(f.type)}`).join(",")})`));
    const EA = ev(a);
    const EB = ev(b);
    expect([...EA].filter((x) => !EB.has(x))).toEqual([]);
    expect([...EB].filter((x) => !EA.has(x)).map((x) => (x as string).split("(")[0])).toEqual(["60:CapacityReservationRateSet", "61:CapacityReservationDropped"]);
  });
});

describe("G. the damage test's skips", () => {
  it("HELD: no bit flip of a new runtime value is passed over by the damage test: ours never decodes what the reference refuses, and the plain form never refuses", () => {
    const md = parseMetadata(NEW_MD);
    const builder = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(NEW_MD))));
    const values = U.reads.filter((r) => r.answer !== null && runtimeOfBlock(U.upgradeOf(r.block)).found && (runtimeOfBlock(U.upgradeOf(r.block)) as { reviewed: ReviewedShape }).reviewed.specVersion === NEW.specVersion);
    const skipped: string[] = [];
    let plainSkip = 0;
    for (const r of values) {
      const e = md.pallets.find((p) => p.name === r.read.pallet)?.storage?.entries.find((x) => x.name === r.read.entry);
      const type = e?.value ?? -1;
      const codec = builder.buildStorage(r.read.pallet, r.read.entry).value;
      const b = r.answer as Uint8Array;
      for (let i = 0; i < b.length; i++) for (const bit of b.length <= 512 ? [0, 1, 2, 3, 4, 5, 6, 7] : [i % 8]) {
        const m = b.slice();
        m.set([(m.at(i) as number) ^ (1 << bit)], i);
        let v: unknown;
        try {
          v = decodeValue(md, type, m);
        } catch (x) {
          if (x instanceof ScaleError) continue;
          throw x;
        }
        let ref: unknown;
        try {
          ref = codec.dec(toHex(m));
        } catch {
          skipped.push(`${r.read.entry} at ${r.height} byte ${i} bit ${bit}`);
          continue;
        }
        try {
          plain(md, "reference", type, ref);
          plain(md, "ours", type, v as never);
        } catch {
          plainSkip++;
        }
      }
    }
    expect(skipped).toEqual([]);
    expect(plainSkip).toBe(0);
    expect(values).toHaveLength(13);
  }, 600_000);
});

describe("G. how the tests find the metadata they pin", () => {
  it("R4, fixed (DEFECT 4, low): test/upgrade-shape.test.ts pins with the metadata found by sha256, not taken by the block it was read at", () => {
    const src = readFileSync(new URL("./upgrade-shape.test.ts", import.meta.url), "utf8");
    const pins = [...src.matchAll(/pinShape\(\{[^}]*\}/g)].map((m) => m[0]);
    expect(pins.length).toBeGreaterThan(0);
    // The pin's input there is `base`, whose metadata is META; META must come from metadataBySha.
    expect(src).not.toMatch(/const META = U\.metadataAt\(/);
  });
});
