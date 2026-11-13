#!/usr/bin/env node
// What differs between two reviewed shape files (shapes/*.json, flop-observatory/decoder-shape@3),
// for everything the shapes state: the index and storage prefix of System, ComputeChannel,
// FlopSessionKeys, ModelRegistry, MinerStaking and HwCalibration, their 16 stated storage entries
// (modifier, hashers, key type, value type, default bytes), the ComputeChannel events, the fields of a channel and its states, the fields of
// an event record and of LastRuntimeUpgrade, and the System.Version type. The types of an entry are
// followed down to where they differ, so a change in System.Events names the pallet and the event of
// the outer event enum it is in. The stated lists (the fields of a channel and its states, the event
// record and the fields of LastRuntimeUpgrade) are compared too, after the entries' value types.
//
//   node scripts/shape-diff.mjs <old shape file> <new shape file>
//
// Type ids are renumbered between runtimes, so a type is compared by what it is, never by its name:
// its kind, its path, and the structure of every type it holds, followed to the end. A change of
// ids alone is not a difference. Each pair of types is followed once, so a type that refers to
// itself ends, and a change in it is printed once, where it is first met.
//
// Before it compares, it reads each file: one that does not exist, is not JSON, whose schema is not
// exactly flop-observatory/decoder-shape@3, that lacks a part the diff reads or holds a part it does
// not read is refused with one line on stderr and exit code 2. Exit code 0 means the comparison
// ran, whether or not something differs: the diff is a report, and the test that holds the committed
// diff to a fresh run is the check. The first line names both specs; then one line per difference,
// sorted, plain text, and for a stated pallet with no difference one line that says so.
// shapes/diff-tzkv-runtime-1014014-1014020.txt is its output for the two reviewed runtimes, held to
// a fresh run by test/upgrade-shape.test.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The one shape format this diff reads, as src/scale/shape.ts writes it. */
export const SHAPE_SCHEMA = "flop-observatory/decoder-shape@3";

/** A shape file the diff will not read, and why: the command prints it on one line and exits 2. */
export class ShapeRefused extends Error {}

/** A type name without the ids it carries, for a reader: H256#13 is H256. */
const plainName = (name) => String(name).replace(/#\d+/g, "");

/**
 * The structural form of every type of one shape's table, by name, as a sha256 of its structure. A
 * type met again on the way down is written by how many steps up it is. A form is kept for later
 * asks only when the walk below it met no type again, since only then is it the same from every
 * place, so the answer for a type never depends on the order types are asked.
 */
export function structure(types) {
  const memo = new Map();
  /** The form of a type at this place, and the highest place on the stack any of its back steps reaches. */
  const visit = (name, stack) => {
    if (memo.has(name)) return { h: memo.get(name), low: Infinity };
    const t = types[name];
    if (t === undefined) return { h: `unknown ${plainName(name)}`, low: Infinity };
    const at = stack.indexOf(name);
    if (at >= 0) return { h: `recursive ${stack.length - at}`, low: at };
    const next = [...stack, name];
    let low = Infinity;
    const of = (n) => {
      const r = visit(n, next);
      if (r.low < low) low = r.low;
      return r.h;
    };
    const fields = (fs) => fs.map((f) => `${f.name ?? ""}:${of(f.type)}`).join(",");
    let text;
    if (t.kind === "primitive") text = `primitive ${t.primitive}`;
    else if (t.kind === "composite") text = `composite ${t.path.join("::")} {${fields(t.fields)}}`;
    else if (t.kind === "variant") text = `variant ${t.path.join("::")} <${t.variants.map((v) => `${v.index} ${v.name}(${fields(v.fields)})`).join(";")}>`;
    else if (t.kind === "sequence") text = `sequence ${of(t.element)}`;
    else if (t.kind === "array") text = `array ${t.len} ${of(t.element)}`;
    else if (t.kind === "tuple") text = `tuple (${t.types.map(of).join(",")})`;
    else if (t.kind === "compact") text = `compact ${of(t.type)}`;
    else text = `kind ${t.kind}`;
    const h = createHash("sha256").update(text).digest("hex");
    // Cyclic: a back step was taken somewhere below, so the form depends on where the walk entered
    // the cycle. Only a form with no back step is the same from every place, and only it is kept.
    const cyclic = low !== Infinity;
    if (!cyclic) memo.set(name, h);
    return { h, low };
  };
  return (name) => visit(name, []).h;
}

/** The parts of a shape the diff reads, by place: a part outside these is refused, so none is missed. */
export const HANDLED = {
  top: ["compute_channel", "flop_session_keys", "hw_calibration", "miner_staking", "model_registry", "schema", "spec_name", "spec_version", "system", "types"],
  system: ["account", "events", "index", "last_runtime_upgrade", "storage_prefix", "version"],
  compute_channel: ["channel_authored_opened_at", "channel_states", "channels", "events", "failed_acks", "index", "storage_prefix"],
  flop_session_keys: ["circuit_breakers", "delegate_sessions", "index", "session_nonces", "sessions", "storage_prefix"],
  model_registry: ["allowed_decode_policies", "index", "measured_roots", "models", "storage_prefix"],
  miner_staking: ["index", "miners", "storage_prefix"],
  hw_calibration: ["calibration_versions", "index", "last_initial_calibration", "storage_prefix"],
  entry: ["default", "hashers", "key", "modifier", "value"],
};
const LISTS = { "system.events": "record", "system.last_runtime_upgrade": "fields", "compute_channel.channels": "fields" };

const PALLETS = [
  ["system", "System"],
  ["compute_channel", "ComputeChannel"],
  ["flop_session_keys", "FlopSessionKeys"],
  ["model_registry", "ModelRegistry"],
  ["miner_staking", "MinerStaking"],
  ["hw_calibration", "HwCalibration"],
];
const ENTRIES = [
  ["system", "events", "System.Events"],
  ["system", "last_runtime_upgrade", "System.LastRuntimeUpgrade"],
  ["system", "account", "System.Account"],
  ["compute_channel", "channels", "ComputeChannel.Channels"],
  ["compute_channel", "failed_acks", "ComputeChannel.FailedAcks"],
  ["compute_channel", "channel_authored_opened_at", "ComputeChannel.ChannelAuthoredOpenedAt"],
  ["flop_session_keys", "sessions", "FlopSessionKeys.Sessions"],
  ["flop_session_keys", "session_nonces", "FlopSessionKeys.SessionNonces"],
  ["flop_session_keys", "circuit_breakers", "FlopSessionKeys.CircuitBreakers"],
  ["flop_session_keys", "delegate_sessions", "FlopSessionKeys.DelegateSessions"],
  ["model_registry", "models", "ModelRegistry.Models"],
  ["model_registry", "measured_roots", "ModelRegistry.MeasuredRoots"],
  ["model_registry", "allowed_decode_policies", "ModelRegistry.AllowedDecodePolicies"],
  ["miner_staking", "miners", "MinerStaking.Miners"],
  ["hw_calibration", "calibration_versions", "HwCalibration.CalibrationVersions"],
  ["hw_calibration", "last_initial_calibration", "HwCalibration.LastInitialCalibration"],
];

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isFieldList = (v) => Array.isArray(v) && v.every((f) => isRecord(f) && (f.name === null || typeof f.name === "string") && typeof f.type === "string");
const isVariantList = (v) => Array.isArray(v) && v.every((x) => isRecord(x) && Number.isInteger(x.index) && typeof x.name === "string" && isFieldList(x.fields));

/** The shape, checked to hold exactly the parts the diff reads, each of the form it reads. Throws ShapeRefused, naming the file. */
export function checkShape(s, name) {
  const refuse = (why) => {
    throw new ShapeRefused(`${name}: ${why}`);
  };
  const exactly = (o, keys, where) => {
    if (!isRecord(o)) refuse(`${where} is not an object`);
    const have = Object.keys(o).sort();
    const missing = keys.filter((k) => !have.includes(k));
    const extra = have.filter((k) => !keys.includes(k));
    if (missing.length > 0) refuse(`${where} lacks ${missing.join(", ")}`);
    if (extra.length > 0) refuse(`${where} holds ${extra.join(", ")}, which the diff does not read`);
  };
  if (!isRecord(s)) refuse("the shape is not an object");
  if (s.schema !== SHAPE_SCHEMA) refuse(`the schema is ${JSON.stringify(s.schema)}, not ${SHAPE_SCHEMA}`);
  exactly(s, HANDLED.top, "the shape");
  if (typeof s.spec_name !== "string" || !Number.isInteger(s.spec_version)) refuse("spec_name and spec_version are not a string and an integer");
  if (!isRecord(s.types)) refuse("types is not an object");
  for (const [k, pallet] of PALLETS) {
    exactly(s[k], HANDLED[k], pallet);
    if (!Number.isInteger(s[k].index) || typeof s[k].storage_prefix !== "string") refuse(`${pallet} has no integer index and string storage prefix`);
  }
  for (const [p, e, label] of ENTRIES) {
    const list = LISTS[`${p}.${e}`];
    exactly(s[p][e], list === undefined ? HANDLED.entry : [...HANDLED.entry, list].sort(), label);
    const x = s[p][e];
    if (typeof x.modifier !== "string" || !Array.isArray(x.hashers) || typeof x.default !== "string" || typeof x.value !== "string" || (x.key !== null && typeof x.key !== "string")) refuse(`${label} is not an entry of the form the diff reads`);
    if (list !== undefined && !isFieldList(x[list])) refuse(`${label} ${list} is not a list of fields`);
  }
  if (!isVariantList(s.compute_channel.events)) refuse("ComputeChannel events is not a list of variants");
  if (!isVariantList(s.compute_channel.channel_states)) refuse("ComputeChannel channel_states is not a list of variants");
  if (typeof s.system.version !== "string") refuse("System version is not a type name");
  return s;
}

/** A shape file's text read and checked. Throws ShapeRefused, naming the file. */
export function readShape(text, name) {
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    throw new ShapeRefused(`${name}: not JSON`);
  }
  return checkShape(s, name);
}

/** The lines that say what differs from shape a to shape b: the specs, then each difference, sorted. Pure. */
export function shapeDiff(a, b) {
  checkShape(a, "the old shape");
  checkShape(b, "the new shape");
  const sa = structure(a.types);
  const sb = structure(b.types);
  const out = new Set();
  const seen = new Set();
  const fieldList = (fs) => fs.map((f) => `${f.name ?? "_"}: ${plainName(f.type)}`).join(", ");
  /** The differences between two lists of fields, compared by name and position, then type by type. */
  const fieldsDiff = (fa, fb, label) => {
    const na = fa.map((f) => f.name ?? "_").join(", ");
    const nb = fb.map((f) => f.name ?? "_").join(", ");
    if (na !== nb) {
      out.add(`${label}: fields were (${fieldList(fa)}), now (${fieldList(fb)})`);
      return;
    }
    // A lone unnamed field (a pallet's events inside the outer event enum) adds nothing to the label.
    fa.forEach((f, i) => typeDiff(f.type, fb[i].type, f.name !== null ? `${label}.${f.name}` : fa.length === 1 ? label : `${label}.${i}`));
  };
  const variantsDiff = (va, vb, label, what) => {
    const byName = (vs) => new Map(vs.map((v) => [v.name, v]));
    const ma = byName(va);
    const mb = byName(vb);
    for (const [n, v] of ma) if (!mb.has(n)) out.add(`${label}: ${what} ${n} removed, was at index ${v.index} (${fieldList(v.fields)})`);
    for (const [n, v] of mb) if (!ma.has(n)) out.add(`${label}: ${what} ${n} added at index ${v.index} (${fieldList(v.fields)})`);
    for (const [n, x] of ma) {
      const y = mb.get(n);
      if (y === undefined) continue;
      if (x.index !== y.index) out.add(`${label}: ${what} ${n} moved from index ${x.index} to index ${y.index}`);
      fieldsDiff(x.fields, y.fields, `${label} ${what} ${n}`);
    }
  };
  /** The differences between two types, by structure, followed to where they are, each pair of types once. */
  const typeDiff = (x, y, label) => {
    if (sa(x) === sb(y)) return;
    const key = JSON.stringify([x, y]);
    if (seen.has(key)) return;
    seen.add(key);
    const ta = a.types[x];
    const tb = b.types[y];
    if (ta === undefined || tb === undefined || ta.kind !== tb.kind || ta.path.join("::") !== tb.path.join("::")) {
      out.add(`${label}: type was ${plainName(x)}, now ${plainName(y)}`);
      return;
    }
    if (ta.kind === "composite") fieldsDiff(ta.fields, tb.fields, label);
    else if (ta.kind === "variant") variantsDiff(ta.variants, tb.variants, label, "variant");
    else if (ta.kind === "sequence") typeDiff(ta.element, tb.element, `${label} each`);
    else if (ta.kind === "compact") typeDiff(ta.type, tb.type, `${label} inner`);
    else if (ta.kind === "array") {
      if (ta.len !== tb.len) out.add(`${label}: length was ${ta.len}, now ${tb.len}`);
      else typeDiff(ta.element, tb.element, `${label} element`);
    } else if (ta.kind === "tuple") {
      if (ta.types.length !== tb.types.length) out.add(`${label}: type was ${plainName(x)}, now ${plainName(y)}`);
      else ta.types.forEach((t, i) => typeDiff(t, tb.types[i], `${label}.${i}`));
    } else out.add(`${label}: type was ${plainName(x)}, now ${plainName(y)}`);
  };
  const same = (label, x, y) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) out.add(`${label}: was ${JSON.stringify(x)}, now ${JSON.stringify(y)}`);
  };
  for (const [k, name] of PALLETS) {
    same(`${name} index`, a[k].index, b[k].index);
    same(`${name} storage prefix`, a[k].storage_prefix, b[k].storage_prefix);
  }
  for (const [p, e, name] of ENTRIES) {
    const x = a[p][e];
    const y = b[p][e];
    same(`${name} modifier`, x.modifier, y.modifier);
    same(`${name} hashers`, x.hashers, y.hashers);
    same(`${name} default bytes`, x.default, y.default);
    if ((x.key === null) !== (y.key === null)) out.add(`${name} key: was ${plainName(x.key)}, now ${plainName(y.key)}`);
    else if (x.key !== null) typeDiff(x.key, y.key, `${name} key`);
    typeDiff(x.value, y.value, `${name} value`);
  }
  variantsDiff(a.compute_channel.events, b.compute_channel.events, "ComputeChannel events", "event");
  typeDiff(a.system.version, b.system.version, "System.Version");
  // The stated lists, after the value types they are part of: a pair of types already followed
  // there is not followed again, so a change prints where its entry's value first met it.
  fieldsDiff(a.compute_channel.channels.fields, b.compute_channel.channels.fields, "ComputeChannel.Channels fields");
  variantsDiff(a.compute_channel.channel_states, b.compute_channel.channel_states, "ComputeChannel channel states", "state");
  fieldsDiff(a.system.events.record, b.system.events.record, "System.Events record");
  fieldsDiff(a.system.last_runtime_upgrade.fields, b.system.last_runtime_upgrade.fields, "System.LastRuntimeUpgrade fields");
  const lines = [...out];
  for (const [, name] of PALLETS) if (!lines.some((l) => l.startsWith(`${name} `) || l.startsWith(`${name}.`))) lines.push(`${name}: no difference in what the shapes state`);
  return [`specs: ${a.spec_name} ${a.spec_version} to ${b.spec_name} ${b.spec_version}`, ...lines.sort()];
}

/** The script's whole output for two shape files' texts. Throws ShapeRefused for a file it will not read. */
export const shapeDiffText = (oldText, newText, names = ["the old shape file", "the new shape file"]) => `${shapeDiff(readShape(oldText, names[0]), readShape(newText, names[1])).join("\n")}\n`;

/** The command: the output on stdout and exit 0, or one line on stderr and exit 2. */
export function main(args, read = (p) => readFileSync(p, "utf8")) {
  if (args.length !== 2) return { code: 2, stderr: "usage: node scripts/shape-diff.mjs <old shape file> <new shape file>\n", stdout: "" };
  try {
    const texts = args.map((p) => {
      try {
        return read(p);
      } catch {
        throw new ShapeRefused(`${p}: cannot be read`);
      }
    });
    return { code: 0, stdout: shapeDiffText(texts[0], texts[1], args), stderr: "" };
  } catch (e) {
    if (e instanceof ShapeRefused) return { code: 2, stdout: "", stderr: `shape-diff refused ${e.message}\n` };
    throw e;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = main(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.code);
}
