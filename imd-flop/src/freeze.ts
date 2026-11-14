/**
 * Freezing where a thing is defined, shared by the encoder, the chain reads and the channel modules, so that no
 * importer can change a table, hang a property on a function or change a prototype at run time. A write to a frozen
 * object throws in a module. This file imports nothing.
 */

/**
 * Deep freezing, for every exported object and array at its definition. Byte arrays are left as they are: they
 * cannot be frozen.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const x of Object.values(value)) deepFreeze(x);
    Object.freeze(value);
  }
  return value;
}

/** Freezes the function that is the own value of `o` under `key`, and the get and set functions of an own accessor. */
function freezeMemberOf(o: object, key: PropertyKey): void {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined) return;
  if ("value" in d) {
    if (typeof d.value === "function") Object.freeze(d.value);
  } else {
    if (typeof d.get === "function") Object.freeze(d.get);
    if (typeof d.set === "function") Object.freeze(d.set);
  }
}

/**
 * Freezes `f`, and when `f` has an own `prototype` that is an object, that object too. Then it freezes the methods:
 * for each own property of `f` (text and symbol keys) and of its prototype, the value when it is a function, and the
 * get and set functions of an own accessor. One level, own properties only: it does not walk into what those
 * functions hold. Returns `f`. It is applied to itself and to deepFreeze below.
 */
export function freezeFunction<F extends Function>(f: F): F {
  const d = Object.getOwnPropertyDescriptor(f, "prototype");
  const proto = d !== undefined && "value" in d && typeof d.value === "object" && d.value !== null ? (d.value as object) : null;
  if (proto !== null) Object.freeze(proto);
  for (const key of Reflect.ownKeys(f)) freezeMemberOf(f, key);
  if (proto !== null) for (const key of Reflect.ownKeys(proto)) freezeMemberOf(proto, key);
  return Object.freeze(f);
}
freezeFunction(freezeFunction);
freezeFunction(deepFreeze);
