// Decoding by type: given a parsed metadata (src/scale/metadata.ts) and a type id, SCALE bytes into
// a plain JSON safe value (RULES.md section 9). It knows the shapes of types, never their names: no
// pallet, no event and no type is special here.
//
// The forms, decided by the type and never by the value:
//   bool                          true or false
//   u8, u16, u32, i8, i16, i32    a number
//   u64, u128, u256, i64, i128, i256   a decimal string, whatever its size ("0", "-5", "1140000000000000")
//   char, str                     a string (strict UTF-8; a char must be a Unicode scalar value)
//   Compact<T>                    as T would be, read from its compact form, which must fit T
//   [u8; N], Vec<u8>              hex: 0x and two lower case digits a byte
//   other arrays, sequences, tuples   a list (an empty tuple is null)
//   fields, of a composite or a variant: none is null, all named an object, one unnamed the field
//                                 itself (so H256 and AccountId32 are hex), several unnamed a list
//   a variant (an enum, Option and Result included)   { "variant": name, "fields": its fields }
//   a bit sequence                refused: the reviewed metadata holds none, so none is read
//
// Limits, each a refusal: a type nests at most MAX_DEPTH levels; a sequence or an array holds no
// more elements than there are bytes left, whatever its element type; one value builds at most
// 1024 + 8 values a byte; a compact must fit its type; a variant index must be one of the type's.
// decodeValue must end exactly at the end of its bytes.
import type { Field, Metadata, Primitive, TypeEntry } from "./metadata.js";
import { Reader, ScaleError, type Width, toHex } from "./reader.js";

export type Decoded = null | boolean | number | string | Decoded[] | { [name: string]: Decoded };

/** The deepest a type may nest while it is decoded. Real event records nest 8 levels. */
export const MAX_DEPTH = 32;
/** The most values one decode may build: 1024, and 8 for each byte it reads from. */
export const valueBudget = (bytes: number): number => 1024 + 8 * bytes;

/** One decode in progress: the metadata, the reader, and the values it may still build. */
export interface Decoding {
  md: Metadata;
  r: Reader;
  budget: { left: number };
}

export function decoding(md: Metadata, bytes: Uint8Array): Decoding {
  return { md, r: new Reader(bytes), budget: { left: valueBudget(bytes.length) } };
}

const WIDTH = new Map<Primitive, Width>([
  ["u8", 1], ["u16", 2], ["u32", 4], ["u64", 8], ["u128", 16], ["u256", 32],
  ["i8", 1], ["i16", 2], ["i32", 4], ["i64", 8], ["i128", 16], ["i256", 32],
]);
const AS_NUMBER = new Set<Primitive>(["u8", "u16", "u32", "i8", "i16", "i32"]);

/** A type's name in a refusal: its id, and its path when it has one. */
export function typeLabel(md: Metadata, id: number): string {
  const path = md.types.at(id)?.path ?? [];
  return path.length > 0 ? `type ${id} (${path.join("::")})` : `type ${id}`;
}

function entry(md: Metadata, id: number): TypeEntry {
  const t = md.types.at(id);
  if (t === undefined || id < 0) throw new ScaleError(`type ${id} does not exist`);
  return t;
}

function integer(p: Primitive, v: bigint): number | string {
  return AS_NUMBER.has(p) ? Number(v) : v.toString();
}

function widthOf(p: Primitive): Width {
  const w = WIDTH.get(p);
  if (w === undefined) throw new ScaleError(`${p} is no integer`);
  return w;
}

function primitive(d: Decoding, p: Primitive, label: string): Decoded {
  const what = `${label}, a ${p}`;
  if (p === "bool") return d.r.bool(what);
  if (p === "str") return d.r.text(what);
  if (p === "char") {
    const at = d.r.pos;
    const c = Number(d.r.unsigned(4, what));
    if (c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) throw new ScaleError(`${what} at byte ${at}: ${c} is no Unicode scalar value`);
    return String.fromCodePoint(c);
  }
  const w = widthOf(p);
  return integer(p, p.startsWith("u") ? d.r.unsigned(w, what) : d.r.signed(w, what));
}

/** The value of fields, as a composite's or a variant's (see the forms above). */
function fieldsValue(d: Decoding, list: Field[], depth: number): Decoded {
  if (list.length === 0) return null;
  if (list.every((f) => f.name !== null)) return Object.fromEntries(list.map((f) => [f.name as string, decodeAt(d, f.type, depth)]));
  if (list.length === 1) return decodeAt(d, (list.at(0) as Field).type, depth);
  return list.map((f) => decodeAt(d, f.type, depth));
}

/** A count of elements of the given type, refused when it is more than the bytes left. */
function count(d: Decoding, n: number, label: string): void {
  if (n > d.r.left) throw new ScaleError(`${label} at byte ${d.r.pos}: ${n} elements cannot fit in the ${d.r.left} bytes left`);
}

/** The compact form of type id, as that type's value: an unsigned integer, or fields around one. */
function compactOf(d: Decoding, id: number, label: string, depth: number): Decoded {
  if (depth >= MAX_DEPTH) throw new ScaleError(`${label} nests deeper than ${MAX_DEPTH} levels`);
  const t = entry(d.md, id);
  if (t.def.kind === "primitive" && t.def.primitive.startsWith("u")) {
    const p = t.def.primitive;
    const at = d.r.pos;
    const v = d.r.compact(`${label}, a Compact<${p}>`);
    if (v >= 1n << BigInt(8 * widthOf(p))) throw new ScaleError(`${label}, a Compact<${p}> at byte ${at}: ${v} does not fit a ${p}`);
    return integer(p, v);
  }
  if (t.def.kind === "composite" && t.def.fields.length === 1) {
    const f = t.def.fields.at(0) as Field;
    const inner = compactOf(d, f.type, typeLabel(d.md, f.type), depth + 1);
    return f.name === null ? inner : Object.fromEntries([[f.name, inner]]);
  }
  throw new ScaleError(`${label}: a compact of ${typeLabel(d.md, id)} is not read, only of an unsigned integer or one field around one`);
}

/** The value of type id at the reader's position. depth counts the types around this one. */
export function decodeAt(d: Decoding, id: number, depth = 0): Decoded {
  const label = typeLabel(d.md, id);
  if (depth >= MAX_DEPTH) throw new ScaleError(`${label} nests deeper than ${MAX_DEPTH} levels`);
  d.budget.left -= 1;
  if (d.budget.left < 0) throw new ScaleError(`${label} at byte ${d.r.pos}: more values than the bytes can hold (at most 1024 and 8 a byte)`);
  const t = entry(d.md, id);
  const def = t.def;
  const next = depth + 1;
  switch (def.kind) {
    case "primitive":
      return primitive(d, def.primitive, label);
    case "compact":
      return compactOf(d, def.type, label, next);
    case "composite":
      return fieldsValue(d, def.fields, next);
    case "variant": {
      const at = d.r.pos;
      const index = d.r.byte(`${label}, a variant index`);
      const v = def.variants.find((x) => x.index === index);
      if (v === undefined) throw new ScaleError(`${label} at byte ${at}: ${index} is not the index of one of its variants`);
      return { variant: v.name, fields: fieldsValue(d, v.fields, next) };
    }
    case "sequence":
    case "array": {
      // A sequence's length is held to the bytes left as it is read; an array's is held here.
      const n = def.kind === "sequence" ? d.r.length(`${label}, a length`) : def.len;
      if (def.kind === "array") count(d, n, label);
      const el = entry(d.md, def.type).def;
      if (el.kind === "primitive" && el.primitive === "u8") return toHex(d.r.take(n, label));
      const out: Decoded[] = [];
      for (let i = 0; i < n; i++) out.push(decodeAt(d, def.type, next));
      return out;
    }
    case "tuple":
      return def.types.length === 0 ? null : def.types.map((x) => decodeAt(d, x, next));
    case "bitSequence":
      throw new ScaleError(`${label}: a bit sequence, which this decoder does not read`);
  }
}

/** The whole value of type id in these bytes, ending exactly at their end, or a ScaleError. */
export function decodeValue(md: Metadata, id: number, bytes: Uint8Array): Decoded {
  const d = decoding(md, bytes);
  const v = decodeAt(d, id);
  d.r.end(typeLabel(md, id));
  return v;
}
