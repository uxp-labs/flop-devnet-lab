// The upgrade watch (RULES.md section 7.2): at the finalized head a live run reads, two storage
// answers turned into what they say of a runtime upgrade. Pure: no file, network, clock or random
// access, like src/rpc-head.ts.
//
// The answers, both read at the finalized head F by its hash, right after state_getRuntimeVersion(F):
//   state_getStorage(System.LastRuntimeUpgrade, F)  which runtime executed F: the decoder's door
//                                                   runtimeOfBlock (src/scale/block.ts) reads it
//   state_getStorage(System.AuthorizedUpgrade, F)   whether an upgrade is authorised at F: kept as
//                                                   the bytes answered, never decoded
// A storage answer is null (the node holds no value) or 0x and lower case hex of whole bytes. Any
// other answer is malformed, and a call that failed on the way is a read error: both are unknown,
// never absent. Absent is only the null the node sent. No answer's text is ever echoed: a detail is
// a fixed sentence or the decoder's own refusal of the bytes, and a failed call is named by its call.
//
// The watch is compared with the latest earlier watch on the same RPC genesis at a lower block, and
// says whether the executing runtime changed and whether an authorisation appeared. It adds no
// conflict, changes no reset signal and no exit code: the spec floor in src/status.ts stays where it is.
import type { Answer } from "./rpc-head.js";
import { runtimeOfBlock } from "./scale/block.js";
import type { Trust, UpgradeWatch } from "./types.js";

export const UPGRADE_SCHEMA = "flop-observatory/upgrade-watch@0";

/** The two storage keys, each twox128 of the pallet then of the entry (test/upgrade-watch.test.ts derives them). */
export const UPGRADE_KEYS = {
  lastRuntimeUpgrade: "0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8",
  authorizedUpgrade: "0x26aa394eea5630e07c48ae0c9558cef72fa9f1bf25567808771bff091dc89ecd",
} as const;

/** What a live run read for the watch, at the finalized head it read by. */
export interface UpgradeReading {
  /** F: the finalized head's hash, 0x plus 64 lower case hex. */
  hash: string;
  /** F's height, or null when its header gave none. */
  number: number | null;
  /** When the head was read. */
  observedAt: string;
  trust: Trust;
  lastRuntimeUpgrade: Answer;
  authorizedUpgrade: Answer;
}

/** An earlier snapshot's watch, with the RPC genesis that snapshot read. */
export interface EarlierUpgrade {
  genesis: string;
  watch: UpgradeWatch;
}

export interface UpgradeInput {
  reading: UpgradeReading;
  /** The RPC genesis the status judged now, or null when it has none. */
  genesis: string | null;
  /** Every earlier watch, oldest first. */
  earlier: readonly EarlierUpgrade[];
}

/** 0x and lower case hex of whole bytes: a storage answer that holds a value. */
const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;

export const DETAIL = {
  lruFailed: "state_getStorage(System.LastRuntimeUpgrade) failed on the way",
  lruMalformed: "the System.LastRuntimeUpgrade answer is neither null nor 0x and lower case hex of whole bytes",
  lruAbsent: "the node holds no System.LastRuntimeUpgrade at this block",
  notReviewed: "no reviewed line names the runtime this record states",
  auFailed: "state_getStorage(System.AuthorizedUpgrade) failed on the way",
  auMalformed: "the System.AuthorizedUpgrade answer is neither null nor 0x and lower case hex of whole bytes",
} as const;

/** The bytes of an answer that passed HEX_BYTES. */
function bytesOf(hex: string): Uint8Array {
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

/** The answer's value: null, a hex string, or why it is unknown. */
function valueOf(a: Answer, failed: string, malformed: string): { value: string | null } | { unknown: string } {
  if ("error" in a) return { unknown: failed };
  if (a.result === null) return { value: null };
  if (typeof a.result !== "string" || !HEX_BYTES.test(a.result)) return { unknown: malformed };
  return { value: a.result };
}

function executingOf(a: Answer): UpgradeWatch["executing"] {
  const v = valueOf(a, DETAIL.lruFailed, DETAIL.lruMalformed);
  if ("unknown" in v) return { state: "unknown", spec_name: null, spec_version: null, detail: v.unknown };
  if (v.value === null) return { state: "absent", spec_name: null, spec_version: null, detail: DETAIL.lruAbsent };
  const r = runtimeOfBlock(bytesOf(v.value));
  if (r.found) return { state: "reviewed", spec_name: r.reviewed.specName, spec_version: r.reviewed.specVersion, detail: null };
  if (r.named !== null) return { state: "not reviewed", spec_name: r.named.specName, spec_version: r.named.specVersion, detail: DETAIL.notReviewed };
  // No whole record: the decoder's refusal, which names byte positions and lengths, never the bytes.
  return { state: "unknown", spec_name: null, spec_version: null, detail: r.refused };
}

function authorizedOf(a: Answer): UpgradeWatch["authorized"] {
  const v = valueOf(a, DETAIL.auFailed, DETAIL.auMalformed);
  if ("unknown" in v) return { state: "unknown", bytes: null, length: null, detail: v.unknown };
  if (v.value === null) return { state: "absent", bytes: null, length: null, detail: null };
  return { state: "present", bytes: v.value, length: (v.value.length - 2) / 2, detail: null };
}

/** The latest earlier watch on the same RPC genesis at a lower block, or null when there is none to compare with. */
function earlierWatch(i: UpgradeInput): UpgradeWatch | null {
  const n = i.reading.number;
  if (i.genesis === null || n === null) return null;
  const hit = i.earlier.findLast((e) => e.genesis === i.genesis && e.watch.at.number !== null && e.watch.at.number < n);
  return hit === undefined ? null : hit.watch;
}

export function watchUpgrade(i: UpgradeInput): UpgradeWatch {
  const executing = executingOf(i.reading.lastRuntimeUpgrade);
  const authorized = authorizedOf(i.reading.authorizedUpgrade);
  const before = earlierWatch(i);
  let executingChanged: boolean | null = null;
  let authorizationAppeared: boolean | null = null;
  if (before !== null) {
    const b = before.executing;
    if (executing.spec_name !== null && b.spec_name !== null) executingChanged = executing.spec_name !== b.spec_name || executing.spec_version !== b.spec_version;
    const was = before.authorized;
    if (authorized.state !== "unknown" && was.state !== "unknown") authorizationAppeared = authorized.state === "present" && (was.state === "absent" || was.bytes !== authorized.bytes);
  }
  return {
    schema: UPGRADE_SCHEMA,
    observed_at: i.reading.observedAt,
    trust: i.reading.trust,
    at: { hash: i.reading.hash, number: i.reading.number },
    executing,
    authorized,
    compared_with: before === null ? null : before.at.number,
    executing_changed: executingChanged,
    authorization_appeared: authorizationAppeared,
  };
}
