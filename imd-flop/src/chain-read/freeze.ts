/**
 * Deep freezing, for the frozen tables of chain-read at their definition, so nothing a read stands on can be
 * changed at run time. chain-read does not import src/chain (the encoder), so it holds its own. Pure.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const x of Object.values(value)) deepFreeze(x);
    Object.freeze(value);
  }
  return value;
}
