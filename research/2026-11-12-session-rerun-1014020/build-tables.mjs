#!/usr/bin/env node
// Builds errors-1014020.json and facts-1014020.json from the metadata of spec 1014020, so no error
// index, event field or constant in this folder is typed by hand.
//
// Input: the observatory's third recording, which holds both metadata answers. Get it with
//   git fetch origin refs/heads/observatory-data:refs/remotes/origin/observatory-data
//   git show origin/observatory-data:recordings/20261112080132-05842a6db1e9c890/tape.jsonl > tape.jsonl
// Usage: node build-tables.mjs --tape tape.jsonl [--out <folder>]
// The two blobs are found by their sha256 (as research/2026-11-12-runtime-upgrade/results.json
// names them). As a check on this reader, the 1014014 blob must name every error the three earlier
// tests recorded, at the indexes they recorded. No network, no key.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMetadataV14, variantsOf, primitiveOf } from "./metadata-v14.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const research = resolve(here, "..");
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
const fail = (m) => { process.stderr.write(`build-tables: ${m}\n`); process.exit(2); };

export const SPECS = { 1014014: "f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444", 1014020: "91294eb61225c4de7459e6a8fed3c37169a2c8a1b1906b46a5890d5e0d328238" };
export const RECORDING = "branch observatory-data, recordings/20261112080132-05842a6db1e9c890/tape.jsonl";
const PALLETS = ["FlopSessionKeys", "ComputeChannel"];
const EVENT_PALLETS = ["System", "Balances", "TransactionPayment", "FlopSessionKeys", "ComputeChannel"];
const EARLIER = ["2026-11-11-session-probe", "2026-11-11-session-escrow", "2026-11-11-session-deny-list"];

/** Finds every metadata answer in a tape (one JSON value a line) and keys it by its sha256. */
export function blobsOfTape(text) {
  const out = {};
  const walk = (x) => {
    if (typeof x === "string" && x.startsWith("0x6d657461")) { const b = Buffer.from(x.slice(2), "hex"); out[createHash("sha256").update(b).digest("hex")] = b; }
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  text.split("\n").filter(Boolean).forEach((l) => walk(JSON.parse(l)));
  return out;
}

/** [{pallet, pallet_index, error_index, name}] for the two pallets. */
export function errorTable(md) {
  return PALLETS.flatMap((p) => {
    const index = md.pallets.find((x) => x.name === p).index;
    return variantsOf(md, p, "error").map((v) => ({ pallet: p, pallet_index: index, error_index: v.index, name: v.name, docs: v.docs }));
  });
}

const leUint = (buf) => { let n = 0n; for (let i = buf.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]); return n.toString(); };
/** Events (index, name, field names) of the pallets the rerun reads, and the constants of the two pallets. */
export function factTable(md) {
  const events = {};
  for (const p of EVENT_PALLETS) events[p] = { pallet_index: md.pallets.find((x) => x.name === p).index, events: variantsOf(md, p, "event").map(({ docs, ...v }) => v) };
  const constants = {};
  for (const p of PALLETS) {
    constants[p] = {};
    for (const c of md.pallets.find((x) => x.name === p).constants) {
      const prim = primitiveOf(md, c.type);
      constants[p][c.name] = /^u(8|16|32|64|128)$/.test(prim ?? "") ? { type: prim, value: leUint(c.value) } : { type: null, raw: "0x" + c.value.toString("hex") };
    }
  }
  return { events, constants };
}

/** The sha256 of the doc comment of each call the rerun sends, to see whether its documented behaviour changed. */
export const DOCUMENTED_CALLS = [["FlopSessionKeys", "create_session"], ["FlopSessionKeys", "revoke_session"], ["FlopSessionKeys", "execute_via_session"], ["ComputeChannel", "force_open"], ["ComputeChannel", "expire_force_open"], ["ComputeChannel", "timeout"]];
export function callDocs(md) {
  return Object.fromEntries(DOCUMENTED_CALLS.map(([p, c]) => {
    const v = variantsOf(md, p, "calls").find((x) => x.name === c);
    if (!v) throw new Error(`no call ${p}.${c}`);
    return [`${p}.${c}`, createHash("sha256").update(v.docs).digest("hex")];
  }));
}

/** Every "(pallet P, error E)" or "pallet P error E = Pallet.Name" an earlier results.json recorded, with the name it gave. */
export function recordedErrors(results) {
  const out = [];
  for (const s of results.steps) {
    const m1 = /([A-Za-z]+)\.([A-Za-z]+) \(pallet (\d+), error (\d+)\)/.exec(s.result);
    const m2 = /pallet (\d+) error (\d+) = ([A-Za-z]+)\.([A-Za-z]+)/.exec(s.result);
    if (m1) out.push({ step: s.step, pallet_index: +m1[3], error_index: +m1[4], name: m1[2] });
    else if (m2) out.push({ step: s.step, pallet_index: +m2[1], error_index: +m2[2], name: m2[4] });
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tape = flag("tape") ?? fail("--tape <tape.jsonl> is required (see the head of this file)");
  const out = flag("out") ?? here;
  const blobs = blobsOfTape(readFileSync(tape, "utf8"));
  const md = {};
  for (const [spec, sha] of Object.entries(SPECS)) md[spec] = parseMetadataV14(blobs[sha] ?? fail(`no metadata with sha256 ${sha} in ${tape}`));
  const old = errorTable(md[1014014]);
  const cross = [];
  for (const dir of EARLIER) {
    for (const r of recordedErrors(JSON.parse(readFileSync(join(research, dir, "results.json"), "utf8")))) {
      const hit = old.find((e) => e.pallet_index === r.pallet_index && e.error_index === r.error_index);
      if (!hit || hit.name !== r.name) fail(`${dir} step ${r.step} recorded ${r.pallet_index}/${r.error_index} ${r.name}; the 1014014 metadata says ${hit ? hit.name : "nothing"}`);
      cross.push(`${dir} ${r.step}: ${r.pallet_index}/${r.error_index} ${r.name}`);
    }
  }
  const source = { recording: RECORDING, metadata_sha256: SPECS[1014020], metadata_bytes: blobs[SPECS[1014020]].length, built_by: "build-tables.mjs", reader: "metadata-v14.mjs" };
  const errors = { spec_version: 1014020, ...source, cross_check_of_the_reader: { against: "the 1014014 blob of the same recording", sha256: SPECS[1014014], errors_recorded_by_the_earlier_tests_found_by_index_and_name: cross }, errors: errorTable(md[1014020]) };
  writeFileSync(join(out, "errors-1014020.json"), JSON.stringify(errors, null, 1) + "\n");
  const d14 = callDocs(md[1014014]), d20 = callDocs(md[1014020]);
  const docs = Object.fromEntries(Object.keys(d20).map((k) => [k, { sha256_at_1014014: d14[k], sha256_at_1014020: d20[k], same: d14[k] === d20[k] }]));
  writeFileSync(join(out, "facts-1014020.json"), JSON.stringify({ spec_version: 1014020, ...source, ...factTable(md[1014020]), call_docs: docs }, null, 1) + "\n");
  console.log(`wrote errors-1014020.json (${errors.errors.length} errors) and facts-1014020.json; ${cross.length} recorded errors of the earlier tests read back from 1014014`);
}
