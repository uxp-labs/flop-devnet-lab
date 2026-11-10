/**
 * The TS loader for ../contract/rules.json and ../contract/vectors/*.json: test infrastructure for imd-flop's
 * contract test. The one Python loader is testlib/contract_vectors.py; both enforce the format in
 * contract/README.md. Loading throws on a malformed file, so a broken contract never runs as an empty suite.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface Vector { id: string; rule: string; input: Json; expect: Record<string, Json>; status?: string; defect?: string; target?: Record<string, Json>; quirks?: string[]; label_rules?: string[]; file: string }

export const PARTS = ["imd-flop", "spend-guard", "viewer"] as const;
export const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contract");

const FLOATS: Record<string, number> = { nan: NaN, inf: Infinity, "-inf": -Infinity };
/** {"$float": "nan"|"inf"|"-inf"} stands for a non-finite float, which JSON cannot hold. */
export const decode = (v: Json): Json => {
  if (Array.isArray(v)) return v.map(decode);
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$float") return FLOATS[v.$float];
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
};

export const isNotApplicable = (e: Json): boolean => e !== null && typeof e === "object" && "not_applicable" in e;
const isObject = (v: Json): boolean => v !== null && typeof v === "object" && !Array.isArray(v);

export const rules: Json = JSON.parse(readFileSync(join(CONTRACT, "rules.json"), "utf8"));

function load(): Vector[] {
  const quirkIds = new Set((rules.quirks as Json[]).map((q) => q.id));
  const defectIds = new Set((rules.known_defects as Json[]).map((d) => d.id));
  const labelRuleIds = new Set((rules.viewer_label_rules.rules as Json[]).map((r) => r.id));
  const seen = new Set<string>();
  const out: Vector[] = [];
  for (const f of readdirSync(join(CONTRACT, "vectors")).filter((n) => n.endsWith(".json")).sort()) {
    for (const v of JSON.parse(readFileSync(join(CONTRACT, "vectors", f), "utf8")).vectors as Vector[]) {
      const where = `${f}:${v.id}`;
      if (typeof v.id !== "string" || !v.id || seen.has(v.id)) throw new Error(`${f}: missing or duplicate id ${JSON.stringify(v.id)}`);
      seen.add(v.id);
      if (typeof v.rule !== "string" || !("input" in v)) throw new Error(`${where}: needs rule and input`);
      if (!isObject(v.expect) || Object.keys(v.expect).sort().join() !== [...PARTS].sort().join()) throw new Error(`${where}: expect must name exactly ${PARTS.join(", ")}`);
      for (const p of PARTS) {
        const e = v.expect[p];
        if (!isObject(e) || Object.keys(e).length === 0) throw new Error(`${where}: ${p} expectation must be a non-empty object`);
        if (isNotApplicable(e) && !(Object.keys(e).length === 1 && typeof e.not_applicable === "string" && e.not_applicable.length > 0)) throw new Error(`${where}: ${p} not_applicable must be the only key and give a reason`);
      }
      if ("status" in v) {
        if (v.status === "known_defect") {
          if (!defectIds.has(v.defect) || !isObject(v.target) || Object.keys(v.target!).length === 0) throw new Error(`${where}: status known_defect needs a known defect id and a target`);
        } else if (v.status === "fixed") {
          if (!defectIds.has(v.defect) || "target" in v) throw new Error(`${where}: status fixed needs a known defect id and no target (the target is now expect)`);
        } else throw new Error(`${where}: status must be known_defect or fixed`);
      }
      for (const q of v.quirks ?? []) if (!quirkIds.has(q)) throw new Error(`${where}: unknown quirk ${q}`);
      const lr = v.label_rules ?? [];
      if (!Array.isArray(lr) || lr.some((x) => !labelRuleIds.has(x))) throw new Error(`${where}: label_rules must list ids from rules.json viewer_label_rules`);
      out.push({ ...v, file: f });
    }
  }
  return out;
}

/** All vectors, schema-checked. */
export const vectors: Vector[] = load();

/** Quirk ids in rules.json that no vector pins. */
export const unreferencedQuirks = (): string[] => {
  const used = new Set(vectors.flatMap((v) => v.quirks ?? []));
  return (rules.quirks as Json[]).map((q) => q.id as string).filter((q) => !used.has(q)).sort();
};

/** FIXER viewer label rule ids in rules.json that no vector names in label_rules. */
export const unreferencedLabelRules = (): string[] => {
  const used = new Set(vectors.flatMap((v) => v.label_rules ?? []));
  return (rules.viewer_label_rules.rules as Json[]).map((r) => r.id as string).filter((r) => !used.has(r)).sort();
};

/** Vectors with an expectation for `part` (the rest carry a not_applicable reason, checked at load). */
export const forPart = (part: string): Vector[] => vectors.filter((v) => !isNotApplicable(v.expect[part]));
