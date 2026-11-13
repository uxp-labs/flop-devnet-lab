/**
 * P2, rules T1 and T4: the session rerun, replayed. A scripted node answers from the observatory's committed
 * recording of the rerun (test/lib/recorded-node.ts). For every step of the rerun's results.json whose block the
 * recording holds, the events read equal the record's events, and the session values read equal the record's
 * reads. Then the cross check of S4 on the rerun's successful session calls, and a disagreement made by changing one
 * total. Nothing is compared with a value typed into this file: every expected value is the record's.
 */
import { describe, expect, it } from "vitest";
import { crossCheck } from "../src/chain-read/cross-check.js";
import { accountOf, sessionKeys } from "../src/chain-read/keys.js";
import { KEY_TABLE } from "../src/chain-read/key-table.js";
import { readBlockEvents, readSessionState, type BlockEventsAt, type SessionState } from "../src/chain-read/read.js";
import { hexOf } from "../src/chain-read/bytes.js";
import { type Log, RERUN_RESULTS, repoJson, rerunScript, transportOf } from "./lib/recorded-node.js";

type Value = null | boolean | number | string | Value[] | { [k: string]: Value };
const RESULTS = repoJson(RERUN_RESULTS);
const STEPS: any[] = RESULTS.steps;
const OWNER: string = RESULTS.accounts.owner.public_key;
const DELEGATES: string[] = [RESULTS.accounts.dev1.public_key, RESULTS.accounts.dev2.public_key];

/** A decoded value in the record's form: every { variant, fields } written { type, value }, as results.json events_form says. */
function recordForm(v: Value): Value {
  if (Array.isArray(v)) return v.map(recordForm);
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 2 && keys.includes("variant") && keys.includes("fields") && typeof v.variant === "string") return { type: v.variant, value: recordForm(v.fields as Value) };
    return Object.fromEntries(keys.map((k) => [k, recordForm(v[k] as Value)]));
  }
  return v;
}

/** The events of one extrinsic of the block, in the record's form. */
const eventsOfExtrinsic = (r: BlockEventsAt, index: number) =>
  r.events
    .filter((e: any) => e.phase?.variant === "ApplyExtrinsic" && e.phase.fields === index)
    .map((e) => ({ pallet: e.pallet, name: e.event, fields: recordForm(e.fields as Value) }));

const blockOf = (s: any) => ({ number: s.finalized_in_block as number, hash: s.block_hash as string });

/** The delegate whose session the step's recorded batch read: the one whose Sessions or SessionNonces key the recording answers at the block. */
function delegateOf(step: any): string | undefined {
  const script = rerunScript(step.block_hash);
  return DELEGATES.find((d) => {
    const line = KEY_TABLE.runtimes.find((r) => r.specVersion === RESULTS.spec_version);
    if (line === undefined) return false;
    const k = sessionKeys(line, (accountOf(OWNER) as any).value, (accountOf(d) as any).value);
    if (k.kind !== "known") return false;
    return [k.value.sessions.key, k.value.sessionNonces.key].some((key) => script.storage.has(`${step.block_hash} ${hexOf(key)}`));
  });
}

/** Each read of the record, and the value the session read gives for it. */
const READS: Record<string, (s: SessionState) => unknown> = {
  session_active: (s) => (s.session.kind === "known" ? String(s.session.value.active) : s.session),
  spent_raw: (s) => (s.session.kind === "known" ? String(s.session.value.spent) : s.session),
  epoch_spent_raw: (s) => (s.session.kind === "known" ? String(s.session.value.epoch_spent) : s.session),
  session_nonce: (s) => (s.sessionNonce.kind === "known" ? String(s.sessionNonce.value) : s.sessionNonce),
  breaker_tx_count: (s) => (s.circuitBreaker.kind === "known" ? String(s.circuitBreaker.value.tx_count) : s.circuitBreaker),
};

describe("T1: the rerun replayed from its recording", () => {
  it("the recording holds the block of every step of the record", () => {
    expect(STEPS.length).toBeGreaterThan(0);
    for (const s of STEPS) expect(rerunScript(s.block_hash).headers.has(s.block_hash)).toBe(true);
  });

  for (const step of STEPS) {
    it(`step ${step.step}: the events of its extrinsic equal the record's`, async () => {
      const t = transportOf(rerunScript(step.block_hash));
      const r = await readBlockEvents(t, blockOf(step));
      expect(r.kind).toBe("known");
      if (r.kind !== "known") return;
      expect(r.value.number).toBe(step.finalized_in_block);
      expect(r.value.hash).toBe(step.block_hash);
      expect(r.value.runtime.specVersion).toBe(step.last_runtime_upgrade_spec);
      expect(eventsOfExtrinsic(r.value, step.extrinsic_index)).toEqual(step.events);
    });
  }

  for (const step of STEPS) {
    const fields = Object.keys(step.reads_after).filter((f) => f in READS && step.reads_after[f] !== null);
    if (fields.length === 0) continue;
    it(`step ${step.step}: the session values read at its block equal the record's reads (${fields.join(", ")})`, async () => {
      const delegate = delegateOf(step);
      expect(delegate).toBeDefined();
      const log: Log = [];
      const r = await readSessionState(transportOf(rerunScript(step.block_hash), log), OWNER, delegate as string);
      expect(r.kind).toBe("known");
      if (r.kind !== "known") return;
      expect(r.value.number).toBe(step.finalized_in_block);
      expect(r.value.hash).toBe(step.block_hash);
      for (const f of fields) expect([f, (READS[f] as (s: SessionState) => unknown)(r.value)]).toEqual([f, step.reads_after[f]]);
      // An entry the recording did not read at this block is unknown, never absent and never a default.
      for (const e of [r.value.session, r.value.sessionNonce, r.value.circuitBreaker]) if (e.kind === "unknown") expect(e.reason).toMatch(/the recording holds no answer/);
    });
  }
});

/** The steps whose record holds the session's SessionCallExecuted: the rerun's successful session calls. */
const CALLS = STEPS.filter((s) => s.result === "success" && s.events.some((e: any) => e.pallet === "FlopSessionKeys" && e.name === "SessionCallExecuted"));

async function bothAt(step: any): Promise<{ state: SessionState; events: BlockEventsAt }> {
  const t = transportOf(rerunScript(step.block_hash));
  const state = await readSessionState(t, OWNER, delegateOf(step) as string);
  const events = await readBlockEvents(t, blockOf(step));
  if (state.kind !== "known" || events.kind !== "known") throw new Error("the replay did not read");
  return { state: state.value, events: events.value };
}

describe("T4: the cross check of S4 on the rerun", () => {
  it("the record holds successful session calls", () => {
    expect(CALLS.map((s) => s.step).length).toBeGreaterThan(0);
  });

  for (const step of CALLS) {
    it(`step ${step.step}: the event's totals agree with the stored session`, async () => {
      const { state, events } = await bothAt(step);
      const c = crossCheck(state, events);
      expect(c.kind).toBe("known");
      if (c.kind !== "known") return;
      const ev = step.events.find((e: any) => e.name === "SessionCallExecuted");
      expect(Object.fromEntries(Object.entries(c.value.totals).map(([k, v]) => [k, String(v)]))).toEqual({ spent: ev.fields.spent, epoch_spent: ev.fields.epoch_spent });
    });
  }

  for (const total of ["spent", "epoch_spent"]) {
    it(`a disagreement made by changing the event's ${total} is unknown and names both values`, async () => {
      const step = CALLS[0];
      const { state, events } = await bothAt(step);
      const changed = events.events.map((e: any) =>
        e.pallet === "FlopSessionKeys" && e.event === "SessionCallExecuted" ? { ...e, fields: { ...e.fields, [total]: String(BigInt(e.fields[total]) + 1n) } } : e,
      );
      const c = crossCheck(state, { ...events, events: changed });
      expect(c.kind).toBe("unknown");
      const said = String(BigInt(step.events.find((e: any) => e.name === "SessionCallExecuted").fields[total]) + 1n);
      const stored = String((state.session as any).value[total]);
      expect((c as { reason: string }).reason).toContain(`${total} disagrees`);
      expect((c as { reason: string }).reason).toContain(said);
      expect((c as { reason: string }).reason).toContain(stored);
    });
  }

  it("a stored total changed instead of the event's disagrees too", async () => {
    const { state, events } = await bothAt(CALLS[0]);
    const s = state.session as any;
    const c = crossCheck({ ...state, session: { kind: "known", value: { ...s.value, spent: s.value.spent + 1n } } }, events);
    expect(c.kind).toBe("unknown");
  });

  it("the session and events of two different blocks are not checked", async () => {
    const a = await bothAt(CALLS[0]);
    const b = await bothAt(CALLS[1] ?? CALLS[0]);
    if (a.state.hash === b.events.hash) return;
    const c = crossCheck(a.state, b.events);
    expect(c.kind).toBe("unknown");
    expect((c as { reason: string }).reason).toMatch(/read at block/);
  });

  it("no SessionCallExecuted of the session at the block, or two of them, is unknown", async () => {
    const { state, events } = await bothAt(CALLS[0]);
    const none = crossCheck(state, { ...events, events: events.events.filter((e) => e.event !== "SessionCallExecuted") });
    expect(none.kind).toBe("unknown");
    expect((none as { reason: string }).reason).toMatch(/^no FlopSessionKeys.SessionCallExecuted/);
    const call = events.events.find((e) => e.event === "SessionCallExecuted");
    const two = crossCheck(state, { ...events, events: [...events.events, call as any] });
    expect(two.kind).toBe("unknown");
    expect((two as { reason: string }).reason).toMatch(/exactly one/);
  });

  it("the event of another session at the block is not taken for this one's", async () => {
    const { state, events } = await bothAt(CALLS[0]);
    const other = DELEGATES.find((d) => d !== state.delegate) as string;
    const moved = events.events.map((e: any) => (e.event === "SessionCallExecuted" ? { ...e, fields: { ...e.fields, delegate: other } } : e));
    const c = crossCheck(state, { ...events, events: moved });
    expect(c.kind).toBe("unknown");
    expect((c as { reason: string }).reason).toMatch(/^no FlopSessionKeys.SessionCallExecuted of this session/);
  });

  it("an absent or unknown session is not checked", async () => {
    const { state, events } = await bothAt(CALLS[0]);
    expect(crossCheck({ ...state, session: { kind: "absent" } }, events).kind).toBe("unknown");
    expect(crossCheck({ ...state, session: { kind: "unknown", reason: "x" } }, events).kind).toBe("unknown");
  });
});
