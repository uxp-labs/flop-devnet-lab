// The plan of the fifth request list, recordings/requests.json: the lab's devnet test of the chain
// encoder (research/2026-11-12-encoder-devnet-test), run on 2026-11-13 at spec 1014020, its nine
// blocks: the finalized block the run started from, then the block of each of the eight transactions
// sent (T7 was not needed and has no block). Nothing in it is typed by hand: the accounts, the
// channel, the heights and the block hashes come from recordings/requests-inputs.json, each with the
// file and field it was taken from, and every storage key is built from the recorded metadata of spec
// 1014020 (core.ts). What is read at which block is the plan below, the lead's design, reviewed like
// code. test/encoder-requests.test.ts holds the list to it byte for byte, reads it a second way from
// the encoder test's steps.json and results.json, derives each key a second way with the reference
// decoder, and holds each input to the record it names.
//
// The list is the finalized head, the genesis hash, and for each block the canonical hash at its
// height and one state_queryStorageAt at its hash; after the batch of each step's block, the block
// itself (chain_getBlock), so the recording holds the extrinsics as the block holds them; and after
// that, for the four steps signed with a mortal era (T3 to T6), the canonical hash at the era's birth
// height, the hash the step's signature binds: 32 calls. Every batch asks the same eight keys in
// the fixed order of READS, at every block: the final record of the test needs the accounts, the
// session, the session nonce and the breaker after every step, and the channel of T3 is read before it
// exists, while it is open and after it expired. System.Account is not in the decoder's reviewed shape
// (src/scale/shape.ts): the recorder asks any key, and its decode is a later piece. The named account
// is an input because the whys name the miner of the channel, whole, so the list changes with it; no
// key is built from it.
import type { Metadata } from "../../../src/scale/metadata.js";
import * as core from "./core.js";

export const ACCOUNTS = ["owner", "device", "named"] as const;
export const CHANNELS = ["t3"] as const;
/** The steps of the run that have a block, in the order of steps.json: every step but T7. */
export const STEP_IDS = ["T1", "T2", "T3", "T4", "T5", "T6", "T8", "T9"] as const;
export type Account = (typeof ACCOUNTS)[number];
export type Channel = (typeof CHANNELS)[number];
export type StepId = (typeof STEP_IDS)[number];
/** The steps signed with a mortal era, whose birth block's hash the signature binds (run-2026-11-13/signed/T<id>.json, era). */
export const MORTAL_IDS = ["T3", "T4", "T5", "T6"] as const satisfies readonly StepId[];
export type MortalId = (typeof MORTAL_IDS)[number];
export type Block = "encoder-devnet-test/start" | `encoder-devnet-test/${StepId}` | `encoder-devnet-test/${MortalId}-birth`;
export const START: Block = "encoder-devnet-test/start";
export const blockOf = (id: StepId): Block => `encoder-devnet-test/${id}`;
export const birthOf = (id: MortalId): Block => `encoder-devnet-test/${id}-birth`;
const isMortal = (id: StepId): id is MortalId => (MORTAL_IDS as readonly StepId[]).includes(id);
/** The nine blocks read, in order: the start, then each step's block. */
export const BLOCKS: readonly Block[] = [START, ...STEP_IDS.map(blockOf)];
/** The four birth blocks, asked by height only. */
export const BIRTHS: readonly Block[] = MORTAL_IDS.map(birthOf);
export const MENTIONED = [] as const;
export type Mentioned = never;
export const NAMES: core.Names<Account, Channel, Block, Mentioned> = { accounts: ACCOUNTS, channels: CHANNELS, blocks: [...BLOCKS, ...BIRTHS], mentioned: MENTIONED };

export type Inputs = core.Inputs<Account, Channel, Block, Mentioned>;
export type Read = core.Read<Account, Channel>;
export type DerivedCall = core.DerivedCall<Account, Channel, Block>;
type Spec = core.CallSpec<Account, Channel, Block>;

/** The inputs file of this list read: in the written form, with exactly the names the plan uses. Throws when it is not. */
export const readInputs = (text: string): Inputs => core.readInputs(text, NAMES);

/** The eight keys every batch asks, in this fixed order, at every block. */
export const READS: readonly Read[] = [
  { pallet: "System", entry: "Events", keys: [] },
  { pallet: "System", entry: "LastRuntimeUpgrade", keys: [] },
  { pallet: "System", entry: "Account", keys: [{ account: "owner" }] },
  { pallet: "System", entry: "Account", keys: [{ account: "device" }] },
  { pallet: "FlopSessionKeys", entry: "Sessions", keys: [{ account: "owner" }, { account: "device" }] },
  { pallet: "FlopSessionKeys", entry: "SessionNonces", keys: [{ account: "owner" }, { account: "device" }] },
  { pallet: "FlopSessionKeys", entry: "CircuitBreakers", keys: [{ account: "device" }] },
  { pallet: "ComputeChannel", entry: "Channels", keys: [{ channel: "t3" }] },
];

/** One step of the run as this list reads it: what was sent, and the outcome its run time record gives. */
export interface Step {
  id: StepId;
  sent: string;
  outcome: "success" | `refused with ${string}`;
}

/** The eight steps with a block, in the order of steps.json. */
export const STEPS: readonly Step[] = [
  { id: "T1", sent: "the owner sends the device its fees", outcome: "success" },
  { id: "T2", sent: "the owner creates the session for the device", outcome: "success" },
  { id: "T3", sent: "the device sends ComputeChannel.force_open through the session, signed through the lab's encoder with a mortal era and a declared spend equal to the escrow", outcome: "success" },
  { id: "T4", sent: "the device sends ComputeChannel.top_up_escrow on the channel of T3 through the session, signed through the lab's encoder", outcome: "refused with ComputeChannel.BadState" },
  { id: "T5", sent: "the device sends ComputeChannel.open_channel through the session, signed through the lab's encoder", outcome: "refused with ComputeChannel.CalibrationUnavailable" },
  { id: "T6", sent: "the device sends ComputeChannel.expire_force_open for the channel of T3 through the session, signed through the lab's encoder", outcome: "success" },
  { id: "T8", sent: "the owner revokes the session of the device", outcome: "success" },
  { id: "T9", sent: "the device sends all it holds back to the owner", outcome: "success" },
];

const ACCOUNT_LABEL: Record<Account, string> = { owner: "the owner", device: "the device", named: "the named miner" };
const keyWords = (inputs: Inputs, k: core.KeyInput<Account, Channel>) =>
  "account" in k ? `${ACCOUNT_LABEL[k.account]} ${core.short(inputs.accounts[k.account].value)}` : `the channel of T3 ${core.short(inputs.channels[k.channel].value)}, the force_open to ${ACCOUNT_LABEL.named} ${inputs.accounts.named.value}`;
const readWords = (inputs: Inputs, r: Read) => (r.keys.length === 0 ? `${r.pallet}.${r.entry}` : `${r.pallet}.${r.entry} of ${r.keys.map((k) => keyWords(inputs, k)).join(" and ")}`);

/** What a block is, in words: the start of the run, or the step sent in it and the outcome the run time record gives. */
function blockWords(id: StepId | null): string {
  if (id === null) return "the finalized block the run started from, before any step";
  const s = STEPS.find((x) => x.id === id) as Step;
  return `the block where ${s.sent} (step ${s.id}; the run time record says ${s.outcome})`;
}

/**
 * The plan as call specs, in order, each with its why: the heads, then for each block its hash by
 * height and one batch at that hash; for a step's block then the block itself, and for a mortal step
 * then the hash at its era's birth height.
 */
export function plan(inputs: Inputs): Spec[] {
  const out: Spec[] = [
    { kind: "head", why: "the finalized head when the run read it: every block below must be at or under it" },
    { kind: "genesis", why: "the genesis hash, so the recording names the chain it was read from" },
  ];
  const what = (b: Block) => (b === START ? "the start of the run" : `step ${b.split("/")[1]}`);
  for (const [i, b] of BLOCKS.entries()) {
    const h = inputs.blocks[b].height.value;
    const id = i === 0 ? null : (STEP_IDS[i - 1] as StepId);
    out.push(
      { kind: "hash", block: b, why: `the canonical hash at height ${h}, to compare with ${inputs.blocks[b].hash.value}, the hash the encoder test's results.json holds for ${what(b)}` },
      {
        kind: "batch",
        block: b,
        reads: READS,
        why: `at block ${h}, ${blockWords(id)}: System.Events, the events of every extrinsic of the block, and System.LastRuntimeUpgrade, the runtime that executed it, then the stored values at the block: ${READS.slice(2).map((r) => readWords(inputs, r)).join(", ")}; asked together in one call, answered as one set for the block, a key that holds nothing listed with null`,
      },
    );
    if (id === null) continue;
    out.push({ kind: "block", block: b, why: `the block ${h} of step ${id}, its header and extrinsics: the extrinsic at the index the run time record names for step ${id} must be byte for byte the signed extrinsic of step ${id}` });
    if (isMortal(id)) {
      const birth = inputs.blocks[birthOf(id)];
      out.push({
        kind: "hash",
        block: birthOf(id),
        why: `the canonical hash at height ${birth.height.value}, to compare with ${birth.hash.value}, the birth block of the mortal era step ${id} was signed with: the signature of step ${id} binds this block's hash`,
      });
    }
  }
  return out;
}

/** The whole list, call by call, from the inputs and the parsed metadata of spec 1014020. Pure. */
export const deriveCalls = (inputs: Inputs, md: Metadata): DerivedCall[] => core.deriveCalls(plan(inputs), inputs, md);

/** The list as recordings/requests.json holds it: the written form of the derived calls. */
export const deriveRequestsText = (inputs: Inputs, md: Metadata): string => core.requestsText(deriveCalls(inputs, md));
