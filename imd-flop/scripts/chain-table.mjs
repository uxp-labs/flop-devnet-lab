#!/usr/bin/env node
// chain-table: writes src/chain/runtimes.ts, the reviewed runtime table of the chain encoder (rule E2 of
// the P3 brief), from recorded metadata. Nothing in that file is typed by hand: every value comes from a
// committed recording, read here through the reference decoder (@polkadot-api, dev dependencies only).
// test/chain-table.test.ts runs deriveRuntimes() again and compares with the committed file byte for byte.
//
// Usage, from imd-flop/:   node scripts/chain-table.mjs          writes src/chain/runtimes.ts
//
// It reads only files of this repository and talks to no network.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = join(PKG, "..");
export const OUT = join(PKG, "src", "chain", "runtimes.ts");

/**
 * The reviewed runtimes. Each names the recording that holds its metadata as an answer to
 * state_getMetadata and the facts file that names that metadata by sha256 and length. The genesis is the
 * same recording's answer to chain_getBlockHash(0).
 */
export const SOURCES = [
  {
    tape: "observatory/fixtures/recording-20261112080132-05842a6db1e9c890/tape.jsonl",
    facts: "research/2026-11-12-session-rerun-1014020/facts-1014020.json",
  },
];

/**
 * The calls the encoder writes: the outer call, then the inner calls it may carry (rule E3), then the two
 * calls of the session's owner (P5a, O1), written as call bytes only.
 */
export const CALLS = [
  ["FlopSessionKeys", "execute_via_session"],
  ["ComputeChannel", "open_channel"],
  ["ComputeChannel", "top_up_escrow"],
  ["ComputeChannel", "timeout"],
  ["ComputeChannel", "force_open"],
  ["ComputeChannel", "expire_force_open"],
  ["FlopSessionKeys", "create_session"],
  ["FlopSessionKeys", "revoke_session"],
];

/** The pallet constants the owner calls are bounded by (P5a, O3): each a u32 of the metadata's constants. */
export const CONSTANTS = [
  ["FlopSessionKeys", "MaxSessionDuration"],
  ["FlopSessionKeys", "SessionEpochLength"],
];

function fail(msg) {
  throw new Error(`chain-table: ${msg}`);
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** The metadata bytes and genesis of one source, picked by the facts file's sha256 and length. */
export function readSource(src) {
  const facts = JSON.parse(readFileSync(join(REPO, src.facts), "utf8"));
  const lines = readFileSync(join(REPO, src.tape), "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
  const answers = lines.filter((o) => o.request?.kind === "rpc");
  const metas = answers
    .filter((o) => o.request.method === "state_getMetadata" && typeof o.answer?.result === "string")
    .map((o) => Buffer.from(o.answer.result.slice(2), "hex"))
    .filter((b) => sha256(b) === facts.metadata_sha256);
  if (metas.length < 1) fail(`${src.tape} holds no metadata with sha256 ${facts.metadata_sha256}`);
  const metadata = metas[0];
  if (metadata.length !== facts.metadata_bytes) fail(`the metadata has ${metadata.length} bytes, ${src.facts} says ${facts.metadata_bytes}`);
  const genesisAnswers = [
    ...new Set(answers.filter((o) => o.request.method === "chain_getBlockHash" && JSON.stringify(o.request.params) === "[0]").map((o) => o.answer?.result)),
  ];
  if (genesisAnswers.length !== 1 || !/^0x[0-9a-f]{64}$/.test(genesisAnswers[0] ?? "")) fail(`${src.tape} does not hold one genesis hash`);
  return { metadata: new Uint8Array(metadata), genesisHash: genesisAnswers[0], metadataSha256: facts.metadata_sha256 };
}

const isU8 = (m, id) => m.lookup[id].def.tag === "primitive" && m.lookup[id].def.value.tag === "u8";
/** A Vec<u8>: a sequence of u8, with no wrapper. */
const isBytes = (m, id) => m.lookup[id].def.tag === "sequence" && isU8(m, m.lookup[id].def.value);

/** A type of the registry reduced to what the encoder writes. A type it does not know is refused. */
function reduce(m, id, callType) {
  if (id === callType) return { kind: "call" };
  const t = m.lookup[id];
  const def = t.def;
  const path = t.path.join("::");
  if (def.tag === "primitive") {
    if (["u32", "u64", "u128"].includes(def.value.tag)) return { kind: def.value.tag };
    fail(`type ${id}: primitive ${def.value.tag} is not written by the encoder`);
  }
  if (def.tag === "array") {
    if (def.value.len === 32 && isU8(m, def.value.type)) return { kind: "bytes32" };
    fail(`type ${id}: an array of ${def.value.len} is not written by the encoder`);
  }
  if (def.tag === "compact") {
    const inner = reduce(m, def.value, callType);
    if (["u32", "u64", "u128"].includes(inner.kind)) return { kind: "compact", of: inner.kind };
    fail(`type ${id}: a compact of ${inner.kind}`);
  }
  if (def.tag === "sequence") {
    // A list of byte strings, Vec<Vec<u8>> (P5a, O4): the allow list of create_session. Nothing else.
    if (isBytes(m, def.value)) return { kind: "bytesList" };
    fail(`type ${id}: a sequence that is not a list of byte strings is not written by the encoder`);
  }
  if (def.tag === "tuple" && def.value.length === 0) return { kind: "unit" };
  if (def.tag === "composite") {
    if (def.value.length === 0) return { kind: "unit" };
    if (def.value.length === 1 && def.value[0].name === undefined) return reduce(m, def.value[0].type, callType);
    if (def.value.every((f) => typeof f.name === "string")) {
      return { kind: "struct", fields: def.value.map((f) => ({ name: f.name, type: reduce(m, f.type, callType) })) };
    }
    fail(`type ${id}: a composite with unnamed fields`);
  }
  if (def.tag === "variant") {
    if (path === "sp_runtime::generic::era::Era") {
      const ok =
        def.value.length === 256 &&
        def.value.every((v, i) =>
          i === 0 ? v.name === "Immortal" && v.index === 0 && v.fields.length === 0 : v.name === `Mortal${i}` && v.index === i && v.fields.length === 1 && isU8(m, v.fields[0].type),
        );
      if (!ok) fail(`type ${id}: an Era of a shape the encoder does not know`);
      return { kind: "era" };
    }
    if (t.path.length === 1 && t.path[0] === "Option") {
      const [none, some] = def.value;
      if (def.value.length === 2 && none.name === "None" && none.index === 0 && none.fields.length === 0 && some.name === "Some" && some.index === 1 && some.fields.length === 1) {
        return { kind: "option", of: reduce(m, some.fields[0].type, callType) };
      }
      fail(`type ${id}: an Option of a shape the encoder does not know`);
    }
    if (def.value.every((v) => v.fields.length === 0)) {
      return { kind: "enum", variants: def.value.map((v) => ({ name: v.name, index: v.index })) };
    }
    fail(`type ${id} (${path}): an enum with fields is not written by the encoder`);
  }
  fail(`type ${id}: ${def.tag} is not written by the encoder`);
}

/** The variant of `typeId` named `name`, whose one field is `fieldCheck`. */
function variantOf(m, typeId, name, fieldCheck) {
  const def = m.lookup[typeId].def;
  if (def.tag !== "variant") fail(`type ${typeId} is not an enum`);
  const v = def.value.find((x) => x.name === name);
  if (!v || v.fields.length !== 1 || !fieldCheck(v.fields[0].type)) fail(`type ${typeId} has no variant ${name} of the expected shape`);
  return { variant: name, index: v.index };
}

/** One table entry, from the metadata bytes and the genesis of the chain they were read on. */
export function deriveRuntime({ metadata, genesisHash, metadataSha256 }) {
  if (sha256(metadata) !== metadataSha256) fail("the metadata bytes do not have the named sha256");
  const any = decAnyMetadata(metadata);
  if (any.metadata.tag !== "v14") fail(`metadata ${any.metadata.tag} is not the reviewed v14`);
  const m = unifyMetadata(any);
  const builder = getDynamicBuilder(getLookupFn(m));
  const system = m.pallets.find((p) => p.name === "System");
  const versionConst = system?.constants.find((c) => c.name === "Version");
  if (!versionConst) fail("the metadata has no System.Version");
  const version = builder.buildConstant("System", "Version").dec(versionConst.value);

  const xt = any.metadata.value.extrinsic;
  const xtType = m.lookup[xt.type];
  if (xtType.path.join("::") !== "sp_runtime::generic::unchecked_extrinsic::UncheckedExtrinsic") fail("the extrinsic type is not UncheckedExtrinsic");
  const param = (name) => xtType.params.find((p) => p.name === name)?.type ?? fail(`the extrinsic type has no ${name}`);
  const callType = param("Call");
  const is32 = (id) => reduce(m, id, callType).kind === "bytes32";
  const is64 = (id) => {
    const d = m.lookup[id].def;
    return d.tag === "array" && d.value.len === 64 && isU8(m, d.value.type);
  };

  const signedExtensions = xt.signedExtensions.map((e) => ({
    identifier: e.identifier,
    extra: reduce(m, e.type, callType),
    additionalSigned: reduce(m, e.additionalSigned, callType),
  }));

  const runtimeCall = m.lookup[callType].def;
  if (runtimeCall.tag !== "variant") fail("RuntimeCall is not an enum");
  const calls = CALLS.map(([pallet, name]) => {
    const p = m.pallets.find((x) => x.name === pallet);
    if (!p?.calls) fail(`no pallet ${pallet} with calls`);
    const outer = runtimeCall.value.find((v) => v.name === pallet);
    if (!outer || outer.index !== p.index || outer.fields.length !== 1 || outer.fields[0].type !== p.calls.type) fail(`RuntimeCall.${pallet} is not pallet index ${p.index}`);
    const callDef = m.lookup[p.calls.type].def;
    const v = callDef.tag === "variant" ? callDef.value.find((x) => x.name === name) : undefined;
    if (!v) fail(`no call ${pallet}.${name}`);
    return {
      pallet,
      name,
      palletIndex: p.index,
      callIndex: v.index,
      fields: v.fields.map((f) => {
        if (typeof f.name !== "string") fail(`${pallet}.${name} has an unnamed field`);
        return { name: f.name, type: reduce(m, f.type, callType) };
      }),
    };
  });

  const constants = CONSTANTS.map(([pallet, name]) => {
    const c = m.pallets.find((x) => x.name === pallet)?.constants.find((x) => x.name === name);
    if (!c) fail(`no constant ${pallet}.${name}`);
    const type = reduce(m, c.type, callType);
    if (type.kind !== "u32") fail(`${pallet}.${name} is a ${type.kind}, not a u32`);
    const value = builder.buildConstant(pallet, name).dec(c.value);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail(`${pallet}.${name} does not read as a u32`);
    return { pallet, name, type, value };
  });

  return {
    specName: version.spec_name,
    specVersion: version.spec_version,
    transactionVersion: version.transaction_version,
    genesisHash,
    metadataSha256,
    extrinsicVersion: xt.version,
    address: variantOf(m, param("Address"), "Id", is32),
    signature: variantOf(m, param("Signature"), "Ed25519", is64),
    signedExtensions,
    calls,
    constants,
  };
}

export function deriveRuntimes() {
  return SOURCES.map((src) => deriveRuntime(readSource(src)));
}

/** The text of src/chain/runtimes.ts. */
export function renderRuntimes(runtimes) {
  return [
    "// Written by scripts/chain-table.mjs from recorded metadata (its SOURCES). Do not edit by hand:",
    "// test/chain-table.test.ts derives it again and compares with this file byte for byte.",
    'import { deepFreeze } from "../freeze.js";',
    'import type { Runtime } from "./table.js";',
    "",
    "/** Frozen here, where it is defined, so no module can change it before the encoder reads it. */",
    `export const RUNTIMES: readonly Runtime[] = deepFreeze(${JSON.stringify(runtimes, null, 2)});`,
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OUT, renderRuntimes(deriveRuntimes()));
  process.stdout.write(`chain-table: wrote ${OUT}\n`);
}
