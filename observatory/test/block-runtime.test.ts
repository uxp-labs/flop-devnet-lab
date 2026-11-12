// Which reviewed runtime reads a block (runtimeOfBlock in src/scale/block.ts): the decoder's
// decision, from the System.LastRuntimeUpgrade bytes read at the block and nothing else. Held on the
// three recordings' real records, on the reviewed shape files' own statement of that record, and on
// every refusal.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runtimeOfBlock } from "../src/scale/block.js";
import { decodeValue } from "../src/scale/decode.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { MAX_INPUT_BYTES, toHex } from "../src/scale/reader.js";
import { REVIEWED } from "../src/scale/shape.js";
import { recordedStorage } from "./helpers/recorded-storage.js";
import { recordedUpgrade } from "./helpers/recorded-upgrade.js";
import { recorded } from "./helpers/recorded.js";
import { DENY_BLOCKS, UPGRADE_BLOCKS } from "./helpers/requests/list-3.js";
import { bytes, cat, compact, str } from "./helpers/scale-write.js";

const U = recordedUpgrade();
const RESULTS = JSON.parse(readFileSync(new URL("../../research/2026-11-12-runtime-upgrade/results.json", import.meta.url), "utf8"));
const LAB = [...RESULTS.boundary.slice(0, 3), RESULTS.a_later_block_of_the_new_spec] as { last_runtime_upgrade: { spec_version: number; spec_name: string } }[];
const lineOf = (name: string, version: number) => REVIEWED.find((r) => r.specName === name && r.specVersion === version);
const found = (b: Uint8Array) => {
  const r = runtimeOfBlock(b);
  return r.found ? r.reviewed : r.refused;
};
const OLD = REVIEWED.at(0);
const NAME = String(OLD?.specName);

describe("runtimeOfBlock: which reviewed runtime reads a block", () => {
  it("names, at the four upgrade blocks, the runtime the lab's reads say executed each: the old one at 3528527 and 3528528, the new one at 3528529 and 3530299", () => {
    expect(UPGRADE_BLOCKS.map((b) => found(U.upgradeOf(b)))).toEqual(LAB.map((b) => lineOf(b.last_runtime_upgrade.spec_name, b.last_runtime_upgrade.spec_version)));
    expect(UPGRADE_BLOCKS.map((b) => (found(U.upgradeOf(b)) as { specVersion: number }).specVersion)).toEqual([OLD?.specVersion, OLD?.specVersion, REVIEWED.at(1)?.specVersion, REVIEWED.at(1)?.specVersion]);
  });

  it("names the old runtime at the deny list test's blocks and at every block of the first two recordings", () => {
    for (const b of DENY_BLOCKS) expect(found(U.upgradeOf(b)), b).toEqual(OLD);
    for (const b of recorded().blocks) expect(found(b.lastRuntimeUpgrade), String(b.number)).toEqual(OLD);
    const S = recordedStorage();
    expect(S.lastRuntimeUpgrade.size).toBe(12);
    for (const [b, lru] of S.lastRuntimeUpgrade) expect(found(lru), b).toEqual(OLD);
  });

  it("reads the record as each reviewed shape states it, a Compact<u32> spec version then a string spec name, so it reads what the reviewed metadata's own type reads", () => {
    for (const r of REVIEWED) {
      const shape = JSON.parse(readFileSync(new URL(`../${r.shapeFile}`, import.meta.url), "utf8"));
      const fields = shape.system.last_runtime_upgrade.fields as { name: string; type: string }[];
      expect(fields.map((f) => f.name), r.shapeFile).toEqual(["spec_version", "spec_name"]);
      expect(shape.types[fields[0]?.type ?? ""], r.shapeFile).toEqual({ kind: "compact", path: [], type: "u32" });
      const name = shape.types[fields[1]?.type ?? ""];
      expect(name.kind, r.shapeFile).toBe("composite");
      expect(name.fields.map((f: { type: string }) => shape.types[f.type]), r.shapeFile).toEqual([{ kind: "primitive", path: [], primitive: "str" }]);
    }
    for (const [i, b] of UPGRADE_BLOCKS.entries()) {
      const r = runtimeOfBlock(U.upgradeOf(b));
      if (!r.found) throw new Error(r.refused);
      const md = parseMetadata(U.metadataBySha(r.reviewed.metadataSha256));
      const type = md.pallets.find((p) => p.name === "System")?.storage?.entries.find((e) => e.name === "LastRuntimeUpgrade")?.value ?? -1;
      expect(decodeValue(md, type, U.upgradeOf(b)), b).toEqual({ spec_version: r.reviewed.specVersion, spec_name: r.reviewed.specName });
      expect(toHex(U.upgradeOf(b)), b).toBe((LAB[i] as unknown as { last_runtime_upgrade: { hex: string } }).last_runtime_upgrade.hex);
    }
  });

  it("answers a copy of the line: changing the answer changes nothing the decoder pins", () => {
    const r = runtimeOfBlock(U.upgradeOf(UPGRADE_BLOCKS[0]));
    if (!r.found) throw new Error(r.refused);
    const before = JSON.stringify(REVIEWED);
    r.reviewed.metadataSha256 = "0".repeat(64);
    expect(JSON.stringify(REVIEWED)).toBe(before);
    expect(runtimeOfBlock(U.upgradeOf(UPGRADE_BLOCKS[0]))).toEqual({ found: true, reviewed: OLD });
  });

  it("refuses a spec no reviewed line names: another version, another name, a version a line names under another name", () => {
    const v = Number(OLD?.specVersion);
    expect(found(cat(compact(v + 1), str(NAME)))).toBe(`no reviewed runtime: the block's LastRuntimeUpgrade names spec "${NAME}" ${v + 1}, which no reviewed line names`);
    expect(found(cat(compact(v), str("other-runtime")))).toBe(`no reviewed runtime: the block's LastRuntimeUpgrade names spec "other-runtime" ${v}, which no reviewed line names`);
    expect(found(cat(compact(v), str(`\u{feff}${NAME}`)))).toBe(`no reviewed runtime: the block's LastRuntimeUpgrade names spec "\u{feff}${NAME}" ${v}, which no reviewed line names`);
  });

  it("refuses bytes that are no whole record: a byte after it, cut short, empty, a compact not in its shortest form, a version past u32, a name not UTF-8 or past 256 characters", () => {
    const good = U.upgradeOf(UPGRADE_BLOCKS[0]);
    expect(found(cat(good, bytes(0)))).toBe(`no reviewed runtime: the LastRuntimeUpgrade ends at byte ${good.length}, 1 bytes before the end`);
    expect(found(good.subarray(0, good.length - 1))).toBe("no reviewed runtime: the spec name at byte 4: 12 cannot fit in the 11 bytes left");
    expect(found(new Uint8Array())).toBe("no reviewed runtime: the spec version at byte 0: needs 1 byte, 0 left");
    expect(found(cat(bytes(0x01, 0x00), str(NAME)))).toBe("no reviewed runtime: the spec version at byte 0: 0 in two bytes is not its shortest form");
    expect(found(cat(compact(2n ** 32n), str(NAME)))).toBe(`no reviewed runtime: the spec version ${2n ** 32n} does not fit a u32`);
    expect(found(cat(compact(Number(OLD?.specVersion)), compact(2), bytes(0xc3, 0x28)))).toBe("no reviewed runtime: the spec name at byte 4: not strict UTF-8");
    expect(found(cat(compact(Number(OLD?.specVersion)), str("a".repeat(257))))).toBe("no reviewed runtime: the spec name is longer than 256 characters");
    expect(found(cat(compact(Number(OLD?.specVersion)), str("a".repeat(256))))).toMatch(/which no reviewed line names$/);
  });

  it("refuses an input that is not bytes, a Proxy over bytes included, with a refusal and never another exception", () => {
    const good = U.upgradeOf(UPGRADE_BLOCKS[0]);
    for (const x of [null, undefined, "0xfae33d00", [250, 227, 61, 0], new Proxy(good, {}), { length: 3 }]) expect(found(x as never)).toBe("no reviewed runtime: the LastRuntimeUpgrade is not bytes");
  });

  it("reads one argument, the bytes, and nothing else of the block", () => {
    expect(runtimeOfBlock.length).toBe(1);
  });
  it("takes the largest u32, 4294967295, as a spec version no line names, and refuses 4294967296 as no u32", () => {
    expect(found(cat(compact(0xffffffff), str(NAME)))).toBe(`no reviewed runtime: the block's LastRuntimeUpgrade names spec "${NAME}" 4294967295, which no reviewed line names`);
    expect(found(cat(compact(0x100000000), str(NAME)))).toBe("no reviewed runtime: the spec version 4294967296 does not fit a u32");
  });

  // The refusal carries what the record names (the lead's decision D3 of the upgrade watch).
  const refusalOf = (b: unknown) => {
    const r = runtimeOfBlock(b as Uint8Array);
    if (r.found) throw new Error("found");
    return r;
  };
  it("names, in a refusal of a whole record no line names, the spec name and version the record states, as a number", () => {
    const v = Number(OLD?.specVersion);
    const NEWV = Number(REVIEWED.at(-1)?.specVersion);
    const cases: [string, number][] = [[NAME, v + 1], ["other-runtime", v], [`\u{feff}${NAME}`, v], [`${NAME} `, v], [NAME, NEWV + 1], [NAME, 0], [NAME, 0xffffffff], ["", v], ["a".repeat(256), v]];
    for (const [n, ver] of cases) {
      const r = refusalOf(cat(compact(ver), str(n)));
      expect(r, JSON.stringify([n, ver])).toEqual({ found: false, refused: `no reviewed runtime: the block's LastRuntimeUpgrade names spec ${JSON.stringify(n)} ${ver}, which no reviewed line names`, named: { specName: n, specVersion: ver } });
      expect(Object.keys(r.named ?? {}), JSON.stringify(n)).toEqual(["specName", "specVersion"]);
      expect(typeof r.named?.specVersion).toBe("number");
    }
  });

  it("names null in a refusal of bytes that are no whole record, and of an input that is not bytes", () => {
    const good = U.upgradeOf(UPGRADE_BLOCKS[0]);
    const notRecords = [cat(good, bytes(0)), good.subarray(0, good.length - 1), new Uint8Array(), cat(bytes(0x01, 0x00), str(NAME)), cat(compact(2n ** 32n), str(NAME)), cat(compact(Number(OLD?.specVersion)), compact(2), bytes(0xc3, 0x28)), cat(compact(Number(OLD?.specVersion)), str("a".repeat(257))), new Uint8Array(MAX_INPUT_BYTES + 1)];
    for (const x of [...notRecords, null, undefined, "0xfae33d00", [250, 227, 61, 0], new Proxy(good, {})]) {
      const r = refusalOf(x);
      expect(r.named, r.refused).toBeNull();
      expect(Object.keys(r)).toEqual(["found", "refused", "named"]);
    }
  });

  it("answers a found line with no named field, and a fresh named object on each refusal, so a write to one changes no later answer", () => {
    expect(Object.keys(runtimeOfBlock(U.upgradeOf(UPGRADE_BLOCKS[0])))).toEqual(["found", "reviewed"]);
    const other = cat(compact(Number(OLD?.specVersion) + 1), str(NAME));
    const a = refusalOf(other);
    const b = refusalOf(other);
    expect(a.named).not.toBe(b.named);
    if (a.named === null) throw new Error("no name");
    a.named.specName = String(REVIEWED.at(-1)?.specName);
    a.named.specVersion = Number(REVIEWED.at(-1)?.specVersion);
    expect(refusalOf(other).named).toEqual({ specName: NAME, specVersion: Number(OLD?.specVersion) + 1 });
    expect(found(U.upgradeOf(UPGRADE_BLOCKS[0]))).toEqual(OLD);
  });

  // The reviewer's odd inputs (review round 23, R5).
  it("ends every odd input in a refusal with a text of ours, never another exception; a subclass of bytes reads as its bytes", () => {
    const good = U.upgradeOf(UPGRADE_BLOCKS[0]);
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
    const getter = new Proxy(good, { get: () => { throw new Error("theirs"); } });
    for (const x of [trap, getter, detached, new Uint8Array(MAX_INPUT_BYTES + 1), new Uint16Array(4), new DataView(new ArrayBuffer(4)), good.buffer, Symbol("x"), 1n, () => good]) {
      expect(() => runtimeOfBlock(x as never)).not.toThrow();
      expect(found(x as never)).toMatch(/^no reviewed runtime: /);
    }
    expect(found(sub)).toEqual(OLD);
    expect(found(detached)).toBe("no reviewed runtime: the LastRuntimeUpgrade is not bytes");
    expect(found(new Uint8Array(MAX_INPUT_BYTES + 1))).toBe(`no reviewed runtime: the LastRuntimeUpgrade is ${MAX_INPUT_BYTES + 1} bytes, more than the ${MAX_INPUT_BYTES} this decoder reads`);
  });

  it("names no line for a name that differs from the reviewed one by case, a NUL, a combining mark, a look alike letter, a space or a BOM, and counts a name's length in characters as JavaScript holds them", () => {
    const v = Number(OLD?.specVersion);
    for (const n of [NAME.slice(0, 1).toUpperCase() + NAME.slice(1), NAME.toUpperCase(), `${NAME}\u0000`, `\u0000${NAME}`, `${NAME}\u0301`, NAME.replace("-", "\u2010"), NAME.replace("e", "\u0435"), `${NAME} `, `\ufeff${NAME}`]) {
      expect(found(cat(compact(v), str(n))), JSON.stringify(n)).toBe(`no reviewed runtime: the block's LastRuntimeUpgrade names spec ${JSON.stringify(n)} ${v}, which no reviewed line names`);
    }
    expect(found(cat(compact(v), str("\u{1f600}".repeat(129))))).toBe("no reviewed runtime: the spec name is longer than 256 characters");
  });
});
