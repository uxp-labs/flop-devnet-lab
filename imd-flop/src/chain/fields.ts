/**
 * The fields of a call, written and read by the types the table gives them (rule E4). A 32 byte value is a
 * Uint8Array of exactly 32 bytes; a u32 is a whole number in range; a u64 or a u128 is a bigint in range; an
 * enum is a name looked up in the table; a struct is an object with exactly its fields. There are no free
 * bytes. A field of any other type is refused: the inner calls carry nothing else.
 */
import { plainInput } from "../plain-input.js";
import { refuse } from "./errors.js";
import { ByteReader, uintLE } from "./scale.js";
import type { Ty } from "./table.js";

const WIDTH = Object.freeze({ u32: 4, u64: 8, u128: 16 } as const);

export type FieldValue = number | bigint | string | Uint8Array | { readonly [name: string]: FieldValue };

/**
 * The checks of reading a caller's value once into plain data (rules H1, H3): bytesOf, takeFields, ownKeys,
 * ownValue and the integer check. They live in the shared module plain-input.ts and refuse here through the
 * encoder's own refuse, with the encoder's codes.
 */
const PLAIN = plainInput(refuse);
export const { bytesOf, takeFields, ownKeys, ownValue } = PLAIN;
const { uintOf } = PLAIN;

/**
 * A caller's value of type `ty`, checked and copied into plain data the caller cannot reach (rules H1, E4):
 * bytes into a fresh array by their internal state, a struct field by field, each read once.
 */
export function takeValue(ty: Ty, value: unknown, what: string): FieldValue {
  switch (ty.kind) {
    case "bytes32":
      return bytesOf(value, 32, what);
    case "u32":
      return uintOf("u32", value, what);
    case "u64":
    case "u128":
      return uintOf(ty.kind, value, what);
    case "enum":
      if (typeof value !== "string") refuse("BAD_INPUT", `${what} must be the name of a variant`);
      if (!ty.variants.some((x) => x.name === value)) refuse("ENUM_UNKNOWN", `${what} ${JSON.stringify(value)} is not one of ${ty.variants.map((x) => x.name).join(", ")}`);
      return value;
    case "struct": {
      const raw = takeFields(value, ty.fields.map((f) => f.name), what);
      const out: Record<string, FieldValue> = {};
      for (const f of ty.fields) out[f.name] = takeValue(f.type, raw[f.name], `${what}.${f.name}`);
      return out;
    }
    default:
      return refuse("RUNTIME_UNKNOWN", `${what} has a type (${ty.kind}) no inner call field may have`);
  }
}

/** The bytes of a value of type `ty`, as takeValue gave it. */
export function writeValue(ty: Ty, value: FieldValue, what: string): Uint8Array {
  switch (ty.kind) {
    case "bytes32":
      return Uint8Array.from(value as Uint8Array);
    case "u32":
      return uintLE(BigInt(value as number), WIDTH.u32);
    case "u64":
    case "u128":
      return uintLE(value as bigint, WIDTH[ty.kind]);
    case "enum": {
      const v = ty.variants.find((x) => x.name === value);
      if (!v) refuse("ENUM_UNKNOWN", `${what} ${JSON.stringify(value)} is not one of ${ty.variants.map((x) => x.name).join(", ")}`);
      return Uint8Array.of(v.index);
    }
    case "struct": {
      const obj = value as Record<string, FieldValue>;
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
