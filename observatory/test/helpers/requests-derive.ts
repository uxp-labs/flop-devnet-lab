// The second request list (recordings/requests.json), derived. Nothing in it is typed by hand: the
// accounts, channel ids, heights and block hashes come from recordings/requests-inputs.json, each
// with the file and field it was taken from, and every storage key is built from the recorded
// metadata with the hashers it states (src/scale/storage-key.ts). What is read at which block is
// the plan below, the lead's design, reviewed like code. test/storage-requests.test.ts holds the
// list to this function byte for byte, derives each key a second way with the reference decoder,
// and holds each input to the test record it names.
//
// It lives with the tests, not in src: the source scan lets src outside src/scale import only
// src/scale/block.ts, and nothing in src needs this list.
import { feedText } from "../../src/feed.js";
import { REQUESTS_SCHEMA, type RequestCall } from "../../src/requests.js";
import type { Metadata } from "../../src/scale/metadata.js";
import { fromHex, toHex } from "../../src/scale/reader.js";
import { storageKey } from "../../src/scale/storage-key.js";

export const INPUTS_SCHEMA = "flop-observatory/requests-inputs@0";

/** One input: its value, and the file and field it was taken from. */
export interface Source<T> {
  file: string;
  field: string;
  value: T;
}

export const ACCOUNTS = ["owner", "device_1", "device_2"] as const;
export const CHANNELS = ["ours", "gateway"] as const;
export const BLOCKS = [
  "session-escrow/2-create-session",
  "session-escrow/3-force-open-declared-0",
  "session-escrow/4-force-open-declared-0.012",
  "session-escrow/6-force-open-over-daily",
  "session-escrow/7-expire-force-open",
  "session-escrow/8-revoke-session",
  "session-escrow/9-return-funds",
  "session-probe/2-create-session",
  "session-probe/3-timeout-via-session",
  "session-probe/4-remark-via-session",
  "session-probe/5-revoke-session",
  "gateway/settled",
] as const;
/** Blocks no call reads at, which a why names by height only. */
export const MENTIONED = ["session-escrow/5-force-open-over-per-call"] as const;
export type Account = (typeof ACCOUNTS)[number];
export type Channel = (typeof CHANNELS)[number];
export type Block = (typeof BLOCKS)[number];
export type Mentioned = (typeof MENTIONED)[number];

export interface Inputs {
  accounts: Record<Account, Source<string>>;
  channels: Record<Channel, Source<string>>;
  blocks: Record<Block, { height: Source<number>; hash: Source<string> }>;
  mentioned: Record<Mentioned, { height: Source<number> }>;
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

/** The inputs file read: in the written form, with exactly the names the plan uses. Throws when it is not. */
export function readInputs(text: string): Inputs {
  const v: unknown = JSON.parse(text);
  if (feedText(v) !== text) throw new Error("the inputs file is not in the written form");
  if (!isRecord(v) || !sameKeys(v, ["accounts", "blocks", "channels", "mentioned", "schema"]) || v.schema !== INPUTS_SCHEMA) throw new Error(`the inputs file is not a ${INPUTS_SCHEMA}`);
  return {
    accounts: named(v.accounts, ACCOUNTS, "accounts", (x, w) => source(x, w, hex32)),
    channels: named(v.channels, CHANNELS, "channels", (x, w) => source(x, w, hex32)),
    blocks: named(v.blocks, BLOCKS, "blocks", (x, w) => {
      if (!isRecord(x) || !sameKeys(x, ["hash", "height"])) throw new Error(`${w} must hold exactly hash and height`);
      return { height: source(x.height, `${w}.height`, height), hash: source(x.hash, `${w}.hash`, hex32) };
    }),
    mentioned: named(v.mentioned, MENTIONED, "mentioned", (x, w) => {
      if (!isRecord(x) || !sameKeys(x, ["height"])) throw new Error(`${w} must hold exactly height`);
      return { height: source(x.height, `${w}.height`, height) };
    }),
  };
}

/** One storage read: an entry and the inputs its map keys are, in key order. */
export type Read =
  | { pallet: "System"; entry: "Events"; keys: [] }
  | { pallet: "FlopSessionKeys"; entry: "Sessions" | "SessionNonces"; keys: [{ account: "owner" }, { account: Account }] }
  | { pallet: "FlopSessionKeys"; entry: "CircuitBreakers"; keys: [{ account: Account }] }
  | { pallet: "ComputeChannel"; entry: "Channels"; keys: [{ channel: Channel }] };

const EVENTS: Read = { pallet: "System", entry: "Events", keys: [] };
const sessions = (d: Account): Read => ({ pallet: "FlopSessionKeys", entry: "Sessions", keys: [{ account: "owner" }, { account: d }] });
const nonces = (d: Account): Read => ({ pallet: "FlopSessionKeys", entry: "SessionNonces", keys: [{ account: "owner" }, { account: d }] });
const breaker = (d: Account): Read => ({ pallet: "FlopSessionKeys", entry: "CircuitBreakers", keys: [{ account: d }] });
const channel = (c: Channel): Read => ({ pallet: "ComputeChannel", entry: "Channels", keys: [{ channel: c }] });

/** What a test record says came of a step: the error it failed with, or null when it succeeded. */
export interface Outcome {
  block: Block | Mentioned;
  error: string | null;
}

export interface PlanStep {
  block: Block;
  /** What happened in the block, as the why says it after the height. */
  happened: (heightOf: (b: Block | Mentioned) => number) => string;
  /** What the test record says of each step the words above name, checked against it. */
  outcomes: Outcome[];
  reads: Read[];
}

/** The lead's design: each block in the order it is read, with the reads named there. */
export const PLAN: PlanStep[] = [
  {
    block: "session-escrow/2-create-session",
    happened: () => "where owner S created a session for device D2 in the lab's second session test",
    outcomes: [{ block: "session-escrow/2-create-session", error: null }],
    reads: [sessions("device_2"), nonces("device_2")],
  },
  {
    block: "session-escrow/3-force-open-declared-0",
    happened: () => "where device D2 sent a force_open through the session declaring a spend of 0, refused with SpendExceedsDeclared and rolled back, so nothing it touched may have changed",
    outcomes: [{ block: "session-escrow/3-force-open-declared-0", error: "SpendExceedsDeclared" }],
    reads: [EVENTS, sessions("device_2"), nonces("device_2"), breaker("device_2"), channel("ours")],
  },
  {
    block: "session-escrow/4-force-open-declared-0.012",
    happened: () => "where device D2 sent the same force_open through the session declaring enough spend, which opened our channel",
    outcomes: [{ block: "session-escrow/4-force-open-declared-0.012", error: null }],
    reads: [EVENTS, sessions("device_2"), nonces("device_2"), breaker("device_2"), channel("ours")],
  },
  {
    block: "session-escrow/6-force-open-over-daily",
    happened: (h) =>
      `after device D2's two force_open calls over the session's limits were refused, at block ${h("session-escrow/5-force-open-over-per-call")} with PerTxLimitExceeded and in this block with DailyCapExceeded`,
    outcomes: [
      { block: "session-escrow/5-force-open-over-per-call", error: "PerTxLimitExceeded" },
      { block: "session-escrow/6-force-open-over-daily", error: "DailyCapExceeded" },
    ],
    reads: [sessions("device_2"), nonces("device_2"), breaker("device_2")],
  },
  {
    block: "session-escrow/7-expire-force-open",
    happened: () => "where device D2 sent expire_force_open through the session, which closed our channel and refunded its escrow",
    outcomes: [{ block: "session-escrow/7-expire-force-open", error: null }],
    reads: [EVENTS, sessions("device_2"), nonces("device_2"), breaker("device_2"), channel("ours")],
  },
  {
    block: "session-escrow/8-revoke-session",
    happened: () => "where owner S revoked the session of device D2",
    outcomes: [{ block: "session-escrow/8-revoke-session", error: null }],
    reads: [EVENTS, sessions("device_2")],
  },
  {
    block: "session-probe/2-create-session",
    happened: () => "where owner S created a session for device D1 in the lab's first session test",
    outcomes: [{ block: "session-probe/2-create-session", error: null }],
    reads: [sessions("device_1")],
  },
  {
    block: "session-probe/3-timeout-via-session",
    happened: () => "where device D1 sent ComputeChannel.timeout through the session for a made up channel, which reached that pallet and failed with ChannelNotFound",
    outcomes: [{ block: "session-probe/3-timeout-via-session", error: "ChannelNotFound" }],
    reads: [EVENTS],
  },
  {
    block: "session-probe/4-remark-via-session",
    happened: () => "where device D1 sent System.remark through the session, refused by the session pallet with PalletNotAllowed",
    outcomes: [{ block: "session-probe/4-remark-via-session", error: "PalletNotAllowed" }],
    reads: [EVENTS],
  },
  {
    block: "session-probe/5-revoke-session",
    happened: () => "where owner S revoked the session of device D1",
    outcomes: [{ block: "session-probe/5-revoke-session", error: null }],
    reads: [sessions("device_1")],
  },
  {
    block: "gateway/settled",
    happened: () => "where the gateway channel settled, as the first recording's events show, for contrast with our channel",
    outcomes: [],
    reads: [channel("gateway")],
  },
  {
    block: "session-escrow/9-return-funds",
    happened: () => "the last block of the lab's second session test, where device D2 sent its funds back to owner S, for contrast with our channel",
    outcomes: [{ block: "session-escrow/9-return-funds", error: null }],
    reads: [channel("gateway")],
  },
];

/** The block the runtime version and the metadata are read at: the last of the second test. */
export const LAST: Block = "session-escrow/9-return-funds";

const ACCOUNT_LABEL: Record<Account, string> = { owner: "owner S", device_1: "device D1", device_2: "device D2" };
const CHANNEL_LABEL: Record<Channel, string> = { ours: "our channel", gateway: "the gateway channel" };
const RECORD_LABEL: Record<string, string> = {
  "session-escrow": "the lab's second session test",
  "session-probe": "the lab's first session test",
  gateway: "the first recording",
};
const short = (hex: string) => `${hex.slice(0, 10)}...`;

/** One call of the derived list, with the block it is made at and the storage it reads, if any. */
export interface DerivedCall {
  call: RequestCall;
  block: Block | null;
  read: Read | null;
}

function keyWords(inputs: Inputs, r: Read): string {
  return r.keys
    .map((k) => ("account" in k ? `${ACCOUNT_LABEL[k.account]} ${short(inputs.accounts[k.account].value)}` : `${CHANNEL_LABEL[k.channel]} ${short(inputs.channels[k.channel].value)}`))
    .join(" and ");
}

function keyBytes(inputs: Inputs, r: Read): Uint8Array[] {
  return r.keys.map((k) => fromHex("account" in k ? inputs.accounts[k.account].value : inputs.channels[k.channel].value));
}

/** The whole list, call by call, from the inputs and the parsed recorded metadata. Pure. */
export function deriveCalls(inputs: Inputs, md: Metadata): DerivedCall[] {
  const heightOf = (b: Block | Mentioned) => (b in inputs.blocks ? inputs.blocks[b as Block] : inputs.mentioned[b as Mentioned]).height.value;
  const hashOf = (b: Block) => inputs.blocks[b].hash.value;
  const key = (pallet: string, entry: string, keys: Uint8Array[]) => toHex(storageKey(md, pallet, entry, keys));
  const out: DerivedCall[] = [
    { call: { method: "chain_getFinalizedHead", params: [], why: "the finalized head when the run read it: every block below must be at or under it" }, block: null, read: null },
    { call: { method: "chain_getBlockHash", params: [0], why: "the genesis hash, so the recording names the chain it was read from" }, block: null, read: null },
  ];
  for (const step of PLAN) {
    const h = heightOf(step.block);
    const hash = hashOf(step.block);
    const happened = step.happened(heightOf);
    const record = RECORD_LABEL[step.block.split("/")[0] as string];
    out.push(
      { call: { method: "chain_getBlockHash", params: [h], why: `the canonical hash at height ${h}, to compare with ${hash}, the hash ${record} holds for that block` }, block: step.block, read: null },
      {
        call: { method: "state_getStorage", params: [key("System", "LastRuntimeUpgrade", []), hash], why: `System.LastRuntimeUpgrade at block ${h}: the runtime the block was written under, which the shape pin reads before anything is decoded` },
        block: step.block,
        read: null,
      },
    );
    for (const r of step.reads) {
      const what = r.keys.length === 0 ? `${r.pallet}.${r.entry}` : `${r.pallet}.${r.entry} of ${keyWords(inputs, r)}`;
      out.push({ call: { method: "state_getStorage", params: [key(r.pallet, r.entry, keyBytes(inputs, r)), hash], why: `${what} at block ${h}, ${happened}` }, block: step.block, read: r });
    }
  }
  const h = heightOf(LAST);
  const hash = hashOf(LAST);
  out.push(
    { call: { method: "state_getRuntimeVersion", params: [hash], why: `the runtime version at block ${h}, the last block of the lab's second session test, which pins the spec the metadata belongs to` }, block: LAST, read: null },
    { call: { method: "state_getMetadata", params: [hash], why: `the metadata at block ${h}, the last block of the lab's second session test: the types every storage value in this recording is decoded with` }, block: LAST, read: null },
  );
  return out;
}

/** The list as recordings/requests.json holds it: the written form of the derived calls. */
export function deriveRequestsText(inputs: Inputs, md: Metadata): string {
  return feedText({ schema: REQUESTS_SCHEMA, calls: deriveCalls(inputs, md).map((d) => d.call) });
}
