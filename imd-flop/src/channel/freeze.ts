/**
 * Freezing a function or a class where it is defined, so that no importer can hang a property on it or change its
 * prototype, and a function handed out cannot be wrapped by editing it. This file imports nothing.
 */

/**
 * Freezes `f` and, when `f` has an own `prototype` that is an object, that object too. Returns `f`. It is applied to
 * itself below.
 */
export function freezeFunction<F extends Function>(f: F): F {
  const d = Object.getOwnPropertyDescriptor(f, "prototype");
  if (d !== undefined && "value" in d && typeof d.value === "object" && d.value !== null) Object.freeze(d.value);
  return Object.freeze(f);
}
freezeFunction(freezeFunction);
