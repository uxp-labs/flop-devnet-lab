// The shape pin (RULES.md section 9): real chain data is decoded only when the chain's shape is a
// reviewed one. Pure: no file, network, clock or random access; the shape file is handed in.
//
// Three parts:
// - REVIEWED, the list of reviewed shapes: a spec name and version, the sha256 and length of the
//   metadata bytes at that spec, and the sha256 of the committed shape file.
// - The shape file, shapes/<spec name>-<spec version>.json, derived from that metadata by
//   deriveShape and written by shapeText: what the observatory relies on, in a form a reviewer can
//   read. One section for each pallet of STATED_TABLE with the pallet's index, its storage prefix
//   and each stated entry of it; beside those the System.Version type, the ComputeChannel event
//   table, the fields of an event record, of LastRuntimeUpgrade and of a channel, and a channel's
//   states; and a table of every type reachable from the stated entries' keys and values and the
//   Version type, each with its kind, its path and what the kind holds. Each storage entry is stated
//   with its modifier, hashers, key type, value type and the default bytes the metadata gives it.
//   scripts/write-shape.mjs writes the file, and nothing else does.
// - pinShape, the one function that says whether a block may be decoded, and why not.
//
// A type is named by its shape: a primitive by itself, a type with a path by the last part of its
// path, its type parameters and #id, and lists, arrays, tuples and compacts around those. A type
// with a path is never named by its fields, so a type that refers to itself through its fields is
// named in one step. A name that nests past MAX_NAME_DEPTH, visits more than MAX_NAME_STEPS types or
// is longer than MAX_NAME_LENGTH is refused, so a type that refers to itself any other way is refused
// too. One deriveShape shares one budget (MAX_SHAPE_STEPS, MAX_SHAPE_CHARS) across every name and
// description it builds, and builds each name once, so its work is linear in what it derives.
import { createHash } from "node:crypto";
import { type Decoded, decodeValue } from "./decode.js";
import type { Field, Metadata, StorageEntry, TypeEntry, Variant } from "./metadata.js";
import { parseMetadata } from "./metadata.js";
import { MAX_INPUT_BYTES, ScaleError, toHex } from "./reader.js";
import { storageEntryOf } from "./storage-key.js";

/** @3: @2's form with ten more stated entries and three more pallets (the table below). */
export const SHAPE_SCHEMA = "flop-observatory/decoder-shape@3";

/** One stated storage entry: its name in the metadata, and its key in its pallet's section of the shape. */
export interface StatedEntry {
  readonly entry: string;
  readonly key: string;
}

/** One stated pallet: its name in the metadata, its section of the shape, and its stated entries in order. */
export interface StatedPallet {
  readonly pallet: string;
  readonly section: string;
  readonly entries: readonly StatedEntry[];
}

const stated = (pallet: string, section: string, entries: readonly (readonly [entry: string, key: string])[]): StatedPallet =>
  Object.freeze({ pallet, section, entries: Object.freeze(entries.map(([entry, key]) => Object.freeze({ entry, key }))) });

/**
 * The one table of what the shape states: each pallet with its section, each entry with its key,
 * a section and a key each the name in snake case. deriveShape writes one entry of the shape for
 * each line, and STATED_ENTRIES is derived from it, so the two cannot differ. Frozen whole.
 */
export const STATED_TABLE: readonly StatedPallet[] = Object.freeze([
  stated("System", "system", [
    ["Events", "events"],
    ["LastRuntimeUpgrade", "last_runtime_upgrade"],
    ["Account", "account"],
  ]),
  stated("ComputeChannel", "compute_channel", [
    ["Channels", "channels"],
    ["FailedAcks", "failed_acks"],
    ["ChannelAuthoredOpenedAt", "channel_authored_opened_at"],
  ]),
  stated("FlopSessionKeys", "flop_session_keys", [
    ["Sessions", "sessions"],
    ["SessionNonces", "session_nonces"],
    ["CircuitBreakers", "circuit_breakers"],
    ["DelegateSessions", "delegate_sessions"],
  ]),
  stated("ModelRegistry", "model_registry", [
    ["Models", "models"],
    ["MeasuredRoots", "measured_roots"],
    ["AllowedDecodePolicies", "allowed_decode_policies"],
  ]),
  stated("MinerStaking", "miner_staking", [["Miners", "miners"]]),
  stated("HwCalibration", "hw_calibration", [
    ["CalibrationVersions", "calibration_versions"],
    ["LastInitialCalibration", "last_initial_calibration"],
  ]),
]);

/** The pallet and entry name of each line of a table, in its order, the list and each pair frozen. */
export function statedEntriesOf(table: readonly StatedPallet[]): readonly (readonly [pallet: string, entry: string])[] {
  return Object.freeze(table.flatMap((p) => p.entries.map((e) => Object.freeze([p.pallet, e.entry] as const))));
}

/**
 * The storage entries the shape states, by pallet and entry name: the only entries whose values
 * real chain data is decoded from (src/scale/block.ts). Derived from STATED_TABLE.
 */
export const STATED_ENTRIES: readonly (readonly [pallet: string, entry: string])[] = statedEntriesOf(STATED_TABLE);
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

/**
 * Each entry here is a review: a reviewer read the shape file and the metadata it came from, and a
 * test derives the file a second way, from the reference decoder's own parse of that metadata.
 * The list and each line are frozen when the module loads, and no reference to a line ever leaves
 * src/scale: every answer carries a fresh copy (reviewedCopy), so no caller can change what was
 * reviewed.
 */
export const REVIEWED: readonly ReviewedShape[] = Object.freeze([
  Object.freeze({
    specName: "tzkv-runtime",
    specVersion: 1014014,
    metadataSha256: "f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444",
    metadataBytes: 482132,
    shapeFile: "shapes/tzkv-runtime-1014014.json",
    shapeSha256: "5e66cf79e9cd5f3ec997e9ff0ac4fca8b08923e0f5cb8f5b2d10ef4aaa03a370",
  }),
  Object.freeze({
    specName: "tzkv-runtime",
    specVersion: 1014020,
    metadataSha256: "91294eb61225c4de7459e6a8fed3c37169a2c8a1b1906b46a5890d5e0d328238",
    metadataBytes: 487100,
    shapeFile: "shapes/tzkv-runtime-1014020.json",
    shapeSha256: "af3f7c6996338b8328de0e67f886c1479d5c382a9fc133ddac8d6862732fb185",
  }),
]);

/** A fresh copy of a reviewed line: the one way a line leaves src/scale, so a write to an answer changes no line. */
export function reviewedCopy(r: ReviewedShape): ReviewedShape {
  return { specName: r.specName, specVersion: r.specVersion, metadataSha256: r.metadataSha256, metadataBytes: r.metadataBytes, shapeFile: r.shapeFile, shapeSha256: r.shapeSha256 };
}

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
  return { modifier: e.modifier, hashers: [...e.hashers], key: e.key === null ? null : nameOf(n, e.key), value: nameOf(n, e.value), default: toHex(e.fallback) };
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
  const palletOf = (name: string) => {
    const p = md.pallets.find((x) => x.name === name);
    if (p === undefined) throw new ScaleError(`the metadata has no ${name} pallet`);
    return p;
  };
  const pallets = STATED_TABLE.map((t) => ({ t, p: palletOf(t.pallet) }));
  const system = palletOf("System");
  const cc = palletOf("ComputeChannel");
  const version = system.constants.find((c) => c.name === "Version");
  if (version === undefined) throw new ScaleError("the System pallet has no Version constant");
  const v = decodeValue(md, version.type, version.value);
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ScaleError("the System.Version constant did not decode as a record");
  // Every stated entry, found by its pallet and name, in the table's order.
  const entries = pallets.map(({ t }) => t.entries.map((e) => ({ key: e.key, entry: storageEntryOf(md, t.pallet, e.entry).entry })));
  const keyOf = (e: StorageEntry): number[] => (e.key === null ? [] : [e.key]);
  /** The storage prefix every key of the pallet starts from, written into the shape and paid for. */
  const prefixOf = (p: { storage: { prefix: string } | null }): string => {
    const prefix = p.storage?.prefix ?? "";
    write(n, prefix.length);
    return prefix;
  };
  // Each stated pallet's section: its index, its storage prefix and one entry for each line of the table.
  const sections: { [section: string]: { [key: string]: ShapeValue } } = {};
  pallets.forEach(({ t, p }, i) => {
    const section: { [key: string]: ShapeValue } = { index: p.index, storage_prefix: prefixOf(p) };
    for (const e of entries[i] ?? []) section[e.key] = entryShape(n, e.entry);
    sections[t.section] = section;
  });
  // What @2 states beside its entries, written as it was.
  const events = storageEntryOf(md, "System", "Events").entry;
  const upgrade = storageEntryOf(md, "System", "LastRuntimeUpgrade").entry;
  const channels = storageEntryOf(md, "ComputeChannel", "Channels").entry;
  const recordType = md.types.at(events.value)?.def;
  if (recordType?.kind !== "sequence") throw new ScaleError("System.Events is not a list");
  const channel = compositeFields(md, channels.value, "the value of ComputeChannel.Channels");
  const state = channel.find((f) => f.name === "state");
  const sys = sections.system as { [key: string]: ShapeValue };
  const ccs = sections.compute_channel as { [key: string]: ShapeValue };
  sys.events = { ...(sys.events as { [key: string]: ShapeValue }), record: fieldsOf(n, compositeFields(md, recordType.type, "an event record")) };
  sys.last_runtime_upgrade = { ...(sys.last_runtime_upgrade as { [key: string]: ShapeValue }), fields: fieldsOf(n, compositeFields(md, upgrade.value, "the value of System.LastRuntimeUpgrade")) };
  sys.version = nameOf(n, version.type);
  ccs.events = variantsOf(n, variants(md, cc.event, "the ComputeChannel event type"));
  ccs.channels = { ...(ccs.channels as { [key: string]: ShapeValue }), fields: fieldsOf(n, channel) };
  ccs.channel_states = variantsOf(n, variants(md, state?.type ?? null, "the state of a channel"));
  // The closure's roots: the Version type, and the key and the value of every stated entry.
  const roots = [version.type, ...entries.flat().flatMap((e) => [e.entry.value, ...keyOf(e.entry)])];
  return {
    schema: SHAPE_SCHEMA,
    spec_name: v.spec_name ?? null,
    spec_version: v.spec_version ?? null,
    ...sections,
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

/**
 * The schema a shape text names at its top level, read without parsing the text, so a refusal can
 * name the format of a file that is not the reviewed one: the one line of two spaces indent that
 * shapeText writes for it. Null when there is no such line. Nothing is decided by it.
 */
export function schemaNamed(text: string): string | null {
  return /\n {2}"schema": "([^"\\\n]{1,128})",?\n/.exec(text)?.[1] ?? null;
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

/** The longest spec name, pallet name or entry name a door reads; a longer one is refused unread. */
export const MAX_NAME_INPUT = 256;

/**
 * One field of a caller's input, read once. Anything thrown while it is read (a getter, a Proxy
 * trap) is a refusal with this text of ours: the foreign error is never looked at, so its message,
 * its class and its own getters never reach the caller.
 */
export function readField<T>(read: () => T, what: string): T {
  try {
    return read();
  } catch {
    throw new ScaleError(`${what} could not be read`);
  }
}

/**
 * The length of the bytes the caller holds, or a refusal. Nothing is copied. A typed array method
 * reads its receiver's internal slots and refuses anything else, a Proxy over a typed array
 * included. findLastIndex with a test that is always true answers the last index after one step,
 * so the length is that plus one, whatever an own "length" property on the object says.
 */
export function bytesLength(v: unknown, what: string): number {
  try {
    if (!(v instanceof Uint8Array)) throw new ScaleError(what);
    return Uint8Array.prototype.findLastIndex.call(v, () => true) + 1;
  } catch {
    throw new ScaleError(`${what} is not bytes`);
  }
}

/**
 * A copy of bytes the caller holds, or a refusal: what is hashed is then what is parsed. The bytes
 * are taken only from a real typed array, whose length is read from its internal slots (a Proxy
 * over one is refused there, see bytesLength). Past MAX_INPUT_BYTES it is refused before anything is copied. The
 * copy is made once, into an array of our own, by the typed array's own set: no iterator is read
 * and the caller's constructor and species are never asked.
 */
export function copyBytes(v: unknown, what: string): Uint8Array {
  const length = bytesLength(v, what);
  if (length > MAX_INPUT_BYTES) throw new ScaleError(`${what} is ${length} bytes, more than the ${MAX_INPUT_BYTES} this decoder reads`);
  const own = new Uint8Array(length);
  try {
    Uint8Array.prototype.set.call(own, v as Uint8Array);
  } catch {
    throw new ScaleError(`${what} is not bytes`);
  }
  return own;
}

/** The input as an object whose fields may be read, or a refusal. */
export function inputObject(input: unknown): object {
  if (typeof input !== "object" || input === null) throw new ScaleError("the input is not an object");
  return input;
}

/**
 * Each field of the input read exactly once, the byte arrays copied. A getter, or a buffer the
 * caller changes later, can then never hand the hash one value and the parser another.
 */
export function copyPinInput(input: unknown): PinInput {
  const i = inputObject(input) as PinInput;
  const specName = readField(() => i.specName, "the spec name");
  const specVersion = readField(() => i.specVersion, "the spec version");
  const metadata = readField(() => i.metadata, "the metadata");
  const lastRuntimeUpgrade = readField(() => i.lastRuntimeUpgrade, "the LastRuntimeUpgrade");
  const shape = readField(() => i.shapeText, "the shape file");
  if (typeof specName !== "string" || typeof specVersion !== "number" || typeof shape !== "string") throw new ScaleError("the spec name, spec version and shape file must be a string, a number and a string");
  if (specName.length > MAX_NAME_INPUT) throw new ScaleError(`the spec name is longer than ${MAX_NAME_INPUT} characters`);
  if (shape.length > MAX_INPUT_BYTES) throw new ScaleError(`the shape file is longer than ${MAX_INPUT_BYTES} characters`);
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
 * The pin with the reviewed line itself, for the doors in src/scale/block.ts only: each copies the
 * line into its own answer with reviewedCopy. Nothing outside src/scale calls it (the source scan
 * lets a src module outside src/scale import only block.ts), and the line it holds is frozen.
 */
export function pinLine(input: PinInput): Pin {
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
  if (sha256(i.shapeText) !== reviewed.shapeSha256) {
    const named = schemaNamed(i.shapeText);
    return refuse(`the shape file given is not the reviewed ${reviewed.shapeFile}${named !== null && named !== SHAPE_SCHEMA ? `: it is ${named}, not ${SHAPE_SCHEMA}` : ""}`);
  }
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

/**
 * Whether a block may be decoded with this metadata: only when the spec is a reviewed one, the
 * metadata bytes are the reviewed bytes, the shape file is the reviewed file and equals the shape
 * derived again from the metadata, and the block's LastRuntimeUpgrade names the same spec.
 * Otherwise it refuses, and says which of these failed. Its answer carries a fresh copy of the line.
 */
export function pinShape(input: PinInput): Pin {
  const p = pinLine(input);
  return p.pinned ? { pinned: true, metadata: p.metadata, reviewed: reviewedCopy(p.reviewed) } : p;
}
