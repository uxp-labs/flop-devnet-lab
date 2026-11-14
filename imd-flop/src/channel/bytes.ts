/**
 * The byte helpers of the channel modules: the shared input checks bound to the channel's refuse, fixed width
 * little endian integers, concatenation, ASCII and UTF-8 text, and lower case hex. Pure: no clock, no file, no
 * randomness. Every array returned is fresh.
 */
import { plainInput } from "../plain-input.js";
import { refuse } from "./errors.js";
import { freezeFunction } from "../freeze.js";

const PLAIN = plainInput(refuse);

/** A fresh copy of a Uint8Array of exactly `n` bytes (any length when `n` is null), by its internal state. */
export const bytesOf = PLAIN.bytesOf;
/** The fields `names` of a caller's object, each read once, into a fresh object; an extra, a missing or an accessor field is refused. */
export const takeFields = PLAIN.takeFields;
/** A u32 as a whole number in range, a u64 or a u128 as a bigint in range. */
export const uintOf = PLAIN.uintOf;

/**
 * The fields `names` of a caller's object, each read once, with every byte value copied at that one reading. The
 * values are not checked further here: each is checked by the function it is handed to. Bytes are copied so that
 * nothing of the caller's is held between two uses of the same reading.
 */
export function snapshotOf(value: unknown, names: readonly string[], what: string): Record<string, unknown> {
  const raw = takeFields(value, names, what);
  const out: Record<string, unknown> = Object.create(null);
  for (const n of names) out[n] = ArrayBuffer.isView(raw[n]) ? bytesOf(raw[n], null, `${what}.${n}`) : raw[n];
  return out;
}
freezeFunction(snapshotOf);

/** The little endian bytes of `value` in exactly `width` bytes. The caller has checked the range. */
export function uintLE(value: bigint, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let v = value;
  for (let i = 0; i < width; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
freezeFunction(uintLE);

/** The parts one after another, in a fresh array. */
export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
freezeFunction(concat);

/** The bytes of an ASCII text, fresh at each call. A domain text is kept as its text and made into bytes here (rule A5). */
export function asciiOf(text: string, what: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x7f) refuse("BAD_INPUT", `${what} is not ASCII at character ${i}`);
    out[i] = c;
  }
  return out;
}
freezeFunction(asciiOf);

/** A lone surrogate: with the u flag a well formed pair never matches. */
const LONE_SURROGATE = /\p{Cs}/u;

/** The UTF-8 bytes of a text. A text that is not a string, or holds a lone surrogate, is refused: it has no exact UTF-8 form. */
export function utf8Of(text: unknown, what: string): Uint8Array {
  if (typeof text !== "string") refuse("BAD_INPUT", `${what} must be a string`);
  if (LONE_SURROGATE.test(text)) refuse("BAD_INPUT", `${what} holds a lone surrogate, so it has no exact UTF-8 form`);
  return new TextEncoder().encode(text);
}
freezeFunction(utf8Of);

const DIGITS = "0123456789abcdef";

/** 0x and the lower case hex digits of the bytes. */
export function hexOf(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += DIGITS[b >> 4]! + DIGITS[b & 15]!;
  return s;
}
freezeFunction(hexOf);
