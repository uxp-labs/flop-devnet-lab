// The session rerun's results.json (research/2026-11-12-session-rerun-1014020), filled from the
// fourth recording through the decoder's one door (src/scale/block.ts) by
// test/helpers/rerun-fill.ts, which scripts/fill-rerun-results.mjs runs. These tests hold the
// committed file to that fill byte for byte, show the fill gives every filled field back from the
// recording alone, hold the lead's fields untouched, and pin the verdict of the folder's own
// check.mjs exactly (review round 25, M4): with decoder-shape@3 (round 29), which states
// FailedAcks and DelegateSessions, all 23 steps pass; the fill run again changed only A10's
// delegate_sessions_of_device and its reads_not_decoded note, and filled_from.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReadField } from "./helpers/requests/list-4.js";
import { RERUN_RESULTS, recordedRerun } from "./helpers/recorded-rerun.js";
import { ERRORS_FILE, FILLED_FROM, clearFill, fillResults, fillStep, rerunResultsText } from "./helpers/rerun-fill.js";
// The folder's own checker, read as a module: tests start no process. check.mjs is its command line.
import { context, judgeRun } from "../../research/2026-11-12-session-rerun-1014020/rerun-lib.mjs";
import { decodeStorageValue } from "../src/scale/block.js";
import { SHAPE_SCHEMA } from "../src/scale/shape.js";
import { keyBytes } from "./helpers/requests/core.js";

const REPO = new URL("../../", import.meta.url);
const repoText = (path: string) => readFileSync(new URL(path, REPO), "utf8");
const TEXT = repoText(RERUN_RESULTS);
type Rec = Record<string, any>;
const RESULTS = JSON.parse(TEXT) as Rec;
const R = recordedRerun();
const ERRORS = (JSON.parse(repoText(ERRORS_FILE)) as { errors: Rec[] }).errors as never[];
const FILL = new Set(["last_runtime_upgrade_spec", "events", "result", "fee_raw", "reads_after", "reads_not_decoded"]);
const stepOf = (id: string) => (RESULTS.steps as Rec[]).find((s) => s.step === id) as Rec;
const blockOf = (id: string) => R.blocks.find((b) => b.step.id === id) as (typeof R.blocks)[number];

describe("results.json of the session rerun, filled from the fourth recording", () => {
  it("is, byte for byte, what the fill gives from the committed file and the recording", () => {
    expect(TEXT).toBe(rerunResultsText());
  });

  it("gives back every filled field from the recording alone: the file with its fill fields cleared fills to the committed file", () => {
    const cleared = clearFill(RESULTS);
    for (const s of cleared.steps as Rec[]) {
      expect([s.last_runtime_upgrade_spec, s.events, s.result, s.fee_raw, s.reads_not_decoded], s.step).toEqual([null, [], null, null, undefined]);
      for (const v of Object.values(s.reads_after as Rec)) expect(v, s.step).toBeNull();
    }
    expect(`${JSON.stringify(fillResults(cleared), null, 2)}\n`).toBe(TEXT);
  });

  it("keeps every field the lead filled: only the fill fields and filled_from differ from the cleared file, and every step keeps its keys and order", () => {
    const cleared = clearFill(RESULTS);
    const { filled_from, steps, ...top } = RESULTS;
    const { steps: clearedSteps, ...clearedTop } = cleared;
    expect(top).toEqual(clearedTop);
    expect(filled_from).toEqual(FILLED_FROM);
    for (const [i, s] of (steps as Rec[]).entries()) {
      const c = (clearedSteps as Rec[])[i] as Rec;
      for (const k of Object.keys(s)) if (!FILL.has(k)) expect(s[k], `${s.step} ${k}`).toEqual(c[k]);
      expect(Object.keys(s).filter((k) => k !== "reads_not_decoded"), s.step).toEqual(Object.keys(c));
      expect(Object.keys(s.reads_after), s.step).toEqual(Object.keys(c.reads_after));
    }
    // The one event the lead decoded at run time for A6 is among the events the fill decoded.
    expect(stepOf("A6").events).toContainEqual({
      pallet: "ComputeChannel",
      name: "ForceOpenRequested",
      fields: expect.objectContaining({ channel_id: "0x7cee53edb4537323733eef3ff1bcac31fd09135ce94a8b6c8e3bae57619949f2", ack_deadline: 3553433 }),
    });
  });

  it("says once, at the top, where the filled values came from: the door, the shape format it pinned, the batch answer, and the bytes not decoded", () => {
    expect(RESULTS.filled_from.recording).toBe(`observatory/fixtures/${"recording-20261112132634-0a472f1b49f7b661"}`);
    expect(RESULTS.filled_from.how).toContain("observatory/src/scale/block.ts");
    expect(RESULTS.filled_from.how).toContain("the batch answer listing its key with null");
    expect(RESULTS.filled_from.how).toContain("reads_not_decoded");
    expect(RESULTS.filled_from.shape).toBe(SHAPE_SCHEMA);
    expect(SHAPE_SCHEMA).toBe("flop-observatory/decoder-shape@3");
  });

  it("changed nothing but A10's delegate_sessions_of_device, its reads_not_decoded note and filled_from, from the record the fill wrote with decoder-shape@2 (fixtures/shapes-at-2)", () => {
    const fixture = new URL("../fixtures/shapes-at-2/", import.meta.url);
    const oldText = readFileSync(new URL("session-rerun-results.json", fixture), "utf8");
    const sum = readFileSync(new URL("SHA256SUMS", fixture), "utf8").split("\n").find((l) => l.endsWith("  session-rerun-results.json"));
    expect(sum).toBe(`${createHash("sha256").update(oldText).digest("hex")}  session-rerun-results.json`);
    const before = JSON.parse(oldText) as Rec;
    const a10Before = (before.steps as Rec[]).find((x) => x.step === "A10") as Rec;
    expect([a10Before.reads_after.delegate_sessions_of_device, a10Before.reads_not_decoded?.delegate_sessions_of_device?.bytes]).toEqual([null, "0x00"]);
    const setAside = (r: Rec) => {
      const c = structuredClone(r);
      delete c.filled_from;
      const a10 = (c.steps as Rec[]).find((x) => x.step === "A10") as Rec;
      delete a10.reads_after.delegate_sessions_of_device;
      delete a10.reads_not_decoded;
      return c;
    };
    expect(setAside(RESULTS)).toEqual(setAside(before));
    // Key order kept too: the two records written the same way are the same text once set aside.
    expect(JSON.stringify(setAside(RESULTS))).toBe(JSON.stringify(setAside(before)));
    expect(stepOf("A10").reads_after.delegate_sessions_of_device).toBe("empty");
  });

  it("names the runtime of every block 1014020, the fee of each step as its one TransactionFeePaid, and fees that add up to what the owner's balance fell by", () => {
    for (const s of RESULTS.steps as Rec[]) {
      expect(s.last_runtime_upgrade_spec, s.step).toBe(RESULTS.spec_version);
      const fees = (s.events as Rec[]).filter((e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid");
      expect(fees.map((e) => e.fields.actual_fee), s.step).toEqual([s.fee_raw]);
    }
    const sum = (RESULTS.steps as Rec[]).reduce((n, s) => n + BigInt(s.fee_raw), 0n);
    const bal = RESULTS.owner_free_balance_raw;
    expect([sum, BigInt(bal.before) - BigInt(bal.after)]).toEqual([BigInt(bal.cost_raw), BigInt(bal.cost_raw)]);
  });

  it("writes every result as success or the error by pallet and error index in errors-1014020.json, and every enum value as type and value", () => {
    for (const s of RESULTS.steps as Rec[]) {
      const failed = (s.events as Rec[]).find((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
      if (failed === undefined) {
        expect(s.result, s.step).toBe("success");
        continue;
      }
      const d = failed.fields.dispatch_error;
      expect(d.type, s.step).toBe("Module");
      const row = (ERRORS as Rec[]).find((e) => e.pallet_index === d.value.index && e.error_index === Number.parseInt(d.value.error.slice(2, 4), 16)) as Rec;
      expect(s.result, s.step).toBe(`failed: ${row.pallet}.${row.name} (pallet ${row.pallet_index}, error ${row.error_index})`);
    }
    expect(JSON.stringify(RESULTS.steps)).not.toContain('"variant"');
  });

  it("fills failed_acks_of_named at A9 as absent from the batch answer, which lists the key the list built with null", () => {
    const b = blockOf("A9");
    const j = b.reads.findIndex((r) => r.entry === "FailedAcks");
    expect(b.answer.read && b.answer.values.get(b.keys[j] as string)).toBeNull();
    expect(stepOf("A9").reads_after.failed_acks_of_named).toBe("absent");
  });

  it("fills delegate_sessions_of_device at A10 as empty: the node answered 0x00, which the door decodes as a stored empty list; no step has a read not decoded", () => {
    const b = blockOf("A10");
    const j = b.reads.findIndex((r) => r.entry === "DelegateSessions");
    const bytes = b.answer.read ? (b.answer.values.get(b.keys[j] as string) as Uint8Array) : null;
    expect(bytes).toEqual(new Uint8Array([0]));
    expect(stepOf("A10").reads_after.delegate_sessions_of_device).toBe("empty");
    expect((RESULTS.steps as Rec[]).filter((s) => s.reads_not_decoded !== undefined).map((s) => s.step)).toEqual([]);
  });

  it("agrees with the fourth recording's FailedAcks and DelegateSessions reads decoded through the door here: A9 no value stored, A10 a stored empty list", () => {
    const pinOf = (id: string) => {
      const b = blockOf(id);
      if (!b.answer.read) throw new Error(`${id} was read`);
      const values = b.answer.values;
      const shapeText = readFileSync(new URL("../shapes/tzkv-runtime-1014020.json", import.meta.url), "utf8");
      return { b, values, pin: { specName: "tzkv-runtime", specVersion: stepOf(id).last_runtime_upgrade_spec, metadata: R.metadata, lastRuntimeUpgrade: values.get(b.keys[1] as string) as Uint8Array, shapeText } };
    };
    const read = (id: string, entry: string) => {
      const { b, values, pin } = pinOf(id);
      const j = b.reads.findIndex((r) => r.entry === entry);
      const r = b.reads[j];
      const key = b.keys[j] as string;
      if (r === undefined) throw new Error(`${id} reads no ${entry}`);
      return decodeStorageValue({ ...pin, pallet: r.pallet, entry: r.entry, keys: keyBytes(R.inputs, r), key: new Uint8Array(Buffer.from(key.slice(2), "hex")), answer: values.get(key) ?? null });
    };
    expect(read("A9", "FailedAcks")).toMatchObject({ decoded: true, stored: false, value: 0 });
    expect(stepOf("A9").reads_after.failed_acks_of_named).toBe("absent");
    expect(read("A10", "DelegateSessions")).toMatchObject({ decoded: true, stored: true, value: [] });
    expect(stepOf("A10").reads_after.delegate_sessions_of_device).toBe("empty");
  });
});

describe("the fill refuses, never guesses: a step's fill fields stay null when its block cannot be read", () => {
  const b = blockOf("A6");
  const s = stepOf("A6");
  const fields = Object.keys(s.reads_after) as ReadField[];
  const fill = (block: typeof b) => fillStep(block, R.inputs, R.metadata, s.extrinsic_index, fields, ERRORS);
  const nothing = { last_runtime_upgrade_spec: null, events: [], result: null, fee_raw: null, reads_after: Object.fromEntries(fields.map((f) => [f, null])), reads_not_decoded: {} };
  const withValue = (j: number, v: Uint8Array | null) => {
    if (!b.answer.read) throw new Error("A6 was read");
    const values = new Map(b.answer.values);
    values.set(b.keys[j] as string, v);
    return { ...b, answer: { read: true as const, values } };
  };

  it("fills A6 from the block as read", () => {
    expect(fill(b)).toMatchObject({ last_runtime_upgrade_spec: 1014020, result: "success", fee_raw: s.fee_raw, reads_after: s.reads_after });
  });

  it("when the batch answer was refused", () => {
    expect(fill({ ...b, answer: { read: false, refused: "refused" } })).toEqual(nothing);
  });

  it("when System.LastRuntimeUpgrade or System.Events is absent", () => {
    expect(fill(withValue(1, null))).toEqual(nothing);
    expect(fill(withValue(0, null))).toEqual(nothing);
  });

  it("when System.LastRuntimeUpgrade names a runtime no reviewed line names", () => {
    const lru = b.answer.read ? (b.answer.values.get(b.keys[1] as string) as Uint8Array) : new Uint8Array();
    const other = lru.slice();
    other[1] = (other[1] as number) ^ 1;
    expect(fill(withValue(1, other))).toEqual(nothing);
  });

  it("when the events do not decode: the runtime is named, nothing else", () => {
    expect(fill(withValue(0, new Uint8Array([0x04])))).toEqual({ ...nothing, last_runtime_upgrade_spec: 1014020 });
  });

  it("when the node holds a value for FailedAcks: not absent, the value as decimal text", () => {
    const a9 = blockOf("A9");
    const s9 = stepOf("A9");
    if (!a9.answer.read) throw new Error("A9 was read");
    const j = a9.reads.findIndex((r) => r.entry === "FailedAcks");
    const values = new Map(a9.answer.values);
    values.set(a9.keys[j] as string, new Uint8Array([1, 0, 0, 0]));
    const f = fillStep({ ...a9, answer: { read: true, values } }, R.inputs, R.metadata, s9.extrinsic_index, Object.keys(s9.reads_after) as ReadField[], ERRORS);
    expect(f.reads_after.failed_acks_of_named).toBe("1");
    expect(f.reads_not_decoded).toEqual({});
    expect(f.reads_after.session_nonce).toBe(s9.reads_after.session_nonce);
  });

  it("when the node holds a list of two pairs for DelegateSessions: the pairs as JSON text", () => {
    const a10 = blockOf("A10");
    const s10 = stepOf("A10");
    if (!a10.answer.read) throw new Error("A10 was read");
    const j = a10.reads.findIndex((r) => r.entry === "DelegateSessions");
    const owner = R.inputs.accounts.owner.value;
    const device = R.inputs.accounts.dev1.value;
    const hexBytes = (h: string) => [...Buffer.from(h.slice(2), "hex")];
    const values = new Map(a10.answer.values);
    values.set(a10.keys[j] as string, new Uint8Array([8, ...hexBytes(owner), ...hexBytes(device), ...hexBytes(device), ...hexBytes(owner)]));
    const f = fillStep({ ...a10, answer: { read: true, values } }, R.inputs, R.metadata, s10.extrinsic_index, Object.keys(s10.reads_after) as ReadField[], ERRORS);
    expect(f.reads_after.delegate_sessions_of_device).toBe(JSON.stringify([[owner, device], [device, owner]]));
    expect(f.reads_not_decoded).toEqual({});
  });

  it("when a read does not decode, that read alone stays null", () => {
    const j = b.reads.findIndex((r) => r.entry === "CircuitBreakers");
    const f = fill(withValue(j, new Uint8Array([0x01])));
    expect(f.reads_after.breaker_tx_count).toBeNull();
    expect(f.reads_after.session_nonce).toBe(s.reads_after.session_nonce);
  });
});

describe("the folder's own checker on results.json (review round 25, M4)", () => {
  it("passes all 23 steps with events, results and reads as steps.json expects", () => {
    const out = judgeRun(context(RESULTS));
    expect(out.top).toEqual([]);
    expect(out.stoppedAt).toBeNull();
    expect(out.all).toBe(true);
    expect(out.run.filter((r: Rec) => r.status === "pass")).toHaveLength(23);
    expect(out.run.filter((r: Rec) => r.status !== "pass")).toEqual([]);
  });

  it("would find A10 incomplete again if its read were unknown, so the read is what passes it", () => {
    const unknown = structuredClone(RESULTS);
    const a10 = (unknown.steps as Rec[]).find((s) => s.step === "A10");
    if (a10 === undefined) throw new Error("the results hold no step A10");
    a10.reads_after.delegate_sessions_of_device = null;
    const out = judgeRun(context(unknown));
    expect(out.run.filter((r: Rec) => r.status !== "pass").map((r: Rec) => [r.id, r.status, r.problems])).toEqual([["A10", "incomplete", ["read delegate_sessions_of_device is missing"]]]);
  });

  it("is what the README of the rerun is written from: the file's sha256, and the table of steps row by row", () => {
    const readme = repoText("research/2026-11-12-session-rerun-1014020/README.md");
    expect(readme).toContain(createHash("sha256").update(TEXT).digest("hex"));
    const expect_ = Object.fromEntries((JSON.parse(repoText("research/2026-11-12-session-rerun-1014020/steps.json")) as { steps: Rec[] }).steps.map((s) => [s.id, s.expect]));
    const rows = readme.split("\n").filter((l) => /^\| [AB]\d+ \|/.test(l));
    const seen = (r: string) => (r === "success" ? "success" : r.replace(/^failed: /, "").replace(/ \(pallet .*$/, ""));
    expect(rows).toEqual((RESULTS.steps as Rec[]).map((s) => `| ${s.step} | ${s.finalized_in_block} | ${expect_[s.step]} | ${seen(s.result)} | ${s.fee_raw} |`));
  });
});
