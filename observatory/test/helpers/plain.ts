// One plain form for a decoded value, so the observatory's decoder (src/scale/decode.ts) and the
// reference (polkadot-api, a dev dependency for tests only) can be compared value by value. Each
// side keeps its own conventions; this walks the type, from the parsed metadata, beside the value
// and writes both the same way:
//   every integer and compact   a decimal string (ours must give u8 to u32 and i8 to i32 as a
//                               number and every wider integer as a decimal string)
//   bool, char, str             as they are
//   bytes ([u8; N], Vec<u8>)    0x hex
//   fields                      none null, named an object, one unnamed the field, several a list
//   a variant                   { tag, value }, Option and Result included
//   lists, arrays, tuples       a list (the empty tuple null)
// It throws when a value does not have the form its type says, so a difference in shape shows as a
// failure, never as a silent match.
import { AccountId } from "@polkadot-api/substrate-bindings";
import type { Field, Metadata, TypeEntry } from "../../src/scale/metadata.js";

export type Plain = null | boolean | string | Plain[] | { [k: string]: Plain };
export type Side = "ours" | "reference";

const NARROW = new Set(["u8", "u16", "u32", "i8", "i16", "i32"]);
const hexOf = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const ss58 = AccountId();

function entry(md: Metadata, id: number): TypeEntry {
  const t = md.types.at(id);
  if (t === undefined) throw new Error(`type ${id} does not exist`);
  return t;
}

const isBytes = (md: Metadata, id: number) => {
  const d = entry(md, id).def;
  return d.kind === "primitive" && d.primitive === "u8";
};

function fail(what: string, v: unknown): never {
  throw new Error(`${what}: ${typeof v === "bigint" ? `${v}n` : JSON.stringify(v)?.slice(0, 120)}`);
}

/** Bytes as hex, from our hex string or the reference's hex string, Binary or Uint8Array. */
function bytesOf(side: Side, v: unknown): string {
  if (typeof v === "string" && /^0x(?:[0-9a-f]{2})*$/.test(v)) return v;
  if (side === "ours") return fail("ours: not hex", v);
  if (v instanceof Uint8Array) return hexOf(v);
  const asHex = (v as { asHex?: () => string } | null)?.asHex;
  if (typeof asHex === "function") return asHex.call(v);
  return fail("reference: not bytes", v);
}

function fieldsOf(md: Metadata, side: Side, fields: Field[], v: unknown, depth: number): Plain {
  if (fields.length === 0) {
    if (side === "ours" ? v !== null : v !== undefined) fail(`${side}: no fields, but`, v);
    return null;
  }
  if (fields.every((f) => f.name !== null)) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) fail(`${side}: named fields, but`, v);
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length !== fields.length) fail(`${side}: ${fields.length} named fields, but`, Object.keys(o));
    return Object.fromEntries(fields.map((f) => [f.name as string, plain(md, side, f.type, o[f.name as string], depth + 1)]));
  }
  if (fields.length === 1) return plain(md, side, (fields.at(0) as Field).type, v, depth + 1);
  if (!Array.isArray(v) || v.length !== fields.length) fail(`${side}: ${fields.length} unnamed fields, but`, v);
  return fields.map((f, i) => plain(md, side, f.type, v[i], depth + 1));
}

/** The plain form of value v of type id, as one side decoded it. */
export function plain(md: Metadata, side: Side, id: number, v: unknown, depth = 0): Plain {
  if (depth > 64) throw new Error("nested past 64 levels");
  const t = entry(md, id);
  const d = t.def;
  switch (d.kind) {
    case "primitive": {
      if (d.primitive === "bool") return typeof v === "boolean" ? v : fail(`${side}: not a bool`, v);
      if (d.primitive === "str" || d.primitive === "char") return typeof v === "string" ? v : fail(`${side}: not a string`, v);
      if (side === "ours") {
        // Our rule: u8 to u32 and i8 to i32 a number, every wider integer a decimal string.
        if (NARROW.has(d.primitive)) return typeof v === "number" && Number.isSafeInteger(v) ? String(v) : fail(`ours: a ${d.primitive} is a number, not`, v);
        return typeof v === "string" && /^-?(?:0|[1-9]\d*)$/.test(v) ? v : fail(`ours: a ${d.primitive} is a decimal string, not`, v);
      }
      if (typeof v === "bigint" || (typeof v === "number" && Number.isSafeInteger(v))) return String(v);
      return fail(`${side}: not an integer`, v);
    }
    case "compact": {
      const inner = entry(md, d.type).def;
      if (inner.kind === "composite") return fieldsOf(md, side, inner.fields, v, depth);
      return plain(md, side, d.type, v, depth + 1);
    }
    case "sequence":
    case "array": {
      if (isBytes(md, d.type)) return bytesOf(side, v);
      if (!Array.isArray(v)) return fail(`${side}: not a list`, v);
      if (d.kind === "array" && v.length !== d.len) fail(`${side}: an array of ${d.len}, but`, v.length);
      return v.map((x) => plain(md, side, d.type, x, depth + 1));
    }
    case "tuple": {
      if (d.types.length === 0) {
        if (side === "ours" ? v !== null : v !== undefined) fail(`${side}: the empty tuple, but`, v);
        return null;
      }
      if (!Array.isArray(v) || v.length !== d.types.length) return fail(`${side}: a tuple of ${d.types.length}, but`, v);
      return d.types.map((x, i) => plain(md, side, x, v[i], depth + 1));
    }
    case "composite": {
      // The reference gives an AccountId32 as an SS58 address; its bytes are the plain form.
      if (side === "reference" && t.path.at(-1) === "AccountId32" && typeof v === "string") return hexOf(ss58.enc(v));
      return fieldsOf(md, side, d.fields, v, depth);
    }
    case "variant": {
      const name = t.path.length === 1 ? t.path.at(0) : undefined;
      if (side === "reference" && name === "Option" && d.variants.length === 2) {
        const some = d.variants.find((x) => x.name === "Some");
        if (v === undefined) return { tag: "None", value: null };
        return { tag: "Some", value: fieldsOf(md, side, some?.fields ?? [], v, depth) };
      }
      if (side === "reference" && name === "Result" && v !== null && typeof v === "object" && "success" in v) {
        const r = v as { success: boolean; value: unknown };
        const x = d.variants.find((y) => y.name === (r.success ? "Ok" : "Err"));
        return { tag: x?.name ?? fail("reference: a Result with no such variant", v), value: fieldsOf(md, side, x.fields, r.value, depth) };
      }
      const tag = side === "ours" ? (v as { variant?: unknown } | null)?.variant : (v as { type?: unknown } | null)?.type;
      const value = side === "ours" ? (v as { fields?: unknown }).fields : (v as { value?: unknown }).value;
      const x = d.variants.find((y) => y.name === tag);
      if (x === undefined) return fail(`${side}: no variant of type ${id} named`, tag);
      return { tag: x.name, value: fieldsOf(md, side, x.fields, value, depth) };
    }
    case "bitSequence":
      return fail(`${side}: a bit sequence`, v);
  }
}
