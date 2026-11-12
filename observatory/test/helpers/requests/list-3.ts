// The plan of the third request list, recordings/requests.json: FLOP devnet's runtime upgrade from
// the old runtime to the new one, the lab's own storage records on both sides of it, and the blocks
// of the lab's deny list test. Nothing in it is typed by hand: the accounts, channel ids, heights
// and block hashes come from recordings/requests-inputs.json, each with the file and field it was
// taken from, and every storage key is built from the recorded metadata (core.ts). What is read at
// which block is the plan below, the lead's design, reviewed like code.
// test/upgrade-requests.test.ts holds the list to it byte for byte, derives each key a second way
// with the reference decoder, and holds each input to the record it names.
//
// The rule every choice here follows: a block is in the encoding of the runtime that executed it.
// That is what System.LastRuntimeUpgrade at the block names, and it is the version and metadata
// read at the block's parent. state_getRuntimeVersion and state_getMetadata at a block describe the
// runtime of the next block.
//
// The only metadata in a committed file is the old runtime's, so every storage key here is built
// from it, the keys of the reads at blocks of the new runtime too. Nothing offline shows the new
// runtime keeps the same prefixes and hashers: a null at such a block is not read as absent until
// the next phase has built the same key again from the recorded new metadata.
import type { Metadata } from "../../../src/scale/metadata.js";
import * as core from "./core.js";

export const ACCOUNTS = ["owner", "device_1", "device_2", "device_3"] as const;
export const CHANNELS = ["ours", "gateway"] as const;
export const UPGRADE_BLOCKS = ["runtime-upgrade/last-of-old-runtime", "runtime-upgrade/carries-upgrade", "runtime-upgrade/first-of-new-runtime", "runtime-upgrade/later-of-new-runtime"] as const;
export const DENY_BLOCKS = ["session-deny-list/2-create-session", "session-deny-list/3-denied-utility", "session-deny-list/10-lower-case-allow-entry", "session-deny-list/11-allowed-control", "session-deny-list/12-revoke-session"] as const;
export const BLOCKS = [...UPGRADE_BLOCKS, ...DENY_BLOCKS] as const;
export const MENTIONED = [] as const;
export type Account = (typeof ACCOUNTS)[number];
export type Channel = (typeof CHANNELS)[number];
export type UpgradeBlock = (typeof UPGRADE_BLOCKS)[number];
export type DenyBlock = (typeof DENY_BLOCKS)[number];
export type Block = (typeof BLOCKS)[number];
export type Mentioned = never;
export const NAMES: core.Names<Account, Channel, Block, Mentioned> = { accounts: ACCOUNTS, channels: CHANNELS, blocks: BLOCKS, mentioned: MENTIONED };

export type Inputs = core.Inputs<Account, Channel, Block, Mentioned>;
export type Read = core.Read<Account, Channel>;
export type DerivedCall = core.DerivedCall<Account, Channel, Block>;
type Spec = core.CallSpec<Account, Channel, Block>;

/** The inputs file of this list read: in the written form, with exactly the names the plan uses. Throws when it is not. */
export const readInputs = (text: string): Inputs => core.readInputs(text, NAMES);

const EVENTS: Read = { pallet: "System", entry: "Events", keys: [] };
const sessions = (d: Account): Read => ({ pallet: "FlopSessionKeys", entry: "Sessions", keys: [{ account: "owner" }, { account: d }] });
const nonces = (d: Account): Read => ({ pallet: "FlopSessionKeys", entry: "SessionNonces", keys: [{ account: "owner" }, { account: d }] });
const breaker = (d: Account): Read => ({ pallet: "FlopSessionKeys", entry: "CircuitBreakers", keys: [{ account: d }] });
const channel = (c: Channel): Read => ({ pallet: "ComputeChannel", entry: "Channels", keys: [{ channel: c }] });
/** A pair that never had a session, from accounts already in the inputs: device D1 as owner, owner S as device. */
export const NEVER_A_SESSION: Read = { pallet: "FlopSessionKeys", entry: "SessionNonces", keys: [{ account: "device_1" }, { account: "owner" }] };

/** The four blocks of the upgrade, each with what it is, in the words the whys use. */
export const UPGRADE: Record<UpgradeBlock, string> = {
  "runtime-upgrade/last-of-old-runtime": "the last block before the runtime upgrade",
  "runtime-upgrade/carries-upgrade": "the block that carries the runtime upgrade, executed by the old runtime",
  "runtime-upgrade/first-of-new-runtime": "the first block the new runtime executed",
  "runtime-upgrade/later-of-new-runtime": "a later finalized block of the new runtime, the finalized block of the lab's own published reading after the upgrade",
};

/** Part B: our own records, each read at both blocks with the same key. */
export const RECORDS: Read[] = [
  sessions("device_1"),
  nonces("device_1"),
  breaker("device_1"),
  sessions("device_2"),
  nonces("device_2"),
  breaker("device_2"),
  sessions("device_3"),
  nonces("device_3"),
  breaker("device_3"),
  channel("ours"),
  channel("gateway"),
  NEVER_A_SESSION,
];
/** The two blocks part B reads at: the control, executed by the old runtime, and a block of the new runtime. */
export const ACROSS: [UpgradeBlock, UpgradeBlock] = ["runtime-upgrade/last-of-old-runtime", "runtime-upgrade/later-of-new-runtime"];

/** What the deny list test's record says came of a step: the error it failed with, or null when it succeeded. */
export interface DenyStep {
  block: DenyBlock;
  /** What happened in the block, as the why says it after the height. */
  happened: string;
  error: string | null;
}

/** Part C: the deny list test's blocks, each by its step, in the record's order. */
export const DENY: DenyStep[] = [
  { block: "session-deny-list/2-create-session", happened: "where owner S created a session for device D3 in the lab's deny list test, with an allow list of nine pallet names", error: null },
  { block: "session-deny-list/3-denied-utility", happened: "where device D3 sent Utility.batch through the session, the first call refused with PalletNotAllowed though the allow list names Utility", error: "PalletNotAllowed" },
  {
    block: "session-deny-list/10-lower-case-allow-entry",
    happened: "where device D3 sent ComputeChannel.timeout through the session for a made up channel, let through by the lower case allow entry and failed in that pallet with ChannelNotFound",
    error: "ChannelNotFound",
  },
  { block: "session-deny-list/11-allowed-control", happened: "where device D3 sent System.remark through the session, the one call through the session that succeeded", error: null },
  { block: "session-deny-list/12-revoke-session", happened: "where owner S revoked the session of device D3", error: null },
];
/** The reads of part C after its blocks: each with the block it is read at, and what it shows there. */
export const DENY_READS: { block: DenyBlock; read: Read; shows: string }[] = [
  { block: "session-deny-list/2-create-session", read: sessions("device_3"), shows: "the record that holds the nine names of the allow list as given" },
  { block: "session-deny-list/12-revoke-session", read: sessions("device_3"), shows: "the same record after the revoke" },
  { block: "session-deny-list/11-allowed-control", read: nonces("device_3"), shows: "the nonce after the one call that succeeded" },
  { block: "session-deny-list/11-allowed-control", read: breaker("device_3"), shows: "the breaker after the one call that succeeded" },
];

const ACCOUNT_LABEL: Record<Account, string> = { owner: "owner S", device_1: "device D1", device_2: "device D2", device_3: "device D3" };
const CHANNEL_LABEL: Record<Channel, string> = { ours: "our channel", gateway: "the gateway channel" };

function keyWords(inputs: Inputs, r: Read): string {
  return r.keys
    .map((k) => ("account" in k ? `${ACCOUNT_LABEL[k.account]} ${core.short(inputs.accounts[k.account].value)}` : `${CHANNEL_LABEL[k.channel]} ${core.short(inputs.channels[k.channel].value)}`))
    .join(" and ");
}
/** What a why adds for the pair that never had a session. */
const neverWords = (r: Read) => (r === NEVER_A_SESSION ? "; device D1 as owner and owner S as device are a pair that never had a session, so its nonce should be the default" : "");
const readWords = (inputs: Inputs, r: Read) => (r.keys.length === 0 ? `${r.pallet}.${r.entry}` : `${r.pallet}.${r.entry} of ${keyWords(inputs, r)}`);

/** The plan as call specs, in order, each with its why: part A, the upgrade; part B, our records across it; part C, the deny list test. */
export function plan(inputs: Inputs): Spec[] {
  const h = (b: Block) => inputs.blocks[b].height.value;
  const [before, carries, first, later] = UPGRADE_BLOCKS;
  const out: Spec[] = [
    { kind: "head", why: "the finalized head when the run read it: every block below must be at or under it" },
    { kind: "genesis", why: "the genesis hash, so the recording names the chain it was read from" },
  ];
  // A. The upgrade.
  for (const b of UPGRADE_BLOCKS) {
    out.push({ kind: "hash", block: b, why: `the canonical hash at height ${h(b)}, to compare with ${inputs.blocks[b].hash.value}, the hash the lab's reads of the runtime upgrade hold for ${UPGRADE[b]}` });
  }
  const versionOf: Record<UpgradeBlock, string> = {
    [before]: `it answers for the runtime of the next block, ${h(carries)}, which the old runtime executed`,
    [carries]: `it answers for the runtime of the next block, ${h(first)}, the first the new runtime executed, and not for this block, which the old runtime executed`,
    [first]: "it answers for the runtime of the next block, the new runtime again",
    [later]: "it answers for the runtime of the next block, the new runtime",
  };
  for (const b of UPGRADE_BLOCKS) out.push({ kind: "version", block: b, why: `the runtime version at block ${h(b)}, ${UPGRADE[b]}: ${versionOf[b]}` });
  out.push(
    {
      kind: "metadata",
      block: before,
      why: `the metadata at block ${h(before)}, ${UPGRADE[before]}: it answers for the runtime of the next block, ${h(carries)}, so it should be the old runtime's, the metadata every block up to ${h(carries)} is decoded with`,
    },
    {
      kind: "metadata",
      block: carries,
      why: `the metadata at block ${h(carries)}, ${UPGRADE[carries]}: it answers for the runtime of the next block, so it should be the new runtime's, the metadata blocks ${h(first)} and later are decoded with, and not the metadata of this block itself`,
    },
  );
  const upgradeOf: Record<UpgradeBlock, string> = {
    [before]: "it should name the old runtime",
    [carries]: "it should still name the old runtime, which executed this block though the version and metadata read here answer for the new one",
    [first]: "the first block where it should name the new runtime",
    [later]: "it should name the new runtime",
  };
  for (const b of UPGRADE_BLOCKS) {
    out.push({ kind: "upgrade", block: b, why: `System.LastRuntimeUpgrade at block ${h(b)}, ${UPGRADE[b]}: the runtime that executed the block, which the shape pin reads before anything is decoded; ${upgradeOf[b]}` });
  }
  const eventsOf: Record<UpgradeBlock, string> = {
    [before]: "in the old runtime's encoding",
    [carries]: "the events of the upgrade itself, System.CodeUpdated among them, in the old runtime's encoding",
    [first]: "in the new runtime's encoding, decoded only once the next phase has a reviewed shape for it",
    [later]: "in the new runtime's encoding, decoded only once the next phase has a reviewed shape for it",
  };
  for (const b of UPGRADE_BLOCKS) out.push({ kind: "storage", block: b, read: EVENTS, why: `System.Events at block ${h(b)}, ${UPGRADE[b]}, ${eventsOf[b]}` });
  // B. Our own records across the upgrade, the same key at both blocks.
  const [control, after] = ACROSS;
  for (const r of RECORDS) {
    out.push({
      kind: "storage",
      block: control,
      read: r,
      why: `${readWords(inputs, r)} at block ${h(control)}, ${UPGRADE[control]}: the control for the same key at block ${h(after)}, so the next phase can say byte for byte whether the upgrade changed this stored value${neverWords(r)}`,
    });
  }
  for (const r of RECORDS) {
    out.push({
      kind: "storage",
      block: after,
      read: r,
      why: `${readWords(inputs, r)} at block ${h(after)}, ${UPGRADE[after]}, the same key as at block ${h(control)}; the key is built from the old runtime's metadata, since no committed file holds the new one yet, so a null here is not read as absent until the next phase has built the same key again from the recorded new metadata, and the read at block ${h(control)} is the control${neverWords(r)}`,
    });
  }
  // C. The deny list test, at the old runtime.
  for (const s of DENY) {
    const b = s.block;
    out.push(
      { kind: "hash", block: b, why: `the canonical hash at height ${h(b)}, to compare with ${inputs.blocks[b].hash.value}, the hash the lab's deny list test holds for that block` },
      { kind: "upgrade", block: b, why: `System.LastRuntimeUpgrade at block ${h(b)}: the runtime the block was written under, which the shape pin reads before anything is decoded` },
      { kind: "storage", block: b, read: EVENTS, why: `System.Events at block ${h(b)}, ${s.happened}` },
    );
  }
  for (const d of DENY_READS) {
    const s = DENY.find((x) => x.block === d.block) as DenyStep;
    out.push({ kind: "storage", block: d.block, read: d.read, why: `${readWords(inputs, d.read)} at block ${h(d.block)}, ${s.happened}: ${d.shows}` });
  }
  return out;
}

/** The whole list, call by call, from the inputs and the parsed recorded metadata. Pure. */
export const deriveCalls = (inputs: Inputs, md: Metadata): DerivedCall[] => core.deriveCalls(plan(inputs), inputs, md);

/** The list as recordings/requests.json holds it: the written form of the derived calls. */
export const deriveRequestsText = (inputs: Inputs, md: Metadata): string => core.requestsText(deriveCalls(inputs, md));
