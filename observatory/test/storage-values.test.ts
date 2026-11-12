// Storage values (src/scale/block.ts decodeStorageValue): the 28 storage reads of the second real
// recording decoded through the one door, and every field of every stored value held to something
// that is not this decoder (review round 20, rule R2):
//   (a) a results file of the lab's own devnet tests (research/2026-11-11-session-escrow and
//       research/2026-11-11-session-probe, results.json),
//   (b) an event of a recording (the first recording names the gateway channel's miner), or
//   (c) the reference decoder's decode of the same bytes (polkadot-api, tests only), marked READ.
// FIELDS below names the source of each field of each read, and a test fails when a field of a
// decoded value has none. The six System.Events reads are held to the results files: the sha256
// each file gives of the value, and the outcome event of each step at its extrinsic index. Where
// an assert rests on a chain rule and not on a file, it is marked RULE. Every expected value is
// taken from those files or from a recording in this test, never typed in. Real data from one RPC
// endpoint: evidence, never proof (RULES.md section 8).
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type StorageRead as DoorRead, type StorageValue, decodeBlockEvents, decodeStorageValue } from "../src/scale/block.js";
import { type Decoded, decodeAt, decodeValue, decoding, valueBudget } from "../src/scale/decode.js";
import { decodeEvents } from "../src/scale/events.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { MAX_INPUT_BYTES, ScaleError } from "../src/scale/reader.js";
import { REVIEWED, pinShape } from "../src/scale/shape.js";
import { type Plain, plain } from "./helpers/plain.js";
import { hexBytes, recorded } from "./helpers/recorded.js";
import { STORAGE_RECORDING, type StorageRead, recordedStorage } from "./helpers/recorded-storage.js";
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

/**
 * The terms of the session a test record's create_session step states, in its own words:
 * "lifetime cap N raw ..., per call N raw ..., per day N raw ..., for N blocks, allowed pallets X".
 */
function sessionTerms(rec: { steps: { step: string; what: string }[] }) {
  const what = String(stepOf(rec as never, "2-create-session").what);
  const m = /lifetime cap (\d+) raw .*, per call (\d+) raw .*, per day (\d+) raw .*, for (\d+) blocks, allowed pallets (\w+(?:, \w+)*)$/.exec(what);
  if (m === null) throw new Error(`the create_session step does not state its terms: ${what}`);
  return { spending_cap: m[1], per_tx_limit: m[2], daily_cap: m[3], duration_blocks: Number(m[4]), allowed_pallets: String(m[5]).split(", ") };
}
const hexText = (s: string) => `0x${Buffer.from(s, "utf8").toString("hex")}`;
const BUILDER = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(S.metadata))));
const typeOf = (r: StorageRead) => MD.pallets.find((p) => p.name === r.read.pallet)?.storage?.entries.find((e) => e.name === r.read.entry)?.value ?? -1;
/** A stored value in the plain form, on our side and on the reference's, from the same bytes. */
function bothSides(r: StorageRead): { ours: Plain; reference: Plain } {
  const v = DECODED.get(r.seq);
  if (v === undefined || !v.decoded || r.answer === null) throw new Error(`${r.read.entry} at ${r.height} is no stored value`);
  return { ours: plain(MD, "ours", typeOf(r), v.value), reference: plain(MD, "reference", typeOf(r), BUILDER.buildStorage(r.read.pallet, r.read.entry).value.dec(r.answer.slice())) };
}

describe("the storage door, on the second recording", () => {
  it("decodes the answers the fixture's tape holds, byte for byte, read here from the tape's own text", () => {
    // The tape's files are held to SHA256SUMS (test/storage-recording.test.ts); this holds the
    // bytes every test here decodes to that tape, apart from the helper that lays them out.
    const tape = readFileSync(new URL(`../fixtures/${STORAGE_RECORDING}/tape.jsonl`, import.meta.url), "utf8").split("\n").filter((l) => l !== "").slice(1).map((l) => JSON.parse(l) as { seq: number; answer: { result: string | null } });
    for (const r of S.reads) {
      const line = tape.find((x) => x.seq === r.seq);
      expect([r.seq, r.answer === null ? null : `0x${Buffer.from(r.answer).toString("hex")}`]).toEqual([r.seq, line?.answer.result]);
    }
  });

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
    expect(decodeStorageValue(doorInput(r, { entry: 7 as never }))).toEqual({ decoded: false, refused: "not decoded: the pallet and the entry must be strings of at most 256 characters" });
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

  it("checks the key byte for byte: one byte more, one byte fewer, the last byte changed, and another plain entry's key are refused, and no refusal prints the key", () => {
    const b = readAt(3497611, "CircuitBreakers", "device_2");
    const key = hexBytes(b.key);
    const last = new Uint8Array(key);
    last.set([(last.at(-1) ?? 0) ^ 1], last.length - 1);
    expect(decodeStorageValue(doorInput(b, { key: new Uint8Array([...key, 0]) }))).toEqual({ decoded: false, refused: `FlopSessionKeys.CircuitBreakers: the key asked is ${key.length + 1} bytes, more than the ${key.length} of this entry and these key parts` });
    expect(decodeStorageValue(doorInput(b, { key: key.subarray(0, -1) }))).toEqual({ decoded: false, refused: `FlopSessionKeys.CircuitBreakers: the key asked is ${key.length - 1} bytes, fewer than the ${key.length} of this entry and these key parts` });
    expect(decodeStorageValue(doorInput(b, { key: last }))).toEqual({ decoded: false, refused: "FlopSessionKeys.CircuitBreakers: the key asked is not the key of this entry and these key parts" });
    // A plain entry: System.Events asked under the key of System.LastRuntimeUpgrade, of the same length.
    const events = S.reads.find((r) => r.read.entry === "Events") as StorageRead;
    const lru = S.calls.find((c) => c.method === "state_getStorage" && c.params[1] === events.hash && c.params[0] !== events.key)?.params[0] as string;
    expect(hexBytes(lru).length).toBe(hexBytes(events.key).length);
    expect(decodeStorageValue(doorInput(events, { key: hexBytes(lru) }))).toEqual({ decoded: false, refused: "System.Events: the key asked is not the key of this entry and these key parts" });
    // A key past the decoder's size limit is refused by its size, and the refusal stays short.
    const huge = decodeStorageValue(doorInput(b, { key: new Uint8Array(MAX_INPUT_BYTES + 1) }));
    expect(huge).toEqual({ decoded: false, refused: `not decoded: the storage key is ${MAX_INPUT_BYTES + 1} bytes, more than the ${MAX_INPUT_BYTES} this decoder reads` });
  });

  it("refuses an answer that is undefined: only null means absent", () => {
    for (const r of [readAt(3497611, "CircuitBreakers", "device_2"), readAt(3497567, "Channels", "ours"), readAt(3497611, "SessionNonces", "device_2")]) {
      expect(decodeStorageValue(doorInput(r, { answer: undefined as never }))).toEqual({ decoded: false, refused: "not decoded: the answer is not bytes" });
    }
  });

  it("reads the pallet and the entry first, and refuses an unstated entry before any other field is read, its malformed key parts included", () => {
    const r = readAt(3497611, "CircuitBreakers", "device_2");
    const seen: string[] = [];
    const input = new Proxy(doorInput(r, { entry: "DelegateSessions", keys: "not a list" as never }), {
      get(t, k, recv) {
        seen.push(String(k));
        return Reflect.get(t, k, recv);
      },
    });
    expect(decodeStorageValue(input)).toEqual({ decoded: false, refused: 'not decoded: "FlopSessionKeys"."DelegateSessions" is not a storage entry the reviewed shape states' });
    expect(seen).toEqual(["pallet", "entry"]);
    // A stated entry: the pin's fields, then the key parts, the key and the answer, each once.
    seen.length = 0;
    const stated = new Proxy(doorInput(r), {
      get(t, k, recv) {
        seen.push(String(k));
        return Reflect.get(t, k, recv);
      },
    });
    expect(decodeStorageValue(stated)).toEqual(DECODED.get(r.seq));
    expect(seen).toEqual(["pallet", "entry", "specName", "specVersion", "metadata", "lastRuntimeUpgrade", "shapeText", "keys", "key", "answer"]);
    expect(decodeStorageValue(doorInput(r, { pallet: "F".repeat(257) }))).toEqual({ decoded: false, refused: "not decoded: the pallet and the entry must be strings of at most 256 characters" });
  });

  it("refuses an input that is not plain data, with a text of its own: not an object, a getter that throws, a revoked Proxy, a Proxy over bytes", () => {
    const r = readAt(3497611, "CircuitBreakers", "device_2");
    for (const bad of [null, undefined, 7, "x", true]) expect(decodeStorageValue(bad as never)).toEqual({ decoded: false, refused: "not decoded: the input is not an object" });
    for (const field of ["pallet", "entry", "specName", "metadata", "keys", "key", "answer"] as const) {
      const input = doorInput(r);
      Object.defineProperty(input, field, {
        get() {
          throw new Error("SECRET from the caller");
        },
      });
      const v = decodeStorageValue(input);
      expect(v.decoded, field).toBe(false);
      expect(JSON.stringify(v), field).not.toContain("SECRET");
      expect(v.decoded ? "" : v.refused, field).toMatch(/^not decoded: .* could not be read$/);
    }
    const { proxy, revoke } = Proxy.revocable(doorInput(r), {});
    revoke();
    expect(decodeStorageValue(proxy)).toEqual({ decoded: false, refused: "not decoded: the pallet could not be read" });
    // A Proxy over a Uint8Array passes instanceof, and is refused all the same, its iterator never read.
    let pulls = 0;
    const fake = new Proxy(new Uint8Array(r.answer ?? []), {
      get(t, k) {
        if (k === Symbol.iterator) pulls++;
        return Reflect.get(t, k);
      },
    });
    expect(decodeStorageValue(doorInput(r, { answer: fake }))).toEqual({ decoded: false, refused: "not decoded: the answer is not bytes" });
    expect(decodeStorageValue(doorInput(r, { key: fake }))).toEqual({ decoded: false, refused: "not decoded: the storage key is not bytes" });
    expect(pulls).toBe(0);
    // Key parts are read by index once their count is checked, never through the list's iterator.
    const keys = new Proxy(keyBytes(r.read), {
      get(t, k) {
        if (k === Symbol.iterator) throw new TypeError("no iterator");
        return Reflect.get(t, k);
      },
    });
    expect(decodeStorageValue(doorInput(r, { keys }))).toEqual(DECODED.get(r.seq));
    const long = new Proxy(keyBytes(r.read), { get: (t, k) => (k === "length" ? 2 ** 40 : Reflect.get(t, k)) });
    expect(decodeStorageValue(doorInput(r, { keys: long }))).toEqual({ decoded: false, refused: "FlopSessionKeys.CircuitBreakers: storage FlopSessionKeys.CircuitBreakers takes 1 map keys, not 1099511627776" });
  });

  it("the other two doors refuse such input too: decodeBlockEvents and pinShape", () => {
    const b = FIRST.blocks.at(0);
    const base = { specName: "tzkv-runtime", specVersion: 1014014, metadata: FIRST.metadata, lastRuntimeUpgrade: b?.lastRuntimeUpgrade ?? new Uint8Array(), shapeText: SHAPE };
    for (const bad of [null, 7]) {
      expect(decodeBlockEvents(bad as never)).toEqual({ decoded: false, refused: "not decoded: the input is not an object" });
      expect(pinShape(bad as never)).toEqual({ pinned: false, refused: "the input is not an object" });
    }
    const thrower = { ...base, events: b?.events ?? new Uint8Array() };
    Object.defineProperty(thrower, "events", {
      get() {
        throw new Error("SECRET");
      },
    });
    expect(decodeBlockEvents(thrower)).toEqual({ decoded: false, refused: "not decoded: the events could not be read" });
    const pinThrower = { ...base };
    Object.defineProperty(pinThrower, "shapeText", {
      get() {
        throw new Error("SECRET");
      },
    });
    expect(pinShape(pinThrower)).toEqual({ pinned: false, refused: "the shape file could not be read" });
    expect(pinShape({ ...base, metadata: new Proxy(FIRST.metadata, {}) })).toEqual({ pinned: false, refused: "the metadata is not bytes" });
    expect(pinShape({ ...base, specName: "t".repeat(257) })).toEqual({ pinned: false, refused: "the spec name is longer than 256 characters" });
    expect(pinShape(base).pinned).toBe(true);
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
  const terms = sessionTerms(ESC);
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
      expect([v.spending_cap, v.per_tx_limit, v.daily_cap]).toEqual([terms.spending_cap, terms.per_tx_limit, terms.daily_cap]);
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
  const terms = sessionTerms(PRB);
  const created = heightOf("session-probe/2-create-session");
  const revoke = heightOf("session-probe/5-revoke-session");

  it("holds the session's terms as the create_session call gives them, at its creation and after its revoke", () => {
    expect(created).toBe(stepOf(PRB, "2-create-session").finalized_in_block);
    for (const h of [created, revoke]) {
      const v = valueAt(h, "Sessions", "device_1");
      expect(v.stored).toBe(true);
      expect(v.value).toMatchObject({ owner: PRB.owner.public_key, delegate: PRB.device.public_key, spending_cap: terms.spending_cap, per_tx_limit: terms.per_tx_limit, daily_cap: terms.daily_cap });
      expect((v.value.allowed_pallets as Decoded[]).map(utf8)).toEqual(terms.allowed_pallets);
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
  const md = parseMetadata(FIRST.metadata);
  const channel = S.inputs.channels.gateway.value;
  const ofChannel = (e: { pallet: string; fields: unknown }) => e.pallet === "ComputeChannel" && (e.fields as Record<string, unknown>).channel_id === channel;
  const events = FIRST.blocks.flatMap((b) => decodeEvents(md, b.events).filter(ofChannel).map((e) => ({ block: b.number, ...e })));
  const one = (name: string) => {
    const x = events.filter((e) => e.event === name);
    expect([name, x.length]).toEqual([name, 1]);
    return x.at(0)?.fields as Record<string, Decoded>;
  };

  it("(b) holds the miner to the first recording's ToplocEvidenceSubmitted, at both blocks", () => {
    const toploc = one("ToplocEvidenceSubmitted");
    for (const h of [settled, last]) expect(valueAt(h, "Channels", "gateway").value.miner).toBe(toploc.miner);
  });

  it("RULE: the channel whose Settled event is in block 3479299 is Closed there; READ: its escrow is the total its EscrowToppedUp event gave", () => {
    expect(events.find((e) => e.event === "Settled")?.block).toBe(settled);
    const c = valueAt(settled, "Channels", "gateway");
    expect(c.stored).toBe(true);
    expect(c.value.state).toEqual({ variant: "Closed", fields: null });
    expect(c.value.escrow).toBe(one("EscrowToppedUp").total);
  });

  it("READ: every other field at both blocks is the reference decoder's decode of the same bytes", () => {
    for (const h of [settled, last]) {
      const r = readAt(h, "Channels", "gateway");
      const { ours, reference } = bothSides(r);
      const o = ours as Record<string, Plain>;
      const f = reference as Record<string, Plain>;
      expect(o.agent, `${h} agent`).toEqual(f.agent);
      expect(o.agent_key, `${h} agent_key`).toEqual(f.agent_key);
      expect(o.enclave_key, `${h} enclave_key`).toEqual(f.enclave_key);
      expect(o.model_hash, `${h} model_hash`).toEqual(f.model_hash);
      expect(o.measured_root, `${h} measured_root`).toEqual(f.measured_root);
      expect(o.precision, `${h} precision`).toEqual(f.precision);
      expect(o.sla, `${h} sla`).toEqual(f.sla);
      expect(o.nonce, `${h} nonce`).toEqual(f.nonce);
      expect(o.opened_at, `${h} opened_at`).toEqual(f.opened_at);
      expect(o.last_attested_at, `${h} last_attested_at`).toEqual(f.last_attested_at);
      expect(o.transcript_ref, `${h} transcript_ref`).toEqual(f.transcript_ref);
      expect(o.weights_pin, `${h} weights_pin`).toEqual(f.weights_pin);
      expect(o.locked_compute_consumed, `${h} locked_compute_consumed`).toEqual(f.locked_compute_consumed);
      expect(o.escrow, `${h} escrow`).toEqual(f.escrow);
      expect(o.state, `${h} state`).toEqual(f.state);
      expect(o.miner, `${h} miner`).toEqual(f.miner);
    }
  });
});

/**
 * What each field of each stored entry read is held to: (a) a value from a results file, (b) a value
 * from an event of a recording, or "c" for READ, the reference decoder's decode of the same bytes.
 * A SessionNonces value has one field, "value". The six System.Events reads are held in the
 * describe below this one.
 */
type Source = { a: Decoded } | { b: Decoded } | "c";
const ESCROW_AFTER: Partial<Record<Block, string>> = {
  "session-escrow/2-create-session": "after_step_2",
  "session-escrow/3-force-open-declared-0": "after_step_3",
  "session-escrow/4-force-open-declared-0.012": "after_step_4",
  "session-escrow/6-force-open-over-daily": "after_step_6",
  "session-escrow/7-expire-force-open": "after_step_7",
  "session-escrow/8-revoke-session": "after_step_8",
};
const BREAKER_AFTER: Partial<Record<Block, string>> = {
  "session-escrow/4-force-open-declared-0.012": "after_step_4",
  "session-escrow/6-force-open-over-daily": "after_step_6",
  "session-escrow/7-expire-force-open": "after_step_7",
};
function FIELDS(r: StorageRead): Record<string, Source> {
  const a = (v: Decoded): Source => ({ a: v });
  const c = "c" as const;
  const escrow = r.block.startsWith("session-escrow/");
  if (r.read.entry === "Sessions" && escrow) {
    const rec = ESC.session_record[ESCROW_AFTER[r.block] ?? ""] ?? {};
    const terms = sessionTerms(ESC);
    return {
      owner: a(ESC.owner.public_key),
      delegate: a(ESC.device.public_key),
      spending_cap: a(ESC.session.spending_cap_raw),
      per_tx_limit: a(ESC.session.per_tx_limit_raw),
      daily_cap: a(ESC.session.daily_cap_raw),
      epoch_spent: rec.epoch_spent_raw === undefined ? c : a(rec.epoch_spent_raw),
      epoch_start: c,
      spent: rec.spent_raw === undefined ? c : a(rec.spent_raw),
      expires_at: a(ESC.session.expires_at),
      allowed_pallets: a(terms.allowed_pallets.map(hexText)),
      active: rec.active === undefined ? c : a(rec.active),
    };
  }
  if (r.read.entry === "Sessions") {
    const terms = sessionTerms(PRB);
    const revoked = r.block === "session-probe/5-revoke-session";
    const expires = /expires at block (\d+)/.exec(String(stepOf(PRB, "2-create-session").note))?.[1];
    return {
      owner: a(PRB.owner.public_key),
      delegate: a(PRB.device.public_key),
      spending_cap: a(terms.spending_cap),
      per_tx_limit: a(terms.per_tx_limit),
      daily_cap: a(terms.daily_cap),
      epoch_spent: c,
      epoch_start: c,
      spent: c,
      expires_at: a(Number(expires)),
      allowed_pallets: a(terms.allowed_pallets.map(hexText)),
      // The revoke step's note: "The session record stays in storage with active false."
      active: revoked && /active false/.test(String(stepOf(PRB, "5-revoke-session").note)) ? a(false) : c,
    };
  }
  if (r.read.entry === "SessionNonces") {
    const rec = ESC.session_record[ESCROW_AFTER[r.block] ?? ""];
    return { value: rec?.nonce === undefined ? c : a(String(rec.nonce)) };
  }
  if (r.read.entry === "CircuitBreakers") {
    const key = BREAKER_AFTER[r.block];
    // After step 6 the record says "unchanged": the breaker after step 4.
    const w = key === undefined ? undefined : ESC.circuit_breaker_of_device[key] === "unchanged" ? ESC.circuit_breaker_of_device.after_step_4 : ESC.circuit_breaker_of_device[key];
    if (w === undefined) return { period_start: c, tx_count: c, total_spend: c, tripped: c };
    return { period_start: a(w.period_start), tx_count: a(w.tx_count), total_spend: a(w.total_spend_raw), tripped: a(w.tripped) };
  }
  // Channels.
  const all = ["agent", "miner", "model_hash", "measured_root", "precision", "enclave_key", "agent_key", "escrow", "sla", "nonce", "opened_at", "last_attested_at", "state", "transcript_ref", "weights_pin", "locked_compute_consumed"];
  const read = Object.fromEntries(all.map((f) => [f, c as Source]));
  if (r.read.keys.some((k) => "channel" in k && k.channel === "gateway")) {
    const md = parseMetadata(FIRST.metadata);
    const toploc = FIRST.blocks.flatMap((b) => decodeEvents(md, b.events)).find((e) => e.event === "ToplocEvidenceSubmitted" && (e.fields as Record<string, Decoded>).channel_id === S.inputs.channels.gateway.value);
    return { ...read, miner: { b: (toploc?.fields as Record<string, Decoded>).miner } };
  }
  if (r.block === "session-escrow/7-expire-force-open") return { ...read, state: a({ variant: ESC.channel.record_after_step_7.state, fields: null }) };
  const rec = ESC.channel.record_after_step_4;
  const fo = ESC.force_open;
  // The record says the enclave key is "all zero": 32 zero bytes, as the force_open call sends no key.
  const enclave = rec.enclave_key === "all zero" ? `0x${"00".repeat(32)}` : undefined;
  return {
    ...read,
    agent: a(ESC.owner.public_key),
    miner: a(ESC.named_miner.public_key),
    model_hash: a(fo.model_hash),
    measured_root: a(fo.measured_root),
    precision: a({ variant: fo.precision, fields: null }),
    enclave_key: enclave === undefined ? c : a(enclave),
    agent_key: a(ESC.device.public_key),
    escrow: a(rec.escrow_raw),
    sla: a(fo.sla),
    nonce: a(fo.channel_nonces.A),
    opened_at: a(rec.opened_at),
    state: a({ variant: rec.state, fields: { ack_deadline: rec.ack_deadline } }),
    weights_pin: a({ variant: "Some", fields: rec.weights_pin }),
  };
}

describe("every field of every stored entry value, held to a results file, a recording's event or the reference decoder", () => {
  const stored = S.reads.filter((r) => r.read.pallet !== "System" && r.answer !== null);

  it("names a source for exactly the fields each of the 21 values holds", () => {
    expect(stored.length).toBe(21);
    for (const r of stored) {
      const v = valueAt(r.height, r.read.entry, (r.read.keys.at(-1) as { account?: string; channel?: string }).account ?? (r.read.keys.at(-1) as { channel: string }).channel).value;
      const fields = r.read.entry === "SessionNonces" ? ["value"] : Object.keys(v);
      expect([r.seq, Object.keys(FIELDS(r)).sort()]).toEqual([r.seq, [...fields].sort()]);
    }
  });

  it("(a) and (b): each field a results file or a recording's event gives equals it", () => {
    const counts = { a: 0, b: 0 };
    for (const r of stored) {
      const v = DECODED.get(r.seq);
      const value = (v?.decoded ? v.value : null) as Record<string, Decoded> | string;
      for (const [f, src] of Object.entries(FIELDS(r))) {
        if (src === "c") continue;
        const got = r.read.entry === "SessionNonces" ? value : (value as Record<string, Decoded>)[f];
        const want = "a" in src ? src.a : src.b;
        expect([r.seq, r.read.entry, f, got]).toEqual([r.seq, r.read.entry, f, want]);
        counts["a" in src ? "a" : "b"]++;
      }
    }
    expect(counts).toEqual({ a: 99, b: 2 });
  });

  it("READ (c): every other field equals the reference decoder's decode of the same bytes", () => {
    let n = 0;
    for (const r of stored) {
      const { ours, reference } = bothSides(r);
      for (const [f, src] of Object.entries(FIELDS(r))) {
        if (src !== "c") continue;
        const o = r.read.entry === "SessionNonces" ? ours : (ours as Record<string, Plain>)[f];
        const ref = r.read.entry === "SessionNonces" ? reference : (reference as Record<string, Plain>)[f];
        expect([r.seq, f, o]).toEqual([r.seq, f, ref]);
        n++;
      }
      // And the whole value, so no field is left out of the comparison.
      expect(ours, String(r.seq)).toEqual(reference);
    }
    expect(n).toBe(72);
  });
});

describe("the six System.Events reads, held to the test records", () => {
  const events = S.reads.filter((r) => r.read.pallet === "System");
  /** The test record and step whose block is this read's, by the block hash the record gives. */
  const stepAt = (r: StorageRead) => {
    for (const rec of [ESC, PRB]) {
      const s = (rec.steps as Record<string, unknown>[]).find((x) => x.block_hash === r.hash);
      if (s !== undefined) return s;
    }
    throw new Error(`no step names block ${r.hash}`);
  };

  it("are six, each at a block a test record names, and each value's sha256 is the events_value_sha256 the record gives, where it gives one", () => {
    expect(events.length).toBe(6);
    let named = 0;
    for (const r of events) {
      const s = stepAt(r);
      if (s.events_value_sha256 === undefined) continue;
      named++;
      // The record's sha256 is of the value's 0x hex text, as the RPC answered it.
      const text = `0x${Buffer.from(r.answer ?? []).toString("hex")}`;
      expect([r.height, createHash("sha256").update(text).digest("hex")]).toEqual([r.height, s.events_value_sha256]);
    }
    expect(named).toBe(4);
  });

  it("hold each step's outcome at its extrinsic index: ExtrinsicSuccess, or ExtrinsicFailed with the module error the record names", () => {
    for (const r of events) {
      const s = stepAt(r);
      const v = DECODED.get(r.seq);
      expect(v?.decoded && v.stored).toBe(true);
      const at = decodeEvents(MD, r.answer ?? new Uint8Array()).filter((e) => e.pallet === "System" && (e.event === "ExtrinsicSuccess" || e.event === "ExtrinsicFailed") && (e.phase as { variant: string; fields: unknown }).fields === s.extrinsic_index);
      expect([r.height, at.length]).toEqual([r.height, 1]);
      const outcome = at.at(0);
      const result = String(s.result);
      if (/^(?:success|ExtrinsicSuccess)$/.test(result)) {
        expect([r.height, outcome?.event]).toEqual([r.height, "ExtrinsicSuccess"]);
        continue;
      }
      const m = /pallet (\d+),? error (\d+)/.exec(result);
      const name = /(\w+)\.(\w+)/.exec(result);
      expect([r.height, outcome?.event, m !== null, name !== null]).toEqual([r.height, "ExtrinsicFailed", true, true]);
      const err = (outcome?.fields as { dispatch_error: { variant: string; fields: { index: number; error: string } } }).dispatch_error;
      expect([r.height, err.variant, err.fields.index, hexBytes(err.fields.error).at(0)]).toEqual([r.height, "Module", Number(m?.[1]), Number(m?.[2])]);
      // The pallet and error named, as the metadata names that index.
      const p = MD.pallets.find((x) => x.index === err.fields.index);
      const errors = MD.types.at(p?.error ?? -1)?.def;
      const variant = errors?.kind === "variant" ? errors.variants.find((x) => x.index === Number(m?.[2]))?.name : undefined;
      expect([r.height, p?.name, variant]).toEqual([r.height, name?.[1], name?.[2]]);
    }
  });

  it("READ: decode event for event as the reference decoder decodes the same bytes, a failed call's module error as the reference names it", () => {
    // The reference reads a module error into the names of its pallet and error, so a failed call's
    // record is compared part by part: its phase, topics and dispatch info in the plain form, and
    // the pallet and error our index and error byte name in the metadata against the reference's.
    const recordType = MD.types.at(typeOf(events.at(0) as StorageRead))?.def;
    const record = recordType?.kind === "sequence" ? recordType.type : -1;
    const fields = (id: number) => {
      const d = MD.types.at(id)?.def;
      return d?.kind === "composite" ? Object.fromEntries(d.fields.map((f) => [f.name, f.type])) : {};
    };
    const sys = MD.pallets.find((p) => p.name === "System");
    const sysEvents = MD.types.at(sys?.event ?? -1)?.def;
    const failed = sysEvents?.kind === "variant" ? sysEvents.variants.find((v) => v.name === "ExtrinsicFailed") : undefined;
    const infoType = failed?.fields.find((f) => f.name === "dispatch_info")?.type ?? -1;
    const rf = fields(record) as Record<string, number>;
    let compared = 0;
    let failedSeen = 0;
    for (const r of events) {
      const ours = decodeValue(MD, typeOf(r), r.answer ?? new Uint8Array()) as { phase: Decoded; event: { variant: string; fields: { variant: string; fields: Record<string, Decoded> } }; topics: Decoded }[];
      const ref = BUILDER.buildStorage("System", "Events").value.dec((r.answer ?? new Uint8Array()).slice()) as { phase: unknown; event: { type: string; value: { type: string; value: Record<string, unknown> } }; topics: unknown }[];
      expect(ours.length, String(r.height)).toBe(ref.length);
      ours.forEach((o, i) => {
        const f = ref.at(i);
        if (o.event.variant === "System" && o.event.fields.variant === "ExtrinsicFailed") {
          failedSeen++;
          expect([f?.event.type, f?.event.value.type]).toEqual(["System", "ExtrinsicFailed"]);
          for (const k of ["phase", "topics"] as const) expect(plain(MD, "ours", rf[k] ?? -1, o[k])).toEqual(plain(MD, "reference", rf[k] ?? -1, f?.[k]));
          expect(plain(MD, "ours", infoType, o.event.fields.fields.dispatch_info)).toEqual(plain(MD, "reference", infoType, f?.event.value.value.dispatch_info));
          const err = o.event.fields.fields.dispatch_error as { variant: string; fields: { index: number; error: string } };
          const named = (f?.event.value.value.dispatch_error ?? {}) as { type: string; value: { type: string; value: { type: string } } };
          const p = MD.pallets.find((x) => x.index === err.fields.index);
          const ev = MD.types.at(p?.error ?? -1)?.def;
          const errName = ev?.kind === "variant" ? ev.variants.find((x) => x.index === hexBytes(err.fields.error).at(0))?.name : undefined;
          expect([err.variant, p?.name, errName]).toEqual([named.type, named.value.type, named.value.value.type]);
        } else {
          expect(plain(MD, "ours", record, o), `${r.height} event ${i}`).toEqual(plain(MD, "reference", record, f));
        }
        compared++;
      });
    }
    expect([compared > 0, failedSeen]).toEqual([true, 3]);
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
  });

  it("decodes or refuses with a ScaleError every bit flip of each stored value of at most 512 bytes, and of each larger one the bit at its byte index mod 8 in every byte, within its budget", () => {
    let decoded = 0;
    let refused = 0;
    let expected = 0;
    for (const r of S.reads) {
      if (r.answer === null) continue;
      const all = r.answer.length <= 512;
      expected += all ? 8 * r.answer.length : r.answer.length;
      for (let bit = 0; bit < r.answer.length * 8; bit++) {
        if (!all && bit % 8 !== (bit >> 3) % 8) continue;
        const b = new Uint8Array(r.answer);
        b.set([(b.at(bit >> 3) ?? 0) ^ (1 << (bit & 7))], bit >> 3);
        if (outcome(r, b) === "decoded") decoded++;
        else refused++;
      }
    }
    expect(decoded + refused).toBe(expected);
    expect(S.reads.filter((r) => (r.answer?.length ?? 0) > 512).map((r) => r.read.entry)).toEqual(["Events", "Events", "Events", "Events", "Events"]);
    expect(refused).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(1);
  });

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
  });
});
