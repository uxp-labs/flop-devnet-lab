/**
 * The P2 fix round, rule X3: the record is the one asked for. In readSessionState a stored session record whose
 * owner or delegate is not the account asked is unknown; in crossCheck a known session record of another owner or
 * delegate than the state's own is unknown, before any event is looked at.
 *
 * Every hash, account and answer comes from the committed rerun through test/lib/recorded-node.ts and
 * research/2026-11-12-session-rerun-1014020/results.json: accounts.owner, dev1 and dev2 .public_key; step B10
 * (dev2's successful session call) .block_hash and .finalized_in_block. A record of another owner or delegate is
 * made from B10's stored bytes of (OWNER, DEV2) by writing another recorded account over the owner's or the
 * delegate's 32 bytes: the shape states owner first and delegate second (session-state.ts SESSION_FIELDS).
 */
import { describe, expect, it } from "vitest";
import { hexOf } from "../src/chain-read/bytes.js";
import { crossCheck } from "../src/chain-read/cross-check.js";
import { accountOf, sessionKeys } from "../src/chain-read/keys.js";
import { KEY_TABLE } from "../src/chain-read/key-table.js";
import { readBlockEvents, readSessionState, type SessionState } from "../src/chain-read/read.js";
import { SESSION_FIELDS } from "../src/chain-read/session-state.js";
import { RERUN_RESULTS, repoJson, rerunScript, type Script, transportOf } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const OWNER: string = RESULTS.accounts.owner.public_key;
const DEV1: string = RESULTS.accounts.dev1.public_key;
const DEV2: string = RESULTS.accounts.dev2.public_key;
const B10 = RESULTS.steps.find((s: any) => s.step === "B10");
const LINE = KEY_TABLE.runtimes[0] as (typeof KEY_TABLE.runtimes)[number];
const sessionKey = (o: string, d: string) => hexOf((sessionKeys(LINE, (accountOf(o) as any).value, (accountOf(d) as any).value) as any).value.sessions.key);

/** B10's script with the stored session of (OWNER, DEV2) given this account over its owner's or delegate's place. */
function rewritten(part: "owner" | "delegate", account: string): Script {
  expect(SESSION_FIELDS.slice(0, 2).map((f) => f.name)).toEqual(["owner", "delegate"]);
  const s = rerunScript(B10.block_hash);
  const at = `${B10.block_hash} ${sessionKey(OWNER, DEV2)}`;
  const v = s.storage.get(at) as string;
  expect(v.slice(2, 66)).toBe(OWNER.slice(2));
  expect(v.slice(66, 130)).toBe(DEV2.slice(2));
  const off = part === "owner" ? 2 : 66;
  s.storage.set(at, `${v.slice(0, off)}${account.slice(2)}${v.slice(off + 64)}`);
  return s;
}

describe("X3: readSessionState answers only the record of the pair asked", () => {
  it("the control: B10's own record of (OWNER, DEV2) is known", async () => {
    const r = (await readSessionState(transportOf(rerunScript(B10.block_hash)), OWNER, DEV2)) as any;
    expect(r.value.session).toMatchObject({ kind: "known", stored: true, value: { owner: OWNER, delegate: DEV2 } });
  });

  it("a record whose owner alone is another account is unknown, and the reason names it", async () => {
    const r = (await readSessionState(transportOf(rewritten("owner", DEV1)), OWNER, DEV2)) as any;
    expect(r.kind).toBe("known");
    expect(r.value.session).toEqual({ kind: "unknown", reason: `FlopSessionKeys.Sessions: the stored record names another owner, ${DEV1}, than ${OWNER}` });
  });

  it("a record whose delegate alone is another account is unknown, and the reason names it", async () => {
    const r = (await readSessionState(transportOf(rewritten("delegate", DEV1)), OWNER, DEV2)) as any;
    expect(r.kind).toBe("known");
    expect(r.value.session).toEqual({ kind: "unknown", reason: `FlopSessionKeys.Sessions: the stored record names another delegate, ${DEV1}, than ${DEV2}` });
  });
});

describe("X3: crossCheck takes only a record of the state's own owner and delegate", () => {
  /** B10's state of (OWNER, DEV2) and B10's events, both known. */
  async function b10() {
    const t = transportOf(rerunScript(B10.block_hash));
    const state = (await readSessionState(t, OWNER, DEV2)) as any;
    const events = (await readBlockEvents(t, { number: B10.finalized_in_block, hash: B10.block_hash })) as any;
    expect([state.kind, events.kind]).toEqual(["known", "known"]);
    return { state: state.value as SessionState, events: events.value };
  }

  it("the control: B10's own state agrees with B10's events", async () => {
    const { state, events } = await b10();
    expect(crossCheck(state, events).kind).toBe("known");
  });

  it("a state built by hand whose delegate is DEV1 over DEV2's known record is unknown, before any event is looked at", async () => {
    const { state, events } = await b10();
    const hand: SessionState = { ...state, delegate: DEV1 };
    const looked = { ...events, get events(): never { throw new Error("an event was looked at"); } };
    expect(crossCheck(hand, looked)).toEqual({ kind: "unknown", reason: `the session: the stored record names another delegate, ${DEV2}, than ${DEV1}` });
  });

  it("a state built by hand whose owner is DEV1 over the known record is unknown, before any event is looked at", async () => {
    const { state, events } = await b10();
    const hand: SessionState = { ...state, owner: DEV1 };
    const looked = { ...events, get events(): never { throw new Error("an event was looked at"); } };
    expect(crossCheck(hand, looked)).toEqual({ kind: "unknown", reason: `the session: the stored record names another owner, ${OWNER}, than ${DEV1}` });
  });
});
