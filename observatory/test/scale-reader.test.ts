// The SCALE reader (src/scale/reader.ts): every read bounded, compact integers in their shortest
// form only, strict UTF-8, and a whole value that ends exactly at the end of its bytes.
import { describe, expect, it } from "vitest";
import { Reader, ScaleError, type Width, fromHex, toHex } from "../src/scale/reader.js";
import { seeded } from "./helpers/random.js";

const r = (hex: string) => new Reader(fromHex(hex));

describe("compact integers", () => {
  it.each([
    ["0x00", 0n],
    ["0x04", 1n],
    ["0xfc", 63n],
    ["0x0101", 64n],
    ["0x1501", 69n],
    ["0xfdff", 16383n],
    ["0x02000100", 16384n],
    ["0xfeffffff", (1n << 30n) - 1n],
    ["0x0300000040", 1n << 30n],
    ["0x03ffffffff", (1n << 32n) - 1n],
    ["0x070000000001", 1n << 32n],
    [`0x33${"ff".repeat(16)}`, (1n << 128n) - 1n],
  ])("reads %s as %s, in all four modes, and nothing more", (hex, v) => {
    const x = r(hex);
    expect(x.compact()).toBe(v);
    expect(x.left).toBe(0);
  });

  it.each([
    ["0x0100", "0 in two bytes"],
    ["0xfd00", "63 in two bytes"],
    ["0x02000000", "0 in four bytes"],
    ["0xfeff0000", "16383 in four bytes"],
    ["0x03ffffff3f", `${(1n << 30n) - 1n} in 4 bytes`],
    ["0x070000000000", "0 in 5 bytes"],
    ["0x07ffffffff00", `${(1n << 32n) - 1n} in 5 bytes`],
  ])("refuses %s, which is not the shortest form (%s)", (hex, says) => {
    expect(() => r(hex).compact()).toThrow(new ScaleError(`a compact integer at byte 0: ${says} is not its shortest form`));
  });

  it.each(["0x", "0x01", "0x020000", "0x03000000", "0x07000000"])("refuses %s, cut short", (hex) => {
    expect(() => r(hex).compact()).toThrow(ScaleError);
  });

  it("refuses a length that cannot fit in the bytes left, before reading anything for it", () => {
    expect(r("0x10aabbccdd").length()).toBe(4);
    expect(() => r("0x14aabbccdd").length()).toThrow(new ScaleError("a length at byte 0: 5 cannot fit in the 4 bytes left"));
    expect(() => r(`0x33${"ff".repeat(16)}`).length()).toThrow(/cannot fit in the 0 bytes left/);
  });
});

describe("fixed width integers, bools and bytes", () => {
  it("reads little endian unsigned and signed integers of every width to 256 bits", () => {
    expect(r("0x0102").unsigned(2)).toBe(0x0201n);
    expect(r("0x78563412").unsigned(4)).toBe(0x12345678n);
    expect(r(`0x${"ff".repeat(32)}`).unsigned(32)).toBe((1n << 256n) - 1n);
    expect(r(`0x${"00".repeat(15)}80`).signed(16)).toBe(-(1n << 127n));
    expect(r("0xff").signed(1)).toBe(-1n);
    expect(r("0x7f").signed(1)).toBe(127n);
    expect(r("0x02a8b81fa0e95301").unsigned(8)).toBe(0x0153e9a01fb8a802n);
  });

  it.each([1, 2, 4, 8, 16, 32] as Width[])("refuses a u%s past the end", (w) => {
    expect(() => new Reader(new Uint8Array(w - 1)).unsigned(w)).toThrow(new ScaleError(`u${w * 8} at byte 0: needs ${w} bytes, ${w - 1} left`));
  });

  it("reads a bool only as 0 or 1", () => {
    expect(r("0x00").bool()).toBe(false);
    expect(r("0x01").bool()).toBe(true);
    expect(() => r("0x02").bool()).toThrow(new ScaleError("a bool at byte 0: 2 is neither 0 nor 1"));
  });

  it("takes bytes only from what is left, and never a length that is not a whole number from 0", () => {
    const x = r("0xaabbcc");
    expect(toHex(x.take(2))).toBe("0xaabb");
    expect(() => x.take(2)).toThrow(new ScaleError("bytes at byte 2: needs 2 bytes, 1 left"));
    expect(x.pos).toBe(2);
    expect(() => x.take(-1)).toThrow(ScaleError);
    expect(() => x.take(0.5)).toThrow(ScaleError);
    expect(toHex(x.take(1))).toBe("0xcc");
    expect(() => x.byte()).toThrow(ScaleError);
  });
});

describe("strings", () => {
  it("reads strict UTF-8, and keeps a byte order mark as written", () => {
    expect(r("0x0c616263").text()).toBe("abc");
    expect(r("0x10f09f9982").text()).toBe("\u{1f642}");
    expect(r("0x0cefbbbf").text()).toBe("﻿");
  });

  it.each([
    ["0x04ff", "a byte that is never UTF-8"],
    ["0x08c080", "an overlong form"],
    ["0x0ceda080", "a surrogate"],
    ["0x08e282", "a sequence cut short"],
  ])("refuses %s, %s, and replaces nothing", (hex) => {
    expect(() => r(hex).text()).toThrow(new ScaleError("a string at byte 0: not strict UTF-8"));
  });
});

describe("the end of a value", () => {
  it("refuses any byte left over", () => {
    const x = r("0x0001");
    x.byte();
    expect(() => x.end()).toThrow(new ScaleError("the value ends at byte 1, 1 bytes before the end"));
    x.byte();
    expect(() => x.end()).not.toThrow();
  });
});

describe("hex", () => {
  it("reads and writes 0x and lower case hex, two digits a byte, only", () => {
    expect(toHex(fromHex("0x00ff10"))).toBe("0x00ff10");
    expect(toHex(new Uint8Array())).toBe("0x");
    for (const bad of ["00ff", "0x0", "0xFF", "0xgg", "0x 1"]) expect(() => fromHex(bad), bad).toThrow(ScaleError);
  });
});

describe("a reader never reads past its end (property, seeded)", () => {
  it("on 2000 random byte strings and random reads, every read gives a value or a ScaleError, inside the bytes", () => {
    const rand = seeded(20261111);
    const widths: Width[] = [1, 2, 4, 8, 16, 32];
    let refused = 0;
    let read = 0;
    for (let n = 0; n < 2000; n++) {
      const bytes = rand.bytes(rand.int(48));
      const x = new Reader(bytes);
      for (let step = 0; step < 12; step++) {
        const before = x.pos;
        try {
          const op = rand.int(7);
          if (op === 0) x.compact();
          else if (op === 1) x.length();
          else if (op === 2) x.unsigned(widths.at(rand.int(6)) as Width);
          else if (op === 3) x.bool();
          else if (op === 4) x.text();
          else if (op === 5) x.take(rand.int(8));
          else x.signed(widths.at(rand.int(6)) as Width);
          read++;
        } catch (e) {
          expect(e).toBeInstanceOf(ScaleError);
          refused++;
          // A refused read may have moved inside the bytes, never past them.
          expect(x.pos).toBeGreaterThanOrEqual(before);
        }
        expect(x.pos).toBeLessThanOrEqual(bytes.length);
        expect(x.left).toBe(bytes.length - x.pos);
      }
    }
    expect(read).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(1000);
  });
});
