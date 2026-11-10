// Spec drift: the canonical FLOP protocol parameters (flop-protocol-params.yaml) against the
// runtime constants read from chain metadata (api.consts). One item per check site.
//
// The deployment contract is the YAML file's header:
//   on_chain.constants names FRAME metadata constants (api.consts). Each one is its own item.
//   on_chain.storage names scalar storage (api.query). M0 reads no storage, so those items are unknown.
//   on_chain.source_only is a reason there is no RPC check: one unknown item that carries the reason.
//   FLOP amounts use meta.decimals. Here a FLOP amount is unit "FLOP" or on_chain.token_units true.
//   on_chain.multiplier and on_chain.divisor then apply (Perbill parts, days to blocks, per byte).
//
// Rules:
//   unknown when the runtime value is missing, null, or not readable exactly (hex, fractions,
//   numbers past 2^53), when the spec value is not a number, or when scaling leaves a fraction.
//   match or mismatch only from exact integer arithmetic (BigInt). Never match by default.
//
// Runtime constants are looked up by their api.consts key (validators.initialMinimumStake) and by
// their metadata spelling (Validators.InitialMinimumStake). Both present and different is unknown.
//
// The YAML is parsed as YAML 1.1, the dialect of PyYAML that upstream uses. Under YAML 1.2 rules
// a value written 63_072_000 is the string "63_072_000", not a number.
import { parse } from "yaml";
import type { DriftItem, DriftReport, RuntimeConstants, Trust } from "./types.js";

/** Thrown when the spec itself is unusable. A report with no items would look like no drift. */
export class DriftSpecError extends Error {
  constructor(reason: string) {
    super(`drift spec unusable: ${reason}`);
    this.name = "DriftSpecError";
  }
}

export interface DriftOptions {
  /** Snapshot time (ISO 8601). */
  observedAt: string;
  trust: Trust;
  /** Where the spec came from, e.g. a path plus upstream commit. */
  specSource: string;
  /** Genesis and finalized height of the chain the constants were read from, when known. */
  genesis?: string | null;
  finalizedHeight?: number | null;
}

/** The spec after parsing: meta.decimals and every parameters and reference entry, in order. */
export interface ParsedSpec {
  decimals: bigint | null;
  entries: unknown[];
}

type Rational = { num: bigint; den: bigint };
type Outcome = { ok: true; value: bigint } | { ok: false; why: string };
type Base = Pick<DriftItem, "param" | "spec" | "unit">;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Integer from the parsed YAML (bigint) or from JSON (a safe integer), else null. */
function exactInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  return null;
}

/** Parses the params YAML with YAML 1.1 rules and integers as BigInt, so nothing rounds. */
export function parseSpec(text: string): ParsedSpec {
  let doc: unknown;
  try {
    doc = parse(text, { version: "1.1", intAsBigInt: true });
  } catch (e) {
    throw new DriftSpecError(`the YAML does not parse: ${(e as Error).message}`);
  }
  if (!isObject(doc)) throw new DriftSpecError("the YAML is not a mapping");
  const entries: unknown[] = [];
  for (const section of ["parameters", "reference"] as const) {
    const list = doc[section];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) throw new DriftSpecError(`${section} is not a list`);
    entries.push(...list);
  }
  if (entries.length === 0) throw new DriftSpecError("no parameters or reference entries");
  const decimals = isObject(doc.meta) ? exactInt(doc.meta.decimals) : null;
  return { decimals: decimals !== null && decimals >= 0n ? decimals : null, entries };
}

/** A spec value as an exact fraction. Floats go through their shortest decimal form (0.05 is 5/100). */
function toRational(v: unknown): Rational | null {
  const whole = exactInt(v);
  if (whole !== null) return { num: whole, den: 1n };
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(v));
  if (m === null) return null;
  const digits = BigInt(`${m[2]}${m[3] ?? ""}`);
  const exp = Number(m[4] ?? "0") - (m[3] ?? "").length;
  const signed = m[1] === "-" ? -digits : digits;
  return exp >= 0 ? { num: signed * 10n ** BigInt(exp), den: 1n } : { num: signed, den: 10n ** BigInt(-exp) };
}

/** multiplier and divisor: absent means 1, otherwise a positive integer, else null. */
function factor(v: unknown): bigint | null {
  if (v === undefined) return 1n;
  const n = exactInt(v);
  return n !== null && n > 0n ? n : null;
}

/** The runtime value the spec asks for, in base units. */
function expectedValue(entry: Record<string, unknown>, onChain: Record<string, unknown>, decimals: bigint | null): Outcome {
  const value = toRational(entry.value);
  if (value === null) return { ok: false, why: `the spec value ${describe(entry.value)} is not a number` };
  const flopAmount = entry.unit === "FLOP" || onChain.token_units === true;
  if (flopAmount && decimals === null) return { ok: false, why: "a FLOP amount, but meta.decimals is missing or invalid" };
  const scale = flopAmount && decimals !== null ? 10n ** decimals : 1n;
  const multiplier = factor(onChain.multiplier);
  if (multiplier === null) return { ok: false, why: "on_chain.multiplier is not a positive integer" };
  const divisor = factor(onChain.divisor);
  if (divisor === null) return { ok: false, why: "on_chain.divisor is not a positive integer" };
  const num = value.num * scale * multiplier;
  const den = value.den * divisor;
  if (num % den !== 0n) {
    return { ok: false, why: "the expected value is not a whole number of base units, and the spec does not say how it rounds" };
  }
  return { ok: true, value: num / den };
}

/** A runtime value, read only when its exact integer value is certain. */
function runtimeValue(v: unknown): Outcome {
  if (typeof v === "bigint") return { ok: true, value: v };
  if (typeof v === "number") {
    if (Number.isSafeInteger(v)) return { ok: true, value: BigInt(v) };
    if (Number.isInteger(v)) return { ok: false, why: "the runtime value is a number past 2^53, so its exact value is lost" };
    return { ok: false, why: "the runtime value is not an integer" };
  }
  if (typeof v === "string") {
    if (/^-?[0-9]+$/.test(v)) return { ok: true, value: BigInt(v) };
    if (/^0x[0-9a-fA-F]*$/.test(v)) {
      return { ok: false, why: "the runtime value is hex, which is ambiguous (SCALE bytes are little endian); read it as a decimal string" };
    }
    return { ok: false, why: "the runtime value is a string that is not a decimal integer" };
  }
  return { ok: false, why: `the runtime value is ${v === null ? "null" : Array.isArray(v) ? "a list" : typeof v}` };
}

/** For JSON output: BigInt becomes a number when safe, otherwise a decimal string. */
function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  if (v === undefined) return null;
  return v;
}

function describe(v: unknown): string {
  if (v === undefined) return "(missing)";
  const s = JSON.stringify(jsonSafe(v)) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
}

/** "Validators.InitialMinimumStake" to its parts, or null when it is not Pallet.Item. */
function sitePath(v: unknown): { pallet: string; item: string } | null {
  if (typeof v !== "string") return null;
  const m = /^(\w+)\.(\w+)$/.exec(v);
  return m === null ? null : { pallet: m[1]!, item: m[2]! };
}

/** api.consts and api.query use the metadata names with the first letter lowered. */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

type Lookup = { found: true; raw: unknown } | { found: false; why: string };

function lookUp(values: Record<string, unknown>, pallet: string, item: string): Lookup {
  const keys = [...new Set([`${lowerFirst(pallet)}.${lowerFirst(item)}`, `${pallet}.${item}`])].filter((k) =>
    Object.hasOwn(values, k),
  );
  if (keys.length === 0) return { found: false, why: "the runtime value is missing" };
  const [a, b] = keys.map((k) => values[k]);
  if (keys.length === 2) {
    const ra = runtimeValue(a);
    const rb = runtimeValue(b);
    const same = ra.ok && rb.ok ? ra.value === rb.value : JSON.stringify(jsonSafe(a)) === JSON.stringify(jsonSafe(b));
    if (!same) return { found: false, why: `two key spellings hold different runtime values (${keys.join(", ")})` };
  }
  return { found: true, raw: a };
}

function item(base: Base, fields: Omit<DriftItem, "param" | "spec" | "unit">): DriftItem {
  return { ...base, ...fields };
}

function sourceOnlyItem(base: Base, reason: string): DriftItem {
  return item(base, { runtime_path: null, mapping: "source_only", runtime: null, expected: null, status: "unknown", note: `source only: ${reason}` });
}

function constantItem(
  base: Base,
  path: unknown,
  expected: Outcome,
  values: Record<string, unknown> | null,
): DriftItem {
  const site = sitePath(path);
  const exp = expected.ok ? expected.value.toString() : null;
  if (site === null) {
    return item(base, { runtime_path: null, mapping: "constant", runtime: null, expected: exp, status: "unknown", note: `constant ${describe(path)} is not Pallet.Item` });
  }
  const runtime_path = `api.consts.${lowerFirst(site.pallet)}.${lowerFirst(site.item)}`;
  const unknown = (runtime: unknown, note: string): DriftItem =>
    item(base, { runtime_path, mapping: "constant", runtime, expected: exp, status: "unknown", note });
  if (values === null) return unknown(null, "no runtime constants were read");
  const hit = lookUp(values, site.pallet, site.item);
  if (!hit.found) return unknown(null, hit.why);
  const runtime = jsonSafe(hit.raw);
  const actual = runtimeValue(hit.raw);
  if (!actual.ok) return unknown(runtime, actual.why);
  if (!expected.ok) return unknown(runtime, expected.why);
  const same = actual.value === expected.value;
  return item(base, {
    runtime_path,
    mapping: "constant",
    runtime,
    expected: exp,
    status: same ? "match" : "mismatch",
    note: same ? null : `runtime holds ${actual.value}, the spec asks for ${expected.value}`,
  });
}

function storageItem(base: Base, path: unknown): DriftItem {
  const site = sitePath(path);
  return item(base, {
    runtime_path: site === null ? null : `api.query.${lowerFirst(site.pallet)}.${lowerFirst(site.item)}`,
    mapping: "storage",
    runtime: null,
    expected: null,
    status: "unknown",
    note: "storage is read through api.query, and M0 drift reads api.consts only",
  });
}

function itemsFor(entry: unknown, n: number, decimals: bigint | null, values: Record<string, unknown> | null): DriftItem[] {
  if (!isObject(entry)) {
    return [item({ param: `(entry ${n})`, spec: null, unit: null }, { runtime_path: null, mapping: "none", runtime: null, expected: null, status: "unknown", note: "the spec entry is not a mapping" })];
  }
  const base: Base = {
    param: typeof entry.name === "string" ? entry.name : `(entry ${n})`,
    spec: jsonSafe(entry.value),
    unit: typeof entry.unit === "string" ? entry.unit : null,
  };
  const none = (note: string): DriftItem[] => [
    item(base, { runtime_path: null, mapping: "none", runtime: null, expected: null, status: "unknown", note }),
  ];
  const onChain = entry.on_chain;
  if (!isObject(onChain)) return none("no on_chain mapping in the spec");
  const { constants = [], storage = [], source_only } = onChain;
  if (!Array.isArray(constants) || !Array.isArray(storage)) return none("on_chain.constants and on_chain.storage must be lists");
  if (source_only !== undefined) {
    if (constants.length > 0 || storage.length > 0) return none("the spec gives both source_only and on-chain mappings");
    if (typeof source_only !== "string" || source_only.trim() === "") return none("source_only gives no reason");
    return [sourceOnlyItem(base, source_only.trim())];
  }
  if (constants.length === 0 && storage.length === 0) return none("on_chain lists no constants, no storage and no source_only reason");
  const expected = expectedValue(entry, onChain, decimals);
  return [...constants.map((c) => constantItem(base, c, expected, values)), ...storage.map((s) => storageItem(base, s))];
}

/** Compares the spec with the runtime constants. spec is the YAML text or parseSpec's result. */
export function drift(spec: string | ParsedSpec, runtime: RuntimeConstants | null, opts: DriftOptions): DriftReport {
  const parsed = typeof spec === "string" ? parseSpec(spec) : spec;
  const values = runtime !== null && isObject(runtime.values) ? runtime.values : null;
  const items = parsed.entries.flatMap((e, n) => itemsFor(e, n, parsed.decimals, values));
  const count = (s: DriftItem["status"]) => items.filter((i) => i.status === s).length;
  const version = runtime?.runtime_spec_version;
  const readAt = runtime?.observed_at;
  return {
    schema: "flop-observatory/drift@0",
    observed_at: opts.observedAt,
    trust: opts.trust,
    genesis: opts.genesis ?? null,
    finalized_height: opts.finalizedHeight ?? null,
    runtime_version: typeof version === "number" && Number.isInteger(version) ? version : null,
    spec_source: opts.specSource,
    runtime_observed_at: typeof readAt === "string" ? readAt : null,
    items,
    matches: count("match"),
    mismatches: count("mismatch"),
    unknown: count("unknown"),
  };
}
