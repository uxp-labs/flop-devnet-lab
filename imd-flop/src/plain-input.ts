/**
 * Reading a caller's value once into plain data, shared by the modules that take named fields from a caller: the
 * chain encoder and the channel modules. A byte value is a Uint8Array copied by its internal state; an object is
 * read field by field, each field once, through its own property descriptor; a u32 is a whole number in range; a
 * u64 or a u128 is a bigint in range.
 *
 * The module refuses through the function it is handed, so each user keeps its own refusal codes and its own error
 * class. It imports nothing.
 */

/** The codes this module refuses with. Each user maps them onto its own refusal of the same name. */
export type PlainInputCode = "BAD_INPUT" | "WRONG_LENGTH" | "OUT_OF_RANGE";
/** How a user refuses: it throws and never returns. If it does return, the module throws its own TypeError (naming the code only) and hands nothing back. */
export type PlainInputRefuse = (code: PlainInputCode, message: string) => never;
/** The integer kinds uintOf checks. */
export type UintKind = "u32" | "u64" | "u128";

/** The checks, bound to one user's refuse. */
export interface PlainInput {
  /**
   * A fresh copy of the bytes of `value`, which must be a Uint8Array (a Node buffer is one) of exactly `n` bytes
   * (any length when `n` is null) by its own internal state. Anything else is refused: another width, an array, a string.
   */
  readonly bytesOf: (value: unknown, n: number | null, what: string) => Uint8Array;
  /**
   * Reads the fields `names` of a caller's object, each exactly once, into a fresh plain object. The object's own
   * keys are listed once; a key it has beyond `names`, or a name it lacks, is refused, and so is a field that is an accessor.
   */
  readonly takeFields: (value: unknown, names: readonly string[], what: string) => Record<string, unknown>;
  /** The own string keys of an object, listed once, enumerable or not. Symbol keys are not fields. */
  readonly ownKeys: (value: object) => string[];
  /**
   * The value an object holds under `name`, read once through its own property descriptor. A field that is an
   * accessor is refused: it computes a value on each read instead of holding one, so no snapshot of it could be
   * the value later reads would see.
   */
  readonly ownValue: (value: object, name: string, what: string) => unknown;
  /** A u32 is a whole number in range; a u64 or a u128 is a bigint in range. Anything else is refused. */
  readonly uintOf: {
    (kind: "u32", value: unknown, what: string): number;
    (kind: "u64" | "u128", value: unknown, what: string): bigint;
    (kind: UintKind, value: unknown, what: string): number | bigint;
  };
}

const WIDTH = Object.freeze({ u32: 4, u64: 8, u128: 16 } as const);

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

/** The checks of this module, refusing through `refuse`. The object returned is frozen. */
export function plainInput(refuse: PlainInputRefuse): PlainInput {
  /** Refuses through the user's function. If that function returns, the check throws its own error: nothing is handed back. */
  function fail(code: PlainInputCode, message: string): never {
    refuse(code, message);
    throw new TypeError("plain-input: the refuse function returned after " + code);
  }

  function bytesOf(value: unknown, n: number | null, what: string): Uint8Array {
    const kind = ArrayBuffer.isView(value) ? KIND.call(value) : undefined;
    if (kind !== "Uint8Array") fail("BAD_INPUT", `${what} must be a Uint8Array${n === null ? "" : ` of ${n} bytes`}`);
    const length = LENGTH.call(value) as number;
    if (n !== null && length !== n) fail("WRONG_LENGTH", `${what} has ${length} bytes, not ${n}`);
    const view = new Uint8Array(BUFFER.call(value) as ArrayBuffer, OFFSET.call(value) as number, length);
    const copy = new Uint8Array(length);
    copy.set(view);
    return copy;
  }

  function takeFields(value: unknown, names: readonly string[], what: string): Record<string, unknown> {
    if (!isObject(value)) fail("BAD_INPUT", `${what} must be an object`);
    const keys = ownKeys(value);
    const want = new Set(names);
    for (const k of keys) if (!want.has(k)) fail("BAD_INPUT", `${what} has a field ${k} that is not one of its fields`);
    const have = new Set(keys);
    for (const n of names) if (!have.has(n)) fail("BAD_INPUT", `${what} lacks the field ${n}`);
    const out: Record<string, unknown> = Object.create(null);
    for (const n of names) out[n] = ownValue(value, n, what);
    return out;
  }

  function ownKeys(value: object): string[] {
    return Reflect.ownKeys(value).filter((k): k is string => typeof k === "string");
  }

  function ownValue(value: object, name: string, what: string): unknown {
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (d === undefined) fail("BAD_INPUT", `${what} lacks the field ${name}`);
    if (!("value" in d)) fail("BAD_INPUT", `${what}.${name} is an accessor, not a value`);
    return d.value;
  }

  function uintOf(kind: "u32", value: unknown, what: string): number;
  function uintOf(kind: "u64" | "u128", value: unknown, what: string): bigint;
  function uintOf(kind: UintKind, value: unknown, what: string): number | bigint;
  function uintOf(kind: UintKind, value: unknown, what: string): number | bigint {
    switch (kind) {
      case "u32":
        if (typeof value !== "number" || !Number.isInteger(value)) fail("BAD_INPUT", `${what} must be a whole number (u32)`);
        if (value < 0 || value > 2 ** 32 - 1) fail("OUT_OF_RANGE", `${what} ${value} is not a u32`);
        return value;
      case "u64":
      case "u128":
        if (typeof value !== "bigint") fail("BAD_INPUT", `${what} must be a bigint (${kind})`);
        if (value < 0n || value >= 1n << BigInt(8 * WIDTH[kind])) fail("OUT_OF_RANGE", `${what} ${value} is not a ${kind}`);
        return value;
      default:
        return fail("BAD_INPUT", `${what} has an integer kind this module does not check`);
    }
  }

  return Object.freeze({ bytesOf, takeFields, ownKeys, ownValue, uintOf });
}
