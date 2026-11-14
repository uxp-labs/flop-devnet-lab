/**
 * The forms the miner modules hold a value to, as pure predicates and decoders that refuse nothing themselves:
 * the caller's checks (check.ts) refuse with BAD_INPUT and the parsers (wire.ts) with WIRE, under one rule each.
 * Every array returned is fresh. Nothing here reads a clock, a file or a random source.
 */
import { freezeFunction } from "../freeze.js";

/** The ranges and the hard maxima of this piece. Each is stated once, here. */
export const LIMITS = Object.freeze({
  /** The most UTF-8 bytes of one bounded text: a model name, a slug, a finish reason, an image version (W6). */
  TEXT_MAX_BYTES: 256,
  /** The most decimal digits a wire decimal may have before its range is checked (W11). */
  DECIMAL_MAX_DIGITS: 39,
  /** The most bytes of a turn's output (W11): 2 MiB. */
  OUTPUT_MAX_BYTES: 2 * 1024 * 1024,
  /** The most a request's max_tokens may be (W8). */
  MAX_TOKENS_MAX: 131072,
  /** The most messages one chat turn may carry. */
  MESSAGES_MAX: 256,
  /** The most UTF-8 bytes of one chat turn's input, the canonical JSON text whole. 1 MiB. */
  INPUT_MAX_BYTES: 1024 * 1024,
  /** The most UTF-8 bytes of an SS58 address text. */
  ADDRESS_MAX_BYTES: 64,
} as const);

export const U8_MAX = 255;
export const U32_MAX = 2 ** 32 - 1;
/** 2^64 minus 1 and 2^128 minus 1, as functions: an export is a function, a text, a number or a frozen object. */
export const u64Max = freezeFunction((): bigint => (1n << 64n) - 1n);
export const u128Max = freezeFunction((): bigint => (1n << 128n) - 1n);

/** A lone surrogate: with the u flag a well formed pair never matches. */
const LONE_SURROGATE = /\p{Cs}/u;
/** A control character: C0, DEL and C1. U+2028 and U+2029 are not control characters and are allowed. */
const CONTROL = /\p{Cc}/u;

/**
 * Why a value is not a bounded text, or null when it is one: a string, well formed UTF-16, with no control
 * character, of 1 to TEXT_MAX_BYTES bytes of UTF-8 (W6, W11). The reason never quotes the value.
 */
export function textProblem(value: unknown, maxBytes: number = LIMITS.TEXT_MAX_BYTES): string | null {
  if (typeof value !== "string") return "must be a string";
  if (value.length === 0) return "must not be empty";
  // A UTF-16 unit is at least one byte of UTF-8, so a longer text is over the bound before it is encoded.
  if (value.length > maxBytes) return `must be at most ${maxBytes} bytes of UTF-8`;
  if (LONE_SURROGATE.test(value)) return "must be well formed UTF-16 (it holds a lone surrogate)";
  if (CONTROL.test(value)) return "must hold no control character";
  if (utf8(value).length > maxBytes) return `must be at most ${maxBytes} bytes of UTF-8`;
  return null;
}
freezeFunction(textProblem);

/** True when a string has no lone surrogate, so it has one exact UTF-8 form. */
export function wellFormed(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}
freezeFunction(wellFormed);

/** The UTF-8 bytes of a text that is well formed. Fresh at each call. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
freezeFunction(utf8);

const LOWER_HEX = /^[0-9a-f]*$/;

/**
 * The bytes of lower case hex of exactly `n` bytes, with `0x` in front when `prefixed` and none when bare, or null
 * for any other spelling. When `n` is null the length may be any even number of digits up to `max` bytes.
 */
export function hexBytes(value: unknown, n: number | null, prefixed: boolean, max = 0): Uint8Array | null {
  if (typeof value !== "string") return null;
  const lead = prefixed ? 2 : 0;
  if (prefixed && !value.startsWith("0x")) return null;
  const digits = value.length - lead;
  if (n !== null ? digits !== 2 * n : digits % 2 !== 0 || digits > 2 * max) return null;
  const body = value.slice(lead);
  if (!LOWER_HEX.test(body)) return null;
  const out = new Uint8Array(digits / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(2 * i, 2 * i + 2), 16);
  return out;
}
freezeFunction(hexBytes);

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/** A wire decimal as a bigint at most `max`, or null: `0` or 1 to 9 then digits, at most 39 digits, nothing else. */
export function decimalOf(value: unknown, max: bigint): bigint | null {
  if (typeof value !== "string" || value.length > LIMITS.DECIMAL_MAX_DIGITS || !DECIMAL.test(value)) return null;
  const n = BigInt(value);
  return n <= max ? n : null;
}
freezeFunction(decimalOf);

/** A wire number as a safe integer from 0 to `max`, or null. */
export function wholeOf(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return null;
  return value;
}
freezeFunction(wholeOf);

/** True when every byte is 0. */
export function allZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}
freezeFunction(allZero);
