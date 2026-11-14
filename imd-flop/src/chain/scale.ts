/**
 * The few SCALE writers the chain encoder needs, and the byte reader its strict reader stands on.
 * Little endian fixed width integers, the compact integer and concatenation. Pure: no clock, no I/O.
 * A value that does not fit is refused, never wrapped.
 */
import { refuse } from "./errors.js";
import { freezeFunction } from "../freeze.js";

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
freezeFunction(concat);

/** An unsigned integer in `bytes` bytes, little endian. */
export function uintLE(value: bigint, bytes: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(8 * bytes)) refuse("OUT_OF_RANGE", `${value} does not fit in ${bytes} bytes`);
  const out = new Uint8Array(bytes);
  let n = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
freezeFunction(uintLE);

/** The SCALE compact integer, in its one canonical form. Values up to 2^536 - 1. */
export function compact(value: bigint): Uint8Array {
  if (value < 0n) refuse("OUT_OF_RANGE", "a compact integer is not negative");
  if (value < 1n << 6n) return uintLE(value << 2n, 1);
  if (value < 1n << 14n) return uintLE((value << 2n) | 1n, 2);
  if (value < 1n << 30n) return uintLE((value << 2n) | 2n, 4);
  let len = 0;
  for (let x = value; x > 0n; x >>= 8n) len++;
  if (len > 67) refuse("OUT_OF_RANGE", "a compact integer has at most 67 bytes");
  return concat(Uint8Array.of(((len - 4) << 2) | 3), uintLE(value, len));
}
freezeFunction(compact);

export function toHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
freezeFunction(toHex);

/**
 * Reads bytes front to back. It refuses bytes that end early, a compact integer not in its canonical form,
 * and, at done(), bytes left over.
 */
export class ByteReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) refuse("BAD_BYTES", `the bytes end early: ${n} wanted at ${this.offset} of ${this.bytes.length}`);
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  byte(): number {
    return this.take(1)[0];
  }

  uint(bytes: number): bigint {
    const b = this.take(bytes);
    let n = 0n;
    for (let i = bytes - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
    return n;
  }

  compact(): bigint {
    const first = this.bytes[this.offset];
    if (first === undefined) refuse("BAD_BYTES", "the bytes end early: a compact integer wanted");
    const mode = first & 3;
    let value: bigint;
    if (mode === 0) value = this.uint(1) >> 2n;
    else if (mode === 1) value = this.uint(2) >> 2n;
    else if (mode === 2) value = this.uint(4) >> 2n;
    else {
      this.take(1);
      value = this.uint((first >> 2) + 4);
    }
    // The first byte holds the mode and, in the big mode, the length: a value written longer than it needs
    // has a first byte other than its canonical one.
    if (compact(value)[0] !== first) refuse("BAD_BYTES", "a compact integer not in its canonical form");
    return value;
  }

  done(what: string): void {
    if (this.offset !== this.bytes.length) refuse("BAD_BYTES", `${what} has ${this.bytes.length - this.offset} bytes left over`);
  }
}
freezeFunction(ByteReader);
