// What every derived request list shares, and no list of its own: an input with the file and field
// it was taken from, the reader of an inputs file against a table of names, the storage key
// builder, and a plan as an ordered list of call specs turned into calls. Each list has one plan
// module beside this one (list-2.ts, list-3.ts, list-4.ts), which names its inputs and says what is
// read at which block and why. Nothing here is typed for one list.
//
// It lives with the tests, not in src: the source scan lets src outside src/scale import only
// src/scale/block.ts, and nothing in src needs a list.
import { feedText } from "../../../src/feed.js";
import { REQUESTS_SCHEMA, type RequestCall } from "../../../src/requests.js";
import type { Metadata } from "../../../src/scale/metadata.js";
import { fromHex, toHex } from "../../../src/scale/reader.js";
import { storageKey } from "../../../src/scale/storage-key.js";

export const INPUTS_SCHEMA = "flop-observatory/requests-inputs@0";

/** One input: its value, and the file and field it was taken from. */
export interface Source<T> {
  file: string;
  field: string;
  value: T;
}

/** The names a list's inputs file holds: its accounts, channels, blocks read at, and blocks a why names by height only. */
export interface Names<A extends string, C extends string, B extends string, M extends string> {
  accounts: readonly A[];
  channels: readonly C[];
  blocks: readonly B[];
  mentioned: readonly M[];
}

export interface Inputs<A extends string, C extends string, B extends string, M extends string> {
  accounts: Record<A, Source<string>>;
  channels: Record<C, Source<string>>;
  blocks: Record<B, { height: Source<number>; hash: Source<string> }>;
  mentioned: Record<M, { height: Source<number> }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const HEX32 = /^0x[0-9a-f]{64}$/;

function source<T>(v: unknown, what: string, valid: (x: unknown) => x is T): Source<T> {
  if (!isRecord(v) || !sameKeys(v, ["field", "file", "value"])) throw new Error(`${what} must hold exactly field, file and value`);
  if (typeof v.file !== "string" || v.file === "" || typeof v.field !== "string" || v.field === "") throw new Error(`${what} must name its file and field`);
  if (!valid(v.value)) throw new Error(`${what} has a value of the wrong form`);
  return { file: v.file, field: v.field, value: v.value };
}
const hex32 = (x: unknown): x is string => typeof x === "string" && HEX32.test(x);
const height = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;

function named<K extends string, T>(v: unknown, names: readonly K[], what: string, each: (x: unknown, what: string) => T): Record<K, T> {
  if (!isRecord(v) || !sameKeys(v, names)) throw new Error(`${what} must hold exactly ${names.join(", ")}`);
  return Object.fromEntries(names.map((n) => [n, each(v[n], `${what}.${n}`)])) as Record<K, T>;
}

/** An inputs file read: in the written form, with exactly the names the table gives. Throws when it is not. */
export function readInputs<A extends string, C extends string, B extends string, M extends string>(text: string, names: Names<A, C, B, M>): Inputs<A, C, B, M> {
  const v: unknown = JSON.parse(text);
  if (feedText(v) !== text) throw new Error("the inputs file is not in the written form");
  if (!isRecord(v) || !sameKeys(v, ["accounts", "blocks", "channels", "mentioned", "schema"]) || v.schema !== INPUTS_SCHEMA) throw new Error(`the inputs file is not a ${INPUTS_SCHEMA}`);
  return {
    accounts: named(v.accounts, names.accounts, "accounts", (x, w) => source(x, w, hex32)),
    channels: named(v.channels, names.channels, "channels", (x, w) => source(x, w, hex32)),
    blocks: named(v.blocks, names.blocks, "blocks", (x, w) => {
      if (!isRecord(x) || !sameKeys(x, ["hash", "height"])) throw new Error(`${w} must hold exactly hash and height`);
      return { height: source(x.height, `${w}.height`, height), hash: source(x.hash, `${w}.hash`, hex32) };
    }),
    mentioned: named(v.mentioned, names.mentioned, "mentioned", (x, w) => {
      if (!isRecord(x) || !sameKeys(x, ["height"])) throw new Error(`${w} must hold exactly height`);
      return { height: source(x.height, `${w}.height`, height) };
    }),
  };
}

/** One map key of a storage read: an account or a channel of the inputs. */
export type KeyInput<A extends string, C extends string> = { account: A } | { channel: C };

/** One storage read: an entry and the inputs its map keys are, in key order. */
export interface Read<A extends string, C extends string> {
  pallet: string;
  entry: string;
  keys: KeyInput<A, C>[];
}

/**
 * One call of a plan, before the inputs are put in: the finalized head, the genesis hash, a block's
 * hash by its height, the runtime version or the metadata at a block's hash, System.LastRuntimeUpgrade
 * at a block's hash (the runtime record the shape pin reads), or a storage entry with its key inputs
 * at a block's hash, or a batch of storage entries read together at a block's hash
 * (state_queryStorageAt: one call, one answer for the block, the keys in the plan's order), or a
 * block's header and extrinsics at its hash (chain_getBlock). Each with its why, one plain line.
 */
export type CallSpec<A extends string, C extends string, B extends string> =
  | { kind: "head"; why: string }
  | { kind: "genesis"; why: string }
  | { kind: "hash"; block: B; why: string }
  | { kind: "version"; block: B; why: string }
  | { kind: "metadata"; block: B; why: string }
  | { kind: "upgrade"; block: B; why: string }
  | { kind: "storage"; block: B; read: Read<A, C>; why: string }
  | { kind: "batch"; block: B; reads: readonly Read<A, C>[]; why: string }
  | { kind: "block"; block: B; why: string };

/** One call of a derived list, with the block it is made at and the storage entry it reads, if any, or the entries of a batch in the order asked. */
export interface DerivedCall<A extends string, C extends string, B extends string> {
  call: RequestCall;
  block: B | null;
  read: Read<A, C> | null;
  reads: readonly Read<A, C>[] | null;
}

/** The SCALE bytes of a read's map keys, from the inputs. */
export function keyBytes<A extends string, C extends string>(inputs: Inputs<A, C, string, string>, r: Read<A, C>): Uint8Array[] {
  return r.keys.map((k) => fromHex("account" in k ? inputs.accounts[k.account].value : inputs.channels[k.channel].value));
}

/** A storage key as hex, built from the metadata with the hashers it states. */
export const keyHex = (md: Metadata, pallet: string, entry: string, keys: Uint8Array[]): string => toHex(storageKey(md, pallet, entry, keys));

/**
 * The keys of a batch, in the order the plan gives its reads. Throws on an empty batch or one that
 * asks a key twice: the reader of the answer refuses a key listed twice, so the list never asks one.
 */
export function batchKeys<A extends string, C extends string>(inputs: Inputs<A, C, string, string>, reads: readonly Read<A, C>[], md: Metadata): string[] {
  if (reads.length === 0) throw new Error("a batch must read at least one storage entry");
  const keys = reads.map((r) => keyHex(md, r.pallet, r.entry, keyBytes(inputs, r)));
  if (new Set(keys).size !== keys.length) throw new Error("a batch asks the same storage key twice");
  return keys;
}

/** The calls of a plan, in its order, with the inputs put in and every storage key built from the metadata. Pure. */
export function deriveCalls<A extends string, C extends string, B extends string, M extends string>(plan: readonly CallSpec<A, C, B>[], inputs: Inputs<A, C, B, M>, md: Metadata): DerivedCall<A, C, B>[] {
  const hashOf = (b: B) => inputs.blocks[b].hash.value;
  return plan.map((s): DerivedCall<A, C, B> => {
    switch (s.kind) {
      case "head":
        return { call: { method: "chain_getFinalizedHead", params: [], why: s.why }, block: null, read: null, reads: null };
      case "genesis":
        return { call: { method: "chain_getBlockHash", params: [0], why: s.why }, block: null, read: null, reads: null };
      case "hash":
        return { call: { method: "chain_getBlockHash", params: [inputs.blocks[s.block].height.value], why: s.why }, block: s.block, read: null, reads: null };
      case "version":
        return { call: { method: "state_getRuntimeVersion", params: [hashOf(s.block)], why: s.why }, block: s.block, read: null, reads: null };
      case "metadata":
        return { call: { method: "state_getMetadata", params: [hashOf(s.block)], why: s.why }, block: s.block, read: null, reads: null };
      case "upgrade":
        return { call: { method: "state_getStorage", params: [keyHex(md, "System", "LastRuntimeUpgrade", []), hashOf(s.block)], why: s.why }, block: s.block, read: null, reads: null };
      case "storage":
        return { call: { method: "state_getStorage", params: [keyHex(md, s.read.pallet, s.read.entry, keyBytes(inputs, s.read)), hashOf(s.block)], why: s.why }, block: s.block, read: s.read, reads: null };
      case "batch":
        return { call: { method: "state_queryStorageAt", params: [batchKeys(inputs, s.reads, md), hashOf(s.block)], why: s.why }, block: s.block, read: null, reads: s.reads };
      case "block":
        return { call: { method: "chain_getBlock", params: [hashOf(s.block)], why: s.why }, block: s.block, read: null, reads: null };
    }
  });
}

/** A list as recordings/requests.json holds it: the written form of the derived calls. */
export function requestsText(calls: readonly DerivedCall<string, string, string>[]): string {
  return feedText({ schema: REQUESTS_SCHEMA, calls: calls.map((d) => d.call) });
}

/** The first characters of a hex value, as a why names an account or a channel. */
export const short = (hex: string) => `${hex.slice(0, 10)}...`;
