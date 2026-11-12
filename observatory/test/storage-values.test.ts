// Storage values (src/scale/block.ts decodeStorageValue): the 28 storage reads of the second real
// recording decoded through the one door, and each value held to what the lab's own devnet tests
// recorded (research/2026-11-11-session-escrow/results.json and
// research/2026-11-11-session-probe/results.json). Every expected value is taken from those files
// or from the first recording in this test, never typed in. Where no file holds a value, the test
// asserts what a chain rule says must hold, and each such assert is marked RULE; a value that no
// file and no rule fixes is marked READ: it is held to what the recording holds, so a change shows,
// and the report names it. Real data from one RPC endpoint: evidence, never proof (RULES.md 8).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type StorageRead as DoorRead, type StorageValue, decodeBlockEvents, decodeStorageValue } from "../src/scale/block.js";
import { type Decoded, decodeAt, decodeValue, decoding, valueBudget } from "../src/scale/decode.js";
import { decodeEvents } from "../src/scale/events.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { ScaleError } from "../src/scale/reader.js";
import { REVIEWED } from "../src/scale/shape.js";
import { hexBytes, recorded } from "./helpers/recorded.js";
import { type StorageRead, recordedStorage } from "./helpers/recorded-storage.js";
import type { Block, Read } from "./helpers/requests-derive.js";

const S = recordedStorage();
const FIRST = recorded();
const SHAPE = readFileSync(new URL(`../${REVIEWED.at(0)?.shapeFile}`, import.meta.url), "utf8");
const MD = S.md;
const record = (name: string) => JSON.parse(readFileSync(new URL(`../../research/${name}/results.json`, import.meta.url), "utf8"));
const ESC = record("2026-11-11-session-escrow");
const PRB = record("2026-11-11-session-probe");

const keyBytes = (r: Read): Uint8Array[] => r.keys.map((k) => hexBytes("account" in k ? S.inputs.accounts[k.account].value : S.inputs.channels[k.channel].value));
/** The door's input for one recorded read, with any field replaced. */
const doorInput = (r: StorageRead, over: Partial<DoorRead> = {}): DoorRead => ({
  specName: String(S.runtimeVersion.specName),
  specVersion: Number(S.runtimeVersion.specVersion),
  metadata: S.metadata,
  lastRuntimeUpgrade: S.lastRuntimeUpgrade.get(r.block) ?? new Uint8Array(),
  shapeText: SHAPE,
  pallet: r.read.pallet,
  entry: r.read.entry,
  keys: keyBytes(r.read),
  key: hexBytes(r.key),
  answer: r.answer,
  ...over,
});
const DECODED = new Map(S.reads.map((r) => [r.seq, decodeStorageValue(doorInput(r))]));

/** The read of an entry at a block, by the block's height, for one key input. */
function readAt(height: number, entry: string, key: string): StorageRead {
  const r = S.reads.find((x) => x.height === height && x.read.entry === entry && x.read.keys.some((k) => ("account" in k ? k.account : k.channel) === key));
  if (r === undefined) throw new Error(`no read of ${entry}(${key}) at ${height}`);
  return r;
}
function valueAt(height: number, entry: string, key: string): { stored: boolean; value: Record<string, Decoded> & Decoded } {
  const v = DECODED.get(readAt(height, entry, key).seq);
  if (v === undefined || !v.decoded) throw new Error(`${entry}(${key}) at ${height} not decoded: ${v && !v.decoded ? v.refused : "missing"}`);
  return { stored: v.stored, value: v.value as Record<string, Decoded> & Decoded };
}
const heightOf = (b: Block) => S.inputs.blocks[b].height.value;
const stepOf = (rec: { steps: { step: string; finalized_in_block: number }[] }, name: string) => {
  const s = rec.steps.find((x) => x.step === name);
  if (s === undefined) throw new Error(`no step ${name}`);
  return s as Record<string, unknown> & { finalized_in_block: number };
};
const utf8 = (hex: Decoded) => Buffer.from(hexBytes(String(hex))).toString("utf8");

/** The create_session call a test record holds, decoded with the recorded metadata: the session's terms as sent. */
function createSession(rec: { steps: { step: string; call: string }[] }) {
  const call = hexBytes(String(stepOf(rec as never, "2-create-session").call));
  const fsk = MD.pallets.find((p) => p.name === "FlopSessionKeys");
  expect(call.at(0)).toBe(fsk?.index);
  const v = decodeValue(MD, fsk?.calls ?? -1, call.subarray(1)) as { variant: string; fields: Record<string, Decoded> };
  expect(v.variant).toBe("create_session");
  return v.fields;
}

describe("the storage door, on the second recording", () => {
  it("decodes all 28 reads through decodeStorageValue, each pinned to the reviewed shape: 27 stored, one absent", () => {
    const all = [...DECODED.values()];
    expect(all.length).toBe(28);
    for (const v of all) expect(v.decoded ? v.reviewed : v.refused).toEqual(REVIEWED.at(0));
    expect(all.filter((v) => v.decoded && v.stored).length).toBe(27);
    expect(valueAt(3497567, "Channels", "ours")).toEqual({ stored: false, value: null });
  });

  it("gives every integer past u32 as a decimal string and every account as 0x and 32 bytes of hex, and no float", () => {
    const numbers = (v: Decoded): number[] => (typeof v === "number" ? [v] : Array.isArray(v) ? v.flatMap(numbers) : v !== null && typeof v === "object" ? Object.values(v).flatMap(numbers) : []);
    for (const v of DECODED.values()) if (v.decoded) for (const n of numbers(v.value)) expect(Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff, String(n)).toBe(true);
    const s = valueAt(3497611, "Sessions", "device_2").value;
    for (const k of ["spending_cap", "per_tx_limit", "daily_cap", "epoch_spent", "spent"]) expect(typeof s[k], k).toBe("string");
    for (const k of ["owner", "delegate"]) expect(s[k]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(typeof valueAt(3497611, "SessionNonces", "device_2").value).toBe("string");
    expect(typeof valueAt(3497611, "CircuitBreakers", "device_2").value.total_spend).toBe("string");
  });

  it("absent is an answer: Optional and null is null, Default and null is the metadata's default, and only bytes are stored", () => {
    // Real: the one absent read, an Optional entry.
    expect(valueAt(3497567, "Channels", "ours")).toEqual({ stored: false, value: null });
    // Real: a nonce the node holds as bytes that equal the default is stored all the same.
    const nonce = readAt(3497525, "SessionNonces", "device_2");
    expect(nonce.answer).toEqual(hexBytes("0x0000000000000000"));
    expect(DECODED.get(nonce.seq)).toMatchObject({ decoded: true, stored: true, value: "0" });
    // Synthetic: the recording holds no absent Default entry, so the same read is given a null answer.
    expect(decodeStorageValue(doorInput(nonce, { answer: null }))).toMatchObject({ decoded: true, stored: false, value: "0" });
    const fallback = MD.pallets.find((p) => p.name === "FlopSessionKeys")?.storage?.entries.find((e) => e.name === "SessionNonces");
    expect([fallback?.modifier, Buffer.from(fallback?.fallback ?? []).toString("hex")]).toEqual(["Default", "0000000000000000"]);
    // Synthetic: an Optional entry the node holds, given a null answer, is null and not stored.
    expect(decodeStorageValue(doorInput(readAt(3497611, "Sessions", "device_2"), { answer: null }))).toMatchObject({ decoded: true, stored: false, value: null });
  });

  it("refuses an entry the reviewed shape does not state, before anything else, whatever its key", () => {
    const r = readAt(3497611, "CircuitBreakers", "device_2");
    for (const [pallet, entry] of [
      ["FlopSessionKeys", "DelegateSessions"],
      ["ComputeChannel", "FailedAcks"],
      ["System", "Account"],
      ["flopsessionkeys", "Sessions"],
      ["FlopSessionKeys", "Sessions "],
    ] as const) {
      expect(decodeStorageValue(doorInput(r, { pallet, entry, metadata: new Uint8Array() }))).toEqual({
        decoded: false,
        refused: `not decoded: ${JSON.stringify(pallet)}.${JSON.stringify(entry)} is not a storage entry the reviewed shape states`,
      });
    }
  });

  it("checks the key: key parts of another account, another entry's key or the wrong number of parts are refused", () => {
    const s2 = readAt(3497611, "Sessions", "device_2");
    const n2 = readAt(3497611, "SessionNonces", "device_2");
    const wrong = "FlopSessionKeys.Sessions: the key asked is not the key of this entry and these key parts";
    // Device D1's key parts, with D2's key asked: the value is never read as D1's.
    expect(decodeStorageValue(doorInput(s2, { keys: [hexBytes(S.inputs.accounts.owner.value), hexBytes(S.inputs.accounts.device_1.value)] }))).toEqual({ decoded: false, refused: wrong });
    // The owner and the device swapped.
    expect(decodeStorageValue(doorInput(s2, { keys: [hexBytes(S.inputs.accounts.device_2.value), hexBytes(S.inputs.accounts.owner.value)] }))).toEqual({ decoded: false, refused: wrong });
    // The nonce's key and answer, read as a session.
    expect(decodeStorageValue(doorInput(n2, { entry: "Sessions" }))).toEqual({ decoded: false, refused: wrong });
    expect(decodeStorageValue(doorInput(s2, { keys: [hexBytes(S.inputs.accounts.owner.value)] }))).toEqual({ decoded: false, refused: "FlopSessionKeys.Sessions: storage FlopSessionKeys.Sessions takes 2 map keys, not 1" });
    expect(decodeStorageValue(doorInput(s2, { keys: [hexBytes(S.inputs.accounts.owner.value), hexBytes(S.inputs.accounts.device_2.value).subarray(1)] }))).toMatchObject({ decoded: false, refused: expect.stringMatching(/^FlopSessionKeys\.Sessions: storage FlopSessionKeys\.Sessions, map key 1: /) });
  });

  it("refuses with the pin's reason a spec, metadata, shape or block that is not the reviewed one", () => {
    const r = readAt(3497611, "Sessions", "device_2");
    expect(decodeStorageValue(doorInput(r, { specVersion: 1014015 }))).toEqual({ decoded: false, refused: "not decoded: spec tzkv-runtime 1014015 is not a reviewed shape" });
    expect(decodeStorageValue(doorInput(r, { shapeText: `${SHAPE} ` }))).toEqual({ decoded: false, refused: `not decoded: the shape file given is not the reviewed ${REVIEWED.at(0)?.shapeFile}` });
    expect(decodeStorageValue(doorInput(r, { lastRuntimeUpgrade: new Uint8Array() }))).toMatchObject({ decoded: false, refused: expect.stringMatching(/^not decoded: the block's LastRuntimeUpgrade: /) });
  });

  it("refuses a value with a byte after it, a value cut short, and input of the wrong kinds, each with a reason", () => {
    for (const r of S.reads) {
      if (r.answer === null) continue;
      const more = decodeStorageValue(doorInput(r, { answer: new Uint8Array([...r.answer, 0]) }));
      expect(more, `${r.read.entry} at ${r.height}`).toMatchObject({ decoded: false, refused: expect.stringMatching(new RegExp(`^${r.read.pallet}\\.${r.read.entry}: .* bytes before the end$`)) });
    }
    const r = readAt(3497611, "CircuitBreakers", "device_2");
    expect(decodeStorageValue(doorInput(r, { answer: (r.answer ?? new Uint8Array()).subarray(0, 24) }))).toMatchObject({ decoded: false, refused: expect.stringMatching(/^FlopSessionKeys\.CircuitBreakers: /) });
    expect(decodeStorageValue(doorInput(r, { answer: "0x00" as never }))).toEqual({ decoded: false, refused: "not decoded: the answer is not bytes" });
    expect(decodeStorageValue(doorInput(r, { key: "0x00" as never }))).toEqual({ decoded: false, refused: "not decoded: the storage key is not bytes" });
    expect(decodeStorageValue(doorInput(r, { keys: "0x00" as never }))).toEqual({ decoded: false, refused: "not decoded: the key parts are not a list" });
    expect(decodeStorageValue(doorInput(r, { keys: ["0x00" as never] }))).toEqual({ decoded: false, refused: "not decoded: key part 0 is not bytes" });
    expect(decodeStorageValue(doorInput(r, { entry: 7 as never }))).toEqual({ decoded: false, refused: "not decoded: the pallet and the entry must be strings" });
  });

  it("reads each field of its input once and copies its bytes: an answer changed after the call or behind a getter changes nothing", () => {
    const r = readAt(3497611, "CircuitBreakers", "device_2");
    const answer = new Uint8Array(r.answer ?? []);
    let reads = 0;
    const input = doorInput(r);
    Object.defineProperty(input, "answer", {
      get: () => {
        reads++;
        return reads === 1 ? answer : new Uint8Array(25);
      },
    });
    const v = decodeStorageValue(input);
    expect(reads).toBe(1);
    expect(v).toEqual(DECODED.get(r.seq));
  });
});

describe("the first recording still pins and decodes exactly as before", () => {
  it("decodes the events of all twelve blocks through decodeBlockEvents, equal to decodeEvents on the same bytes", () => {
    const md = parseMetadata(FIRST.metadata);
    for (const b of FIRST.blocks) {
      const v = decodeBlockEvents({ specName: String(FIRST.runtimeVersion.specName), specVersion: Number(FIRST.runtimeVersion.specVersion), metadata: FIRST.metadata, lastRuntimeUpgrade: b.lastRuntimeUpgrade, shapeText: SHAPE, events: b.events });
      expect(v.decoded ? v.events : v.refused, String(b.number)).toEqual(decodeEvents(md, b.events));
    }
  });
});

describe("values against the second session test (research/2026-11-11-session-escrow)", () => {
  const terms = createSession(ESC);
  const created = heightOf("session-escrow/2-create-session");
  const AFTER: [Block, string][] = [
    ["session-escrow/2-create-session", "after_step_2"],
    ["session-escrow/3-force-open-declared-0", "after_step_3"],
    ["session-escrow/4-force-open-declared-0.012", "after_step_4"],
    ["session-escrow/6-force-open-over-daily", "after_step_6"],
    ["session-escrow/7-expire-force-open", "after_step_7"],
  ];

  it("holds the session's terms as the create_session call and the record give them, at every block it is read", () => {
    expect(created).toBe(ESC.session.created_in_block);
    for (const s of S.reads.filter((r) => r.read.entry === "Sessions" && r.block.startsWith("session-escrow/"))) {
      const v = valueAt(s.height, "Sessions", "device_2").value;
      expect(v, String(s.height)).toMatchObject({
        owner: ESC.owner.public_key,
        delegate: ESC.device.public_key,
        spending_cap: ESC.session.spending_cap_raw,
        per_tx_limit: ESC.session.per_tx_limit_raw,
        daily_cap: ESC.session.daily_cap_raw,
        expires_at: ESC.session.expires_at,
      });
      expect([v.spending_cap, v.per_tx_limit, v.daily_cap, v.delegate]).toEqual([terms.spending_cap, terms.per_tx_limit, terms.daily_cap, terms.delegate]);
      expect((v.allowed_pallets as Decoded[]).map(utf8)).toEqual(ESC.session.allowed_pallets);
      // RULE: a session expires its duration after the block that created it.
      expect(v.expires_at).toBe(created + Number(terms.duration_blocks));
      // READ: the first spending epoch starts at the block that created the session; no file says so.
      expect(v.epoch_start).toBe(created);
    }
  });

  it("holds spent and epoch_spent after each step as the record gives them, and the nonce in SessionNonces", () => {
    for (const [b, k] of AFTER) {
      const want = ESC.session_record[k];
      const s = valueAt(heightOf(b), "Sessions", "device_2");
      expect([b, s.stored, s.value.spent, s.value.epoch_spent]).toEqual([b, true, want.spent_raw, want.epoch_spent_raw]);
      const n = valueAt(heightOf(b), "SessionNonces", "device_2");
      expect([b, n.stored, n.value]).toEqual([b, true, String(want.nonce)]);
    }
  });

  it("holds the session active until the revoke and inactive after it, with nothing spent by the revoke", () => {
    for (const [b] of AFTER) expect([b, valueAt(heightOf(b), "Sessions", "device_2").value.active]).toEqual([b, true]); // RULE: active from create_session until revoke_session.
    const revoked = valueAt(heightOf("session-escrow/8-revoke-session"), "Sessions", "device_2").value;
    expect(revoked.active).toBe(ESC.session_record.after_step_8.active);
    // RULE: a revoke moves no value, so the counters are those after step 7.
    expect([revoked.spent, revoked.epoch_spent]).toEqual([ESC.session_record.after_step_7.spent_raw, ESC.session_record.after_step_7.epoch_spent_raw]);
  });

  it("holds the device's circuit breaker after steps 4, 6 and 7 as the record gives it", () => {
    const breaker = (b: Block) => valueAt(heightOf(b), "CircuitBreakers", "device_2");
    const want = (w: { period_start: number; tx_count: number; total_spend_raw: string; tripped: boolean }) => ({ stored: true, value: { period_start: w.period_start, tx_count: w.tx_count, total_spend: w.total_spend_raw, tripped: w.tripped } });
    expect(breaker("session-escrow/4-force-open-declared-0.012")).toEqual(want(ESC.circuit_breaker_of_device.after_step_4));
    expect(ESC.circuit_breaker_of_device.after_step_6).toBe("unchanged");
    expect(breaker("session-escrow/6-force-open-over-daily")).toEqual(want(ESC.circuit_breaker_of_device.after_step_4));
    expect(breaker("session-escrow/7-expire-force-open")).toEqual(want(ESC.circuit_breaker_of_device.after_step_7));
  });

  it("RULE: a refused call leaves the session, the nonce and the breaker as they were", () => {
    // Step 3 (refused) against step 2, and step 6 (after the refused steps 5 and 6) against step 4.
    for (const [after, before, entries] of [
      ["session-escrow/3-force-open-declared-0", "session-escrow/2-create-session", ["Sessions", "SessionNonces"]],
      ["session-escrow/6-force-open-over-daily", "session-escrow/4-force-open-declared-0.012", ["Sessions", "SessionNonces", "CircuitBreakers"]],
    ] as [Block, Block, string[]][]) {
      for (const e of entries) expect([after, e, valueAt(heightOf(after), e, "device_2")]).toEqual([after, e, valueAt(heightOf(before), e, "device_2")]);
    }
    expect(stepOf(ESC, "3-force-open-declared-0").result).toMatch(/^failed: /);
    expect(stepOf(ESC, "5-force-open-over-per-call").result).toMatch(/^failed: /);
    expect(stepOf(ESC, "6-force-open-over-daily").result).toMatch(/^failed: /);
  });

  it("RULE: before any call through the session succeeded, the breaker counts no call and no spend; READ: its period starts at the session's creation", () => {
    // Step 3 is the first call through the session and it was refused and rolled back.
    const b = valueAt(heightOf("session-escrow/3-force-open-declared-0"), "CircuitBreakers", "device_2");
    expect([b.stored, b.value.tx_count, b.value.total_spend, b.value.tripped]).toEqual([true, 0, "0", false]);
    expect(b.value.period_start).toBe(created);
  });

  it("RULE: the refused force_open opened no channel, so the channel is absent at that block", () => {
    expect(valueAt(heightOf("session-escrow/3-force-open-declared-0"), "Channels", "ours")).toEqual({ stored: false, value: null });
  });

  it("holds our channel after force_open as the record gives it: agent, miner, agent key, escrow, terms and PendingAck", () => {
    const c = valueAt(heightOf("session-escrow/4-force-open-declared-0.012"), "Channels", "ours");
    const rec = ESC.channel.record_after_step_4;
    const fo = ESC.force_open;
    expect(c.stored).toBe(true);
    expect(c.value).toMatchObject({
      agent: ESC.owner.public_key,
      miner: ESC.named_miner.public_key,
      agent_key: ESC.device.public_key,
      escrow: rec.escrow_raw,
      model_hash: fo.model_hash,
      measured_root: fo.measured_root,
      precision: { variant: fo.precision, fields: null },
      sla: fo.sla,
      nonce: fo.channel_nonces.A,
      opened_at: rec.opened_at,
      state: { variant: rec.state, fields: { ack_deadline: rec.ack_deadline } },
      weights_pin: { variant: "Some", fields: rec.weights_pin },
    });
    expect(rec.enclave_key).toBe("all zero");
    expect(c.value.enclave_key).toBe(`0x${"00".repeat(32)}`);
    // RULE (the record's note): the ack deadline is opened_at plus 600.
    expect(rec.ack_deadline).toBe(rec.opened_at + 600);
  });

  it("holds our channel after expire_force_open as Closed, as the record gives it; READ: every other field is as after force_open", () => {
    const after = valueAt(heightOf("session-escrow/7-expire-force-open"), "Channels", "ours");
    const before = valueAt(heightOf("session-escrow/4-force-open-declared-0.012"), "Channels", "ours");
    expect(after.stored).toBe(true);
    expect(after.value.state).toEqual({ variant: ESC.channel.record_after_step_7.state, fields: null });
    // The record says the escrow was refunded to the owner; the channel's escrow field keeps the amount.
    const { state: s1, ...restAfter } = after.value as Record<string, Decoded>;
    const { state: s0, ...restBefore } = before.value as Record<string, Decoded>;
    expect(s1).not.toEqual(s0);
    expect(restAfter).toEqual(restBefore);
    expect([restAfter.agent, restAfter.miner, restAfter.escrow]).toEqual([ESC.owner.public_key, ESC.named_miner.public_key, ESC.channel.record_after_step_4.escrow_raw]);
  });
});

describe("values against the first session test (research/2026-11-11-session-probe)", () => {
  const terms = createSession(PRB);
  const created = heightOf("session-probe/2-create-session");
  const revoke = heightOf("session-probe/5-revoke-session");

  it("holds the session's terms as the create_session call gives them, at its creation and after its revoke", () => {
    expect(created).toBe(stepOf(PRB, "2-create-session").finalized_in_block);
    for (const h of [created, revoke]) {
      const v = valueAt(h, "Sessions", "device_1");
      expect(v.stored).toBe(true);
      expect(v.value).toMatchObject({ owner: PRB.owner.public_key, delegate: PRB.device.public_key, spending_cap: terms.spending_cap, per_tx_limit: terms.per_tx_limit, daily_cap: terms.daily_cap });
      expect(v.value.delegate).toBe(terms.delegate);
      expect((v.value.allowed_pallets as Decoded[]).map(utf8)).toEqual((terms.allowed_pallets as Decoded[]).map(utf8));
      // RULE: it expires its duration after creation; the record's note and left_on_chain give the same block.
      expect(v.value.expires_at).toBe(created + Number(terms.duration_blocks));
      expect(String(stepOf(PRB, "2-create-session").note)).toContain(`expires at block ${v.value.expires_at}`);
      expect(PRB.left_on_chain).toContain(`expiry ${v.value.expires_at}`);
      // The record: nothing spent (the one call through it was rolled back). READ: epoch_start is the creation block.
      expect([v.value.spent, v.value.epoch_spent, v.value.epoch_start]).toEqual(["0", "0", created]);
      expect(PRB.left_on_chain).toContain("nothing spent");
    }
  });

  it("holds it active at creation (RULE) and inactive after the revoke, as the record says", () => {
    expect(valueAt(created, "Sessions", "device_1").value.active).toBe(true);
    expect(valueAt(revoke, "Sessions", "device_1").value.active).toBe(false);
    expect(String(stepOf(PRB, "5-revoke-session").note)).toContain("active false");
    expect(PRB.left_on_chain).toContain("active false");
  });
});

describe("values of the gateway channel, which no results file holds", () => {
  const settled = heightOf("gateway/settled");
  const last = heightOf("session-escrow/9-return-funds");

  it("RULE: the channel whose Settled event is in block 3479299 is Closed there, with the escrow its EscrowToppedUp event gave", () => {
    const md = parseMetadata(FIRST.metadata);
    const channel = S.inputs.channels.gateway.value;
    const ofChannel = (e: { pallet: string; fields: unknown }) => e.pallet === "ComputeChannel" && (e.fields as Record<string, unknown>).channel_id === channel;
    const events = FIRST.blocks.flatMap((b) => decodeEvents(md, b.events).filter(ofChannel).map((e) => ({ block: b.number, ...e })));
    const settledEvent = events.find((e) => e.event === "Settled");
    const topped = events.filter((e) => e.event === "EscrowToppedUp");
    expect([settledEvent?.block, topped.length]).toEqual([settled, 1]);
    const c = valueAt(settled, "Channels", "gateway");
    expect(c.stored).toBe(true);
    expect(c.value.state).toEqual({ variant: "Closed", fields: null });
    expect(c.value.escrow).toBe((topped.at(0)?.fields as Record<string, Decoded>).total);
  });

  it("READ: the record at the last block of the second test is the record at 3479299, field for field", () => {
    expect(valueAt(last, "Channels", "gateway")).toEqual(valueAt(settled, "Channels", "gateway"));
  });
});

describe("damaged values: never anything but a ScaleError, never past the decoder's budget", () => {
  /** A decode of the read's entry over these bytes: a value, or refused with a ScaleError. */
  // As decodeValue does it, but counting the steps: no decode may take more than valueBudget(bytes).
  // The most any decode took, as a share of its bound, is checked once at the end of each test.
  let most = 0;
  const TYPE = new Map(S.reads.map((r) => [r.seq, MD.pallets.find((p) => p.name === r.read.pallet)?.storage?.entries.find((x) => x.name === r.read.entry)?.value ?? -1]));
  const outcome = (r: StorageRead, b: Uint8Array): "decoded" | "refused" => {
    const d = decoding(MD, b);
    const bound = valueBudget(b.length);
    try {
      decodeAt(d, TYPE.get(r.seq) ?? -1);
      d.r.end();
      return "decoded";
    } catch (x) {
      if (x instanceof ScaleError) return "refused";
      throw x;
    } finally {
      most = Math.max(most, (bound - Math.max(d.budget.left, 0)) / bound);
    }
  };

  it("refuses every prefix of every stored value short of its whole", () => {
    let n = 0;
    for (const r of S.reads) {
      if (r.answer === null) continue;
      for (let k = 0; k < r.answer.length; k++, n++) if (outcome(r, r.answer.subarray(0, k)) !== "refused") expect.fail(`${r.read.entry} at ${r.height} cut to ${k} decoded`);
    }
    expect(n).toBe(S.reads.reduce((t, r) => t + (r.answer?.length ?? 0), 0));
    expect(most).toBeLessThanOrEqual(1);
  }, 120_000);

  const flips = (reads: StorageRead[]) => {
    let decoded = 0;
    let refused = 0;
    for (const r of reads) {
      if (r.answer === null) continue;
      for (let bit = 0; bit < r.answer.length * 8; bit++) {
        const b = new Uint8Array(r.answer);
        b.set([(b.at(bit >> 3) ?? 0) ^ (1 << (bit & 7))], bit >> 3);
        if (outcome(r, b) === "decoded") decoded++;
        else refused++;
      }
    }
    expect(decoded + refused).toBe(8 * reads.reduce((t, r) => t + (r.answer?.length ?? 0), 0));
    expect(refused).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(1);
    return decoded + refused;
  };

  it("decodes or refuses with a ScaleError every single bit flip of the 21 stored session, nonce, breaker and channel values, within its budget", () => {
    const reads = S.reads.filter((r) => r.read.pallet !== "System");
    expect(reads.filter((r) => r.answer !== null).length).toBe(21);
    expect(flips(reads)).toBe(21_184);
  }, 120_000);

  it("decodes or refuses with a ScaleError every single bit flip of the 6 System.Events values read through the door, within its budget", () => {
    const reads = S.reads.filter((r) => r.read.pallet === "System");
    expect(reads.length).toBe(6);
    expect(flips(reads)).toBe(69_744);
  }, 300_000);

  it("through the door too: every prefix and bit flip of the breaker and the nonce ends in a value or a refusal", () => {
    for (const r of [readAt(3497611, "CircuitBreakers", "device_2"), readAt(3497611, "SessionNonces", "device_2")]) {
      const a = r.answer ?? new Uint8Array();
      const tries: Uint8Array[] = [];
      for (let k = 0; k < a.length; k++) tries.push(a.subarray(0, k));
      for (let bit = 0; bit < a.length * 8; bit += 7) {
        const b = new Uint8Array(a);
        b.set([(b.at(bit >> 3) ?? 0) ^ (1 << (bit & 7))], bit >> 3);
        tries.push(b);
      }
      for (const b of tries) {
        const v: StorageValue = decodeStorageValue(doorInput(r, { answer: b }));
        if (b.length < a.length) expect(v.decoded, `${r.read.entry} cut to ${b.length}`).toBe(false);
        if (!v.decoded) expect(v.refused).toMatch(new RegExp(`^FlopSessionKeys\\.${r.read.entry}: `));
      }
    }
  }, 120_000);
});
