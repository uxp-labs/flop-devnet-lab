// Reading a data record by a key the code does not spell out (RULES.md section 4).
//
// src names every property it reads or writes in the code itself: no o[k] with a key that is not
// a string or number literal, so the source scan reads every name src can reach. A key that only
// exists at run time (an account, a parameter path, a kind from a list) goes through own(), which
// walks the record's own entries instead: an inherited member such as constructor or __proto__ is
// never reached, and a function is never handed back.

/**
 * The value of o's own enumerable property named k, or undefined when o has none. Throws when the
 * value is a function, which no data record holds.
 */
export function own<T>(o: Readonly<Record<string, T>>, k: string): T | undefined;
export function own(o: object, k: string): unknown;
export function own(o: object, k: string): unknown {
  for (const [key, v] of Object.entries(o)) {
    if (key !== k) continue;
    if (typeof v === "function") throw new TypeError(`own: ${JSON.stringify(k)} holds a function, not data`);
    return v;
  }
  return undefined;
}
