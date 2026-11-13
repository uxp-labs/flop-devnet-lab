// The encoder test's final record (research/2026-11-12-encoder-devnet-test/results.final.json),
// filled from the fifth recording through the decoder's one door (src/scale/block.ts) by
// test/helpers/encoder-fill.ts, which scripts/fill-encoder-results.mjs runs (review round 32). These
// tests hold the committed file to that fill byte for byte, show the fill gives every filled field
// back from the fixture and the run folder alone, hold the run time record untouched, hold the
// balances step by step, and hold every word the fill writes for a read the node holds nothing for.
// Offline. The observatory depends on nothing of imd-flop, so no test here imports the encoder
// folder's judge (judge.mjs, check.mjs, lib.mjs, record.mjs): the verdict of its checker on the
// final record is held by that folder's own final-record.test.mjs, where both packages are built.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHAPE_SCHEMA } from "../src/scale/shape.js";
import { pinBlock } from "./helpers/block-fill.js";
import {
  BEFORE_FIELDS,
  CHAIN_FIELDS,
  ENCODER_FINAL,
  FILLED_FROM,
  type ReadOutcome,
  SENT_FIELDS,
  accountText,
  beforeFill,
  breakerText,
  chainFill,
  channelText,
  clearFinal,
  encoderFinalText,
  fillFinal,
  readsOf,
  recordText,
  sentFill,
  sessionNonceText,
  sessionText,
} from "./helpers/encoder-fill.js";
import { ENCODER_DIR, ENCODER_RUN_TIME, type EncoderBlock, encoderMetadata, recordedEncoder } from "./helpers/recorded-encoder.js";

const REPO = new URL("../../", import.meta.url);
const repoText = (path: string) => readFileSync(new URL(path, REPO), "utf8");
type Rec = Record<string, any>;
const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const RUN_TIME_TEXT = repoText(ENCODER_RUN_TIME);
const RUN_TIME = JSON.parse(RUN_TIME_TEXT) as Rec;
const TEXT = repoText(ENCODER_FINAL);
const FINAL = JSON.parse(TEXT) as Rec;
const R = recordedEncoder();
const stepOf = (id: string) => (FINAL.steps as Rec[]).find((s) => s.step === id) as Rec;
const blockOf = (id: string) => R.blocks.find((b) => b.id === id) as EncoderBlock;
const SENT_IDS = ["T1", "T2", "T3", "T4", "T5", "T6", "T8", "T9"];
const OWNER_STEPS = ["T1", "T2", "T8"];
const DEVICE_STEPS = ["T3", "T4", "T5", "T6", "T9"];
const big = (v: unknown) => BigInt(String(v));
/** The lead's two readings by position, from the README's section "The run of 2026-11-13", which names their source. */
const leadReadings = () => {
  const t = repoText(`${ENCODER_DIR}/README.md`);
  const from = t.indexOf("## The run of 2026-11-13");
  const s = t.slice(from, t.indexOf("\n## ", from + 1));
  const before = /^- before: (\d+) raw;$/m.exec(s)?.[1];
  const after = /^- after: (\d+) raw;$/m.exec(s)?.[1];
  if (before === undefined || after === undefined) throw new Error("the README's run section holds no reading before and after");
  return { before, after };
};

describe("results.final.json, filled from the fifth recording", () => {
  it("is, byte for byte, what the fill gives from the committed run time record and the recording", () => {
    expect(TEXT).toBe(encoderFinalText());
  });

  it("gives back every filled field from the fixture and the run folder alone: the record with its fill fields cleared fills to the committed file", () => {
    const cleared = clearFinal(FINAL, RUN_TIME);
    for (const s of cleared.steps as Rec[]) for (const f of [...CHAIN_FIELDS, ...SENT_FIELDS]) expect(s[f], `${s.step} ${f}`).toEqual((RUN_TIME.steps as Rec[]).find((x) => x.step === s.step)?.[f]);
    expect(recordText(fillFinal(cleared))).toBe(TEXT);
  });

  it("C1: the run time record is not changed, byte for byte", () => {
    expect(sha256(RUN_TIME_TEXT)).toBe("a0c853cda774e3e57a44663519eef92cfe4405d4fe3952f33e8b8561c9c7267f");
    expect(RUN_TIME.record).toBe("run-time");
  });

  it("C2: equals the run time record once the fill's fields, record, balances_source and filled_from are set aside, in value and in key order", () => {
    const aside = (r: Rec) => {
      const c = structuredClone(r);
      delete c.record;
      delete c.balances_source;
      delete c.filled_from;
      for (const f of BEFORE_FIELDS) delete c.before[f];
      for (const s of c.steps as Rec[]) for (const f of [...CHAIN_FIELDS, ...SENT_FIELDS]) delete s[f];
      return c;
    };
    expect(aside(FINAL)).toEqual(aside(RUN_TIME));
    expect(JSON.stringify(aside(FINAL))).toBe(JSON.stringify(aside(RUN_TIME)));
    expect([FINAL.record, FINAL.balances_source]).toEqual(["final", "decoder"]);
    expect(Object.keys(FINAL)).toEqual([...Object.keys(RUN_TIME), "filled_from"]);
    expect(JSON.stringify(clearFinal(FINAL, RUN_TIME))).toBe(JSON.stringify({ ...RUN_TIME }));
  });

  it("C3: says which field has which source, in the fill's own words, and names the shape format the door pinned", () => {
    expect(FINAL.filled_from).toEqual(FILLED_FROM);
    expect(FINAL.filled_from.from_the_recording.how).toContain("observatory/src/scale/block.ts");
    expect(FINAL.filled_from.from_the_recording.fields).toEqual(["before", ...CHAIN_FIELDS.map((f) => `steps[].${f}`)]);
    expect(FINAL.filled_from.from_the_run.fields).toEqual(SENT_FIELDS.map((f) => `steps[].${f}`));
    expect(FINAL.filled_from.words.absent).toContain("reads_form gives that word for an account only");
    expect(FINAL.filled_from.channel).toContain("the fill's own field, beside the form");
    expect(FINAL.filled_from.shape).toBe(SHAPE_SCHEMA);
  });

  it("C3: the fields of what the lab signed and sent are the signed files' and the run time record's", () => {
    for (const id of SENT_IDS) {
      const s = stepOf(id);
      const signed = JSON.parse(repoText(`${ENCODER_DIR}/run-2026-11-13/signed/${id}.json`)) as Rec;
      const rt = (RUN_TIME.steps as Rec[]).find((x) => x.step === id)?.run_time as Rec;
      expect([s.signer, s.account_nonce, s.call, s.extrinsic_hash, s.submitted_utc], id).toEqual([signed.signer, signed.account_nonce, signed.call, rt.extrinsic_hash, rt.sent.submitted_utc]);
      expect(s.era, id).toEqual(signed.era === "immortal" ? "immortal" : { birth_number: signed.era.birth_number, birth_hash: signed.era.birth_hash, last_valid_block: signed.era.last_valid_block });
    }
  });

  it("C4: every step sent has its chain fields, from the block the run time record names finalized; T7 keeps its nulls", () => {
    for (const id of SENT_IDS) {
      const s = stepOf(id);
      const sent = (RUN_TIME.steps as Rec[]).find((x) => x.step === id)?.run_time.sent as Rec;
      expect([s.finalized_in_block, s.block_hash, s.extrinsic_index], id).toEqual([sent.block_number, sent.block_hash, sent.extrinsic_index]);
      expect([s.last_runtime_upgrade_spec, s.events_value_sha256], id).toEqual([1014020, sent.events_sha256]);
      expect(Object.keys(s.raw_reads), id).toEqual(blockOf(id).keys);
      const fees = (s.events as Rec[]).filter((e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid");
      expect(fees.map((e) => e.fields.actual_fee), id).toEqual([s.fee_raw]);
    }
    expect(stepOf("T7")).toEqual((RUN_TIME.steps as Rec[]).find((x) => x.step === "T7"));
    expect([FINAL.before.block_number, FINAL.before.block_hash]).toEqual([RUN_TIME.start.finalized.number, RUN_TIME.start.finalized.hash]);
    expect(Object.keys(FINAL.before)).toEqual(BEFORE_FIELDS);
  });

  it("C5: the start and T1 hold no session, session nonce or breaker: written { absent: true } and \"absent\", never the default and never null", () => {
    for (const r of [FINAL.before, stepOf("T1").after]) {
      expect([r.session, r.session_nonce, r.breaker_tx_count]).toEqual([{ absent: true }, "absent", "absent"]);
    }
    for (const id of ["start", "T1"]) {
      const b = blockOf(id);
      if (!b.answer.read) throw new Error(`${id} was read`);
      for (const entry of ["Sessions", "SessionNonces", "CircuitBreakers"]) expect(b.answer.values.get(b.keys[b.reads.findIndex((r) => r.entry === entry)] as string), `${id} ${entry}`).toBeNull();
    }
    expect([stepOf("T2").after.session, stepOf("T2").after.session_nonce, stepOf("T2").after.breaker_tx_count]).toEqual([{ active: "true", spent_raw: "0", epoch_spent_raw: "0" }, "0", "0"]);
  });
});

describe("the balances step by step (C9)", () => {
  const owner = (r: Rec) => big(r.accounts.owner.free);
  const fee = (id: string) => big(stepOf(id).fee_raw);
  const sum = (ids: string[]) => ids.reduce((n, id) => n + fee(id), 0n);
  const t1Sent = () => big((stepOf("T1").events as Rec[]).find((e) => e.pallet === "Balances" && e.name === "Transfer")?.fields.amount);

  it("the owner's free balance at the start and at T9's block are the lead's two readings by position", () => {
    const lead = leadReadings();
    expect([FINAL.before.accounts.owner.free, stepOf("T9").after.accounts.owner.free]).toEqual([lead.before, lead.after]);
  });

  it("the owner's free balance fell by exactly the sum of the eight fees, the owner's own and the device's: nothing else was lost", () => {
    expect(owner(FINAL.before) - owner(stepOf("T9").after)).toBe(sum(SENT_IDS));
    expect(sum(OWNER_STEPS) + sum(DEVICE_STEPS)).toBe(sum(SENT_IDS));
    for (const id of OWNER_STEPS) expect(stepOf(id).signer, id).toBe(FINAL.accounts.owner.public_key);
    for (const id of DEVICE_STEPS) expect(stepOf(id).signer, id).toBe(FINAL.accounts.device.public_key);
  });

  it("the 0.01 FLOP of T3's escrow left the owner at T3 and came back at T6", () => {
    const escrow = big((stepOf("T3").events as Rec[]).find((e) => e.name === "ForceOpenRequested")?.fields.escrow);
    expect(escrow).toBe(10000000000000000n);
    expect(owner(stepOf("T2").after) - owner(stepOf("T3").after)).toBe(escrow);
    expect(owner(stepOf("T6").after) - owner(stepOf("T5").after)).toBe(escrow);
  });

  it("the device's account is absent at the start and at T9; at T9 the owner gained what T1 sent less the device's five fees", () => {
    expect(FINAL.before.accounts.device).toEqual({ absent: true });
    expect(stepOf("T9").after.accounts.device).toEqual({ absent: true });
    expect(big(stepOf("T1").after.accounts.device.free)).toBe(t1Sent());
    expect(owner(stepOf("T9").after) - owner(stepOf("T8").after)).toBe(t1Sent() - sum(DEVICE_STEPS));
  });
});

describe("the channel of T3 (C6)", () => {
  it("is absent at the start, T1 and T2, pending its ack with the escrow after T3, T4 and T5, and Closed and still stored from T6 on", () => {
    expect([FINAL.before.channel, stepOf("T1").after.channel, stepOf("T2").after.channel]).toEqual([{ absent: true }, { absent: true }, { absent: true }]);
    const deadline = (stepOf("T3").events as Rec[]).find((e) => e.name === "ForceOpenRequested")?.fields.ack_deadline;
    for (const id of ["T3", "T4", "T5"]) {
      expect(stepOf(id).after.channel.state, id).toEqual({ type: "PendingAck", value: { ack_deadline: Number(deadline) } });
      expect(stepOf(id).after.channel.escrow, id).toBe("10000000000000000");
    }
    for (const id of ["T6", "T8", "T9"]) expect(stepOf(id).after.channel.state, id).toEqual({ type: "Closed", value: null });
    expect(stepOf("T3").after.channel.agent).toBe(FINAL.accounts.owner.public_key);
  });
});

describe("the fill refuses, never guesses: a step's chain fields stay null when its block cannot be read (C7)", () => {
  const b = blockOf("T3");
  const s = (RUN_TIME.steps as Rec[]).find((x) => x.step === "T3") as Rec;
  const ext = sentFill(s).extrinsic;
  const fill = (block: EncoderBlock) => chainFill(block, s.run_time.sent, ext, R.inputs, R.metadata);
  const withValue = (j: number, v: Uint8Array | null): EncoderBlock => {
    if (!b.answer.read) throw new Error("T3 was read");
    const values = new Map(b.answer.values);
    values.set(b.keys[j] as string, v);
    return { ...b, answer: { read: true, values } };
  };

  it("fills T3 from the block as read", () => {
    expect(fill(b)).toMatchObject({ last_runtime_upgrade_spec: 1014020, result: "success", fee_raw: stepOf("T3").fee_raw, after: stepOf("T3").after });
  });

  it("when the batch answer was refused", () => {
    expect(fill({ ...b, answer: { read: false, refused: "refused" } })).toEqual({});
  });

  it("when System.LastRuntimeUpgrade names a runtime no reviewed line names, or is absent", () => {
    const lru = b.answer.read ? (b.answer.values.get(b.keys[1] as string) as Uint8Array) : new Uint8Array();
    const other = lru.slice();
    other[1] = (other[1] as number) ^ 1;
    expect(fill(withValue(1, other))).toEqual({});
    expect(fill(withValue(1, null))).toEqual({});
  });

  it("when the events do not decode: the runtime is named, nothing else", () => {
    expect(fill(withValue(0, new Uint8Array([0x04])))).toEqual({ last_runtime_upgrade_spec: 1014020 });
  });

  it("when the block is not the one the run time record names finalized, or does not hold the signed extrinsic exactly once", () => {
    expect(fill({ ...b, answeredHash: `0x${"00".repeat(32)}` })).toEqual({});
    expect(chainFill(b, { ...s.run_time.sent, status: "deadline" }, ext, R.inputs, R.metadata)).toEqual({});
    expect(fill({ ...b, extrinsics: (b.extrinsics as string[]).filter((x) => x !== ext) })).toEqual({});
    expect(fill({ ...b, extrinsics: [...(b.extrinsics as string[]), ext] })).toEqual({});
  });

  it("when a read does not decode, that read alone stays null", () => {
    const j = b.reads.findIndex((r) => r.entry === "CircuitBreakers");
    const f = fill(withValue(j, new Uint8Array([0x01]))) as Rec;
    expect(f.after.breaker_tx_count).toBeNull();
    expect(f.after.session_nonce).toBe(stepOf("T3").after.session_nonce);
    expect(f.raw_reads[b.keys[j] as string]).toBe("0x01");
  });

  it("the before stays the run time record's when the start block cannot be read", () => {
    const start = blockOf("start");
    expect(beforeFill({ ...start, answer: { read: false, refused: "refused" } }, RUN_TIME.start.finalized, R.inputs, R.metadata)).toBeNull();
    expect(beforeFill(start, { ...RUN_TIME.start.finalized, hash: `0x${"00".repeat(32)}` }, R.inputs, R.metadata)).toBeNull();
  });
});

describe("stored against not stored, with made answers, for each kind of read the fill writes (C5, T4)", () => {
  const md = encoderMetadata();
  /** The reads of a block with one entry's answer replaced by a made one. */
  const made = (id: string, entry: string, account: string | null, answer: Uint8Array | null) => {
    const b = blockOf(id);
    const p = pinBlock(b.answer, b.keys[0], b.keys[1], md);
    if (p.state !== "decoded") throw new Error(`${id} decodes`);
    const j = b.reads.findIndex((r) => r.entry === entry && (account === null || r.keys.some((k) => "account" in k && k.account === account)));
    const values = new Map(p.values);
    values.set(b.keys[j] as string, answer);
    return readsOf(b, p.pin, values, R.inputs).after;
  };
  const zeros = (n: number) => new Uint8Array(n);
  /** The default bytes of System.Account: every number 0 and the top bit of flags set, as the metadata states it. */
  const accountDefault = () => {
    const a = new Uint8Array(4 * 4 + 16 * 4);
    a[a.length - 1] = 0x80;
    return a;
  };

  it("an account: nothing stored is { absent: true }; the default's bytes stored are a stored account with its numbers", () => {
    expect(made("T3", "Account", "device", null).accounts.device).toEqual({ absent: true });
    expect(made("T3", "Account", "device", accountDefault()).accounts.device).toEqual({ free: "0", reserved: "0", nonce: "0" });
    expect(made("T9", "Account", "owner", null).accounts.owner).toEqual({ absent: true });
  });

  it("the session: nothing stored is { absent: true }; a stored session is its fields", () => {
    expect(made("T3", "Sessions", null, null).session).toEqual({ absent: true });
    const t3 = blockOf("T3");
    const bytes = t3.answer.read ? (t3.answer.values.get(t3.keys[t3.reads.findIndex((r) => r.entry === "Sessions")] as string) as Uint8Array) : null;
    expect(made("start", "Sessions", null, bytes).session).toEqual(stepOf("T3").after.session);
  });

  it("the session nonce: nothing stored is \"absent\"; the default's bytes stored are \"0\"", () => {
    expect(made("T3", "SessionNonces", null, null).session_nonce).toBe("absent");
    expect(made("start", "SessionNonces", null, zeros(8)).session_nonce).toBe("0");
  });

  it("the breaker: nothing stored is \"absent\"; a stored breaker of tx_count 0 is \"0\"", () => {
    expect(made("T3", "CircuitBreakers", null, null).breaker_tx_count).toBe("absent");
    expect(made("start", "CircuitBreakers", null, zeros(4 + 4 + 16 + 1)).breaker_tx_count).toBe("0");
  });

  it("the channel: nothing stored is { absent: true }; a stored channel is its fields", () => {
    expect(made("T3", "Channels", null, null).channel).toEqual({ absent: true });
    const t3 = blockOf("T3");
    const bytes = t3.answer.read ? (t3.answer.values.get(t3.keys[t3.reads.findIndex((r) => r.entry === "Channels")] as string) as Uint8Array) : null;
    expect(made("start", "Channels", null, bytes).channel).toEqual(stepOf("T3").after.channel);
  });

  it("each text function writes unknown for a read not decoded, never a default", () => {
    const no: ReadOutcome = { decoded: false };
    expect([accountText(no), sessionText(no), sessionNonceText(no), breakerText(no), channelText(no)]).toEqual([
      { free: null, reserved: null, nonce: null, absent: null },
      { active: null, spent_raw: null, epoch_spent_raw: null },
      null,
      null,
      null,
    ]);
  });
});
