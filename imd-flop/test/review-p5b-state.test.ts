/**
 * Review of P5b, attacks 5, 6 and 8 (promises P7, P8, P9, P11) and the lead's L1, L3 and L4. The node is the rerun's
 * recording (test/lib/session-fixtures.ts) at a step of research/2026-11-12-session-rerun-1014020/results.json; the
 * head's number is that step's `finalized_in_block`. A state no recording holds is made from a recorded answer with
 * the fields named in the test changed. The breaker's limits come from that folder's facts-1014020.json
 * (`constants.FlopSessionKeys.CircuitBreakerMaxSpend`, `CircuitBreakerMaxTxs`, `CircuitBreakerPeriod`). No socket.
 */
import { describe, expect, it } from "vitest";
import { ERA_PERIOD } from "../src/chain/era.js";
import { readJson, RERUN } from "./lib/chain-fixtures.js";
import type { Log, Script } from "./lib/recorded-node.js";
import { copyScript, DEV1, DEV2, keysOf, OWNER, scriptAt, seatHome, session, stepOf, transportOf, withField, withNone } from "./lib/session-fixtures.js";

const K1 = keysOf(OWNER.public_key, DEV1.public_key);
const CB = readJson(`${RERUN}/facts-1014020.json`).constants.FlopSessionKeys;
const MAX_SPEND = BigInt(CB.CircuitBreakerMaxSpend.value);
const MAX_TXS = BigInt(CB.CircuitBreakerMaxTxs.value);
const headOf = (id: string): number => stepOf(id).finalized_in_block as number;
const run = (sub: string, script: Script, json = true, log?: Log, extra: string[] = []) =>
  session(seatHome(), [sub, "--owner", OWNER.ss58, ...extra, ...(sub === "grant" ? ["--days", "1"] : []), ...(json ? ["--json"] : [])], transportOf(script, log));

/** A copy whose node answers a key at the head with a text that is not hex: the read of it is unknown. */
function withGarbage(s: Script, key: string): Script {
  const c = copyScript(s);
  c.storage.set(`${s.head} ${key}`, "0xnothex");
  return c;
}

/** A copy whose session record at the head has the allow list given (byte strings), the other fields kept. */
function withAllowList(s: Script, names: Uint8Array[]): Script {
  const c = copyScript(s);
  const k = `${s.head} ${K1.sessions}`;
  const body = (c.storage.get(k) as string).slice(2);
  // The fixed fields up to expires_at: 32 + 32 + 16 * 3 + 16 + 4 + 16 + 4 bytes (src/chain-read/session-state.ts SESSION_FIELDS).
  const listAt = 2 * (32 + 32 + 16 * 3 + 16 + 4 + 16 + 4);
  const compact = (n: number) => {
    if (n >= 64) throw new Error("small lists only");
    return (n << 2).toString(16).padStart(2, "0");
  };
  const list = compact(names.length) + names.map((n) => compact(n.length) + Buffer.from(n).toString("hex")).join("");
  c.storage.set(k, `0x${body.slice(0, listAt)}${list}${body.slice(-2)}`);
  return c;
}
const utf8 = (t: string) => new TextEncoder().encode(t);

describe("review P5b, attack 5: grant and revoke at each edge of the stored state", () => {
  it("control: the head the scripted node gives is the step's finalized_in_block", async () => {
    expect((await run("show", scriptAt("A6"))).json().head.number).toBe(headOf("A6"));
  });

  for (const [d, printed] of [[-1, true], [0, true], [1, false]] as const) {
    it(`HOLDS: grant over A6 active with expires_at at the head ${d < 0 ? "minus" : "plus"} ${Math.abs(d)}: ${printed ? "the call with the stored record line" : "exit 5, no call"}`, async () => {
      const log: Log = [];
      const r = await run("grant", withField(scriptAt("A6"), K1.sessions, "session", "expires_at", BigInt(headOf("A6") + d)), true, log);
      if (printed) {
        expect(r.code).toBe(0);
        expect(r.json().stored_record).toContain(`past its expiry at block ${headOf("A6") + d}`);
      } else expect([r.code, r.out]).toEqual([5, ""]);
    });
  }

  it("HOLDS: grant and revoke over a record of another pair (A6's delegate set to dev2): exit 1, no call", async () => {
    const s = copyScript(scriptAt("A6"));
    const k = `${s.head} ${K1.sessions}`;
    s.storage.set(k, (s.storage.get(k) as string).replace(DEV1.public_key.slice(2), DEV2.public_key.slice(2)));
    for (const sub of ["grant", "revoke"]) {
      const r = await run(sub, s);
      expect([sub, r.code, r.out]).toEqual([sub, 1, ""]);
      expect(r.err).toMatch(/another delegate/);
    }
  });

  it("HOLDS: grant and revoke with the session's answer not hex (A6): exit 1, no call; an unknown nonce or breaker does not stop them", async () => {
    for (const sub of ["grant", "revoke"]) {
      expect([sub, (await run(sub, withGarbage(scriptAt("A6"), K1.sessions))).code]).toEqual([sub, 1]);
      // A6 active: grant refuses for the active session, revoke prints.
      expect([sub, (await run(sub, withGarbage(scriptAt("A6"), K1.breakers))).code]).toEqual([sub, sub === "grant" ? 5 : 0]);
      expect([sub, (await run(sub, withGarbage(scriptAt("A10"), K1.nonces))).code]).toEqual([sub, 0]);
    }
  });

  it("HOLDS: RP5B-4 (the lead's L3): revoke over a session that is active but past its expiry (A6, expires_at set to the head minus 1) calls it an active session", async () => {
    const r = await run("revoke", withField(scriptAt("A6"), K1.sessions, "session", "expires_at", BigInt(headOf("A6") - 1)));
    expect(r.code).toBe(0);
    // grant, on the same state, says the record is past its expiry; revoke must not say less.
    expect(r.json().stored).not.toBe("an active session");
  });
});

describe("review P5b, attack 6: show, unknown and the room", () => {
  it("HOLDS: RP5B-5 (the lead's L1): show with the seat's local caps unknown (no cap) at A6, where all else is known, exits 0", async () => {
    const r = await session(seatHome(DEV1, null), ["show", "--owner", OWNER.ss58, "--json"], transportOf(scriptAt("A6")));
    expect(r.json().local_caps.state).toBe("unknown");
    expect(r.code).toBe(1);
  });

  it("control: A6 as recorded is all known, exit 0", async () => {
    expect((await run("show", scriptAt("A6"))).code).toBe(0);
  });

  for (const [what, key] of [["session", K1.sessions], ["nonce", K1.nonces], ["breaker", K1.breakers]] as const) {
    it(`HOLDS: show at A6 with the ${what}'s answer not hex: exit 1, the value null with a reason in JSON, unknown (<reason>) in words, no 0 for it`, async () => {
      const s = withGarbage(scriptAt("A6"), key);
      const j = await run("show", s);
      const w = await run("show", s, false);
      expect([j.code, w.code]).toEqual([1, 1]);
      const field = { session: "session", nonce: "session_nonce", breaker: "circuit_breaker" }[what];
      expect(j.json()[field]).toMatchObject({ state: "unknown", value: null });
      expect(j.json()[field].reason.length).toBeGreaterThan(0);
      const line = w.out.split("\n").find((l) => l.startsWith(`  ${{ session: "session ", nonce: "session nonce", breaker: "breaker " }[what]}`))!;
      expect(line).toMatch(/unknown \(.+\)/);
      expect(line).not.toMatch(/\b0 raw\b|\(0 FLOP\)/);
      // The room needs the session and the breaker; the nonce it does not.
      expect(j.json().room.state).toBe(what === "nonce" ? "known" : "unknown");
      expect(j.json().room.value).toBe(what === "nonce" ? j.json().room.value : null);
    });
  }

  it("HOLDS: show with the session unknown and the breaker tripped (A6, breaker tripped, session not hex): the room is none, exit 1", async () => {
    const s = withGarbage(withField(scriptAt("A6"), K1.breakers, "breaker", "tripped", 1n), K1.sessions);
    const r = await run("show", s);
    expect([r.code, r.json().room.state]).toEqual([1, "none"]);
  });

  it("HOLDS: spent above the spending cap and epoch_spent above the daily cap (A6, both set to their cap plus 1 raw): the room is 0, not negative, exit 0", async () => {
    const s0 = scriptAt("A6");
    const rec = (await run("show", s0)).json().session.value;
    const s = withField(withField(s0, K1.sessions, "session", "spent", BigInt(rec.spending_cap) + 1n), K1.sessions, "session", "epoch_spent", BigInt(rec.daily_cap) + 1n);
    const r = await run("show", s);
    expect([r.code, r.json().room.state, r.json().room.value]).toEqual([0, "known", "0"]);
    expect(r.json().room.bounds).toMatchObject({ epoch_left: "0", lifetime_left: "0" });
  });

  it("HOLDS: the expiry at the head itself and below it gives no room (A6, expires_at at the head and 1 below)", async () => {
    for (const d of [0, -1]) {
      const r = await run("show", withField(scriptAt("A6"), K1.sessions, "session", "expires_at", BigInt(headOf("A6") + d)));
      expect([d, r.json().room.state]).toEqual([d, "none"]);
    }
  });

  const lists: [string, Uint8Array[], "known" | "none", boolean][] = [
    ["computechannel in lower case alone", [utf8("computechannel")], "known", true],
    ["COMPUTECHANNEL in upper case alone", [utf8("COMPUTECHANNEL")], "known", true],
    ["two names, Balances and ComputeChannel", [utf8("Balances"), utf8("ComputeChannel")], "known", true],
    ["a name that is not UTF-8", [Uint8Array.of(0xff, 0xfe, 0x43)], "none", true],
    ["ComputeChannel with a trailing space", [utf8("ComputeChannel ")], "none", true],
    ["ComputeChannel exactly", [utf8("ComputeChannel")], "known", false],
  ];
  for (const [name, list, room, note] of lists) {
    it(`HOLDS: show at A6 with the allow list ${name}: the room is ${room}${note ? ", and the note says the list is not exactly ComputeChannel" : ", no note"}`, async () => {
      const r = await run("show", withAllowList(scriptAt("A6"), list));
      expect(r.json().room.state).toBe(room);
      expect(r.json().notes.some((n: string) => /not exactly ComputeChannel/.test(n))).toBe(note);
    });
  }

  it("HOLDS: a name that is not UTF-8 is shown as its hex, in words and in JSON alike", async () => {
    const s = withAllowList(scriptAt("A6"), [Uint8Array.of(0xff, 0xfe, 0x43)]);
    expect((await run("show", s)).json().session.value.allowed_pallets).toEqual(["0xfffe43"]);
    expect((await run("show", s, false)).out).toContain("allowed_pallets  [0xfffe43]");
  });

  it("HOLDS: RP5B-6 (the lead's L4): the room is larger than the chain allows when the caps are above the breaker's spend per period (A6 with the three caps set to 4 times CircuitBreakerMaxSpend, nothing spent, no breaker stored), and the words do not say the breaker's limits are left out", async () => {
    let s = withNone(scriptAt("A6"), K1.breakers);
    for (const f of ["spending_cap", "per_tx_limit", "daily_cap"]) s = withField(s, K1.sessions, "session", f, 4n * MAX_SPEND);
    for (const f of ["spent", "epoch_spent"]) s = withField(s, K1.sessions, "session", f, 0n);
    const r = await run("show", s);
    const words = (await run("show", s, false)).out;
    const room = r.json().room;
    expect(room.state).toBe("known");
    // The chain refuses a call whose declared spend takes the delegate's breaker past CircuitBreakerMaxSpend in a
    // period (research/2026-11-11-session-runtime/report.md, section C, steps 9 and C3).
    const bounded = BigInt(room.value) <= MAX_SPEND;
    const said = /breaker/i.test(words.split("\n").find((l) => l.startsWith("  room for one call"))!);
    expect({ bounded, said }).not.toEqual({ bounded: false, said: false });
  });

  it("HOLDS: RP5B-6 (the lead's L4): a breaker at CircuitBreakerMaxTxs calls in the current period (A6, period_start at the head, tx_count at the max) leaves the room known and above 0", async () => {
    const h = BigInt(headOf("A6"));
    const s = withField(withField(scriptAt("A6"), K1.breakers, "breaker", "period_start", h), K1.breakers, "breaker", "tx_count", MAX_TXS);
    const r = await run("show", s);
    const room = r.json().room;
    const words = (await run("show", s, false)).out.split("\n").find((l) => l.startsWith("  room for one call"))!;
    expect(room.state === "known" && BigInt(room.value) > 0n && !/breaker/i.test(words)).toBe(false);
  });
});

/** Every leaf of a JSON value with its key, strings and numbers alone. */
function leaves(v: unknown, key = ""): [string, string][] {
  if (v === null || v === undefined || typeof v === "boolean") return [];
  if (typeof v === "string" || typeof v === "number") return [[key, String(v)]];
  if (Array.isArray(v)) return v.flatMap((x) => leaves(x, key));
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, k));
}

describe("review P5b, attack 8: words and JSON, value by value", () => {
  // JSON only vocabulary: the state labels of a value, and the fields whose words are a fixed phrase.
  const JSON_WORDS = new Set(["state"]);
  for (const id of ["A2", "A6", "A8", "A9", "A10", "B1"]) {
    for (const sub of ["grant", "revoke", "show"]) {
      it(`HOLDS: ${sub} at ${id}: every value of the JSON is in the words, and every number of the words is in the JSON`, async () => {
        const j = await run(sub, scriptAt(id));
        const w = await run(sub, scriptAt(id), false);
        expect([j.code, j.err]).toEqual([w.code, w.err]);
        if (j.code !== 0 && j.out === "") return; // refused: nothing printed either way
        const json = j.json();
        const missing = leaves(json)
          .filter(([k]) => !JSON_WORDS.has(k))
          .filter(([, v]) => !w.out.includes(v));
        expect(missing).toEqual([]);
        const all = JSON.stringify(json);
        const numbers = [...w.out.matchAll(/(?<![0-9a-fA-Fx.])[0-9]+(?![0-9a-fA-F])/g)].map((m) => m[0]);
        expect(numbers.filter((n) => !all.includes(n))).toEqual([]);
      });
    }
  }
});
