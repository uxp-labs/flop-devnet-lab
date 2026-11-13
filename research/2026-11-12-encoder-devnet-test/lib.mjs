// The shared part of plan.mjs, sign-device.mjs and check.mjs: reads steps.json and the files it
// names, and resolves each $NAME. No network, no key.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { substitute as rerunSubstitute } from "../2026-11-12-session-rerun-1014020/rerun-lib.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const RERUN = resolve(HERE, "..", "2026-11-12-session-rerun-1014020");
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const loadPlan = (dir = HERE) => readJson(join(dir, "steps.json"));
export const RAW = /^(0|[1-9][0-9]*)$/;
export const HASH = /^0x[0-9a-f]{64}$/;

/** The parts of a path like steps[5].events[1].fields.to or keys["System.Events"]. */
export function pathParts(path) {
  const parts = [];
  const re = /\["([^"]+)"\]|\[(\d+)\]|\.?([^.[\]]+)/g;
  let m;
  while ((m = re.exec(path)) !== null) parts.push(m[1] ?? m[2] ?? m[3]);
  return parts;
}

/** The value at a path of a JSON value, or an error naming the path. */
export function atPath(obj, path) {
  let v = obj;
  for (const part of pathParts(path)) {
    if (v === null || typeof v !== "object" || !(part in v)) throw new Error(`no ${path}`);
    v = v[part];
  }
  return v;
}

/** The value a values entry names in its source file: the field, or the regex group in it. Arrays are joined with commas. */
export function fromSource(plan, from, repo = REPO) {
  let v = atPath(readJson(join(repo, plan.files[from.file])), from.path);
  if (Array.isArray(v)) v = v.join(",");
  v = String(v);
  if (from.re) {
    const m = new RegExp(from.re).exec(v);
    if (!m) throw new Error(`${from.file} ${from.path} does not match ${from.re}`);
    v = m[1];
  }
  return v;
}

/** A computed value from the values it names: only whole division, as steps.json uses. */
export function computed(plan, spec) {
  if (spec.div) {
    const [a, b] = spec.div;
    const n = BigInt(plan.values[a].value), d = BigInt(b);
    if (n % d !== 0n) throw new Error(`${a} / ${b} is not whole`);
    return (n / d).toString();
  }
  throw new Error(`unknown computation ${JSON.stringify(spec)}`);
}

/**
 * Replaces each $NAME in a text: DEVICE from the recorded accounts, the rest as the rerun's
 * library does (a value of steps.json, or step.Pallet.Event.field from the recorded events).
 * An unknown name is left as it is unless strict is set.
 */
export function substitute(text, plan, results, strict = false) {
  const device = results?.accounts?.device?.public_key;
  const withDevice = String(text).replace(/\$DEVICE\b/g, (w) => (device ? device : w));
  if (strict && /\$DEVICE\b/.test(withDevice)) throw new Error("$DEVICE is not known");
  return rerunSubstitute(withDevice, plan, results, strict);
}

export const isUnresolved = (t) => /\$[A-Z]/.test(String(t));

/** The fee the rerun recorded for a step of its own, as a raw string, or null for none. */
export function rerunFee(id, rerunResults = readJson(join(RERUN, "results.json"))) {
  if (id === null) return null;
  const s = rerunResults.steps.find((x) => x.step === id);
  if (!s) throw new Error(`the rerun has no step ${id}`);
  return s.fee_raw;
}

export const stepOf = (plan, id) => {
  const s = plan.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const FLOP = 10n ** 18n;
/** A raw amount as FLOP text. */
export const flopText = (raw) => {
  const r = BigInt(raw);
  const f = (r % FLOP).toString().padStart(18, "0").replace(/0+$/, "");
  return `${r / FLOP}${f ? "." + f : ""}`;
};
