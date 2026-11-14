/**
 * P4 part 1, rules M1 to M8: the shared input checks of src/plain-input.ts on their own, with a refuse of this
 * test's own. Each refusal of each function, the accessor, the Proxy, a subclass that lies about its length, a Node
 * Buffer accepted, the copy fresh, the object frozen, and a scan that the file imports nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ChainEncodeError } from "../src/chain/errors.js";
import { bytesOf as chainBytesOf, takeFields as chainTakeFields, takeValue } from "../src/chain/fields.js";
import { plainInput, type PlainInputCode } from "../src/plain-input.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

class Refused extends Error {
  constructor(
    readonly code: PlainInputCode,
    message: string,
  ) {
    super(message);
  }
}
const P = plainInput((code, message) => {
  throw new Refused(code, message);
});

/** The code and the message of what `f` refused with, or a failure if it did not refuse. */
function refusal(f: () => unknown): { code: PlainInputCode; message: string } {
  try {
    f();
  } catch (e) {
    if (e instanceof Refused) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("did not refuse");
}

class LyingLength extends Uint8Array {
  override get length() {
    return 32;
  }
}
class LyingBuffer extends Uint8Array {
  override get byteLength() {
    return 32;
  }
}

describe("M2: plainInput(refuse) gives a frozen object of the five functions", () => {
  it("has exactly bytesOf, takeFields, ownKeys, ownValue and uintOf, and is frozen", () => {
    expect(Object.keys(P).sort()).toEqual(["bytesOf", "ownKeys", "ownValue", "takeFields", "uintOf"]);
    expect(Object.isFrozen(P)).toBe(true);
  });

  it("refuses through the function it is handed, not another", () => {
    const seen: string[] = [];
    const mine = plainInput((code, message) => {
      seen.push(`${code}: ${message}`);
      throw new Error("mine");
    });
    expect(() => mine.bytesOf("x", 32, "v")).toThrow("mine");
    expect(seen).toEqual(["BAD_INPUT: v must be a Uint8Array of 32 bytes"]);
  });
});

describe("bytesOf", () => {
  it("refuses what is not a Uint8Array: a string, an array, a number, a DataView, a Uint16Array, a fake with the tag", () => {
    const fake = { length: 32, [Symbol.toStringTag]: "Uint8Array", buffer: new ArrayBuffer(32), byteLength: 32, byteOffset: 0 };
    for (const v of ["00", [1, 2], 3, new DataView(new ArrayBuffer(32)), new Uint16Array(16), fake, null, undefined]) {
      expect(refusal(() => P.bytesOf(v, 32, "v"))).toEqual({ code: "BAD_INPUT", message: "v must be a Uint8Array of 32 bytes" });
    }
    expect(refusal(() => P.bytesOf("00", null, "v"))).toEqual({ code: "BAD_INPUT", message: "v must be a Uint8Array" });
  });

  it("refuses a Proxy over a Uint8Array", () => {
    expect(refusal(() => P.bytesOf(new Proxy(new Uint8Array(32), {}), 32, "v")).code).toBe("BAD_INPUT");
  });

  it("refuses a wrong length, naming the length found and wanted", () => {
    expect(refusal(() => P.bytesOf(new Uint8Array(31), 32, "v"))).toEqual({ code: "WRONG_LENGTH", message: "v has 31 bytes, not 32" });
    expect(refusal(() => P.bytesOf(new Uint8Array(33), 32, "v"))).toEqual({ code: "WRONG_LENGTH", message: "v has 33 bytes, not 32" });
  });

  it("does not believe a subclass that lies about its length", () => {
    expect(refusal(() => P.bytesOf(new LyingLength(33), 32, "v"))).toEqual({ code: "WRONG_LENGTH", message: "v has 33 bytes, not 32" });
    expect(refusal(() => P.bytesOf(new LyingBuffer(40), 32, "v"))).toEqual({ code: "WRONG_LENGTH", message: "v has 40 bytes, not 32" });
  });

  it("accepts a Node Buffer and a view into a larger buffer, by its own offset and length", () => {
    const big = new Uint8Array(64).map((_, i) => i);
    const got = P.bytesOf(Buffer.from(big.buffer, 10, 32), 32, "v");
    expect(Array.from(got)).toEqual(Array.from(big.subarray(10, 42)));
    expect(Object.getPrototypeOf(got)).toBe(Uint8Array.prototype);
  });

  it("gives a fresh copy: a change to the input or the output changes nothing of the other", () => {
    const input = new Uint8Array(32).fill(7);
    const got = P.bytesOf(input, 32, "v");
    input[0] = 1;
    expect(got[0]).toBe(7);
    got[1] = 2;
    expect(input[1]).toBe(7);
    expect(got.buffer).not.toBe(input.buffer);
  });

  it("any length when n is null", () => {
    expect(P.bytesOf(new Uint8Array(0), null, "v").length).toBe(0);
    expect(P.bytesOf(new Uint8Array(1000), null, "v").length).toBe(1000);
  });
});

describe("takeFields, ownKeys, ownValue", () => {
  it("refuses what is not an object: null, an array, bytes, a string", () => {
    for (const v of [null, undefined, [], new Uint8Array(1), "x", 1]) expect(refusal(() => P.takeFields(v, ["a"], "input"))).toEqual({ code: "BAD_INPUT", message: "input must be an object" });
  });

  it("refuses an extra field, with the shared text", () => {
    expect(refusal(() => P.takeFields({ a: 1, b: 2 }, ["a"], "input"))).toEqual({ code: "BAD_INPUT", message: "input has a field b that is not one of its fields" });
  });

  it("refuses an extra field that is not enumerable", () => {
    const o = { a: 1 };
    Object.defineProperty(o, "hidden", { value: 1, enumerable: false });
    expect(refusal(() => P.takeFields(o, ["a"], "input")).message).toBe("input has a field hidden that is not one of its fields");
  });

  it("refuses a missing field, and a field held only by the prototype", () => {
    expect(refusal(() => P.takeFields({ a: 1 }, ["a", "b"], "input"))).toEqual({ code: "BAD_INPUT", message: "input lacks the field b" });
    expect(refusal(() => P.takeFields(Object.create({ a: 1 }), ["a"], "input"))).toEqual({ code: "BAD_INPUT", message: "input lacks the field a" });
  });

  it("refuses an accessor, and never calls it", () => {
    let calls = 0;
    const o = {
      get a() {
        calls++;
        return 1;
      },
    };
    expect(refusal(() => P.takeFields(o, ["a"], "input"))).toEqual({ code: "BAD_INPUT", message: "input.a is an accessor, not a value" });
    expect(calls).toBe(0);
  });

  it("reads each field of a Proxy exactly once, and lists its keys once", () => {
    const reads: string[] = [];
    let lists = 0;
    const p = new Proxy(
      { a: 1, b: 2 },
      {
        ownKeys: (t) => {
          lists++;
          return Reflect.ownKeys(t);
        },
        getOwnPropertyDescriptor: (t, k) => {
          reads.push(String(k));
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
        get: () => {
          throw new Error("get is not used");
        },
      },
    );
    const got = P.takeFields(p, ["a", "b"], "input");
    expect({ ...got }).toEqual({ a: 1, b: 2 });
    expect(lists).toBe(1);
    expect(reads).toEqual(["a", "b"]);
  });

  it("gives a fresh object with no prototype, which a later change of the input does not reach", () => {
    const input = { a: 1 };
    const got = P.takeFields(input, ["a"], "input");
    input.a = 2;
    expect(got.a).toBe(1);
    expect(Object.getPrototypeOf(got)).toBe(null);
  });

  it("ownKeys lists string keys, enumerable or not, and no symbol", () => {
    const o: Record<string | symbol, unknown> = { a: 1, [Symbol("s")]: 2 };
    Object.defineProperty(o, "h", { value: 3, enumerable: false });
    expect(P.ownKeys(o)).toEqual(["a", "h"]);
  });

  it("ownValue refuses a missing field and an accessor, and reads a value", () => {
    expect(refusal(() => P.ownValue({}, "a", "x"))).toEqual({ code: "BAD_INPUT", message: "x lacks the field a" });
    expect(refusal(() => P.ownValue({ get a() { return 1; } }, "a", "x"))).toEqual({ code: "BAD_INPUT", message: "x.a is an accessor, not a value" });
    expect(P.ownValue({ a: 5 }, "a", "x")).toBe(5);
  });
});

describe("uintOf", () => {
  it("u32: a whole number from 0 to 2^32 - 1", () => {
    expect(P.uintOf("u32", 0, "n")).toBe(0);
    expect(P.uintOf("u32", 2 ** 32 - 1, "n")).toBe(2 ** 32 - 1);
    for (const v of [1n, "1", 1.5, Number.NaN, Number.POSITIVE_INFINITY, null]) expect(refusal(() => P.uintOf("u32", v, "n"))).toEqual({ code: "BAD_INPUT", message: "n must be a whole number (u32)" });
    expect(refusal(() => P.uintOf("u32", -1, "n"))).toEqual({ code: "OUT_OF_RANGE", message: "n -1 is not a u32" });
    expect(refusal(() => P.uintOf("u32", 2 ** 32, "n"))).toEqual({ code: "OUT_OF_RANGE", message: "n 4294967296 is not a u32" });
  });

  for (const [kind, bits] of [["u64", 64], ["u128", 128]] as const) {
    it(`${kind}: a bigint from 0 to 2^${bits} - 1`, () => {
      const max = (1n << BigInt(bits)) - 1n;
      expect(P.uintOf(kind, 0n, "n")).toBe(0n);
      expect(P.uintOf(kind, max, "n")).toBe(max);
      for (const v of [1, "1", null]) expect(refusal(() => P.uintOf(kind, v, "n"))).toEqual({ code: "BAD_INPUT", message: `n must be a bigint (${kind})` });
      expect(refusal(() => P.uintOf(kind, -1n, "n"))).toEqual({ code: "OUT_OF_RANGE", message: `n -1 is not a ${kind}` });
      expect(refusal(() => P.uintOf(kind, max + 1n, "n"))).toEqual({ code: "OUT_OF_RANGE", message: `n ${max + 1n} is not a ${kind}` });
    });
  }

  it("refuses an integer kind it does not check", () => {
    expect(refusal(() => P.uintOf("u8" as never, 1, "n"))).toEqual({ code: "BAD_INPUT", message: "n has an integer kind this module does not check" });
  });
});

describe("M3: plain-input.ts imports nothing", () => {
  const scan = (t: string) => /(?:^|[^\w$.])import\b|\brequire\s*\(/m.test(t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""));

  it("the scan finds a static import, a type import, a dynamic import and a require (control)", () => {
    for (const s of ['import { a } from "./a.js";', 'import type { B } from "./b.js";', 'const m = await import("x");', 'const x = require("y");', 'export { a } from "./a.js";\nimport "z";']) expect(scan(s)).toBe(true);
    expect(scan("/* import x */ const a = 1; // import y")).toBe(false);
  });

  it("the file holds no import, and no re-export from another module", () => {
    const t = readFileSync(join(PKG, "src", "plain-input.ts"), "utf8");
    expect(scan(t)).toBe(false);
    expect(/\bexport\s[^;]*\bfrom\s*["'`]/.test(t)).toBe(false);
  });
});

describe("M4, M5: the encoder builds its checks from the shared module, with its own refuse", () => {
  const chainRefusal = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      if (e instanceof ChainEncodeError) return { refusal: e.refusal, message: e.message };
      throw e;
    }
    throw new Error("did not refuse");
  };

  it("an extra field is refused as the encoder's BAD_INPUT, with the one changed text", () => {
    expect(chainRefusal(() => chainTakeFields({ a: 1, b: 2 }, ["a"], "sla"))).toEqual({ refusal: "BAD_INPUT", message: "chain encoder refused (BAD_INPUT): sla has a field b that is not one of its fields" });
  });

  it("a wrong length is the encoder's WRONG_LENGTH, with its text", () => {
    expect(chainRefusal(() => chainBytesOf(new Uint8Array(3), 32, "owner"))).toEqual({ refusal: "WRONG_LENGTH", message: "chain encoder refused (WRONG_LENGTH): owner has 3 bytes, not 32" });
  });

  it("takeValue checks its three integer kinds through uintOf, with the encoder's codes and texts", () => {
    expect(chainRefusal(() => takeValue({ kind: "u32" } as never, 2 ** 32, "n"))).toEqual({ refusal: "OUT_OF_RANGE", message: "chain encoder refused (OUT_OF_RANGE): n 4294967296 is not a u32" });
    expect(chainRefusal(() => takeValue({ kind: "u64" } as never, 1, "n"))).toEqual({ refusal: "BAD_INPUT", message: "chain encoder refused (BAD_INPUT): n must be a bigint (u64)" });
    expect(chainRefusal(() => takeValue({ kind: "u128" } as never, 1n << 128n, "n"))).toEqual({ refusal: "OUT_OF_RANGE", message: `chain encoder refused (OUT_OF_RANGE): n ${1n << 128n} is not a u128` });
    expect(takeValue({ kind: "u64" } as never, 5n, "n")).toBe(5n);
  });

  it("fields.ts takes them from plain-input.ts and defines none of its own", () => {
    const t = readFileSync(join(PKG, "src", "chain", "fields.ts"), "utf8");
    expect(t).toContain('import { plainInput } from "../plain-input.js";');
    expect(t).toContain("plainInput(refuse)");
    for (const name of ["bytesOf", "takeFields", "ownKeys", "ownValue", "uintOf"]) expect(t).not.toMatch(new RegExp(`function ${name}\\b`));
    expect(t).not.toMatch(/getOwnPropertyDescriptor\(TYPED/);
  });
});
