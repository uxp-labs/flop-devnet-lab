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
import type { Field, Metadata, StorageEntry, Variant } from "./metadata.js";
import { parseMetadata } from "./metadata.js";
import { ScaleError } from "./reader.js";
import { storageEntryOf } from "./storage-key.js";

export const SHAPE_SCHEMA = "flop-observatory/decoder-shape@0";
export const MAX_NAME_DEPTH = 16;
export const MAX_NAME_STEPS = 256;

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
    shapeSha256: "720dec7042378853678afa2259d8b1d61854805be51434c024da12d6d6978f3f",
  },
];

export type ShapeValue = null | boolean | number | string | ShapeValue[] | { [key: string]: ShapeValue };

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** A type's name, by its shape (see above). */
export function typeName(md: Metadata, id: number): string {
  const steps = { left: MAX_NAME_STEPS };
  const name = (t: number, depth: number): string => {
    steps.left -= 1;
    if (depth >= MAX_NAME_DEPTH || steps.left < 0) throw new ScaleError(`type ${id} nests too deeply to be named`);
    const e = Number.isSafeInteger(t) && t >= 0 ? md.types.at(t) : undefined;
    if (e === undefined) throw new ScaleError(`type ${t} does not exist`);
    const d = e.def;
    if (d.kind === "primitive") return d.primitive;
    if (e.path.length > 0) {
      const params = e.params.filter((p) => p.type !== null).map((p) => name(p.type as number, depth + 1));
      return `${e.path.at(-1)}${params.length > 0 ? `<${params.join(", ")}>` : ""}#${t}`;
    }
    switch (d.kind) {
      case "sequence":
        return `Vec<${name(d.type, depth + 1)}>`;
      case "array":
        return `[${name(d.type, depth + 1)}; ${d.len}]`;
      case "tuple":
        return `(${d.types.map((x) => name(x, depth + 1)).join(", ")})`;
      case "compact":
        return `Compact<${name(d.type, depth + 1)}>`;
      case "bitSequence":
        return `BitSequence<${name(d.store, depth + 1)}, ${name(d.order, depth + 1)}>`;
      case "composite":
      case "variant":
        return `${d.kind}#${t}`;
    }
  };
  return name(id, 0);
}

const fieldsOf = (md: Metadata, fields: Field[]): ShapeValue => fields.map((f) => ({ name: f.name, type: typeName(md, f.type) }));
const variantsOf = (md: Metadata, variants: Variant[]): ShapeValue => variants.map((v) => ({ index: v.index, name: v.name, fields: fieldsOf(md, v.fields) }));

function entryShape(md: Metadata, e: StorageEntry): { [key: string]: ShapeValue } {
  return { modifier: e.modifier, hashers: [...e.hashers], key: e.key === null ? null : typeName(md, e.key), value: typeName(md, e.value) };
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

/** The shape this metadata gives what the observatory relies on, or a refusal saying what is missing. */
export function deriveShape(md: Metadata): ShapeValue {
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
  return {
    schema: SHAPE_SCHEMA,
    spec_name: v.spec_name ?? null,
    spec_version: v.spec_version ?? null,
    system: {
      index: system.index,
      events: { ...entryShape(md, events), record: fieldsOf(md, compositeFields(md, recordType.type, "an event record")) },
      last_runtime_upgrade: { ...entryShape(md, upgrade), fields: fieldsOf(md, compositeFields(md, upgrade.value, "the value of System.LastRuntimeUpgrade")) },
    },
    compute_channel: {
      index: cc.index,
      events: variantsOf(md, variants(md, cc.event, "the ComputeChannel event type")),
      channels: { ...entryShape(md, channels), fields: fieldsOf(md, channel) },
      channel_states: variantsOf(md, variants(md, state?.type ?? null, "the state of a channel")),
    },
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
  const reviewed = REVIEWED.find((r) => r.specName === input.specName && r.specVersion === input.specVersion);
  if (reviewed === undefined) return refuse(`spec ${input.specName} ${input.specVersion} is not a reviewed shape`);
  const hash = sha256(input.metadata);
  if (input.metadata.length !== reviewed.metadataBytes || hash !== reviewed.metadataSha256) {
    return refuse(`the metadata for spec ${reviewed.specVersion} is ${input.metadata.length} bytes with sha256 ${hash}, not the reviewed ${reviewed.metadataBytes} bytes with sha256 ${reviewed.metadataSha256}`);
  }
  if (sha256(input.shapeText) !== reviewed.shapeSha256) return refuse(`the shape file given is not the reviewed ${reviewed.shapeFile}`);
  try {
    const md = parseMetadata(input.metadata);
    const derived = shapeText(deriveShape(md));
    if (derived !== input.shapeText) return refuse(`the shape derived from the metadata differs from ${reviewed.shapeFile}`);
    const u = upgradeOf(md, input.lastRuntimeUpgrade);
    if (u.spec_name !== reviewed.specName || u.spec_version !== reviewed.specVersion) {
      return refuse(`the block's LastRuntimeUpgrade names spec ${String(u.spec_name)} ${String(u.spec_version)}, not ${reviewed.specName} ${reviewed.specVersion}`);
    }
    return { pinned: true, metadata: md, reviewed };
  } catch (e) {
    if (e instanceof ScaleError) return refuse(e.message);
    throw e;
  }
}
