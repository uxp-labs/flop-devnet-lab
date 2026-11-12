/**
 * Deep freezing, for every exported object and array of src/chain at its definition (rule H7). A write to a
 * frozen object throws in a module, so nothing the encoder stands on can be changed at run time.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const x of Object.values(value)) deepFreeze(x);
    Object.freeze(value);
  }
  return value;
}
