// A reader over SCALE bytes (the encoding of every value a Substrate node stores and answers), with
// a position and nothing else: no globals, no network, no clock. RULES.md section 9.
//
// Every read is bounded. A read past the end, a compact integer in any but its shortest form, a
// length that cannot fit in the bytes left and text that is not strict UTF-8 are each refused with
// a ScaleError, which names what was refused and where. The reader never guesses: it reads exactly
// what it is asked, and `end` refuses any byte left over, so a whole value must end exactly at the
// end of its bytes. How deep a value may nest is the decoder's limit (src/scale/decode.ts), since
// the reader reads only flat things.

/** A refusal to read: what was refused and at which byte. The decoder's only failure. */
export class ScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaleError";
  }
}

/**
 * What a read is of, for a refusal: a string, or a function that builds one. A function is called
 * only when a refusal is thrown, so a read that succeeds builds no text.
 */
export type What = string | (() => string);
const say = (w: What): string => (typeof w === "string" ? w : w());

/**
 * The most bytes one metadata or one value may be: 16 MiB. A larger input is refused before it is
 * read, so no string the decoder builds from it can reach the engine's own limit.
 */
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;

/** A refusal of an input past MAX_INPUT_BYTES, or nothing. */
export function withinSize(bytes: Uint8Array, what: string): void {
  if (bytes.length > MAX_INPUT_BYTES) throw new ScaleError(`${what} is ${bytes.length} bytes, more than the ${MAX_INPUT_BYTES} this decoder reads`);
}

/** The widths in bytes a fixed width integer may have: u8 to u256. */
export type Width = 1 | 2 | 4 | 8 | 16 | 32;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Lower case hex with 0x, two digits a byte. */
export function toHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** The bytes of lower case hex with 0x and two digits a byte, or a ScaleError. */
export function fromHex(hex: string): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(hex)) throw new ScaleError("not 0x and lower case hex, two digits a byte");
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out.set([Number.parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16)], i);
  return out;
}

export class Reader {
  readonly bytes: Uint8Array;
  #pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** The offset of the next byte to read. */
  get pos(): number {
    return this.#pos;
  }

  /** How many bytes are left to read. */
  get left(): number {
    return this.bytes.length - this.#pos;
  }

  /** The next n bytes, as a view, or a refusal when fewer are left. */
  take(n: number, what: What = "bytes"): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0) throw new ScaleError(`${say(what)} at byte ${this.#pos}: ${n} is no length`);
    if (n > this.left) throw new ScaleError(`${say(what)} at byte ${this.#pos}: needs ${n} bytes, ${this.left} left`);
    const out = this.bytes.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }

  byte(what: What = "a byte"): number {
    return this.take(1, what).at(0) as number;
  }

  /** An unsigned little endian integer of the width given. */
  unsigned(width: Width, what: What = `u${width * 8}`): bigint {
    const b = this.take(width, what);
    let v = 0n;
    for (let i = width - 1; i >= 0; i--) v = (v << 8n) | BigInt(b.at(i) as number);
    return v;
  }

  /** A signed little endian integer of the width given, in two's complement. */
  signed(width: Width, what: What = `i${width * 8}`): bigint {
    return BigInt.asIntN(width * 8, this.unsigned(width, what));
  }

  /**
   * A compact integer, in all four of its modes, refused unless it is in its shortest form: a
   * value that fits a shorter mode, or a big integer mode with a top byte of zero, has a second
   * spelling, and the encoding has one spelling for each value.
   */
  compact(what: What = "a compact integer"): bigint {
    const at = this.#pos;
    if (this.left < 1) throw new ScaleError(`${say(what)} at byte ${at}: needs 1 byte, 0 left`);
    const mode = (this.bytes.at(at) as number) & 3;
    if (mode === 0) return BigInt(this.byte(what) >> 2);
    if (mode === 1) {
      const v = this.unsigned(2, what) >> 2n;
      if (v < 1n << 6n) throw new ScaleError(`${say(what)} at byte ${at}: ${v} in two bytes is not its shortest form`);
      return v;
    }
    if (mode === 2) {
      const v = this.unsigned(4, what) >> 2n;
      if (v < 1n << 14n) throw new ScaleError(`${say(what)} at byte ${at}: ${v} in four bytes is not its shortest form`);
      return v;
    }
    const n = (this.byte(what) >> 2) + 4;
    const b = this.take(n, what);
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b.at(i) as number);
    if (n === 4 ? v < 1n << 30n : b.at(n - 1) === 0) throw new ScaleError(`${say(what)} at byte ${at}: ${v} in ${n} bytes is not its shortest form`);
    return v;
  }

  /**
   * A compact length: a count of things that follow, each at least one byte, so a count above
   * the bytes left is refused before anything is read for it. A thing that takes no bytes is
   * held to the same bound by the decoder.
   */
  length(what: What = "a length"): number {
    const at = this.#pos;
    const n = this.compact(what);
    if (n > BigInt(this.left)) throw new ScaleError(`${say(what)} at byte ${at}: ${n} cannot fit in the ${this.left} bytes left`);
    return Number(n);
  }

  bool(what: What = "a bool"): boolean {
    const at = this.#pos;
    const b = this.byte(what);
    if (b > 1) throw new ScaleError(`${say(what)} at byte ${at}: ${b} is neither 0 nor 1`);
    return b === 1;
  }

  /** A string: a compact length, then that many bytes of strict UTF-8 (no byte replaced or dropped). */
  text(what: What = "a string"): string {
    const at = this.#pos;
    const b = this.take(this.length(what), what);
    try {
      return UTF8.decode(b);
    } catch {
      throw new ScaleError(`${say(what)} at byte ${at}: not strict UTF-8`);
    }
  }

  /** Refuses any byte left over: a whole value ends exactly at the end of its bytes. */
  end(what: What = "the value"): void {
    if (this.left !== 0) throw new ScaleError(`${say(what)} ends at byte ${this.#pos}, ${this.left} bytes before the end`);
  }
}
