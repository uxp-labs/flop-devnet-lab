// The shape pin (RULES.md section 9): real chain data is decoded only when the chain's shape is one a
// person reviewed. Pure: no file, network, clock or random access; the shape file is handed in.
//
// Three parts:
// - REVIEWED, the list of reviewed shapes: a spec name and version, the sha256 and length of the
//   metadata bytes at that spec, and the sha256 of the committed shape file.
// - The shape file, shapes/<spec name>-<spec version>.json, derived from that metadata by
//   deriveShape and written by shapeText: what the observatory relies on, in a form a person can
//   read. The System.Version constant, the ComputeChannel pallet index, its event table, its
//   Channels entry with the fields and states of a channel, and the System entries the events and
//   the spec are read from.
// - pinShape, the one function that says whether a block may be decoded, and why not.
//
// A type is named by its shape: a primitive by itself, a type with a path by the last part of its
// path, its type parameters and #id, and lists, arrays, tuples and compacts around those. A type
// with a path is never named by its fields, so a type that refers to itself through its fields is
// named in one step. A name that nests past MAX_NAME_DEPTH, or names more than MAX_NAME_STEPS types,
// is refused, so a type that refers to itself any other way is refused too.
import { createHash } from "node:crypto";
import { type Decoded, decodeValue } from "./decode.js";
import type { Field, Metadata, StorageEntry, TypeEntry, Variant } from "./metadata.js";
import { parseMetadata } from "./metadata.js";
import { ScaleError } from "./reader.js";
import { storageEntryOf } from "./storage-key.js";

export const SHAPE_SCHEMA = "flop-observatory/decoder-shape@1";
/** How deep one name may nest. */
export const MAX_NAME_DEPTH = 16;
/** How many types one name may visit, a type named again included. */
export const MAX_NAME_STEPS = 256;
/** The longest name a type may have, in characters. */
export const MAX_NAME_LENGTH = 2048;
/** The most steps one deriveShape may take: each type visited, field, variant and parameter. */
export const MAX_SHAPE_STEPS = 1_000_000;
/** The most characters of names and paths one deriveShape may write. */
export const MAX_SHAPE_CHARS = 4_000_000;

export interface ReviewedShape {
  specName: string;
  specVersion: number;
  metadataSha256: string;
  metadataBytes: number;
  /** The committed file the shape is held to, by its path in the observatory package. */
  shapeFile: string;
  shapeSha256: string;
}

/** Each entry here is a review: a person read the shape file and the metadata it came from. */
export const REVIEWED: readonly ReviewedShape[] = [
  {
    specName: "tzkv-runtime",
    specVersion: 1014014,
    metadataSha256: "f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444",
    metadataBytes: 482132,
    shapeFile: "shapes/tzkv-runtime-1014014.json",
    shapeSha256: "4b50e851350028f6114c9a81217599fee8f7d18df725ff97ac40b3d80b6be82a",
  },
];

export type ShapeValue = null | boolean | number | string | ShapeValue[] | { [key: string]: ShapeValue };

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/**
 * One budget for naming and describing types, shared by a whole deriveShape: steps and characters.
 * Each name is built once per type id and kept, so a type named from many places costs one build
 * and one step for each place it is named from.
 */
export interface Namer {
  md: Metadata;
  memo: Map<number, string>;
  steps: { left: number };
  chars: { left: number };
}

export function namer(md: Metadata): Namer {
  return { md, memo: new Map(), steps: { left: MAX_SHAPE_STEPS }, chars: { left: MAX_SHAPE_CHARS } };
}

/** One step of the shape's budget. */
function spend(n: Namer, what: number): void {
  n.steps.left -= 1;
  if (n.steps.left < 0) throw new ScaleError(`the shape takes more than ${MAX_SHAPE_STEPS} steps, at type ${what}`);
}

/** Characters written into the shape, from its budget. */
function write(n: Namer, count: number): void {
  n.chars.left -= count;
  if (n.chars.left < 0) throw new ScaleError(`the shape writes more than ${MAX_SHAPE_CHARS} characters of names and paths`);
}

function lookup(md: Metadata, t: number): TypeEntry {
  const e = Number.isSafeInteger(t) && t >= 0 ? md.types.at(t) : undefined;
  if (e === undefined) throw new ScaleError(`type ${t} does not exist`);
  return e;
}

/** A type's name, by its shape (see above), with the namer's budget and memo. */
export function nameOf(n: Namer, id: number): string {
  // The types one name visits, memo hits included; its own limit, beside the shape's whole budget.
  const visits = { left: MAX_NAME_STEPS };
  const tooLong = (t: number): never => {
    throw new ScaleError(`the name of type ${t} is longer than ${MAX_NAME_LENGTH} characters`);
  };
  /** Each part's name after the last, refused as soon as the text passes MAX_NAME_LENGTH. */
  const joined = (t: number, open: string, ids: number[], close: string, depth: number): string => {
    let out = open;
    ids.forEach((x, i) => {
      out += `${i > 0 ? ", " : ""}${name(x, depth + 1)}`;
      if (out.length > MAX_NAME_LENGTH) tooLong(t);
    });
    return `${out}${close}`;
  };
  const name = (t: number, depth: number): string => {
    spend(n, t);
    visits.left -= 1;
    if (depth >= MAX_NAME_DEPTH || visits.left < 0) throw new ScaleError(`type ${id} nests too deeply to be named`);
    const known = n.memo.get(t);
    if (known !== undefined) return known;
    const e = lookup(n.md, t);
    const d = e.def;
    let out: string;
    if (d.kind === "primitive") out = d.primitive;
    else if (e.path.length > 0) {
      const last = e.path.at(-1) as string;
      if (last.length > MAX_NAME_LENGTH) tooLong(t);
      const params: number[] = [];
      for (const p of e.params) {
        // Every parameter costs a step, one of no type too.
        spend(n, t);
        if (p.type !== null) params.push(p.type);
      }
      out = params.length > 0 ? joined(t, `${last}<`, params, `>#${t}`, depth) : `${last}#${t}`;
    } else {
      switch (d.kind) {
        case "sequence":
          out = joined(t, "Vec<", [d.type], ">", depth);
          break;
        case "array":
          out = joined(t, "[", [d.type], `; ${d.len}]`, depth);
          break;
        case "tuple":
          out = joined(t, "(", d.types, ")", depth);
          break;
        case "compact":
          out = joined(t, "Compact<", [d.type], ">", depth);
          break;
        case "bitSequence":
          out = joined(t, "BitSequence<", [d.store, d.order], ">", depth);
          break;
        default:
          out = `${d.kind}#${t}`;
      }
    }
    if (out.length > MAX_NAME_LENGTH) tooLong(t);
    write(n, out.length);
    n.memo.set(t, out);
    return out;
  };
  return name(id, 0);
}

/** A type's name, by its shape (see above), with a budget of its own. */
export function typeName(md: Metadata, id: number): string {
  return nameOf(namer(md), id);
}

function fieldsOf(n: Namer, fields: Field[]): ShapeValue {
  return fields.map((f) => {
    spend(n, f.type);
    return { name: f.name, type: nameOf(n, f.type) };
  });
}
function variantsOf(n: Namer, variants: Variant[]): ShapeValue {
  return variants.map((v) => {
    spend(n, -1);
    return { index: v.index, name: v.name, fields: fieldsOf(n, v.fields) };
  });
}

function entryShape(n: Namer, e: StorageEntry): { [key: string]: ShapeValue } {
  return { modifier: e.modifier, hashers: [...e.hashers], key: e.key === null ? null : nameOf(n, e.key), value: nameOf(n, e.value) };
}

/** The fields of a composite type, or a refusal naming what was looked for. */
function compositeFields(md: Metadata, id: number, what: string): Field[] {
  const d = md.types.at(id)?.def;
  if (d?.kind !== "composite") throw new ScaleError(`${what} is not a type with fields`);
  return d.fields;
}

function variants(md: Metadata, id: number | null, what: string): Variant[] {
  const d = id === null ? undefined : md.types.at(id)?.def;
  if (d?.kind !== "variant") throw new ScaleError(`${what} is not an enum`);
  return d.variants;
}

/** What a type's kind holds, each type it names given by its name, and the ids it names. */
function describe(n: Namer, e: TypeEntry): { desc: { [key: string]: ShapeValue }; names: number[] } {
  const d = e.def;
  // The path is written into the shape, so it is paid for from the shape's characters.
  write(n, e.path.reduce((k, p) => k + p.length, 0));
  const base = { kind: d.kind, path: [...e.path] };
  // A type's parameters are in its name, so their types are in the closure too.
  const params = e.params.flatMap((p) => (p.type === null ? [] : [p.type]));
  switch (d.kind) {
    case "primitive":
      return { desc: { ...base, primitive: d.primitive }, names: params };
    case "composite":
      return { desc: { ...base, fields: fieldsOf(n, d.fields) }, names: [...params, ...d.fields.map((f) => f.type)] };
    case "variant":
      return { desc: { ...base, variants: variantsOf(n, d.variants) }, names: [...params, ...d.variants.flatMap((v) => v.fields.map((f) => f.type))] };
    case "sequence":
      return { desc: { ...base, element: nameOf(n, d.type) }, names: [...params, d.type] };
    case "array":
      return { desc: { ...base, element: nameOf(n, d.type), len: d.len }, names: [...params, d.type] };
    case "tuple":
      return {
        desc: {
          ...base,
          types: d.types.map((x) => {
            spend(n, x);
            return nameOf(n, x);
          }),
        },
        names: [...params, ...d.types],
      };
    case "compact":
      return { desc: { ...base, type: nameOf(n, d.type) }, names: [...params, d.type] };
    case "bitSequence":
      return { desc: { ...base, store: nameOf(n, d.store), order: nameOf(n, d.order) }, names: [...params, d.store, d.order] };
  }
}

/**
 * Every type reachable from the roots, each once, keyed by its name, with what its kind holds. Two
 * types of one name must have one description, or the shape could not tell them apart.
 */
function closure(n: Namer, roots: number[]): { [name: string]: ShapeValue } {
  const seen = new Set<number>();
  const queue = [...roots];
  const table = new Map<string, { [key: string]: ShapeValue }>();
  for (let at = 0; at < queue.length; at++) {
    const t = queue.at(at) as number;
    if (seen.has(t)) continue;
    seen.add(t);
    spend(n, t);
    const e = lookup(n.md, t);
    const key = nameOf(n, t);
    const { desc, names } = describe(n, e);
    const known = table.get(key);
    if (known !== undefined && JSON.stringify(known) !== JSON.stringify(desc)) throw new ScaleError(`two types are named ${key} and differ`);
    table.set(key, desc);
    for (const x of names) if (!seen.has(x)) queue.push(x);
  }
  return Object.fromEntries(table);
}

/**
 * The shape this metadata gives what the observatory relies on, or a refusal saying what is missing.
 * Its work is bounded by one namer's budget: MAX_SHAPE_STEPS steps and MAX_SHAPE_CHARS characters.
 */
export function deriveShape(md: Metadata, n: Namer = namer(md)): ShapeValue {
  const system = md.pallets.find((p) => p.name === "System");
  const cc = md.pallets.find((p) => p.name === "ComputeChannel");
  if (system === undefined || cc === undefined) throw new ScaleError("the metadata has no System or no ComputeChannel pallet");
  const version = system.constants.find((c) => c.name === "Version");
  if (version === undefined) throw new ScaleError("the System pallet has no Version constant");
  const v = decodeValue(md, version.type, version.value);
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ScaleError("the System.Version constant did not decode as a record");
  const events = storageEntryOf(md, "System", "Events").entry;
  const upgrade = storageEntryOf(md, "System", "LastRuntimeUpgrade").entry;
  const channels = storageEntryOf(md, "ComputeChannel", "Channels").entry;
  const recordType = md.types.at(events.value)?.def;
  if (recordType?.kind !== "sequence") throw new ScaleError("System.Events is not a list");
  const channel = compositeFields(md, channels.value, "the value of ComputeChannel.Channels");
  const state = channel.find((f) => f.name === "state");
  const roots = [events.value, upgrade.value, channels.value, ...(channels.key === null ? [] : [channels.key]), version.type];
  return {
    schema: SHAPE_SCHEMA,
    spec_name: v.spec_name ?? null,
    spec_version: v.spec_version ?? null,
    system: {
      index: system.index,
      events: { ...entryShape(n, events), record: fieldsOf(n, compositeFields(md, recordType.type, "an event record")) },
      last_runtime_upgrade: { ...entryShape(n, upgrade), fields: fieldsOf(n, compositeFields(md, upgrade.value, "the value of System.LastRuntimeUpgrade")) },
      version: nameOf(n, version.type),
    },
    compute_channel: {
      index: cc.index,
      events: variantsOf(n, variants(md, cc.event, "the ComputeChannel event type")),
      channels: { ...entryShape(n, channels), fields: fieldsOf(n, channel) },
      channel_states: variantsOf(n, variants(md, state?.type ?? null, "the state of a channel")),
    },
    types: closure(n, roots),
  };
}

function sortDeep(v: ShapeValue): ShapeValue {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v !== null && typeof v === "object") {
    // fromEntries defines each key as an own property, so a key named __proto__ is kept as data.
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortDeep(x)]),
    );
  }
  return v;
}

/** The written form of a shape: sorted keys, two space indent, a newline at the end. */
export function shapeText(shape: ShapeValue): string {
  return `${JSON.stringify(sortDeep(shape), null, 2)}\n`;
}

/** What a block's decode is pinned to, or the reason it is refused. */
export type Pin = { pinned: true; metadata: Metadata; reviewed: ReviewedShape } | { pinned: false; refused: string };

export interface PinInput {
  /** The spec the node names for the block (state_getRuntimeVersion), name and version. */
  specName: string;
  specVersion: number;
  /** The metadata bytes the node answered for the block (state_getMetadata). */
  metadata: Uint8Array;
  /** The value of System.LastRuntimeUpgrade at the block. */
  lastRuntimeUpgrade: Uint8Array;
  /** The text of the committed shape file REVIEWED names for this spec. */
  shapeText: string;
}

const refuse = (refused: string): Pin => ({ pinned: false, refused });

/** A copy of bytes the caller holds, or a refusal: what is hashed is then what is parsed. */
export function copyBytes(v: unknown, what: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new ScaleError(`${what} is not bytes`);
  // The typed array constructor copies from the source's own buffer, through no getter.
  return new Uint8Array(v);
}

/**
 * Each field of the input read exactly once, the byte arrays copied. A getter, or a buffer the
 * caller changes later, can then never hand the hash one value and the parser another.
 */
export function copyPinInput(input: PinInput): PinInput {
  const specName = input.specName;
  const specVersion = input.specVersion;
  const metadata = input.metadata;
  const lastRuntimeUpgrade = input.lastRuntimeUpgrade;
  const shape = input.shapeText;
  if (typeof specName !== "string" || typeof specVersion !== "number" || typeof shape !== "string") throw new ScaleError("the spec name, spec version and shape file must be a string, a number and a string");
  return { specName, specVersion, metadata: copyBytes(metadata, "the metadata"), lastRuntimeUpgrade: copyBytes(lastRuntimeUpgrade, "the LastRuntimeUpgrade"), shapeText: shape };
}

/** The block's System.LastRuntimeUpgrade as a record, or a refusal that names it. */
function upgradeOf(md: Metadata, bytes: Uint8Array): { [name: string]: Decoded } {
  try {
    const v = decodeValue(md, storageEntryOf(md, "System", "LastRuntimeUpgrade").entry.value, bytes);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ScaleError("it did not decode as a record");
    return v;
  } catch (e) {
    if (e instanceof ScaleError) throw new ScaleError(`the block's LastRuntimeUpgrade: ${e.message}`);
    throw e;
  }
}

/**
 * Whether a block may be decoded with this metadata: only when the spec is a reviewed one, the
 * metadata bytes are the reviewed bytes, the shape file is the reviewed file and equals the shape
 * derived again from the metadata, and the block's LastRuntimeUpgrade names the same spec.
 * Otherwise it refuses, and says which of these failed.
 */
export function pinShape(input: PinInput): Pin {
  let i: PinInput;
  try {
    i = copyPinInput(input);
  } catch (e) {
    if (e instanceof ScaleError) return refuse(e.message);
    throw e;
  }
  const reviewed = REVIEWED.find((r) => r.specName === i.specName && r.specVersion === i.specVersion);
  if (reviewed === undefined) return refuse(`spec ${i.specName} ${i.specVersion} is not a reviewed shape`);
  const hash = sha256(i.metadata);
  if (i.metadata.length !== reviewed.metadataBytes || hash !== reviewed.metadataSha256) {
    return refuse(`the metadata for spec ${reviewed.specVersion} is ${i.metadata.length} bytes with sha256 ${hash}, not the reviewed ${reviewed.metadataBytes} bytes with sha256 ${reviewed.metadataSha256}`);
  }
  if (sha256(i.shapeText) !== reviewed.shapeSha256) return refuse(`the shape file given is not the reviewed ${reviewed.shapeFile}`);
  try {
    const md = parseMetadata(i.metadata);
    const derived = shapeText(deriveShape(md));
    if (derived !== i.shapeText) return refuse(`the shape derived from the metadata differs from ${reviewed.shapeFile}`);
    const u = upgradeOf(md, i.lastRuntimeUpgrade);
    if (u.spec_name !== reviewed.specName || u.spec_version !== reviewed.specVersion) {
      return refuse(`the block's LastRuntimeUpgrade names spec ${String(u.spec_name)} ${String(u.spec_version)}, not ${reviewed.specName} ${reviewed.specVersion}`);
    }
    return { pinned: true, metadata: md, reviewed };
  } catch (e) {
    if (e instanceof ScaleError) return refuse(e.message);
    throw e;
  }
}
