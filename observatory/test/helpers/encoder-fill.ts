// The fill of the encoder test's final record, research/2026-11-12-encoder-devnet-test/results.final.json,
// from the fifth recording (review round 32). Pure but for reading the committed files it names. The
// one place both the tests and the script (scripts/fill-encoder-results.mjs) get it from.
//
// Two sources and no third (C3). Chain facts come from the recording's tape through the lab's
// decoder's one door (src/scale/block.ts, by block-fill.ts), at the spec each block's
// System.LastRuntimeUpgrade names. What the lab itself signed and sent (the signer, the account
// nonce, the call, the era, the extrinsic hash, the time of sending) comes from the committed run
// time record (results.json) and the signed files (run-2026-11-13/signed/). The run time record is
// read, never written: the final record is a new file beside it, the run time record with record
// "final", balances_source "decoder", the fill's fields filled in their place, and filled_from at the
// end (C2).
//
// Each storage read is decoded once, in readsOf, and carries the door's stored to where its text is
// written, so a default is never written for a value the node does not hold (C5, round 29 F1).
// Nothing stored is { "absent": true } for an account (reads_form), a session and the channel, and
// "absent" for the session nonce and the breaker (the lead's words, C5); null is unknown. A step's
// chain fields are filled only from a block whose batch answer was read, whose LastRuntimeUpgrade
// names a reviewed runtime and whose events are the runner's and decoded; otherwise they stay null (C7).
import { createHash } from "node:crypto";
import { SHAPE_SCHEMA } from "../../src/scale/shape.js";
import { type Pin, type Rec, type Value, errorRows, extrinsicFill, hex, isRec, pinBlock, readThroughDoor, repoText, resultsForm, text } from "./block-fill.js";
import { ENCODER_DIR, ENCODER_RECORDING, ENCODER_RUN_TIME, type EncoderBlock, recordedEncoder } from "./recorded-encoder.js";
import { keyBytes } from "./requests/core.js";
import type { Inputs, Read } from "./requests/list-5.js";

/** The final record, beside the run time record it is filled from. */
export const ENCODER_FINAL = `${ENCODER_DIR}/results.final.json`;
const signedText = (id: string) => repoText(`${ENCODER_DIR}/run-2026-11-13/signed/${id}.json`);

/** The step fields the fill writes from the tape, in the record's order. */
export const CHAIN_FIELDS = ["finalized_in_block", "block_hash", "extrinsic_index", "last_runtime_upgrade_spec", "events_value_sha256", "events", "result", "fee_raw", "after", "raw_reads"] as const;
/** The step fields the fill writes from what the lab signed and sent. */
export const SENT_FIELDS = ["signer", "account_nonce", "call", "extrinsic_hash", "era", "submitted_utc"] as const;
/** The fields of before the fill writes, every one from the tape. */
export const BEFORE_FIELDS = ["block_number", "block_hash", "accounts", "session", "session_nonce", "breaker_tx_count", "channel", "raw_reads"] as const;

/** Where each filled value came from, in the fill's own words (C3): the one entry the final record carries for all of them. */
export const FILLED_FROM = {
  recording: `observatory/fixtures/${ENCODER_RECORDING}`,
  by: "observatory/scripts/fill-encoder-results.mjs (test/helpers/encoder-fill.ts)",
  from_the_recording: {
    fields: ["before", ...CHAIN_FIELDS.map((f) => `steps[].${f}`)],
    how: "decoded from the recording's tape through the lab's decoder's one door, observatory/src/scale/block.ts, at the spec each block's System.LastRuntimeUpgrade names, with the reviewed shape the door pinned. block_number and finalized_in_block are the height the list asked, block_hash the hash the tape answered for it, filled only where it is the block the run time record names finalized; extrinsic_index is where the block on the tape holds the signed extrinsic, byte for byte; events_value_sha256 is the sha256 of the System.Events value on the tape; events, result and fee_raw are of that extrinsic alone; the accounts are System.Account, the session FlopSessionKeys.Sessions, session_nonce FlopSessionKeys.SessionNonces and breaker_tx_count FlopSessionKeys.CircuitBreakers tx_count, each of the owner and the device; raw_reads is each key the batch asked and the node's answer.",
  },
  from_the_run: {
    fields: SENT_FIELDS.map((f) => `steps[].${f}`),
    how: "what the lab signed and sent: signer, account_nonce, call and era from the step's signed file, research/2026-11-12-encoder-devnet-test/run-2026-11-13/signed/<step>.json, the era in the form results.template.json gives it; extrinsic_hash and submitted_utc from the run time record, results.json, steps[].run_time.extrinsic_hash and run_time.sent.submitted_utc.",
  },
  words: {
    absent: "the node holds nothing under the key: the batch answer lists it with null, which the door answers as not stored. An account is then { \"absent\": true } as reads_form says. reads_form gives that word for an account only; the session and the channel are then { \"absent\": true } in the same shape, and session_nonce and breaker_tx_count are \"absent\": these are the fill's words, by the lead's rule, never the default the metadata states and never null. A stored 0 is \"0\".",
    unknown: "null: not read, not decoded, or no block. Never 0.",
  },
  channel: "before.channel and steps[].after.channel are the fill's own field, beside the form: ComputeChannel.Channels of T3's channel, { \"absent\": true } when nothing is stored, else the channel's fields as the door gives them, amounts as decimal strings, accounts and hashes as 0x lower case hex, every enum value as { type, value }.",
  /** The format of the reviewed shape the door pinned when this fill ran. */
  shape: SHAPE_SCHEMA,
};

/** One storage read of a block, decoded once: not decoded, or the door's stored with its value. */
export type ReadOutcome = { decoded: false } | { decoded: true; stored: boolean; value: Value };

/** The text of an account read in the record's form: unknown is the template's nulls. */
export function accountText(r: ReadOutcome): Value {
  if (!r.decoded) return { free: null, reserved: null, nonce: null, absent: null };
  if (!r.stored) return { absent: true };
  const v = r.value as Rec;
  const data = isRec(v) && isRec(v.data) ? v.data : {};
  return { free: text(data.free), reserved: text(data.reserved), nonce: text(v.nonce) };
}

/** The text of a session read: { active, spent_raw, epoch_spent_raw }, { absent: true } when nothing is stored. */
export function sessionText(r: ReadOutcome): Value {
  if (!r.decoded) return { active: null, spent_raw: null, epoch_spent_raw: null };
  if (!r.stored) return { absent: true };
  const v = isRec(r.value) ? r.value : {};
  return { active: text(v.active), spent_raw: text(v.spent), epoch_spent_raw: text(v.epoch_spent) };
}

/** The text of the session nonce: the stored number, "absent" when nothing is stored. */
export const sessionNonceText = (r: ReadOutcome): string | null => (!r.decoded ? null : r.stored ? text(r.value) : "absent");

/** The text of the breaker: its stored tx_count, "absent" when nothing is stored. */
export const breakerText = (r: ReadOutcome): string | null => (!r.decoded ? null : r.stored ? text(isRec(r.value) ? r.value.tx_count : undefined) : "absent");

/** The text of the channel: its fields in the results form, { absent: true } when nothing is stored. */
export const channelText = (r: ReadOutcome): Value => (!r.decoded ? null : r.stored ? resultsForm(r.value) : { absent: true });

/** The reads of one block as the record writes them: the reads after a step, and raw_reads. */
export interface BlockReads {
  after: { accounts: { owner: Value; device: Value }; session: Value; session_nonce: string | null; breaker_tx_count: string | null; channel: Value };
  raw_reads: Record<string, string | null>;
}

const entryIs = (r: Read, pallet: string, entry: string) => r.pallet === pallet && r.entry === entry;
const ofAccount = (r: Read, who: string) => r.keys.some((k) => "account" in k && k.account === who);

/** Every read of a pinned block, each decoded once through the door; raw_reads is each key asked and the node's answer. */
export function readsOf(b: EncoderBlock, pin: Pin, values: ReadonlyMap<string, Uint8Array | null>, inputs: Inputs): BlockReads {
  const raw: Record<string, string | null> = {};
  const outcome = (find: (r: Read) => boolean): ReadOutcome => {
    const j = b.reads.findIndex(find);
    const r = b.reads[j];
    const key = b.keys[j];
    if (r === undefined || key === undefined || !values.has(key)) return { decoded: false };
    const v = readThroughDoor(pin, r.pallet, r.entry, keyBytes(inputs, r), key, values.get(key) ?? null);
    return v.decoded ? { decoded: true, stored: v.stored, value: v.value as Value } : { decoded: false };
  };
  b.keys.forEach((key) => {
    if (!values.has(key)) return;
    const a = values.get(key) ?? null;
    raw[key] = a === null ? null : hex(a);
  });
  return {
    after: {
      accounts: {
        owner: accountText(outcome((r) => entryIs(r, "System", "Account") && ofAccount(r, "owner"))),
        device: accountText(outcome((r) => entryIs(r, "System", "Account") && ofAccount(r, "device"))),
      },
      session: sessionText(outcome((r) => entryIs(r, "FlopSessionKeys", "Sessions"))),
      session_nonce: sessionNonceText(outcome((r) => entryIs(r, "FlopSessionKeys", "SessionNonces"))),
      breaker_tx_count: breakerText(outcome((r) => entryIs(r, "FlopSessionKeys", "CircuitBreakers"))),
      channel: channelText(outcome((r) => entryIs(r, "ComputeChannel", "Channels"))),
    },
    raw_reads: raw,
  };
}

/** The run time record's word for a step's block: its number and hash, only where the runner relayed it finalized. */
interface RunSent {
  status?: unknown;
  block_number?: unknown;
  block_hash?: unknown;
  submitted_utc?: unknown;
  events_sha256?: unknown;
  events_length?: unknown;
}

/**
 * The chain fields of one step from its block on the tape (C7): none when the block is not the one
 * the run time record names finalized (its number, its hash, and the sha256 and length of its
 * System.Events value, which are the runner's), its batch answer was not read, its runtime is not reviewed,
 * or it does not hold the signed extrinsic exactly once; only last_runtime_upgrade_spec when its
 * events do not decode, as the rerun's fill; every one otherwise. A field not given keeps the run
 * time record's null.
 */
export function chainFill(b: EncoderBlock, sent: RunSent | null, extrinsic: string, inputs: Inputs, metadata: Uint8Array): Partial<Record<(typeof CHAIN_FIELDS)[number], unknown>> {
  // The block is the one the run time record names finalized, by its number and the hash the tape answered.
  if (sent?.status !== "finalized" || sent.block_number !== b.height || sent.block_hash !== b.answeredHash) return {};
  // The events on the tape are the ones the runner saw: the sha256 and the length it relayed, checked before any read is decoded.
  const tapeEvents = b.answer.read ? b.answer.values.get(b.keys[0] ?? "") : undefined;
  if (!(tapeEvents instanceof Uint8Array) || createHash("sha256").update(tapeEvents).digest("hex") !== sent.events_sha256 || tapeEvents.length !== sent.events_length) return {};
  const p = pinBlock(b.answer, b.keys[0], b.keys[1], metadata);
  if (p.state === "not read") return {};
  if (p.state === "events not decoded") return { last_runtime_upgrade_spec: p.spec };
  const exts = Array.isArray(b.extrinsics) ? (b.extrinsics as unknown[]) : [];
  const at = exts.flatMap((x, i) => (x === extrinsic ? [i] : []));
  if (at.length !== 1) return {};
  const index = at[0] as number;
  const events = p.values.get(b.keys[0] as string) as Uint8Array;
  const reads = readsOf(b, p.pin, p.values, inputs);
  return {
    finalized_in_block: b.height,
    block_hash: b.answeredHash,
    extrinsic_index: index,
    last_runtime_upgrade_spec: p.spec,
    events_value_sha256: createHash("sha256").update(events).digest("hex"),
    ...extrinsicFill(p.events, index, errorRows()),
    after: reads.after,
    raw_reads: reads.raw_reads,
  };
}

/** The before of the record from the start block: null fields when it cannot be read. */
export function beforeFill(b: EncoderBlock, start: { number?: unknown; hash?: unknown } | null, inputs: Inputs, metadata: Uint8Array): Rec | null {
  const p = pinBlock(b.answer, b.keys[0], b.keys[1], metadata);
  if (p.state !== "decoded" || start?.number !== b.height || start.hash !== b.answeredHash) return null;
  const reads = readsOf(b, p.pin, p.values, inputs);
  return { block_number: b.height, block_hash: b.answeredHash, ...reads.after, raw_reads: reads.raw_reads };
}

/** The fields of a step from what the lab signed and sent: the signed file and the run time record. */
export function sentFill(step: Rec): Record<(typeof SENT_FIELDS)[number], unknown> & { extrinsic: string } {
  const signed = JSON.parse(signedText(String(step.step))) as Rec;
  const rt = step.run_time as Rec;
  const era = signed.era === "immortal" ? "immortal" : { birth_number: (signed.era as Rec).birth_number, birth_hash: (signed.era as Rec).birth_hash, last_valid_block: (signed.era as Rec).last_valid_block };
  return {
    signer: signed.signer,
    account_nonce: signed.account_nonce,
    call: signed.call,
    extrinsic_hash: rt.extrinsic_hash,
    era,
    submitted_utc: (rt.sent as Rec).submitted_utc,
    extrinsic: String(signed.extrinsic),
  };
}

/** A record's object with some fields replaced in their place and others added after a named key. */
const placed = (o: Rec, set: Rec, addAfter: Record<string, Rec> = {}): Rec => {
  const out: Rec = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = k in set ? set[k] : v;
    for (const [nk, nv] of Object.entries(addAfter[k] ?? {})) out[nk] = nv;
  }
  return out;
};

/** The final record filled from the run time record and the recording. */
export function fillFinal(runTime: Rec): Rec {
  const R = recordedEncoder();
  const blockOf = (id: string) => R.blocks.find((b) => b.id === id);
  const start = blockOf("start") as EncoderBlock;
  const before = beforeFill(start, (runTime.start as Rec | null)?.finalized as Rec | null, R.inputs, R.metadata);
  const runBefore = runTime.before as Rec;
  const filledBefore = before === null ? runBefore : placed(runBefore, before, { breaker_tx_count: { channel: before.channel } });
  const steps = (runTime.steps as Rec[]).map((s) => {
    const b = blockOf(String(s.step));
    if (b === undefined || s.run_time === null || s.run_time === undefined) return s; // T7: not needed, not sent; its fields stay null
    const { extrinsic, ...sentFields } = sentFill(s);
    const chain = chainFill(b, (s.run_time as Rec).sent as RunSent, extrinsic, R.inputs, R.metadata);
    return placed(s, { ...sentFields, ...chain });
  });
  const top = placed(runTime, { record: "final", balances_source: "decoder", before: filledBefore, steps });
  return { ...top, filled_from: FILLED_FROM };
}

/** The text of the final record, as record-step.mjs writes a record: one space of indent and a line end. */
export const recordText = (r: Rec) => `${JSON.stringify(r, null, 1)}\n`;

/** results.final.json as the committed file must hold it: the committed run time record filled from the recording. */
export const encoderFinalText = (): string => recordText(fillFinal(JSON.parse(repoText(ENCODER_RUN_TIME)) as Rec));

/** The final record with the fill's fields cleared back to the run time record's: what the fill must give back whole. */
export function clearFinal(final: Rec, runTime: Rec): Rec {
  const runSteps = runTime.steps as Rec[];
  const steps = (final.steps as Rec[]).map((s) => {
    const r = runSteps.find((x) => x.step === s.step) ?? {};
    const out = { ...s };
    for (const f of [...CHAIN_FIELDS, ...SENT_FIELDS]) out[f] = r[f];
    return out;
  });
  const { filled_from: _, ...top } = final;
  const { channel: __, ...before } = final.before as Rec;
  for (const f of BEFORE_FIELDS) if (f !== "channel") before[f] = (runTime.before as Rec)[f];
  return { ...top, record: runTime.record, balances_source: runTime.balances_source, before, steps };
}
