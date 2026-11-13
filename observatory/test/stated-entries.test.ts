// The ten entries decoder-shape@3 states (round 29, rules T3 and T4), through the storage door
// (src/scale/block.ts) for both reviewed runtimes: the key the door builds is the key the
// reference library (polkadot-api, a dev dependency) builds, the door refuses a value under
// another entry's key or another account's or hash's key, and a value the test states, encoded by
// the reference, is decoded by the door to that value. The accounts and hashes are the third
// recording's inputs (its requests-inputs.json, accounts and channels); the values are stated here.
import { readFileSync } from "node:fs";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { AccountId, Binary, decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import { decodeStorageValue } from "../src/scale/block.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { fromHex } from "../src/scale/reader.js";
import { REVIEWED, type ReviewedShape } from "../src/scale/shape.js";
import { plain } from "./helpers/plain.js";
import { recordedUpgrade } from "./helpers/recorded-upgrade.js";
import { UPGRADE_BLOCKS } from "./helpers/requests/list-3.js";

const U = recordedUpgrade();
const [BEFORE, , , LATER] = UPGRADE_BLOCKS;
const ss58 = AccountId();
const account = (name: "owner" | "device_1" | "device_2" | "device_3") => fromHex(U.inputs.accounts[name].value);
const hash = (name: "gateway" | "ours") => fromHex(U.inputs.channels[name].value);
const OWNER = ss58.dec(account("owner"));
const DEVICE = ss58.dec(account("device_1"));
const GATEWAY = U.inputs.channels.gateway.value;
const OURS = U.inputs.channels.ours.value;
/** ModelPrecision INT8, by its index in both runtimes' metadata (held below). */
const INT8 = new Uint8Array([3]);
const text = (t: string) => Binary.fromText(t);

/** One new entry: its key parts and another account's or hash's, and a value in the reference's form. */
interface Case {
  pallet: string;
  entry: string;
  parts: Uint8Array[];
  other: Uint8Array[];
  value: unknown;
}

const CASES: Case[] = [
  {
    pallet: "System",
    entry: "Account",
    parts: [account("owner")],
    other: [account("device_1")],
    // free above 2^64; flags 0, where the metadata's default sets its top bit.
    value: { nonce: 7, consumers: 1, providers: 2, sufficients: 0, data: { free: 2n ** 64n + 12345n, reserved: 3n, frozen: 0n, flags: 0n } },
  },
  { pallet: "ComputeChannel", entry: "FailedAcks", parts: [account("owner")], other: [account("device_2")], value: 3 },
  { pallet: "ComputeChannel", entry: "ChannelAuthoredOpenedAt", parts: [hash("gateway")], other: [hash("ours")], value: 1234 },
  { pallet: "FlopSessionKeys", entry: "DelegateSessions", parts: [account("device_1")], other: [account("device_3")], value: [[OWNER, DEVICE], [DEVICE, OWNER]] },
  {
    pallet: "ModelRegistry",
    entry: "Models",
    parts: [hash("ours")],
    other: [hash("gateway")],
    value: {
      model_hash: OURS,
      model_name: text("model"),
      version: text("1.0"),
      publisher: OWNER,
      published_at: 10n,
      model_uri: text("ipfs://x"),
      license_hash: GATEWAY,
      architecture: { type: "Custom", value: text("hybrid") },
      params_billion: 7,
      supported_precisions: [{ type: "INT8", value: undefined }, { type: "FP16", value: undefined }],
      gflops_per_token: 3n,
      min_vram_gb: 24,
      status: { type: "Verified", value: undefined },
      approved_by: [DEVICE],
      supported_tee_platforms: [{ type: "IntelTdx", value: undefined }],
      benchmark_scores: [{ benchmark_name: text("mmlu"), score: 9, verified_at: 1n, verified_by: OWNER, decays_at: 2n, source: { type: "TeeVerified", value: undefined } }],
      registered_miners: [{ miner: DEVICE, gpu_model: text("h100"), vram_gb: 80, tee_type: { type: "NvidiaCc", value: undefined }, availability: { type: "Busy", value: undefined }, last_active: 5n, tasks_completed: 6n, avg_latency_ms: 7n, success_rate: 990000 }],
      online_miner_count: 1,
      avg_price_per_gflop: 2n ** 80n,
      avg_latency_ms: 5n,
      p99_latency_ms: 9n,
      task_success_rate: 990000,
      total_tasks_completed: 4n,
      total_gflops_consumed: 8n,
      task_types: [{ type: "CodeGeneration", value: undefined }],
    },
  },
  { pallet: "ModelRegistry", entry: "MeasuredRoots", parts: [hash("ours"), INT8], other: [hash("gateway"), INT8], value: GATEWAY },
  { pallet: "ModelRegistry", entry: "AllowedDecodePolicies", parts: [hash("ours")], other: [hash("gateway")], value: [GATEWAY, OURS] },
  {
    pallet: "MinerStaking",
    entry: "Miners",
    parts: [account("device_2")],
    other: [account("device_3")],
    value: { self_stake: 2n ** 70n, delegated_stake: 5n, commission_rate: 50_000_000, is_active: true, total_rewards_earned: 0n, registered_at: 42 },
  },
  { pallet: "HwCalibration", entry: "CalibrationVersions", parts: [account("device_2")], other: [account("owner")], value: 2 },
  { pallet: "HwCalibration", entry: "LastInitialCalibration", parts: [account("device_2")], other: [account("owner")], value: 99 },
];

/** Each reviewed runtime with what the door needs, and the reference built from the same metadata. */
const RUNTIMES = REVIEWED.map((r: ReviewedShape) => {
  const metadata = U.metadataBySha(r.metadataSha256);
  return {
    r,
    md: parseMetadata(metadata),
    ref: getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(metadata)))),
    pin: { specName: r.specName, specVersion: r.specVersion, metadata, lastRuntimeUpgrade: U.upgradeOf(r.specVersion === 1014014 ? BEFORE : LATER), shapeText: readFileSync(new URL(`../${r.shapeFile}`, import.meta.url), "utf8") },
  };
});
type Runtime = (typeof RUNTIMES)[number];

const cat = (parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));
/** The storage key the reference builds for these key parts: each part read by the reference's own codec, then its key encoder. */
const refKey = (rt: Runtime, c: { pallet: string; entry: string }, parts: Uint8Array[]): Uint8Array => {
  const s = rt.ref.buildStorage(c.pallet, c.entry);
  return fromHex(s.keys.enc(...s.args.dec(cat(parts))));
};
const refValue = (rt: Runtime, c: Case): Uint8Array => rt.ref.buildStorage(c.pallet, c.entry).value.enc(c.value);
const entryOf = (rt: Runtime, c: { pallet: string; entry: string }) => {
  const e = rt.md.pallets.find((p) => p.name === c.pallet)?.storage?.entries.find((x) => x.name === c.entry);
  if (e === undefined) throw new Error(`${c.pallet}.${c.entry} is not in the metadata`);
  return e;
};
const door = (rt: Runtime, c: Case, over: { keys?: Uint8Array[]; key?: Uint8Array; answer?: Uint8Array | null } = {}) =>
  decodeStorageValue({ ...rt.pin, pallet: c.pallet, entry: c.entry, keys: over.keys ?? c.parts, key: over.key ?? refKey(rt, c, c.parts), answer: over.answer === undefined ? refValue(rt, c) : over.answer });

const BOTH = RUNTIMES.flatMap((rt) => CASES.map((c) => [`${c.pallet}.${c.entry}`, rt.r.specVersion, rt, c] as const));

describe("the ten entries @3 adds, through the door", () => {
  it.each(RUNTIMES.map((rt) => [rt.r.specVersion, rt] as const))("spec %i: ModelPrecision INT8 is index 3, as the key parts state it", (_spec, rt) => {
    const precision = rt.md.types.find((t) => t.path.at(-1) === "ModelPrecision")?.def;
    expect(precision?.kind === "variant" ? precision.variants.find((v) => v.name === "INT8")?.index : null).toBe(INT8[0]);
  });

  it.each(BOTH)("%s, spec %i: the door builds the reference's key, and refuses another entry's key and another account's or hash's", (name, _spec, rt, c) => {
    // The reference's key is the key the door builds: the door decodes under it and refuses any other.
    expect(door(rt, c)).toMatchObject({ decoded: true, stored: true });
    const sibling = CASES.find((x) => x !== c && x.parts.length === c.parts.length && x.parts.every((p, i) => p.length === c.parts[i]?.length)) ?? CASES.find((x) => x !== c);
    if (sibling === undefined) throw new Error("no other entry");
    const underOther = door(rt, c, { key: refKey(rt, sibling, sibling.parts) });
    expect(underOther.decoded ? "decoded" : underOther.refused).toMatch(new RegExp(`^${name.replace(".", "\\.")}: the key asked is `));
    // The key of this entry at the other account or hash, with this one's key parts: refused.
    expect(door(rt, c, { key: refKey(rt, c, c.other) })).toEqual({ decoded: false, refused: `${name}: the key asked is not the key of this entry and these key parts` });
    // The other account's key parts with this one's key asked: refused the same.
    expect(door(rt, c, { keys: c.other })).toEqual({ decoded: false, refused: `${name}: the key asked is not the key of this entry and these key parts` });
  });

  it.each(BOTH)("%s, spec %i: a value the test states, encoded by the reference, is decoded by the door to that value; absence is told apart from a stored value", (_name, _spec, rt, c) => {
    const e = entryOf(rt, c);
    const v = door(rt, c);
    if (!v.decoded) throw new Error(v.refused);
    expect(v.stored).toBe(true);
    expect(plain(rt.md, "ours", e.value, v.value)).toEqual(plain(rt.md, "reference", e.value, c.value));
    const absent = door(rt, c, { answer: null });
    if (!absent.decoded) throw new Error(absent.refused);
    expect(absent.stored).toBe(false);
    if (e.modifier === "Optional") expect(absent.value).toBeNull();
    else {
      // A Default entry absent is its default; the default's bytes stored are stored.
      const fallback = rt.ref.buildStorage(c.pallet, c.entry).value.dec(e.fallback.slice());
      expect(plain(rt.md, "ours", e.value, absent.value)).toEqual(plain(rt.md, "reference", e.value, fallback));
      expect(door(rt, c, { answer: e.fallback })).toMatchObject({ decoded: true, stored: true, value: absent.value });
    }
  });

  it.each(RUNTIMES.map((rt) => [rt.r.specVersion, rt] as const))("spec %i: System.Account is nonce, consumers, providers and sufficients as numbers, and the four amounts of data as decimal text, one above 2^64", (_spec, rt) => {
    const c = CASES[0] as Case;
    expect(door(rt, c)).toMatchObject({
      decoded: true,
      stored: true,
      value: { nonce: 7, consumers: 1, providers: 2, sufficients: 0, data: { free: (2n ** 64n + 12345n).toString(), reserved: "3", frozen: "0", flags: "0" } },
    });
    // Absent, it is the metadata's default, not stored: all zero but the top bit of flags, as the default bytes state.
    expect(entryOf(rt, c).fallback.at(-1)).toBe(0x80);
    expect(door(rt, c, { answer: null })).toMatchObject({ decoded: true, stored: false, value: { nonce: 0, consumers: 0, providers: 0, sufficients: 0, data: { free: "0", reserved: "0", frozen: "0", flags: (1n << 127n).toString() } } });
  });

  it("states the values in our form for the plain entries: a number, a list of account pairs, a hash, a list of hashes and a miner's record", () => {
    const rt = RUNTIMES[1] as Runtime;
    const at = (entry: string) => door(rt, CASES.find((c) => c.entry === entry) as Case);
    expect(at("FailedAcks")).toMatchObject({ value: 3 });
    expect(at("CalibrationVersions")).toMatchObject({ value: 2 });
    expect(at("DelegateSessions")).toMatchObject({ value: [[U.inputs.accounts.owner.value, U.inputs.accounts.device_1.value], [U.inputs.accounts.device_1.value, U.inputs.accounts.owner.value]] });
    expect(at("MeasuredRoots")).toMatchObject({ value: GATEWAY });
    expect(at("AllowedDecodePolicies")).toMatchObject({ value: [GATEWAY, OURS] });
    expect(at("Miners")).toMatchObject({ value: { self_stake: (2n ** 70n).toString(), delegated_stake: "5", commission_rate: 50_000_000, is_active: true, total_rewards_earned: "0", registered_at: 42 } });
  });
});
