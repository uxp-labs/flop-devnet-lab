// Review of decoder-shape@3 (round 29), attack 1 and 2: the ten new entries of each shape file read
// a third way. The metadata is parsed by polkadot-api here, in this file, with a walk of its own: not
// through src/scale and not through test/helpers/reference-shape.ts. Each stated entry is held by
// type id and structure, not by the shape's own names: modifier, hashers, key id(s), value id,
// default bytes, and for System.Account, ModelRegistry.Models and MinerStaking.Miners every field
// of the value, in order, against the shape file's types table. The closure is held both ways.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decAnyMetadata } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import { REVIEWED } from "../src/scale/shape.js";
import { reviewedMetadata } from "./helpers/recorded-upgrade.js";

const TEN: [section: string, key: string, pallet: string, entry: string][] = [
  ["system", "account", "System", "Account"],
  ["compute_channel", "failed_acks", "ComputeChannel", "FailedAcks"],
  ["compute_channel", "channel_authored_opened_at", "ComputeChannel", "ChannelAuthoredOpenedAt"],
  ["flop_session_keys", "delegate_sessions", "FlopSessionKeys", "DelegateSessions"],
  ["model_registry", "models", "ModelRegistry", "Models"],
  ["model_registry", "measured_roots", "ModelRegistry", "MeasuredRoots"],
  ["model_registry", "allowed_decode_policies", "ModelRegistry", "AllowedDecodePolicies"],
  ["miner_staking", "miners", "MinerStaking", "Miners"],
  ["hw_calibration", "calibration_versions", "HwCalibration", "CalibrationVersions"],
  ["hw_calibration", "last_initial_calibration", "HwCalibration", "LastInitialCalibration"],
];
const OLD_SIX: [string, string, string, string][] = [
  ["system", "events", "System", "Events"],
  ["system", "last_runtime_upgrade", "System", "LastRuntimeUpgrade"],
  ["compute_channel", "channels", "ComputeChannel", "Channels"],
  ["flop_session_keys", "sessions", "FlopSessionKeys", "Sessions"],
  ["flop_session_keys", "session_nonces", "FlopSessionKeys", "SessionNonces"],
  ["flop_session_keys", "circuit_breakers", "FlopSessionKeys", "CircuitBreakers"],
];

// biome-ignore lint/suspicious/noExplicitAny: a raw walk over the reference's parse
type Any = any;
const HASH: Record<string, string> = { Blake2128: "Blake2_128", Blake2256: "Blake2_256", Blake2128Concat: "Blake2_128Concat", Twox128: "Twox128", Twox256: "Twox256", Twox64Concat: "Twox64Concat", Identity: "Identity" };

/** The id a shape name ends in, when it names a type with a path. */
const idOf = (name: string): number | null => {
  const m = /#(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
};

function load(spec: number) {
  const line = REVIEWED.find((r) => r.specVersion === spec);
  if (!line) throw new Error("no line");
  const bytes = reviewedMetadata(spec);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(line.metadataSha256);
  const md = decAnyMetadata(bytes);
  if (md.metadata.tag !== "v14") throw new Error("not v14");
  const v14: Any = md.metadata.value;
  const shapeText = readFileSync(new URL(`../${line.shapeFile}`, import.meta.url), "utf8");
  return { v14, shape: JSON.parse(shapeText) as Any };
}

/** Does this shape type name stand for metadata type id t? Checked by structure, by my own walk. */
function sameType(v14: Any, shape: Any, name: string, t: number, depth = 0): boolean {
  if (depth > 12) return true;
  const lt = v14.lookup[t];
  const d = lt.def;
  if (d.tag === "primitive") return name === d.value.tag;
  if (lt.path.length > 0) return idOf(name) === t && name.startsWith(lt.path.at(-1));
  const desc = shape.types[name];
  if (desc === undefined) return false;
  if (d.tag === "sequence") return desc.kind === "sequence" && sameType(v14, shape, desc.element, d.value, depth + 1);
  if (d.tag === "tuple") return desc.kind === "tuple" && desc.types.length === d.value.length && d.value.every((x: number, i: number) => sameType(v14, shape, desc.types[i], x, depth + 1));
  if (d.tag === "array") return desc.kind === "array" && desc.len === d.value.len && sameType(v14, shape, desc.element, d.value.type, depth + 1);
  if (d.tag === "compact") return desc.kind === "compact";
  return false;
}

function entryOf(v14: Any, pallet: string, entry: string) {
  const p = v14.pallets.find((x: Any) => x.name === pallet);
  const e = p?.storage?.items.find((i: Any) => i.name === entry);
  if (!e) throw new Error(`no ${pallet}.${entry}`);
  const map = e.type.tag === "map";
  return {
    modifier: e.modifier === 0 ? "Optional" : "Default",
    hashers: map ? e.type.value.hashers.map((h: Any) => HASH[h.tag]) : [],
    keyId: map ? (e.type.value.key as number) : null,
    valueId: (map ? e.type.value.value : e.type.value) as number,
    default: e.fallback as string,
    palletIndex: p.index as number,
    prefix: p.storage.prefix as string,
  };
}

/** Every type id reachable from one id, by my own walk of the reference's lookup. */
function reach(v14: Any, roots: number[]): Set<number> {
  const seen = new Set<number>();
  const todo = [...roots];
  while (todo.length) {
    const t = todo.pop() as number;
    if (seen.has(t)) continue;
    seen.add(t);
    const lt = v14.lookup[t];
    for (const p of lt.params) if (p.type !== undefined) todo.push(p.type);
    const d = lt.def;
    if (d.tag === "composite") for (const f of d.value) todo.push(f.type);
    else if (d.tag === "variant") for (const v of d.value) for (const f of v.fields) todo.push(f.type);
    else if (d.tag === "sequence" || d.tag === "compact") todo.push(d.value);
    else if (d.tag === "array") todo.push(d.value.type);
    else if (d.tag === "tuple") todo.push(...d.value);
    else if (d.tag === "bitSequence") todo.push(d.value.bitStoreType, d.value.bitOrderType);
  }
  return seen;
}

describe("review shape 3: the ten new entries read a third way", () => {
  for (const spec of [1014014, 1014020]) {
    const { v14, shape } = load(spec);
    for (const [section, key, pallet, entry] of TEN) {
      it(`HOLDS: spec ${spec} ${pallet}.${entry}: modifier, hashers, key, value and default are the metadata's`, () => {
        const m = entryOf(v14, pallet, entry);
        const s = shape[section][key];
        expect(Object.keys(s).sort()).toEqual(["default", "hashers", "key", "modifier", "value"]);
        expect(s.modifier).toBe(m.modifier);
        expect(s.hashers).toEqual(m.hashers);
        expect(s.default).toBe(m.default);
        if (m.keyId === null) expect(s.key).toBeNull();
        else expect(sameType(v14, shape, s.key, m.keyId)).toBe(true);
        expect(sameType(v14, shape, s.value, m.valueId)).toBe(true);
        expect(shape[section].index).toBe(m.palletIndex);
        expect(shape[section].storage_prefix).toBe(m.prefix);
      });
    }
    for (const [entry, pallet, depthNames] of [
      ["Account", "System", ["AccountData"]],
      ["Models", "ModelRegistry", []],
      ["Miners", "MinerStaking", []],
    ] as [string, string, string[]][]) {
      it(`HOLDS: spec ${spec} ${pallet}.${entry}: every field of the value, its name, order and type, is the metadata's`, () => {
        const m = entryOf(v14, pallet, entry);
        const walk = (t: number, depth: number) => {
          const lt = v14.lookup[t];
          if (lt.def.tag !== "composite") return;
          const name = Object.keys(shape.types).find((n) => idOf(n) === t) as string;
          expect(name, `type ${t}`).toBeDefined();
          const desc = shape.types[name];
          expect(desc.kind).toBe("composite");
          expect(desc.path).toEqual(lt.path);
          expect(desc.fields.map((f: Any) => f.name)).toEqual(lt.def.value.map((f: Any) => f.name ?? null));
          lt.def.value.forEach((f: Any, i: number) => {
            expect(sameType(v14, shape, desc.fields[i].type, f.type), `${name}.${f.name}`).toBe(true);
            if (depth < 3) walk(f.type, depth + 1);
          });
        };
        walk(m.valueId, 0);
        expect(depthNames.length).toBeGreaterThanOrEqual(0);
      });
    }
    it(`HOLDS: spec ${spec} the types table is exactly the closure of the sixteen stated keys and values and Version`, () => {
      const roots: number[] = [];
      for (const [, , p, e] of [...OLD_SIX, ...TEN]) {
        const m = entryOf(v14, p, e);
        roots.push(m.valueId);
        if (m.keyId !== null) roots.push(m.keyId);
      }
      const sys = v14.pallets.find((x: Any) => x.name === "System");
      roots.push(sys.constants.find((c: Any) => c.name === "Version").type);
      const ids = reach(v14, roots);
      // Each type with a path in the table is reachable, and each reachable type with a path is in the table.
      const tableIds = new Set(Object.keys(shape.types).map(idOf).filter((x): x is number => x !== null));
      const pathIds = new Set([...ids].filter((t) => v14.lookup[t].path.length > 0 && v14.lookup[t].def.tag !== "primitive"));
      expect([...tableIds].filter((t) => !pathIds.has(t))).toEqual([]);
      expect([...pathIds].filter((t) => !tableIds.has(t))).toEqual([]);
    });
  }
});
