// The plan of the fourth request list, recordings/requests.json: the lab's session rerun at spec
// 1014020 (research/2026-11-12-session-rerun-1014020), its 23 transactions block by block. Nothing in
// it is typed by hand: the accounts, heights and block hashes come from recordings/requests-inputs.json,
// each with the file and field it was taken from, and every storage key is built from the recorded
// metadata of spec 1014020 (core.ts). What is read at which block is the plan below, the lead's
// design, reviewed like code. test/rerun-requests.test.ts holds the list to it byte for byte, reads
// it a second way from the rerun's steps.json and results.json, derives each key a second way with
// the reference decoder, and holds each input to the record it names.
//
// The list is the first to ask state_queryStorageAt. One step's block holds its events, the record of
// the runtime that executed it and the reads its step names in steps.json; asked one key a call, 23
// blocks need 46 calls for the events and the runtime and 26 more for the reads, which is over the 64
// call bound of src/requests.ts. One state_queryStorageAt a block asks every key of that block in one
// call, answered as one set for the block, so the list is 48 calls: the finalized head, the genesis
// hash, and for each step the hash at its height and one batch at that hash.
//
// Every batch reads System.Events and System.LastRuntimeUpgrade first, then the step's reads in the
// fixed order of ENTRY_ORDER. The keys are built from the 1014020 metadata, the runtime that executed
// every block of the run, which the third recording holds (found by the sha256 its REVIEWED line
// names), and the batch at each block reads the LastRuntimeUpgrade that says so.
import type { Metadata } from "../../../src/scale/metadata.js";
import * as core from "./core.js";

export const ACCOUNTS = ["owner", "dev1", "dev2", "named"] as const;
export const CHANNELS = [] as const;
export const STEP_IDS = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12"] as const;
export type Account = (typeof ACCOUNTS)[number];
export type Channel = never;
export type StepId = (typeof STEP_IDS)[number];
export type Block = `session-rerun-1014020/${StepId}`;
export const blockOf = (id: StepId): Block => `session-rerun-1014020/${id}`;
export const BLOCKS: readonly Block[] = STEP_IDS.map(blockOf);
export const MENTIONED = [] as const;
export type Mentioned = never;
export const NAMES: core.Names<Account, Channel, Block, Mentioned> = { accounts: ACCOUNTS, channels: CHANNELS, blocks: BLOCKS, mentioned: MENTIONED };

export type Inputs = core.Inputs<Account, Channel, Block, Mentioned>;
export type Read = core.Read<Account, Channel>;
export type DerivedCall = core.DerivedCall<Account, Channel, Block>;
type Spec = core.CallSpec<Account, Channel, Block>;

/** The inputs file of this list read: in the written form, with exactly the names the plan uses. Throws when it is not. */
export const readInputs = (text: string): Inputs => core.readInputs(text, NAMES);

/** A key of reads_after in the rerun's results form (reads_form in results.template.json). */
export type ReadField = "session_active" | "session_nonce" | "spent_raw" | "epoch_spent_raw" | "breaker_tx_count" | "failed_acks_of_named" | "delegate_sessions_of_device";

/** The storage entries a batch can read after a step, in the order a batch asks them. */
export const ENTRY_ORDER = ["Sessions", "SessionNonces", "CircuitBreakers", "FailedAcks", "DelegateSessions"] as const;
export type Entry = (typeof ENTRY_ORDER)[number];
/** Which entry gives each field of reads_after: a session record gives active, spent and epoch_spent at once. */
export const ENTRY_OF: Record<ReadField, Entry> = {
  session_active: "Sessions",
  spent_raw: "Sessions",
  epoch_spent_raw: "Sessions",
  session_nonce: "SessionNonces",
  breaker_tx_count: "CircuitBreakers",
  failed_acks_of_named: "FailedAcks",
  delegate_sessions_of_device: "DelegateSessions",
};

/** The device of each session: session A is dev1's, session B is dev2's (plan.md, "How it is made small"). */
export const DEVICE_OF: Record<"A" | "B", Account> = { A: "dev1", B: "dev2" };

/** The read of an entry for a session's device, with its map keys. */
export function entryRead(e: Entry, device: Account): Read {
  switch (e) {
    case "Sessions":
      return { pallet: "FlopSessionKeys", entry: "Sessions", keys: [{ account: "owner" }, { account: device }] };
    case "SessionNonces":
      return { pallet: "FlopSessionKeys", entry: "SessionNonces", keys: [{ account: "owner" }, { account: device }] };
    case "CircuitBreakers":
      return { pallet: "FlopSessionKeys", entry: "CircuitBreakers", keys: [{ account: device }] };
    case "FailedAcks":
      return { pallet: "ComputeChannel", entry: "FailedAcks", keys: [{ account: "named" }] };
    case "DelegateSessions":
      return { pallet: "FlopSessionKeys", entry: "DelegateSessions", keys: [{ account: device }] };
  }
}

export const EVENTS: Read = { pallet: "System", entry: "Events", keys: [] };
export const LAST_RUNTIME_UPGRADE: Read = { pallet: "System", entry: "LastRuntimeUpgrade", keys: [] };

/** One step of the rerun as this list reads it: what was sent, what steps.json expects, and the fields of reads_after it names. */
export interface Step {
  id: StepId;
  sent: string;
  expect: string;
  fields: readonly ReadField[];
}

/** The 23 steps in the order of steps.json, each with the reads_after fields steps.json names for it. */
export const STEPS: readonly Step[] = [
  { id: "A1", sent: "the owner sends dev1 its funds", expect: "success", fields: [] },
  { id: "A2", sent: "the owner creates session A for dev1, allow list ComputeChannel", expect: "success", fields: ["session_active", "session_nonce", "spent_raw", "epoch_spent_raw"] },
  { id: "A3", sent: "dev1 sends ComputeChannel.timeout for a made up channel through session A", expect: "ComputeChannel.ChannelNotFound", fields: ["session_nonce", "spent_raw", "epoch_spent_raw"] },
  { id: "A4", sent: "dev1 sends System.remark, not on the allow list, through session A", expect: "FlopSessionKeys.PalletNotAllowed", fields: ["session_nonce"] },
  { id: "A5", sent: "dev1 sends a force_open of 0.01 FLOP declared 0 through session A", expect: "FlopSessionKeys.SpendExceedsDeclared", fields: ["session_nonce", "spent_raw", "epoch_spent_raw"] },
  { id: "A6", sent: "dev1 sends the same force_open declared 0.012 through session A", expect: "success", fields: ["session_nonce", "spent_raw", "epoch_spent_raw", "breaker_tx_count"] },
  { id: "A7", sent: "dev1 sends a force_open of 0.03 FLOP, over the per call limit, through session A", expect: "FlopSessionKeys.PerTxLimitExceeded", fields: ["session_nonce", "spent_raw"] },
  { id: "A8", sent: "dev1 sends a force_open of 0.019 FLOP, over what is left of the daily cap, through session A", expect: "FlopSessionKeys.DailyCapExceeded", fields: ["session_nonce", "spent_raw", "epoch_spent_raw", "breaker_tx_count"] },
  { id: "A9", sent: "dev1 expires the force_open of A6 after its ack window through session A", expect: "success", fields: ["session_nonce", "spent_raw", "epoch_spent_raw", "failed_acks_of_named"] },
  { id: "A10", sent: "the owner revokes session A", expect: "success", fields: ["session_active", "delegate_sessions_of_device"] },
  { id: "A11", sent: "dev1 sends all it holds to dev2", expect: "success", fields: [] },
  { id: "B1", sent: "the owner creates session B for dev2, an allow list of nine names", expect: "success", fields: ["session_active", "session_nonce"] },
  { id: "B2", sent: "dev2 sends a Utility call through session B", expect: "FlopSessionKeys.PalletNotAllowed", fields: [] },
  { id: "B3", sent: "dev2 sends a Proxy call through session B", expect: "FlopSessionKeys.PalletNotAllowed", fields: [] },
  { id: "B4", sent: "dev2 sends a Multisig call through session B", expect: "FlopSessionKeys.PalletNotAllowed", fields: [] },
  { id: "B5", sent: "dev2 sends a Sudo call through session B", expect: "FlopSessionKeys.PalletNotAllowed", fields: [] },
  { id: "B6", sent: "dev2 sends a Scheduler call through session B", expect: "FlopSessionKeys.PalletNotAllowed", fields: [] },
  { id: "B7", sent: "dev2 sends an EmergencyOverride call through session B", expect: "FlopSessionKeys.PalletNotAllowed", fields: [] },
  { id: "B8", sent: "dev2 sends a FlopSessionKeys call through session B", expect: "FlopSessionKeys.PalletNotAllowed", fields: [] },
  { id: "B9", sent: "dev2 sends ComputeChannel.timeout for a made up channel through session B, let through by the lower case allow entry", expect: "ComputeChannel.ChannelNotFound", fields: ["session_nonce"] },
  { id: "B10", sent: "dev2 sends System.remark through session B", expect: "success", fields: ["session_nonce", "spent_raw"] },
  { id: "B11", sent: "the owner revokes session B", expect: "success", fields: ["session_active"] },
  { id: "B12", sent: "dev2 sends all it holds back to the owner", expect: "success", fields: [] },
];

/** The reads of a step after its events and runtime record: one per entry its fields name, in ENTRY_ORDER. */
export function readsAfter(step: Step): Read[] {
  const device = DEVICE_OF[step.id.startsWith("A") ? "A" : "B"];
  const entries = new Set(step.fields.map((f) => ENTRY_OF[f]));
  return ENTRY_ORDER.filter((e) => entries.has(e)).map((e) => entryRead(e, device));
}

/** What one batch reads, in the order asked: System.Events, System.LastRuntimeUpgrade, then the step's reads. */
export const batchReads = (step: Step): Read[] => [EVENTS, LAST_RUNTIME_UPGRADE, ...readsAfter(step)];

const ACCOUNT_LABEL: Record<Account, string> = { owner: "the owner", dev1: "dev1", dev2: "dev2", named: "the named account" };
const readWords = (inputs: Inputs, r: Read) =>
  r.keys.length === 0 ? `${r.pallet}.${r.entry}` : `${r.pallet}.${r.entry} of ${r.keys.map((k) => ("account" in k ? `${ACCOUNT_LABEL[k.account]} ${core.short(inputs.accounts[k.account].value)}` : "")).join(" and ")}`;
const outcome = (s: Step) => (s.expect === "success" ? "steps.json expects success" : `steps.json expects it refused with ${s.expect}`);

/** The plan as call specs, in order, each with its why: the heads, then for each step its hash by height and one batch at that hash. */
export function plan(inputs: Inputs): Spec[] {
  const out: Spec[] = [
    { kind: "head", why: "the finalized head when the run read it: every block below must be at or under it" },
    { kind: "genesis", why: "the genesis hash, so the recording names the chain it was read from" },
  ];
  for (const s of STEPS) {
    const b = blockOf(s.id);
    const h = inputs.blocks[b].height.value;
    const reads = batchReads(s);
    const after = reads.slice(2);
    out.push(
      { kind: "hash", block: b, why: `the canonical hash at height ${h}, to compare with ${inputs.blocks[b].hash.value}, the hash the session rerun's results.json holds for step ${s.id}` },
      {
        kind: "batch",
        block: b,
        reads,
        why: `at block ${h}, where ${s.sent} (step ${s.id}; ${outcome(s)}): System.Events, the events of every extrinsic of the block, and System.LastRuntimeUpgrade, the runtime that executed it${after.length === 0 ? "" : `, then the stored values after the step: ${after.map((r) => readWords(inputs, r)).join(", ")}`}; asked together in one call, answered as one set for the block, a key that holds nothing listed with null`,
      },
    );
  }
  return out;
}

/** The whole list, call by call, from the inputs and the parsed metadata of spec 1014020. Pure. */
export const deriveCalls = (inputs: Inputs, md: Metadata): DerivedCall[] => core.deriveCalls(plan(inputs), inputs, md);

/** The list as recordings/requests.json holds it: the written form of the derived calls. */
export const deriveRequestsText = (inputs: Inputs, md: Metadata): string => core.requestsText(deriveCalls(inputs, md));
