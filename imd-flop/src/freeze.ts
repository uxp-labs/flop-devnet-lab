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

/**
 * Freezes `f` and, when `f` has an own `prototype` that is an object, that object too. Returns `f`. It is applied to
 * itself and to deepFreeze below.
 */
export function freezeFunction<F extends Function>(f: F): F {
  const d = Object.getOwnPropertyDescriptor(f, "prototype");
  if (d !== undefined && "value" in d && typeof d.value === "object" && d.value !== null) Object.freeze(d.value);
  return Object.freeze(f);
}
freezeFunction(freezeFunction);
freezeFunction(deepFreeze);
