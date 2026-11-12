// The session rerun's results.json (research/2026-11-12-session-rerun-1014020), filled from the
// fourth recording through the decoder's one door (src/scale/block.ts) by
// test/helpers/rerun-fill.ts, which scripts/fill-rerun-results.mjs runs. These tests hold the
// committed file to that fill byte for byte, show the fill gives every filled field back from the
// recording alone, hold the lead's fields untouched, and pin the verdict of the folder's own
// check.mjs exactly (review round 25, M4): 22 steps pass, and A10 is incomplete for its one read
// of FlopSessionKeys.DelegateSessions, which the reviewed shape does not state, and nothing else.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReadField } from "./helpers/requests/list-4.js";
import { recordedRerun } from "./helpers/recorded-rerun.js";
import { ERRORS_FILE, FILLED_FROM, clearFill, fillResults, fillStep, rerunResultsText } from "./helpers/rerun-fill.js";
import { RERUN_RESULTS } from "./helpers/requests-list.js";
// The folder's own checker, read as a module: tests start no process. check.mjs is its command line.
import { context, judgeRun } from "../../research/2026-11-12-session-rerun-1014020/rerun-lib.mjs";

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

  it("says once, at the top, where the filled values came from: the door, the batch answer, and the bytes not decoded", () => {
    expect(RESULTS.filled_from.recording).toBe(`observatory/fixtures/${"recording-20261112132634-0a472f1b49f7b661"}`);
    expect(RESULTS.filled_from.how).toContain("observatory/src/scale/block.ts");
    expect(RESULTS.filled_from.how).toContain("the batch answer listing its key with null");
    expect(RESULTS.filled_from.how).toContain("reads_not_decoded");
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

  it("leaves delegate_sessions_of_device at A10 null, unknown to the decoder, and keeps the bytes the node answered in reads_not_decoded", () => {
    const b = blockOf("A10");
    const j = b.reads.findIndex((r) => r.entry === "DelegateSessions");
    const bytes = b.answer.read ? (b.answer.values.get(b.keys[j] as string) as Uint8Array) : null;
    expect(stepOf("A10").reads_after.delegate_sessions_of_device).toBeNull();
    expect(stepOf("A10").reads_not_decoded).toEqual({ delegate_sessions_of_device: { entry: "FlopSessionKeys.DelegateSessions", bytes: `0x${Buffer.from(bytes as Uint8Array).toString("hex")}`, why: "the reviewed shape does not state this entry" } });
    expect((RESULTS.steps as Rec[]).filter((s) => s.reads_not_decoded !== undefined).map((s) => s.step)).toEqual(["A10"]);
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

  it("when a read does not decode, that read alone stays null", () => {
    const j = b.reads.findIndex((r) => r.entry === "CircuitBreakers");
    const f = fill(withValue(j, new Uint8Array([0x01])));
    expect(f.reads_after.breaker_tx_count).toBeNull();
    expect(f.reads_after.session_nonce).toBe(s.reads_after.session_nonce);
  });
});

describe("the folder's own checker on results.json (review round 25, M4)", () => {
  it("passes 22 steps with events and results as steps.json expects, and finds A10 incomplete for its one read and nothing else", () => {
    const out = judgeRun(context(RESULTS));
    expect(out.top).toEqual([]);
    expect(out.stoppedAt).toBeNull();
    expect(out.all).toBe(false);
    expect(out.run.filter((r: Rec) => r.status === "pass")).toHaveLength(22);
    expect(out.run.filter((r: Rec) => r.status !== "pass").map((r: Rec) => [r.id, r.status, r.problems])).toEqual([["A10", "incomplete", ["read delegate_sessions_of_device is missing"]]]);
  });

  it("would pass A10 too if that read were known, so nothing else holds it back", () => {
    const known = structuredClone(RESULTS);
    (known.steps as Rec[]).find((s) => s.step === "A10").reads_after.delegate_sessions_of_device = "empty";
    const out = judgeRun(context(known));
    expect([out.all, out.top, out.run.every((r: Rec) => r.status === "pass")]).toEqual([true, [], true]);
  });

  it("holds the file whose sha256 the README of the rerun names", () => {
    const readme = repoText("research/2026-11-12-session-rerun-1014020/README.md");
    expect(readme).toContain(createHash("sha256").update(TEXT).digest("hex"));
  });
});
