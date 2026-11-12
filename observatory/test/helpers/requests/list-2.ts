// The plan of the second request list: the storage the lab's two devnet session tests left behind,
// read block by block. Its recording is fixtures/recording-20261112004113-0b2b505d2d4b703b, and
// that folder keeps the list (requests.json) and the inputs it was derived from
// (requests-inputs.json), frozen. Nothing in it is typed by hand: the accounts, channel ids, heights
// and block hashes come from those inputs, each with the file and field it was taken from, and every
// storage key is built from the recorded metadata (core.ts). What is read at which block is the plan
// below, the lead's design, reviewed like code. test/storage-requests.test.ts holds the frozen list
// to it byte for byte, derives each key a second way with the reference decoder, and holds each
// input to the test record it names.
import type { Metadata } from "../../../src/scale/metadata.js";
import * as core from "./core.js";

export type { Source } from "./core.js";
export { INPUTS_SCHEMA } from "./core.js";

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
export const NAMES: core.Names<Account, Channel, Block, Mentioned> = { accounts: ACCOUNTS, channels: CHANNELS, blocks: BLOCKS, mentioned: MENTIONED };

export type Inputs = core.Inputs<Account, Channel, Block, Mentioned>;
export type Read = core.Read<Account, Channel>;
export type DerivedCall = core.DerivedCall<Account, Channel, Block>;

/** The inputs file of this list read: in the written form, with exactly the names the plan uses. Throws when it is not. */
export const readInputs = (text: string): Inputs => core.readInputs(text, NAMES);

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

function keyWords(inputs: Inputs, r: Read): string {
  return r.keys
    .map((k) => ("account" in k ? `${ACCOUNT_LABEL[k.account]} ${core.short(inputs.accounts[k.account].value)}` : `${CHANNEL_LABEL[k.channel]} ${core.short(inputs.channels[k.channel].value)}`))
    .join(" and ");
}

/** The plan as call specs, in order, each with its why: the heads, then each block of PLAN, then the runtime and metadata at LAST. */
export function plan(inputs: Inputs): core.CallSpec<Account, Channel, Block>[] {
  const heightOf = (b: Block | Mentioned) => (b in inputs.blocks ? inputs.blocks[b as Block] : inputs.mentioned[b as Mentioned]).height.value;
  const out: core.CallSpec<Account, Channel, Block>[] = [
    { kind: "head", why: "the finalized head when the run read it: every block below must be at or under it" },
    { kind: "genesis", why: "the genesis hash, so the recording names the chain it was read from" },
  ];
  for (const step of PLAN) {
    const h = heightOf(step.block);
    const hash = inputs.blocks[step.block].hash.value;
    const happened = step.happened(heightOf);
    const record = RECORD_LABEL[step.block.split("/")[0] as string];
    out.push(
      { kind: "hash", block: step.block, why: `the canonical hash at height ${h}, to compare with ${hash}, the hash ${record} holds for that block` },
      { kind: "upgrade", block: step.block, why: `System.LastRuntimeUpgrade at block ${h}: the runtime the block was written under, which the shape pin reads before anything is decoded` },
    );
    for (const r of step.reads) {
      const what = r.keys.length === 0 ? `${r.pallet}.${r.entry}` : `${r.pallet}.${r.entry} of ${keyWords(inputs, r)}`;
      out.push({ kind: "storage", block: step.block, read: r, why: `${what} at block ${h}, ${happened}` });
    }
  }
  const h = heightOf(LAST);
  out.push(
    { kind: "version", block: LAST, why: `the runtime version at block ${h}, the last block of the lab's second session test, which pins the spec the metadata belongs to` },
    { kind: "metadata", block: LAST, why: `the metadata at block ${h}, the last block of the lab's second session test: the types every storage value in this recording is decoded with` },
  );
  return out;
}

/** The whole list, call by call, from the inputs and the parsed recorded metadata. Pure. */
export const deriveCalls = (inputs: Inputs, md: Metadata): DerivedCall[] => core.deriveCalls(plan(inputs), inputs, md);

/** The list as its recording's fixture holds it: the written form of the derived calls. */
export const deriveRequestsText = (inputs: Inputs, md: Metadata): string => core.requestsText(deriveCalls(inputs, md));
