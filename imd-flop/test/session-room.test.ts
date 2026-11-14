/**
 * P5b, rule C14, test T10: the room function alone, over a table of cases at each edge. The base record is the one
 * the chain stored at the rerun's step A6, read through the scripted node (test/lib/session-fixtures.ts), and each case
 * names the fields it changes. The era period is the encoder's (src/chain/era.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ERA_PERIOD } from "../src/chain/era.js";
import { readSessionState, type SessionState } from "../src/chain-read/read.js";
import { known, unknown, absent, knownEntry } from "../src/chain-read/result.js";
import type { CircuitBreakerRecord, SessionRecord } from "../src/chain-read/session-state.js";
import { holdsChannel, roomOf } from "../src/session/room.js";
import { DEV1, OWNER, scriptAt, transportOf } from "./lib/session-fixtures.js";

let A6: SessionState;
let S: SessionRecord;
let B: CircuitBreakerRecord;
beforeAll(async () => {
  const r = await readSessionState(transportOf(scriptAt("A6")), OWNER.public_key, DEV1.public_key);
  if (r.kind !== "known" || r.value.session.kind !== "known" || r.value.circuitBreaker.kind !== "known") throw new Error("A6 must be known");
  A6 = r.value;
  S = r.value.session.value;
  B = r.value.circuitBreaker.value;
});

const C = known({ sessionEpochLength: 1, maxSessionDuration: 1 });
const room = (s: Partial<SessionRecord>, o: { head?: number; breaker?: Partial<CircuitBreakerRecord> | "absent" | "unknown"; constants?: typeof C | ReturnType<typeof unknown> } = {}) =>
  roomOf({
    head: o.head ?? A6.number,
    session: knownEntry({ ...S, ...s }, true),
    breaker: o.breaker === "absent" ? absent() : o.breaker === "unknown" ? unknown("not read") : knownEntry({ ...B, ...(o.breaker ?? {}) }, true),
    constants: o.constants ?? C,
    eraPeriod: ERA_PERIOD,
  });
const raw = (r: ReturnType<typeof roomOf>) => (r.kind === "known" ? r.raw : r.kind);

describe("T10: the room for one call", () => {
  it("A6 as stored: the least of the three bounds", () => {
    const r = room({});
    expect(r.kind).toBe("known");
    expect(raw(r)).toBe([S.per_tx_limit, S.daily_cap - S.epoch_spent, S.spending_cap - S.spent].reduce((a, b) => (b < a ? b : a)));
  });

  it("equal bounds give that bound", () => {
    expect(raw(room({ per_tx_limit: 5n, daily_cap: 5n, epoch_spent: 0n, spending_cap: 5n, spent: 0n }))).toBe(5n);
    expect(raw(room({ per_tx_limit: 5n, daily_cap: 7n, epoch_spent: 2n, spending_cap: 9n, spent: 4n }))).toBe(5n);
  });

  it("each bound can be the least", () => {
    expect(raw(room({ per_tx_limit: 3n, daily_cap: 10n, epoch_spent: 0n, spending_cap: 10n, spent: 0n }))).toBe(3n);
    expect(raw(room({ per_tx_limit: 10n, daily_cap: 10n, epoch_spent: 6n, spending_cap: 10n, spent: 0n }))).toBe(4n);
    expect(raw(room({ per_tx_limit: 10n, daily_cap: 10n, epoch_spent: 0n, spending_cap: 10n, spent: 8n }))).toBe(2n);
  });

  it("a bound of 0 gives a known room of 0", () => {
    const r = room({ daily_cap: 10n, epoch_spent: 10n });
    expect(r).toMatchObject({ kind: "known", raw: 0n });
    expect(raw(room({ spending_cap: 10n, spent: 10n }))).toBe(0n);
  });

  it("spent above a cap gives 0, never a negative room", () => {
    const r = room({ daily_cap: 10n, epoch_spent: 11n, spending_cap: 10n, spent: 12n });
    expect(r).toMatchObject({ kind: "known", raw: 0n, bounds: { epoch_left: 0n, lifetime_left: 0n } });
  });

  it("the expiry at exactly the head plus the era period, and one block either side", () => {
    const h = A6.number;
    expect(room({ expires_at: h + ERA_PERIOD - 1 }).kind).toBe("none");
    expect(room({ expires_at: h + ERA_PERIOD }).kind).toBe("none");
    expect(room({ expires_at: h + ERA_PERIOD + 1 }).kind).toBe("known");
  });

  it("not active, a tripped breaker, an allow list without ComputeChannel: none, with every reason", () => {
    const r = room({ active: false, allowed_pallets: ["0x" + Buffer.from("Utility").toString("hex")] }, { breaker: { tripped: true } });
    expect(r).toEqual({ kind: "none", reason: "the session is not active (revoked); the allow list does not hold ComputeChannel; the circuit breaker is tripped" });
  });

  it("an empty allow list, or ComputeChannel in any case of letters among others, gives a room", () => {
    expect(room({ allowed_pallets: [] }).kind).toBe("known");
    for (const n of ["computechannel", "COMPUTECHANNEL", "cOmPuTeChAnNeL"]) expect(room({ allowed_pallets: ["0x5574696c697479", "0x" + Buffer.from(n).toString("hex")] }).kind).toBe("known");
    expect(holdsChannel(["0x" + Buffer.from("ComputeChannels").toString("hex")])).toBe(false);
    expect(holdsChannel(["0x" + Buffer.from("Compute Channel").toString("hex")])).toBe(false);
  });

  it("no breaker stored is no limit; an unknown breaker makes the room unknown unless a known value rules a call out", () => {
    expect(room({}, { breaker: "absent" }).kind).toBe("known");
    expect(room({}, { breaker: "unknown" })).toEqual({ kind: "unknown", reason: "the circuit breaker is unknown (not read)" });
    expect(room({ active: false }, { breaker: "unknown" }).kind).toBe("none");
  });

  it("no session is none; an unknown session is unknown; a runtime the encoder does not know is unknown first", () => {
    const base = { head: A6.number, breaker: absent(), constants: C, eraPeriod: ERA_PERIOD } as const;
    expect(roomOf({ ...base, session: absent() })).toEqual({ kind: "none", reason: "no session is stored for this owner and device" });
    expect(roomOf({ ...base, session: unknown("gone") })).toEqual({ kind: "unknown", reason: "the session is unknown (gone)" });
    expect(roomOf({ ...base, session: knownEntry({ ...S, active: false }, true), constants: unknown("not in the table") })).toEqual({ kind: "unknown", reason: "the runtime is not one the encoder knows (not in the table)" });
  });
});
