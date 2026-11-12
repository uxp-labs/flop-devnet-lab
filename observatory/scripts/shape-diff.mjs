#!/usr/bin/env node
// What differs between two reviewed shape files (shapes/*.json, flop-observatory/decoder-shape@2),
// for what the shapes state: the index and storage prefix of System, ComputeChannel and
// FlopSessionKeys, their six stated storage entries (modifier, hashers, key type, value type,
// default bytes), the ComputeChannel events, the fields of a channel and its states, the fields of
// an event record and of LastRuntimeUpgrade, and the System.Version type. The types of an entry are
// followed down to where they differ, so a change in System.Events names the pallet and the event of
// the outer event enum it is in. The fields of a channel and its states, the event record and the
// fields of LastRuntimeUpgrade are compared inside the value types of their entries.
//
//   node scripts/shape-diff.mjs <old shape file> <new shape file>
//
// Type ids are renumbered between runtimes, so a type is compared by what it is, never by its name:
// its kind, its path, and the structure of every type it holds, followed to the end. A change of
// ids alone is not a difference. Pure: it reads the two files it is given and prints one line per
// difference, sorted, plain text, and for a stated pallet with no difference one line that says so.
// shapes/diff-tzkv-runtime-1014014-1014020.txt is its output for the two reviewed runtimes, held to
// a fresh run by test/upgrade-shape.test.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** A type name without the ids it carries, for a reader: H256#13 is H256. */
const plainName = (name) => String(name).replace(/#\d+/g, "");

/** The structural form of every type of one shape's table, by name, as a sha256 of its structure. */
function structure(types) {
  const memo = new Map();
  const visit = (name, stack) => {
    if (memo.has(name)) return memo.get(name);
    const t = types[name];
    if (t === undefined) return `unknown ${plainName(name)}`;
    if (stack.includes(name)) return { cyclic: `recursive ${t.path.join("::")}` };
    const next = [...stack, name];
    let cyclic = false;
    const of = (n) => {
      const r = visit(n, next);
      if (typeof r === "object") {
        cyclic = true;
        return r.cyclic;
      }
      return r;
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
    if (!cyclic) memo.set(name, h);
    return h;
  };
  return (name) => {
    const r = visit(name, []);
    return typeof r === "object" ? r.cyclic : r;
  };
}

const PALLETS = [
  ["system", "System"],
  ["compute_channel", "ComputeChannel"],
  ["flop_session_keys", "FlopSessionKeys"],
];
const ENTRIES = [
  ["system", "events", "System.Events"],
  ["system", "last_runtime_upgrade", "System.LastRuntimeUpgrade"],
  ["compute_channel", "channels", "ComputeChannel.Channels"],
  ["flop_session_keys", "sessions", "FlopSessionKeys.Sessions"],
  ["flop_session_keys", "session_nonces", "FlopSessionKeys.SessionNonces"],
  ["flop_session_keys", "circuit_breakers", "FlopSessionKeys.CircuitBreakers"],
];

/** The lines that say what differs from shape a to shape b, sorted. Pure. */
export function shapeDiff(a, b) {
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
  /** The differences between two types, by structure, followed to where they are. */
  const typeDiff = (x, y, label) => {
    if (sa(x) === sb(y)) return;
    const key = `${x}|${y}|${label}`;
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
  // The fields of a channel, its states, the event record and LastRuntimeUpgrade are inside the
  // value types of their entries, compared above, so they are not compared a second time here.
  typeDiff(a.system.version, b.system.version, "System.Version");
  const lines = [...out];
  for (const [, name] of PALLETS) if (!lines.some((l) => l.startsWith(`${name} `) || l.startsWith(`${name}.`))) lines.push(`${name}: no difference in what the shapes state`);
  return lines.sort();
}

/** The script's whole output for two shape files' texts. */
export const shapeDiffText = (oldText, newText) => `${shapeDiff(JSON.parse(oldText), JSON.parse(newText)).join("\n")}\n`;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write("usage: node scripts/shape-diff.mjs <old shape file> <new shape file>\n");
    process.exit(2);
  }
  process.stdout.write(shapeDiffText(readFileSync(args[0], "utf8"), readFileSync(args[1], "utf8")));
}
