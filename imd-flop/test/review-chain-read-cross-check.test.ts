/**
 * Review of P2 (reviewer, not the builder): attack E, the cross check (R7), played as a table.
 *
 * All "HOLDS": each case passes on fcf75d0, but one: the lead's rule X3 (the P2 fix round) makes the hand built session
 * with no owner and no delegate unknown, and that test says so in its name. Several kill mutants the builder's tests leave alive (named per case:
 * X1 number not compared, X2 hash not compared, X3 runtime not compared, X7 leading zero taken, X9 pallet not
 * compared). The L3 case (a stored record of another delegate) is in review-chain-read-lead.test.ts.
 *
 * The state and the events are read from the rerun's recording at results.json step A6 (dev1's first successful
 * session call); every changed value is made from the read one.
 */
import { describe, expect, it } from "vitest";
import { crossCheck } from "../src/chain-read/cross-check.js";
import { type BlockEventsAt, readBlockEvents, readSessionState, type SessionState } from "../src/chain-read/read.js";
import { RERUN_RESULTS, repoJson, rerunScript, transportOf } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const OWNER: string = RESULTS.accounts.owner.public_key;
const DEV1: string = RESULTS.accounts.dev1.public_key;
const DEV2: string = RESULTS.accounts.dev2.public_key;
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const A9 = RESULTS.steps.find((s: any) => s.step === "A9");

async function both(): Promise<{ state: SessionState; events: BlockEventsAt }> {
  const t = transportOf(rerunScript(A6.block_hash));
  const s = await readSessionState(t, OWNER, DEV1);
  const e = await readBlockEvents(t, { number: A6.finalized_in_block, hash: A6.block_hash });
  if (s.kind !== "known" || e.kind !== "known") throw new Error("the replay did not read");
  return { state: s.value, events: e.value };
}

const isCall = (e: any) => e.pallet === "FlopSessionKeys" && e.event === "SessionCallExecuted";
const withFields = (ev: BlockEventsAt, f: (fields: any) => unknown): BlockEventsAt => ({ ...ev, events: ev.events.map((e: any) => (isCall(e) ? { ...e, fields: f(e.fields) } : e)) as any });
const withSession = (st: SessionState, f: (v: any) => any): SessionState => ({ ...st, session: { ...(st.session as any), value: f((st.session as any).value) } });
const callOf = (ev: BlockEventsAt) => ev.events.find(isCall) as any;

type Case = [string, (s: SessionState, e: BlockEventsAt) => [SessionState, BlockEventsAt], "known" | "unknown"];

const CASES: Case[] = [
  ["equal", (s, e) => [s, e], "known"],
  ["the event's spent one more", (s, e) => [s, withFields(e, (f) => ({ ...f, spent: String(BigInt(f.spent) + 1n) }))], "unknown"],
  ["the event's epoch_spent one less", (s, e) => [s, withFields(e, (f) => ({ ...f, epoch_spent: String(BigInt(f.epoch_spent) - 1n) }))], "unknown"],
  ["the stored spent one more", (s, e) => [withSession(s, (v) => ({ ...v, spent: v.spent + 1n })), e], "unknown"],
  ["the stored epoch_spent one more", (s, e) => [withSession(s, (v) => ({ ...v, epoch_spent: v.epoch_spent + 1n })), e], "unknown"],
  ["the event of the same owner and another delegate", (s, e) => [s, withFields(e, (f) => ({ ...f, delegate: DEV2 }))], "unknown"],
  ["the event of another owner and the same delegate", (s, e) => [s, withFields(e, (f) => ({ ...f, owner: DEV2 }))], "unknown"],
  ["two events of the session", (s, e) => [s, { ...e, events: [...e.events, callOf(e)] }], "unknown"],
  ["the event's totals as JSON numbers", (s, e) => [s, withFields(e, (f) => ({ ...f, spent: Number(f.spent), epoch_spent: Number(f.epoch_spent) }))], "unknown"],
  ["the event's spent with a leading zero (kills X7)", (s, e) => [s, withFields(e, (f) => ({ ...f, spent: `0${f.spent}` }))], "unknown"],
  ["the event's spent with a + sign", (s, e) => [s, withFields(e, (f) => ({ ...f, spent: `+${f.spent}` }))], "unknown"],
  ["the event's spent with a space", (s, e) => [s, withFields(e, (f) => ({ ...f, spent: ` ${f.spent}` }))], "unknown"],
  ["the event's spent in hex", (s, e) => [s, withFields(e, (f) => ({ ...f, spent: `0x${BigInt(f.spent).toString(16)}` }))], "unknown"],
  ["the event's spent missing", (s, e) => [s, withFields(e, (f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== "spent")))], "unknown"],
  ["the event's fields as a list", (s, e) => [s, withFields(e, (f) => Object.values(f))], "unknown"],
  ["the event's owner in upper case", (s, e) => [s, withFields(e, (f) => ({ ...f, owner: `0x${f.owner.slice(2).toUpperCase()}` }))], "unknown"],
  ["a state built by hand whose totals are numbers", (s, e) => [withSession(s, (v) => ({ ...v, spent: Number(v.spent), epoch_spent: Number(v.epoch_spent) })), e], "unknown"],
  ["the same number and another hash (kills X2)", (s, e) => [s, { ...e, hash: A9.block_hash }], "unknown"],
  ["the same hash and another number (kills X1)", (s, e) => [s, { ...e, number: A9.finalized_in_block }], "unknown"],
  ["runtimes that differ in the shape file only (kills X3)", (s, e) => [s, { ...e, runtime: { ...e.runtime, shapeFile: `${e.runtime.shapeFile}.other` } }], "unknown"],
  ["runtimes that differ in the spec version only (kills X3)", (s, e) => [s, { ...e, runtime: { ...e.runtime, specVersion: e.runtime.specVersion + 1 } }], "unknown"],
  ["the event under another pallet, the same name (kills X9)", (s, e) => [s, { ...e, events: e.events.map((x: any) => (isCall(x) ? { ...x, pallet: "System" } : x)) as any }], "unknown"],
  ["the session absent", (s, e) => [{ ...s, session: { kind: "absent" } }, e], "unknown"],
];

describe("E: the cross check table", () => {
  for (const [what, make, expected] of CASES) {
    it(`HOLDS ${what}: ${expected}`, async () => {
      const { state, events } = await both();
      const [s, e] = make(state, events);
      const c = crossCheck(s, e);
      expect(c.kind).toBe(expected);
      if (c.kind === "unknown") expect(c.reason.length).toBeGreaterThan(0);
    });
  }

  it("HOLDS (info, changed by the lead's rule X3) a hand built session with no owner and no delegate is unknown: the record must name the state's own owner and delegate", async () => {
    const { state, events } = await both();
    const strip = (o: any) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "owner" && k !== "delegate"));
    const c = crossCheck(withSession(state, strip), withFields(events, strip));
    // On fcf75d0 crossCheck compared fields[k] === session[k], undefined === undefined, and agreed. Rule X3 checks the record's owner first.
    expect(c.kind).toBe("unknown");
  });
});
