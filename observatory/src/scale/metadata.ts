// A strict parser of runtime metadata version 14, the answer of state_getMetadata (RULES.md section
// 9): the magic "meta", the version byte, then RuntimeMetadataV14 as frame-metadata and scale-info
// define it. Every part is read, nothing is skipped, and the whole value must end exactly at the
// end of its bytes. Any other version is refused, naming the version met.
//
// Beyond the encoding, it refuses what would give one name two meanings or point at nothing:
// type ids that do not count from 0 in order, a type id that names no type, a composite that mixes
// named and unnamed fields or names a field twice, a variant index or name used twice, two pallets
// with one name or index, a storage entry named twice in a pallet, a map with no hasher, and a map
// of several hashers whose key is not a tuple of as many types. It knows no pallet and no type by
// name: what the observatory relies on is the shape's to say (src/shape.ts).
import { Reader, ScaleError, toHex } from "./reader.js";

export const PRIMITIVES = ["bool", "char", "str", "u8", "u16", "u32", "u64", "u128", "u256", "i8", "i16", "i32", "i64", "i128", "i256"] as const;
export type Primitive = (typeof PRIMITIVES)[number];
export const HASHERS = ["Blake2_128", "Blake2_256", "Blake2_128Concat", "Twox128", "Twox256", "Twox64Concat", "Identity"] as const;
export type Hasher = (typeof HASHERS)[number];

export interface Field {
  name: string | null;
  type: number;
  typeName: string | null;
  docs: string[];
}
export interface Variant {
  name: string;
  fields: Field[];
  index: number;
  docs: string[];
}
export type TypeDef =
  | { kind: "composite"; fields: Field[] }
  | { kind: "variant"; variants: Variant[] }
  | { kind: "sequence"; type: number }
  | { kind: "array"; len: number; type: number }
  | { kind: "tuple"; types: number[] }
  | { kind: "primitive"; primitive: Primitive }
  | { kind: "compact"; type: number }
  | { kind: "bitSequence"; store: number; order: number };
export interface TypeEntry {
  id: number;
  path: string[];
  params: { name: string; type: number | null }[];
  def: TypeDef;
  docs: string[];
}
export interface StorageEntry {
  name: string;
  modifier: "Optional" | "Default";
  /** Empty for a plain entry; one hasher a key part for a map. */
  hashers: Hasher[];
  /** The key type of a map, null for a plain entry. */
  key: number | null;
  value: number;
  /** The value read when nothing is stored, for a Default entry. */
  fallback: Uint8Array;
  docs: string[];
}
export interface Constant {
  name: string;
  type: number;
  value: Uint8Array;
  docs: string[];
}
export interface Pallet {
  name: string;
  index: number;
  storage: { prefix: string; entries: StorageEntry[] } | null;
  calls: number | null;
  event: number | null;
  error: number | null;
  constants: Constant[];
}
export interface Metadata {
  version: 14;
  types: TypeEntry[];
  pallets: Pallet[];
  extrinsic: { type: number; version: number; signedExtensions: { identifier: string; type: number; additionalSigned: number }[] };
  runtimeType: number;
}

const MAGIC = "0x6d657461";

/** A compact that names a type id: a u32. */
function typeId(r: Reader, what: string): number {
  const v = r.compact(what);
  if (v > 0xffffffffn) throw new ScaleError(`${what}: ${v} is no type id`);
  return Number(v);
}

/** A list: a compact count, then each item. Each item takes at least one byte, so the count is bounded by what is left. */
function list<T>(r: Reader, what: string, item: (r: Reader, i: number) => T): T[] {
  const n = r.length(what);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(item(r, i));
  return out;
}

function option<T>(r: Reader, what: string, item: (r: Reader) => T): T | null {
  const at = r.pos;
  const tag = r.byte(what);
  if (tag === 0) return null;
  if (tag === 1) return item(r);
  throw new ScaleError(`${what} at byte ${at}: ${tag} is neither None (0) nor Some (1)`);
}

const strings = (r: Reader, what: string) => list(r, what, (x) => x.text(what));

function fieldsOf(r: Reader, what: string): Field[] {
  const fields = list(r, `${what} fields`, (x) => ({
    name: option(x, `${what} field name`, (y) => y.text(`${what} field name`)),
    type: typeId(x, `${what} field type`),
    typeName: option(x, `${what} field type name`, (y) => y.text(`${what} field type name`)),
    docs: strings(x, `${what} field docs`),
  }));
  const named = fields.filter((f) => f.name !== null).length;
  if (named !== 0 && named !== fields.length) throw new ScaleError(`${what}: fields are either all named or all unnamed`);
  const seen = new Set<string>();
  for (const f of fields) {
    if (f.name === null) continue;
    if (seen.has(f.name)) throw new ScaleError(`${what}: the field ${JSON.stringify(f.name)} is named twice`);
    seen.add(f.name);
  }
  return fields;
}

function typeDef(r: Reader, what: string): TypeDef {
  const kind = r.byte(`${what} kind`);
  switch (kind) {
    case 0:
      return { kind: "composite", fields: fieldsOf(r, what) };
    case 1: {
      const variants = list(r, `${what} variants`, (x) => ({
        name: x.text(`${what} variant name`),
        fields: fieldsOf(x, what),
        index: x.byte(`${what} variant index`),
        docs: strings(x, `${what} variant docs`),
      }));
      const names = new Set<string>();
      const indices = new Set<number>();
      for (const v of variants) {
        if (names.has(v.name)) throw new ScaleError(`${what}: the variant ${JSON.stringify(v.name)} is named twice`);
        if (indices.has(v.index)) throw new ScaleError(`${what}: the variant index ${v.index} is used twice`);
        names.add(v.name);
        indices.add(v.index);
      }
      return { kind: "variant", variants };
    }
    case 2:
      return { kind: "sequence", type: typeId(r, `${what} element`) };
    case 3: {
      const len = Number(r.unsigned(4, `${what} length`));
      return { kind: "array", len, type: typeId(r, `${what} element`) };
    }
    case 4:
      return { kind: "tuple", types: list(r, `${what} tuple`, (x) => typeId(x, `${what} tuple element`)) };
    case 5: {
      const p = r.byte(`${what} primitive`);
      const primitive = PRIMITIVES.at(p);
      if (primitive === undefined) throw new ScaleError(`${what}: ${p} is no primitive`);
      return { kind: "primitive", primitive };
    }
    case 6:
      return { kind: "compact", type: typeId(r, `${what} compact`) };
    case 7:
      return { kind: "bitSequence", store: typeId(r, `${what} bit store`), order: typeId(r, `${what} bit order`) };
    default:
      throw new ScaleError(`${what}: ${kind} is no type definition kind`);
  }
}

function storageEntry(r: Reader, pallet: string): StorageEntry {
  const name = r.text(`a storage entry name of ${pallet}`);
  const what = `storage ${pallet}.${name}`;
  const m = r.byte(`${what} modifier`);
  if (m > 1) throw new ScaleError(`${what}: ${m} is no modifier`);
  const t = r.byte(`${what} kind`);
  let hashers: Hasher[] = [];
  let key: number | null = null;
  let value: number;
  if (t === 0) {
    value = typeId(r, `${what} value`);
  } else if (t === 1) {
    hashers = list(r, `${what} hashers`, (x) => {
      const h = x.byte(`${what} hasher`);
      const hasher = HASHERS.at(h);
      if (hasher === undefined) throw new ScaleError(`${what}: ${h} is no hasher`);
      return hasher;
    });
    key = typeId(r, `${what} key`);
    value = typeId(r, `${what} value`);
  } else {
    throw new ScaleError(`${what}: ${t} is neither a plain entry (0) nor a map (1)`);
  }
  const fallback = r.take(r.length(`${what} default`), `${what} default`);
  return { name, modifier: m === 0 ? "Optional" : "Default", hashers, key, value, fallback, docs: strings(r, `${what} docs`) };
}

function palletOf(r: Reader): Pallet {
  const name = r.text("a pallet name");
  const what = `pallet ${name}`;
  const storage = option(r, `${what} storage`, (x) => {
    const prefix = x.text(`${what} storage prefix`);
    const entries = list(x, `${what} storage entries`, (y) => storageEntry(y, name));
    const seen = new Set<string>();
    for (const e of entries) {
      if (seen.has(e.name)) throw new ScaleError(`storage ${name}.${e.name} is named twice`);
      seen.add(e.name);
    }
    return { prefix, entries };
  });
  const calls = option(r, `${what} calls`, (x) => typeId(x, `${what} calls`));
  const event = option(r, `${what} event`, (x) => typeId(x, `${what} event`));
  const constants = list(r, `${what} constants`, (x) => ({
    name: x.text(`${what} constant name`),
    type: typeId(x, `${what} constant type`),
    value: x.take(x.length(`${what} constant value`), `${what} constant value`),
    docs: strings(x, `${what} constant docs`),
  }));
  const error = option(r, `${what} error`, (x) => typeId(x, `${what} error`));
  return { name, index: r.byte(`${what} index`), storage, calls, event, error, constants };
}

/** Every type id a type definition names. */
function namedBy(d: TypeDef): number[] {
  switch (d.kind) {
    case "composite":
      return d.fields.map((f) => f.type);
    case "variant":
      return d.variants.flatMap((v) => v.fields.map((f) => f.type));
    case "sequence":
    case "array":
    case "compact":
      return [d.type];
    case "tuple":
      return d.types;
    case "bitSequence":
      return [d.store, d.order];
    case "primitive":
      return [];
  }
}

/** Refuses a type id that names no type, and the other meanings checked across the whole metadata. */
function check(m: Metadata): void {
  const n = m.types.length;
  const exists = (id: number | null, who: string) => {
    if (id !== null && id >= n) throw new ScaleError(`${who} names type ${id}, which does not exist`);
  };
  for (const t of m.types) {
    for (const id of namedBy(t.def)) exists(id, `type ${t.id}`);
    for (const p of t.params) exists(p.type, `type ${t.id}`);
  }
  const names = new Set<string>();
  const indices = new Map<number, string>();
  for (const p of m.pallets) {
    if (names.has(p.name)) throw new ScaleError(`the pallet name ${p.name} is used twice`);
    if (indices.has(p.index)) throw new ScaleError(`pallet ${p.name} has the index ${p.index} of another pallet`);
    names.add(p.name);
    indices.set(p.index, p.name);
    for (const id of [p.calls, p.event, p.error, ...p.constants.map((c) => c.type)]) exists(id, `pallet ${p.name}`);
    for (const e of p.storage?.entries ?? []) {
      const who = `storage ${p.name}.${e.name}`;
      exists(e.key, who);
      exists(e.value, who);
      if (e.key === null) continue;
      if (e.hashers.length === 0) throw new ScaleError(`${who} is a map with no hasher`);
      const k = m.types.at(e.key)?.def;
      if (e.hashers.length > 1 && (k?.kind !== "tuple" || k.types.length !== e.hashers.length)) {
        throw new ScaleError(`${who} has ${e.hashers.length} hashers, so its key must be a tuple of ${e.hashers.length} types`);
      }
    }
  }
  exists(m.extrinsic.type, "the extrinsic");
  for (const s of m.extrinsic.signedExtensions) {
    exists(s.type, `the signed extension ${s.identifier}`);
    exists(s.additionalSigned, `the signed extension ${s.identifier}`);
  }
  exists(m.runtimeType, "the runtime type");
}

/** The metadata these bytes hold, or a ScaleError saying why they hold none. Pure. */
export function parseMetadata(bytes: Uint8Array): Metadata {
  const r = new Reader(bytes);
  const magic = toHex(r.take(4, "the magic"));
  if (magic !== MAGIC) throw new ScaleError(`not metadata: the first four bytes are ${magic}, not ${MAGIC} (meta)`);
  const version = r.byte("the version");
  if (version !== 14) throw new ScaleError(`metadata version ${version}: this parser reads version 14 only`);
  const types = list(r, "the types", (x, i) => {
    const what = `type ${i}`;
    const id = typeId(x, `${what} id`);
    if (id !== i) throw new ScaleError(`${what} has id ${id}: ids must count from 0 in order`);
    const path = strings(x, `${what} path`);
    const params = list(x, `${what} params`, (y) => ({ name: y.text(`${what} param name`), type: option(y, `${what} param type`, (z) => typeId(z, `${what} param type`)) }));
    return { id, path, params, def: typeDef(x, what), docs: strings(x, `${what} docs`) };
  });
  const pallets = list(r, "the pallets", palletOf);
  const extrinsic = {
    type: typeId(r, "the extrinsic type"),
    version: r.byte("the extrinsic version"),
    signedExtensions: list(r, "the signed extensions", (x) => ({
      identifier: x.text("a signed extension identifier"),
      type: typeId(x, "a signed extension type"),
      additionalSigned: typeId(x, "a signed extension additional type"),
    })),
  };
  const runtimeType = typeId(r, "the runtime type");
  r.end("the metadata");
  const m: Metadata = { version: 14, types, pallets, extrinsic, runtimeType };
  check(m);
  return m;
}
