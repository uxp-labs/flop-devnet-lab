#!/usr/bin/env node
// read-key-table: writes src/chain-read/key-table.ts, the frozen table of the chain reads (P2, rule C2): the two
// fixed 16 byte parts of each storage key a read asks, the hashers of its account parts, the fields of the records
// it decodes, and the pairs of the cross check (C5). Nothing in that file is typed by hand:
//  - the fixed parts are twox128 of the storage prefix and of the entry name, read from the recorded metadata of
//    each reviewed runtime through the reference decoder (@polkadot-api, dev dependencies only), and checked
//    against the committed shape file of that runtime (its storage prefix, hashers and modifier);
//  - the records and the cross check come from the committed shape file.
// test/chain-read-keys.test.ts runs deriveKeyTable() again and compares with the committed file byte for byte.
//
// Usage, from imd-flop/:   node scripts/read-key-table.mjs          writes src/chain-read/key-table.ts
//
// It reads only files of this repository and talks to no network.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decAnyMetadata, Twox128, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { REPO, readSource } from "./chain-table.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(PKG, "src", "chain-read", "key-table.ts");

/**
 * The reviewed runtimes the reads hold a table line for. Each names the recording that holds its metadata, the facts
 * file that names that metadata by sha256 and length (as scripts/chain-table.mjs reads them), and the committed
 * shape file of the runtime, by its path in the observatory package.
 */
export const SOURCES = [
  {
    tape: "observatory/fixtures/recording-20261112080132-05842a6db1e9c890/tape.jsonl",
    facts: "research/2026-11-12-session-rerun-1014020/facts-1014020.json",
    shapeFile: "shapes/tzkv-runtime-1014020.json",
  },
];

/** The entries a read asks, by the shape file's names: [shape pallet part, shape entry name, metadata pallet, metadata entry]. */
const SYSTEM_ENTRIES = [
  ["events", "System", "Events"],
  ["last_runtime_upgrade", "System", "LastRuntimeUpgrade"],
];
const SESSION_ENTRIES = [
  ["sessions", "FlopSessionKeys", "Sessions"],
  ["session_nonces", "FlopSessionKeys", "SessionNonces"],
  ["circuit_breakers", "FlopSessionKeys", "CircuitBreakers"],
];
/** The one event of the cross check (S4), by its pallet and name. */
const CROSS_EVENT = ["FlopSessionKeys", "SessionCallExecuted"];

/** The hashers chain-read/keys.ts computes, by the shape file's names, and the reference decoder's name of each. */
const HASHERS = { Blake2_128Concat: "Blake2128Concat" };

function fail(msg) {
  throw new Error(`read-key-table: ${msg}`);
}

const hex = (b) => `0x${Buffer.from(b).toString("hex")}`;
const twox128 = (text) => hex(Twox128(new TextEncoder().encode(text)));

/** A type of the shape file reduced to what chain-read/session-state.ts reads. A type it does not know is refused. */
function reduce(types, name, depth = 0) {
  if (depth > 8) fail(`type ${name} nests too deep`);
  if (["u8", "u16", "u32", "u64", "u128", "bool"].includes(name)) return { kind: name };
  const t = types[name];
  if (t === undefined) fail(`the shape file has no type ${name}`);
  if (t.kind === "composite" && t.fields.length === 1 && t.fields[0].name === null) return reduce(types, t.fields[0].type, depth + 1);
  if (t.kind === "composite" && t.fields.length > 0 && t.fields.every((f) => typeof f.name === "string")) {
    return { kind: "record", fields: t.fields.map((f) => ({ name: f.name, type: reduce(types, f.type, depth + 1) })) };
  }
  if ((t.kind === "array" || t.kind === "sequence") && t.element === "u8") return t.kind === "array" ? { kind: "bytes", length: t.len } : { kind: "bytes" };
  if (t.kind === "sequence") return { kind: "list", of: reduce(types, t.element, depth + 1) };
  fail(`type ${name} of kind ${t.kind} is not one session-state.ts reads`);
}

/** The storage item of a pallet in the reference decoder's parse. */
function itemOf(m, pallet, entry) {
  const p = m.pallets.find((x) => x.name === pallet);
  if (p === undefined || p.storage === undefined) fail(`the metadata has no storage of pallet ${pallet}`);
  const it = p.storage.items.find((x) => x.name === entry);
  if (it === undefined) fail(`the metadata has no entry ${pallet}.${entry}`);
  return { prefix: p.storage.prefix, item: it };
}

/** One entry's line: the fixed parts from the metadata, checked against the shape file's statement of it. */
function entryLine(m, stated, pallet, entry) {
  const { prefix, item } = itemOf(m, pallet, entry);
  const hashers = item.type.tag === "map" ? item.type.value.hashers.map((h) => h.tag) : [];
  const shapeHashers = stated.entry.hashers;
  if (stated.prefix !== prefix) fail(`${pallet}: the shape's storage prefix ${stated.prefix} is not the metadata's ${prefix}`);
  if (JSON.stringify(shapeHashers.map((h) => HASHERS[h] ?? `unknown ${h}`)) !== JSON.stringify(hashers)) fail(`${pallet}.${entry}: the shape's hashers ${shapeHashers} are not the metadata's ${hashers}, or not ones keys.ts computes`);
  const modifier = item.modifier === 0 ? "Optional" : "Default";
  if (stated.entry.modifier !== modifier) fail(`${pallet}.${entry}: the shape's modifier ${stated.entry.modifier} is not the metadata's ${modifier}`);
  return { pallet, entry, palletPart: twox128(prefix), entryPart: twox128(entry), hashers: shapeHashers, modifier };
}

/** The event of the cross check in the shape's outer event enum, by the pallet's index and the event's name. */
function crossEvent(shape) {
  const [pallet, name] = CROSS_EVENT;
  const index = shape.flop_session_keys.index;
  const outer = Object.values(shape.types).filter((t) => t.kind === "variant" && Array.isArray(t.path) && t.path.at(-1) === "RuntimeEvent");
  if (outer.length !== 1) fail("the shape file does not hold one RuntimeEvent");
  const v = outer[0].variants.find((x) => x.index === index);
  if (v === undefined || v.name !== pallet || v.fields.length !== 1) fail(`RuntimeEvent has no variant ${pallet} at index ${index}`);
  const events = shape.types[v.fields[0].type];
  const e = events?.variants?.find((x) => x.name === name);
  if (e === undefined) fail(`${pallet} has no event ${name}`);
  return e.fields;
}

/**
 * The cross check's pairs (C5): each field of the event that the session record states by the same name and type,
 * an account field matched to a key part, and every other one a total of the stored record. An event field the
 * record does not state, or states with another type, is refused: the pairing would not follow from the shape.
 */
function crossCheck(shape, session) {
  const fields = crossEvent(shape);
  const keys = [];
  const totals = [];
  for (const f of fields) {
    const r = session.fields.find((x) => x.name === f.name);
    if (r === undefined) fail(`${CROSS_EVENT.join(".")}.${f.name} is not a field of the session record`);
    const t = reduce(shape.types, f.type);
    if (JSON.stringify(t) !== JSON.stringify(r.type)) fail(`${CROSS_EVENT.join(".")}.${f.name} is not of the session record's type for it`);
    if (t.kind === "bytes" && t.length === 32) keys.push(f.name);
    else if (t.kind === "u128") totals.push(f.name);
    else fail(`${CROSS_EVENT.join(".")}.${f.name} is neither an account nor a u128 total`);
  }
  if (JSON.stringify(keys) !== JSON.stringify(["owner", "delegate"])) fail(`${CROSS_EVENT.join(".")} does not name the session by owner then delegate`);
  if (totals.length === 0) fail(`${CROSS_EVENT.join(".")} carries no total`);
  return { pallet: CROSS_EVENT[0], event: CROSS_EVENT[1], keys, totals };
}

/** One reviewed runtime's line. */
export function deriveRuntime(src) {
  const { metadata, metadataSha256 } = readSource(src);
  const m = unifyMetadata(decAnyMetadata(metadata));
  const shape = JSON.parse(readFileSync(join(REPO, "observatory", src.shapeFile), "utf8"));
  if (shape.schema !== "flop-observatory/decoder-shape@3") fail(`${src.shapeFile} is ${JSON.stringify(shape.schema)}, not decoder-shape@3`);
  const sys = { prefix: shape.system.storage_prefix };
  const fsk = { prefix: shape.flop_session_keys.storage_prefix };
  const system = Object.fromEntries(SYSTEM_ENTRIES.map(([k, p, e]) => [k, entryLine(m, { ...sys, entry: shape.system[k] }, p, e)]));
  const entries = Object.fromEntries(SESSION_ENTRIES.map(([k, p, e]) => [k, entryLine(m, { ...fsk, entry: shape.flop_session_keys[k] }, p, e)]));
  const session = reduce(shape.types, shape.flop_session_keys.sessions.value);
  const breaker = reduce(shape.types, shape.flop_session_keys.circuit_breakers.value);
  const nonce = reduce(shape.types, shape.flop_session_keys.session_nonces.value);
  if (session.kind !== "record" || breaker.kind !== "record") fail("the session and the circuit breaker are not records");
  return {
    specName: shape.spec_name,
    specVersion: shape.spec_version,
    shapeFile: src.shapeFile,
    metadataSha256,
    system,
    entries,
    records: { session: session.fields, circuitBreaker: breaker.fields, sessionNonce: nonce },
    crossCheck: crossCheck(shape, session),
  };
}

/** The whole table. The System keys are the same for every runtime, or the table is refused. */
export function deriveKeyTable() {
  const runtimes = SOURCES.map(deriveRuntime);
  const system = runtimes[0].system;
  for (const r of runtimes) if (JSON.stringify(r.system) !== JSON.stringify(system)) fail(`spec ${r.specVersion} has other System keys`);
  return { system, runtimes: runtimes.map(({ system: _, ...rest }) => rest) };
}

/** The text of src/chain-read/key-table.ts. */
export function renderKeyTable(table) {
  return [
    "// Written by scripts/read-key-table.mjs from committed files. Do not edit: run the script again.",
    "// test/chain-read-keys.test.ts derives it again and compares byte for byte.",
    'import { deepFreeze } from "./freeze.js";',
    'import type { KeyTable } from "./key-table-types.js";',
    "",
    `export const SOURCES = deepFreeze(${JSON.stringify(SOURCES, null, 2)});`,
    "",
    `export const KEY_TABLE: KeyTable = deepFreeze(${JSON.stringify(table, null, 2)});`,
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OUT, renderKeyTable(deriveKeyTable()));
  console.log(`wrote ${OUT}`);
}
