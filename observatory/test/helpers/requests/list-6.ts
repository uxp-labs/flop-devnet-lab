// The plan of the sixth request list, recordings/requests.json: the two blocks of the first
// recording where a compute channel settled, block by block. The gateway's channel settled in one
// and another channel in the other, each by the one ComputeChannel.Settled event in that block's
// System.Events on the first recording's tape. Each block is read whole (chain_getBlock), so the
// recording holds the settle call's bytes as the block holds them, with the block's events, its
// runtime and the channel's stored record at the block; and the block's parent is read for the
// channel's record before the settle.
//
// Nothing in it is typed by hand: the channels, the heights and the block hashes come from
// recordings/requests-inputs.json, each with the file and field it was taken from (all on the first
// recording's tape), and every storage key is built from the reviewed metadata of the runtime this
// plan names (RUNTIME): the spec that System.LastRuntimeUpgrade, as the first recording read it at
// the gateway's settled block, names through runtimeOfBlock (test/helpers/requests-list.ts). A
// parent block's height is the one derived number: its child's recorded header's number less one,
// which its field says in those words. test/settle-requests.test.ts holds the list to this plan
// byte for byte, derives each key a second way with the reference decoder, and holds each input to
// the tape it names.
import type { Metadata } from "../../../src/scale/metadata.js";
import * as core from "./core.js";

export const ACCOUNTS = [] as const;
/** The two channels that settled: the gateway's, and the other one. */
export const CHANNELS = ["gateway", "second"] as const;
export type Account = never;
export type Channel = (typeof CHANNELS)[number];
export type Block = `${Channel}/settled` | `${Channel}/settled-parent`;
export const settledOf = (c: Channel): Block => `${c}/settled`;
export const parentOf = (c: Channel): Block => `${c}/settled-parent`;
/** The four blocks read, in order: for each channel its settled block, then that block's parent. */
export const BLOCKS: readonly Block[] = CHANNELS.flatMap((c) => [settledOf(c), parentOf(c)]);
export const MENTIONED = [] as const;
export type Mentioned = never;
export const NAMES: core.Names<Account, Channel, Block, Mentioned> = { accounts: ACCOUNTS, channels: CHANNELS, blocks: BLOCKS, mentioned: MENTIONED };

/** The tape every input and the runtime are taken from: the first recording's. */
export const TAPE = "observatory/fixtures/recording-20261111160917-3c228907aa129a01/tape.jsonl";
/**
 * The runtime every key is built for, named by a file, a field and a block of this plan: the
 * System.LastRuntimeUpgrade the first recording read at the gateway's settled block, whose spec
 * runtimeOfBlock names. The field passes only when its tape line is that read at that block
 * (specNamed in test/helpers/requests-list.ts).
 */
export const RUNTIME = { file: TAPE, field: "the answer to the state_getStorage call at seq 21", block: settledOf("gateway") } as const;

export type Inputs = core.Inputs<Account, Channel, Block, Mentioned>;
export type Read = core.Read<Account, Channel>;
export type DerivedCall = core.DerivedCall<Account, Channel, Block>;
type Spec = core.CallSpec<Account, Channel, Block>;

/** The inputs file of this list read: in the written form, with exactly the names the plan uses. Throws when it is not. */
export const readInputs = (text: string): Inputs => core.readInputs(text, NAMES);

const EVENTS: Read = { pallet: "System", entry: "Events", keys: [] };
const UPGRADE: Read = { pallet: "System", entry: "LastRuntimeUpgrade", keys: [] };
const record = (c: Channel): Read => ({ pallet: "ComputeChannel", entry: "Channels", keys: [{ channel: c }] });
/** What one batch asks at a settled block, in this fixed order. */
export const settledReads = (c: Channel): readonly Read[] => [EVENTS, UPGRADE, record(c)];
/** What one batch asks at a settled block's parent, in this fixed order. */
export const parentReads = (c: Channel): readonly Read[] => [UPGRADE, record(c)];

const LABEL: Record<Channel, string> = { gateway: "the gateway's channel", second: "the other channel" };
const SAID = "a key that holds nothing listed with null";

/**
 * The plan as call specs, in order, each with its why: the heads, then for each channel the hash at
 * its settled block's height, the block, one batch at it, the hash at the parent's height and one
 * batch at the parent.
 */
export function plan(inputs: Inputs): Spec[] {
  const out: Spec[] = [
    { kind: "head", why: "the finalized head when the list was read: every block below must be at or under it" },
    { kind: "genesis", why: "the genesis hash, so the recording names the chain it was read from" },
  ];
  for (const c of CHANNELS) {
    const s = inputs.blocks[settledOf(c)];
    const p = inputs.blocks[parentOf(c)];
    const channel = `${LABEL[c]} ${core.short(inputs.channels[c].value)}`;
    const where = `the block where ${channel} settled, by the ComputeChannel.Settled event of the first recording`;
    out.push(
      { kind: "hash", block: settledOf(c), why: `the canonical hash at height ${s.height.value}, to compare with ${s.hash.value}, the hash the first recording's tape answered for ${where}` },
      { kind: "block", block: settledOf(c), why: `the block ${s.height.value}, ${where}: its header and extrinsics, so the recording holds the settle call's bytes as the block holds them` },
      {
        kind: "batch",
        block: settledOf(c),
        reads: settledReads(c),
        why: `at block ${s.height.value}, ${where}: System.Events, the events of every extrinsic of the block, System.LastRuntimeUpgrade, the runtime that executed it, and ComputeChannel.Channels of ${channel}, its stored record at the block; asked together in one call, answered as one set for the block, ${SAID}`,
      },
      { kind: "hash", block: parentOf(c), why: `the canonical hash at height ${p.height.value}, to compare with ${p.hash.value}, the parentHash of the header the first recording's tape holds for block ${s.height.value}, ${where}` },
      {
        kind: "batch",
        block: parentOf(c),
        reads: parentReads(c),
        why: `at block ${p.height.value}, the parent of ${where}, read for the channel's record before the settle: System.LastRuntimeUpgrade, the runtime that executed it, and ComputeChannel.Channels of ${channel}; asked together in one call, answered as one set for the block, ${SAID}`,
      },
    );
  }
  return out;
}

/** The whole list, call by call, from the inputs and the parsed metadata of the runtime RUNTIME names. Pure. */
export const deriveCalls = (inputs: Inputs, md: Metadata): DerivedCall[] => core.deriveCalls(plan(inputs), inputs, md);

/** The list as recordings/requests.json holds it: the written form of the derived calls. */
export const deriveRequestsText = (inputs: Inputs, md: Metadata): string => core.requestsText(deriveCalls(inputs, md));
