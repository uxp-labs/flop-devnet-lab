/**
 * The fields of a call, written and read by the types the table gives them (rule E4). A 32 byte value is a
 * Uint8Array of exactly 32 bytes; a u32 is a whole number in range; a u64 or a u128 is a bigint in range; an
 * enum is a name looked up in the table; a struct is an object with exactly its fields. There are no free
 * bytes. A field of any other type is refused: the inner calls carry nothing else.
 */
import { refuse } from "./errors.js";
import { ByteReader, uintLE } from "./scale.js";
import type { Field, Ty } from "./table.js";

const WIDTH = Object.freeze({ u32: 4, u64: 8, u128: 16 } as const);

export type FieldValue = number | bigint | string | Uint8Array | { readonly [name: string]: FieldValue };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !ArrayBuffer.isView(v) && !Array.isArray(v);

/**
 * The getters of %TypedArray%.prototype, taken once at load. They read a typed array's internal slots, so
 * a subclass or an own property that lies about the length, the offset or the buffer is not believed.
 */
const TYPED = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getter = (name: PropertyKey) => Object.getOwnPropertyDescriptor(TYPED, name)!.get! as (this: unknown) => unknown;
const KIND = getter(Symbol.toStringTag);
const BUFFER = getter("buffer");
const OFFSET = getter("byteOffset");
const LENGTH = getter("byteLength");

/**
 * A fresh copy of the bytes of `value`, which must be a Uint8Array (a Node buffer is one) of exactly `n` bytes
 * (any length when `n` is null) by its own internal state (rule H3). Anything else is refused: another width, an array, a string.
 */
export function bytesOf(value: unknown, n: number | null, what: string): Uint8Array {
  const kind = ArrayBuffer.isView(value) ? KIND.call(value) : undefined;
  if (kind !== "Uint8Array") refuse("BAD_INPUT", `${what} must be a Uint8Array${n === null ? "" : ` of ${n} bytes`}`);
  const length = LENGTH.call(value) as number;
  if (n !== null && length !== n) refuse("WRONG_LENGTH", `${what} has ${length} bytes, not ${n}`);
  const view = new Uint8Array(BUFFER.call(value) as ArrayBuffer, OFFSET.call(value) as number, length);
  const copy = new Uint8Array(length);
  copy.set(view);
  return copy;
}

/** Refuses an object whose keys are not exactly `fields` (plus `allow`). */
export function exactKeys(value: unknown, fields: readonly Field[], what: string, allow: readonly string[] = []): Record<string, unknown> {
  if (!isObject(value)) refuse("BAD_INPUT", `${what} must be an object`);
  const want = new Set([...fields.map((f) => f.name), ...allow]);
  for (const k of Object.keys(value)) if (!want.has(k)) refuse("BAD_INPUT", `${what} has a field ${k} the table does not have`);
  for (const f of fields) if (!Object.hasOwn(value, f.name)) refuse("BAD_INPUT", `${what} lacks the field ${f.name}`);
  return value;
}

/** The bytes of `value` as a field of type `ty`. */
export function writeValue(ty: Ty, value: unknown, what: string): Uint8Array {
  switch (ty.kind) {
    case "bytes32":
      return bytesOf(value, 32, what);
    case "u32":
      if (typeof value !== "number" || !Number.isInteger(value)) refuse("BAD_INPUT", `${what} must be a whole number (u32)`);
      if (value < 0 || value > 2 ** 32 - 1) refuse("OUT_OF_RANGE", `${what} ${value} is not a u32`);
      return uintLE(BigInt(value), WIDTH.u32);
    case "u64":
    case "u128":
      if (typeof value !== "bigint") refuse("BAD_INPUT", `${what} must be a bigint (${ty.kind})`);
      if (value < 0n || value >= 1n << BigInt(8 * WIDTH[ty.kind])) refuse("OUT_OF_RANGE", `${what} ${value} is not a ${ty.kind}`);
      return uintLE(value, WIDTH[ty.kind]);
    case "enum": {
      if (typeof value !== "string") refuse("BAD_INPUT", `${what} must be the name of a variant`);
      const v = ty.variants.find((x) => x.name === value);
      if (!v) refuse("ENUM_UNKNOWN", `${what} ${JSON.stringify(value)} is not one of ${ty.variants.map((x) => x.name).join(", ")}`);
      return Uint8Array.of(v.index);
    }
    case "struct": {
      const obj = exactKeys(value, ty.fields, what);
      const parts = ty.fields.map((f) => writeValue(f.type, obj[f.name], `${what}.${f.name}`));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    }
    default:
      return refuse("RUNTIME_UNKNOWN", `${what} has a type (${ty.kind}) no inner call field may have`);
  }
}

/** Reads one field of type `ty`. Refuses an enum index the table does not have. */
export function readValue(r: ByteReader, ty: Ty, what: string): FieldValue {
  switch (ty.kind) {
    case "bytes32":
      return r.take(32);
    case "u32":
      return Number(r.uint(WIDTH.u32));
    case "u64":
    case "u128":
      return r.uint(WIDTH[ty.kind]);
    case "enum": {
      const index = r.byte();
      const v = ty.variants.find((x) => x.index === index);
      if (!v) refuse("ENUM_UNKNOWN", `${what} has variant index ${index}, which the table does not have`);
      return v.name;
    }
    case "struct": {
      const out: Record<string, FieldValue> = {};
      for (const f of ty.fields) out[f.name] = readValue(r, f.type, `${what}.${f.name}`);
      return out;
    }
    default:
      return refuse("RUNTIME_UNKNOWN", `${what} has a type (${ty.kind}) no inner call field may have`);
  }
}
