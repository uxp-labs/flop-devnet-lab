/**
 * The checks of a caller's input to the miner modules (W3), refusing with BAD_INPUT. An object is plain fields of
 * exactly the named ones, read once each through its own property descriptor, no accessor. A byte value is a
 * Uint8Array of the exact length, taken as a fresh copy. A number is a bigint inside its type. The messages name
 * the field and the form wanted. They never quote a value, a key the caller added, or a number the caller gave.
 */
import { plainInput, type PlainInputCode } from "../plain-input.js";
import { freezeFunction } from "../freeze.js";
import { refuseMiner } from "./errors.js";
import { imageTextProblem, textProblem, u128Max, u64Max, U32_MAX, U8_MAX } from "./forms.js";

/** plain-input's checks, each of its codes taken as the caller's input out of its form. */
const PLAIN = plainInput((_code: PlainInputCode, message: string) => refuseMiner("BAD_INPUT", "input", message));

const bad = (what: string, wanted: string): never => refuseMiner("BAD_INPUT", what, `${what} ${wanted}`);

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !ArrayBuffer.isView(v) && !Array.isArray(v);

/** The fields `names` of a caller's object, each read once, into a fresh object. An extra, a missing or an accessor field is refused. */
export function fieldsOf(value: unknown, names: readonly string[], what: string): Record<string, unknown> {
  if (!isObject(value)) return bad(what, "must be an object");
  const want = new Set(names);
  const keys = PLAIN.ownKeys(value);
  if (keys.some((k) => !want.has(k))) bad(what, `has a field that is not one of its fields (${names.join(", ")})`);
  const have = new Set(keys);
  for (const n of names) if (!have.has(n)) bad(what, `lacks the field ${n}`);
  if (Object.getOwnPropertySymbols(value).length > 0) bad(what, "has a symbol key");
  const out: Record<string, unknown> = Object.create(null);
  for (const n of names) out[n] = PLAIN.ownValue(value, n, what);
  return out;
}
freezeFunction(fieldsOf);

/** The items of a caller's array, each read once, with no hole, no accessor and no key but the indices and length. */
export function itemsOf(value: unknown, min: number, max: number, what: string): unknown[] {
  if (!Array.isArray(value)) return bad(what, "must be an array");
  const length = PLAIN.ownValue(value, "length", what);
  if (typeof length !== "number" || length < min || length > max) bad(what, `must hold ${min} to ${max} items`);
  const keys = PLAIN.ownKeys(value);
  if (keys.length !== (length as number) + 1 || Object.getOwnPropertySymbols(value).length > 0) bad(what, "must be a plain array with no hole and no extra key");
  const out: unknown[] = [];
  for (let i = 0; i < (length as number); i++) out.push(PLAIN.ownValue(value, String(i), what));
  return out;
}
freezeFunction(itemsOf);

/** A fresh copy of a Uint8Array of exactly `n` bytes (any length when `n` is null). */
export function bytesIn(value: unknown, n: number | null, what: string): Uint8Array {
  return PLAIN.bytesOf(value, n, what);
}
freezeFunction(bytesIn);

const MAX = Object.freeze({ u64: u64Max(), u128: u128Max() });

/** A bigint inside a u64 or a u128. The message names the type, never the number. */
export function bigIn(kind: "u64" | "u128", value: unknown, what: string): bigint {
  if (typeof value !== "bigint") return bad(what, `must be a bigint (${kind})`);
  if (value < 0n || value > MAX[kind]) bad(what, `must be inside a ${kind}`);
  return value;
}
freezeFunction(bigIn);

/** A whole number at least min and at most max, and at most a u32. */
export function wholeIn(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return bad(what, "must be a whole number");
  if (value < min || value > max || value > U32_MAX) bad(what, `must be from ${min} to ${max}`);
  return value;
}
freezeFunction(wholeIn);

/** A u8. */
export function u8In(value: unknown, what: string): number {
  return wholeIn(value, 0, U8_MAX, what);
}
freezeFunction(u8In);

/** A bounded text (W6). */
export function textIn(value: unknown, what: string): string {
  const problem = textProblem(value);
  if (problem !== null) bad(what, problem);
  return value as string;
}
freezeFunction(textIn);

/** An image text (the proof's image version or revision, M-19): 0 to 256 bytes, well formed, control characters allowed. */
export function imageTextIn(value: unknown, what: string): string {
  const problem = imageTextProblem(value);
  if (problem !== null) bad(what, problem);
  return value as string;
}
freezeFunction(imageTextIn);

/** A boolean. */
export function booleanIn(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") return bad(what, "must be a boolean");
  return value;
}
freezeFunction(booleanIn);
