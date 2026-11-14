/**
 * P5b, `session show` (rules C13 to C17), tests T1, T2 and T3. A scripted node answers from the session rerun's
 * recording (test/lib/session-fixtures.ts). Every expected value is read from
 * research/2026-11-12-session-rerun-1014020/results.json: the caps and the expiry from the step's SessionCreated
 * event fields, the counters from `reads_after`. A case no recording holds is made from a recorded answer with named
 * fields changed, and the test's name says which.
 */
import { describe, expect, it } from "vitest";
import { ERA_PERIOD } from "../src/chain/era.js";
import { amountText } from "../src/chain/describe.js";
import { RUNTIMES } from "../src/chain/runtimes.js";
import { compact } from "../src/chain/scale.js";
import { hexOf } from "../src/chain-read/bytes.js";
import { lastRuntimeUpgradeKey } from "../src/chain-read/keys.js";
import { copyScript, createdOf, DEV1, DEV2, keysOf, OWNER, scriptAt, seatHome, session, stepOf, transportOf, withEmptyAllowList, withField, withNone } from "./lib/session-fixtures.js";

const A2 = createdOf("A2");
const B1 = createdOf("B1");
const EPOCH = RUNTIMES[0].constants.find((c) => c.name === "SessionEpochLength")!.value;
const K1 = keysOf(OWNER.public_key, DEV1.public_key);
const show = (home: string, script: Parameters<typeof transportOf>[0], json = false) => session(home, ["show", "--owner", OWNER.ss58, ...(json ? ["--json"] : [])], transportOf(script));

/** The room the test works out from recorded values: the least of the three bounds, never below 0. */
function roomFrom(caps: Record<string, string>, spent: string, epochSpent: string): bigint {
  const clip = (n: bigint) => (n < 0n ? 0n : n);
  return [BigInt(caps.per_tx_limit), clip(BigInt(caps.daily_cap) - BigInt(epochSpent)), clip(BigInt(caps.spending_cap) - BigInt(spent))].reduce((a, b) => (b < a ? b : a));
}

/** No 0 stands where a value is unknown: every unknown line carries its reason, and an unknown JSON value is null with a reason. */
function noZeroForUnknown(out: string, json: any) {
  for (const l of out.split("\n").filter((x) => /unknown/.test(x))) expect(l).toMatch(/unknown \(.+\)/);
  const walk = (v: any) => {
    if (v && typeof v === "object") {
      if (v.state === "unknown") {
        expect(v.value).toBeNull();
        expect(typeof v.reason).toBe("string");
        expect(v.reason.length).toBeGreaterThan(0);
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(json);
}

describe("T1: show on the recorded states", () => {
  it("A6: spent and epoch spent with a breaker; the room is the least of the three bounds", async () => {
    const step = stepOf("A6");
    const home = seatHome();
    const r = await show(home, scriptAt("A6"));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`read at the finalized head ${step.finalized_in_block} ${step.block_hash}, runtime tzkv-runtime ${step.last_runtime_upgrade_spec}`);
    expect(r.out).toContain("session  stored, active");
    for (const f of ["spending_cap", "per_tx_limit", "daily_cap"]) expect(r.out).toMatch(new RegExp(`${f} +${amountText(BigInt(A2[f])).replace(/[().]/g, "\\$&")}`));
    expect(r.out).toContain(`spent            ${amountText(BigInt(step.reads_after.spent_raw))}`);
    expect(r.out).toContain(`epoch_spent      ${amountText(BigInt(step.reads_after.epoch_spent_raw))}`);
    expect(r.out).toContain(`expires_at       ${A2.expires_at}`);
    expect(r.out).toContain("allowed_pallets  [ComputeChannel]");
    expect(r.out).toContain(`session nonce  ${step.reads_after.session_nonce}\n`);
    expect(r.out).toContain(`tx_count ${step.reads_after.breaker_tx_count}`);
    expect(r.out).toContain("tripped false");
    const room = roomFrom(A2, step.reads_after.spent_raw, step.reads_after.epoch_spent_raw);
    expect(r.out).toContain(`room for one call  ${amountText(room)}: the least of`);
    const j = (await show(home, scriptAt("A6"), true)).json();
    expect(j.head).toEqual({ number: step.finalized_in_block, hash: step.block_hash });
    expect(j.session.state).toBe("stored");
    expect(j.session.value).toMatchObject({ owner: OWNER.ss58, delegate: DEV1.ss58, spending_cap: A2.spending_cap, per_tx_limit: A2.per_tx_limit, daily_cap: A2.daily_cap, spent: step.reads_after.spent_raw, epoch_spent: step.reads_after.epoch_spent_raw, expires_at: Number(A2.expires_at), allowed_pallets: ["ComputeChannel"], active: true });
    expect(j.session_nonce).toEqual({ state: "stored", value: step.reads_after.session_nonce });
    expect(j.circuit_breaker.value.tx_count).toBe(Number(step.reads_after.breaker_tx_count));
    expect(j.room).toMatchObject({ state: "known", value: String(room) });
    expect(typeof j.room.value).toBe("string");
    expect(j.notes).toEqual([]);
  });

  it("A8: the same counters and breaker; the same room", async () => {
    const step = stepOf("A8");
    const r = await show(seatHome(), scriptAt("A8"), true);
    expect(r.code).toBe(0);
    const j = r.json();
    expect(j.session.value.spent).toBe(step.reads_after.spent_raw);
    expect(j.circuit_breaker.value.tx_count).toBe(Number(step.reads_after.breaker_tx_count));
    expect(j.room.value).toBe(String(roomFrom(A2, step.reads_after.spent_raw, step.reads_after.epoch_spent_raw)));
  });

  it("A2: an active session with nonce 0; the recording holds no breaker there, so the room is unknown, exit 1", async () => {
    const step = stepOf("A2");
    const r = await show(seatHome(), scriptAt("A2"));
    expect(r.code).toBe(1);
    expect(r.out).toContain(`session nonce  ${step.reads_after.session_nonce}\n`);
    expect(r.out).toContain(`spent            ${amountText(BigInt(step.reads_after.spent_raw))}`);
    expect(r.out).toMatch(/breaker  unknown \(FlopSessionKeys\.CircuitBreakers: .+\)/);
    expect(r.out).toMatch(/room for one call  unknown \(the circuit breaker is unknown \(.+\)\)/);
    const j = (await show(seatHome(), scriptAt("A2"), true)).json();
    expect(j.room).toMatchObject({ state: "unknown", value: null });
    noZeroForUnknown(r.out, j);
  });

  it("A9: nonce 2", async () => {
    const step = stepOf("A9");
    const r = await show(seatHome(), scriptAt("A9"));
    expect(r.out).toContain(`session nonce  ${step.reads_after.session_nonce}\n`);
    expect(r.out).toContain(`spent            ${amountText(BigInt(step.reads_after.spent_raw))}`);
  });

  it("A10: a revoked session; the room is none, and the nonce the recording does not hold is unknown, never 0", async () => {
    const step = stepOf("A10");
    expect(step.reads_after.session_active).toBe("false");
    const r = await show(seatHome(), scriptAt("A10"));
    expect(r.out).toContain("session  stored, not active (revoked)");
    expect(r.out).toContain("room for one call  none (the session is not active (revoked))");
    expect(r.out).toMatch(/session nonce  unknown \(.+\)/);
    expect(r.code).toBe(1);
    const j = (await show(seatHome(), scriptAt("A10"), true)).json();
    expect(j.room).toEqual({ state: "none", value: null, reason: "the session is not active (revoked)" });
    expect(j.session_nonce.value).toBeNull();
    noZeroForUnknown(r.out, j);
  });

  it("B1: the nine name list; a lower case computechannel counts for the room; the list is not one this tool writes", async () => {
    const step = stepOf("B1");
    const home = seatHome(DEV2, { daily: Number(BigInt(B1.daily_cap) / 10n ** 12n) / 1e6, perCall: Number(BigInt(B1.per_tx_limit) / 10n ** 12n) / 1e6 });
    const r = await show(home, scriptAt("B1"), true);
    const j = r.json();
    const names = j.session.value.allowed_pallets as string[];
    expect(names.length).toBe(9);
    expect(names).toContain("computechannel");
    expect(j.session.value.spending_cap).toBe(B1.spending_cap);
    expect(j.session_nonce.value).toBe(step.reads_after.session_nonce);
    expect(j.notes).toContain("The allow list is not exactly ComputeChannel: this is not a grant this tool writes.");
    // The recording holds no breaker at B1: the room is unknown, not none for the list.
    expect(j.room.state).toBe("unknown");
    expect(j.room.reason).toMatch(/circuit breaker/);
  });
});

describe("T2: cases no recording holds, made from A6's recorded answers", () => {
  it("no session: A6 with the node holding no Sessions value", async () => {
    const r = await show(seatHome(), withNone(scriptAt("A6"), K1.sessions), true);
    expect(r.code).toBe(0);
    expect(r.json().session).toEqual({ state: "none", value: null });
    expect(r.json().room).toMatchObject({ state: "none", reason: "no session is stored for this owner and device" });
    expect((await show(seatHome(), withNone(scriptAt("A6"), K1.sessions))).out).toContain("session  no session");
  });

  it("no nonce stored: A6 with no SessionNonces value is the chain's default, said so", async () => {
    const r = await show(seatHome(), withNone(scriptAt("A6"), K1.nonces));
    expect(r.out).toContain("session nonce  0 (not stored: the chain's default)");
    expect((await show(seatHome(), withNone(scriptAt("A6"), K1.nonces), true)).json().session_nonce).toEqual({ state: "default", value: "0" });
  });

  it("expired: A6 with expires_at set at the head plus the era period, plus one, and minus one", async () => {
    const head = stepOf("A6").finalized_in_block as number;
    for (const [at, room] of [[head + ERA_PERIOD - 1, "none"], [head + ERA_PERIOD, "none"], [head + ERA_PERIOD + 1, "known"]] as const) {
      const r = await show(seatHome(), withField(scriptAt("A6"), K1.sessions, "session", "expires_at", BigInt(at)), true);
      expect([at, r.json().room.state]).toEqual([at, room]);
      if (room === "none") expect(r.json().room.reason).toContain(`plus the era period of ${ERA_PERIOD} blocks reaches expires_at ${at}: a call signed now may land up to ${ERA_PERIOD} blocks later`);
    }
  });

  it("a tripped breaker: A6 with the breaker's tripped set to true", async () => {
    const r = await show(seatHome(), withField(scriptAt("A6"), K1.breakers, "breaker", "tripped", 1n), true);
    expect(r.code).toBe(0);
    expect(r.json().room).toMatchObject({ state: "none", reason: "the circuit breaker is tripped" });
  });

  it("an epoch past its reset: A6 with epoch_start set an epoch length before the head", async () => {
    const step = stepOf("A6");
    const head = step.finalized_in_block as number;
    const at = await show(seatHome(), withField(scriptAt("A6"), K1.sessions, "session", "epoch_start", BigInt(head - EPOCH)));
    expect(at.out).toContain("the chain resets this epoch's spend at the next call");
    expect(at.out).toContain("(inferred)");
    expect(at.out).toContain("it is a lower bound");
    expect(at.out).toContain(`room for one call  ${amountText(roomFrom(A2, step.reads_after.spent_raw, step.reads_after.epoch_spent_raw))}`);
    const before = await show(seatHome(), withField(scriptAt("A6"), K1.sessions, "session", "epoch_start", BigInt(head - EPOCH + 1)));
    expect(before.out).not.toContain("resets this epoch");
  });

  it("an empty allow list: A6 with allowed_pallets emptied; the room is computed and the line says it is not this tool's grant", async () => {
    const r = await show(seatHome(), withEmptyAllowList(scriptAt("A6"), K1.sessions), true);
    expect(r.json().session.value.allowed_pallets).toEqual([]);
    expect(r.json().room.state).toBe("known");
    expect(r.json().notes).toContain("The allow list is empty, which lets the session call every pallet: this is not a grant this tool writes.");
  });

  it("an allow list without ComputeChannel: A6 with the name's first letter changed gives no room", async () => {
    const s = copyScript(scriptAt("A6"));
    const k = `${s.head} ${K1.sessions}`;
    const name = Buffer.from("ComputeChannel").toString("hex");
    s.storage.set(k, (s.storage.get(k) as string).replace(name, Buffer.from("XomputeChannel").toString("hex")));
    const r = await show(seatHome(), s, true);
    expect(r.json().room).toMatchObject({ state: "none", reason: "the allow list does not hold ComputeChannel" });
  });

  it("a chain cap above the local cap: the seat's local caps set below A6's chain caps", async () => {
    const r = await show(seatHome(DEV1, { daily: 0.01, perCall: 0.005 }), scriptAt("A6"), true);
    expect(r.json().notes).toEqual([
      `The chain's per_tx_limit ${amountText(BigInt(A2.per_tx_limit))} is above the seat's per call cap ${amountText(5000000000000000n)}.`,
      `The chain's daily_cap ${amountText(BigInt(A2.daily_cap))} is above the seat's daily cap ${amountText(10000000000000000n)}.`,
    ]);
  });

  it("no local cap: show still reads the chain and says the local caps are unknown", async () => {
    const r = await show(seatHome(DEV1, null), scriptAt("A6"));
    expect(r.out).toMatch(/local caps  unknown \(no daily cap for seat 42/);
  });
});

describe("T3: unknown, never 0", () => {
  const only = (r: { code: number; out: string; err: string }) => {
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/the session's state is unknown: .+/);
  };

  it("a head that cannot be read: the node's finalized head has no header", async () => {
    const s = copyScript(scriptAt("A6"));
    s.headers.delete(s.head);
    const r = await show(seatHome(), s);
    only(r);
    expect(r.err).toContain("the finalized head's header");
  });

  it("a transport that throws after block 0", async () => {
    const base = transportOf(scriptAt("A6"));
    const r = await session(seatHome(), ["show", "--owner", OWNER.ss58], async (m, p) => {
      if (m === "chain_getBlockHash" && p[0] === 0) return base(m, p);
      throw new Error("the node is gone");
    });
    only(r);
    expect(r.err).toContain("the node is gone");
  });

  it("a runtime the decoder does not know: A6's LastRuntimeUpgrade naming another spec version", async () => {
    const s = copyScript(scriptAt("A6"));
    const k = `${s.head} ${hexOf(lastRuntimeUpgradeKey())}`;
    const old = s.storage.get(k) as string;
    const spec = stepOf("A6").last_runtime_upgrade_spec as number;
    const oldCompact = hexOf(compact(BigInt(spec))).slice(2);
    expect(old.slice(2).startsWith(oldCompact)).toBe(true);
    s.storage.set(k, `0x${hexOf(compact(BigInt(spec + 1))).slice(2)}${old.slice(2 + oldCompact.length)}`);
    only(await show(seatHome(), s));
  });

  it("a record of another pair: A6's record with its delegate set to dev2", async () => {
    const s = copyScript(scriptAt("A6"));
    const k = `${s.head} ${K1.sessions}`;
    s.storage.set(k, (s.storage.get(k) as string).replace(DEV1.public_key.slice(2), DEV2.public_key.slice(2)));
    const r = await show(seatHome(), s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/session  unknown \(FlopSessionKeys\.Sessions: the stored record names another delegate/);
    expect(r.out).toMatch(/room for one call  unknown \(the session is unknown/);
    const j = (await show(seatHome(), s, true)).json();
    expect(j.session).toMatchObject({ state: "unknown", value: null });
    noZeroForUnknown(r.out, j);
  });
});
