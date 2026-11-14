/**
 * The walk of the frozen tests (piece A1, F2): what is open or extra in a function, its prototype and every object
 * reachable from an export. One walk for test/chain-frozen.test.ts, test/chain-read-frozen.test.ts and
 * test/channel-frozen.test.ts. Taken from the channel test of P4 review F4, unchanged.
 */

/** The own properties every function is born with. A class or a plain function also has its prototype. */
export const BORN = ["length", "name"];

/** True when `f` can be called with new: an arrow function or a method cannot. */
export function constructable(f: Function): boolean {
  try {
    Reflect.construct(String, [], f);
    return true;
  } catch {
    return false;
  }
}

/** What is open or extra in one function: itself, its prototype, and any own property it was not born with. */
export function problemsOf(f: Function, path: string): string[] {
  const out: string[] = [];
  if (!Object.isFrozen(f)) out.push(`${path} is not frozen`);
  const proto = Object.getOwnPropertyDescriptor(f, "prototype")?.value as unknown;
  if (typeof proto === "object" && proto !== null && !Object.isFrozen(proto)) out.push(`${path}.prototype is not frozen`);
  const allowed = constructable(f) ? [...BORN, "prototype"] : BORN;
  for (const name of Object.getOwnPropertyNames(f)) if (!allowed.includes(name)) out.push(`${path} has an own property ${name}`);
  for (const sym of Object.getOwnPropertySymbols(f)) out.push(`${path} has an own symbol ${String(sym)}`);
  return out;
}

/** Every function and object reachable by own enumerable properties from `value`, checked. A byte array cannot be frozen, so an exported one is found as open. */
export function problems(value: unknown, path: string, seen = new Set<unknown>()): string[] {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  if (typeof value === "function") out.push(...problemsOf(value, path));
  else {
    if (!Object.isFrozen(value)) out.push(`${path} is not frozen`);
    for (const [k, v] of Object.entries(value)) out.push(...problems(v, `${path}.${k}`, seen));
  }
  return out;
}
