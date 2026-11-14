/**
 * The fixes of the P5b review (RP5B-2 to RP5B-7), each rule with a test that fails without it. The node is the rerun's
 * recording (test/lib/session-fixtures.ts); a state no recording holds is a recorded answer with named fields changed.
 * The reviewer's own tests are test/review-p5b-*.test.ts. No socket.
 */
import { describe, expect, it } from "vitest";
import { ERA_PERIOD } from "../src/chain/era.js";
import { checkDaysAgainstRuntime } from "../src/session/caps.js";
import { BREAKER_NOT_COUNTED, roomOf } from "../src/session/room.js";
import { storedName } from "../src/session/stored.js";
import { CliError } from "../src/errors.js";
import { known } from "../src/chain-read/result.js";
import { cli } from "./helpers.js";
import type { Script } from "./lib/recorded-node.js";
import { DEV1, keysOf, OWNER, scriptAt, seatHome, session, stepOf, transportOf, withField, withNone } from "./lib/session-fixtures.js";

const K1 = keysOf(OWNER.public_key, DEV1.public_key);
const headOf = (id: string): number => stepOf(id).finalized_in_block as number;
const run = (sub: string, script: Script, json = true) =>
  session(seatHome(), [sub, "--owner", OWNER.ss58, ...(sub === "grant" ? ["--days", "1"] : []), ...(json ? ["--json"] : [])], transportOf(script));
const roomLine = (out: string): string => out.split("\n").find((l) => l.startsWith("  room for one call"))!;

describe("F1 (RP5B-6): a known room says the breaker's limits per period are not counted", () => {
  it("the clause names the three constants and types no number", () => {
    for (const n of ["CircuitBreakerMaxSpend", "CircuitBreakerMaxTxs", "CircuitBreakerPeriod"]) expect(BREAKER_NOT_COUNTED).toContain(n);
    expect(BREAKER_NOT_COUNTED).not.toMatch(/\d/);
  });

  it("a known room ends its line with the clause, and its JSON carries the same text in not_counted", async () => {
    const j = (await run("show", scriptAt("A6"))).json().room;
    const w = roomLine((await run("show", scriptAt("A6"), false)).out);
    expect(j.state).toBe("known");
    expect(j.not_counted).toBe(BREAKER_NOT_COUNTED);
    expect(w.endsWith(BREAKER_NOT_COUNTED)).toBe(true);
  });

  it("a room of none (revoked) and a room of unknown carry no clause, in words or in JSON", async () => {
    const none = await run("show", scriptAt("A10"));
    expect(none.json().room.state).toBe("none");
    expect(none.json().room).not.toHaveProperty("not_counted");
    expect((await run("show", scriptAt("A10"), false)).out).not.toContain("not counted");
    const bad = scriptAt("A6");
    bad.storage.set(`${bad.head} ${K1.sessions}`, "0xnothex");
    const unk = await run("show", bad);
    expect(unk.json().room.state).toBe("unknown");
    expect(unk.json().room).not.toHaveProperty("not_counted");
    expect(roomLine((await run("show", bad, false)).out)).not.toContain("not counted");
  });

  it("a tripped breaker leaves the room none, with no clause", async () => {
    const r = (await run("show", withField(scriptAt("A6"), K1.breakers, "breaker", "tripped", 1n))).json().room;
    expect(r.state).toBe("none");
    expect(r).not.toHaveProperty("not_counted");
  });

  it("the room's unit: a known room has no breaker arithmetic, so a breaker at its counters leaves the value as the three bounds give it", () => {
    const rec = { owner: "", delegate: "", spending_cap: 100n, per_tx_limit: 10n, daily_cap: 50n, spent: 0n, epoch_spent: 0n, epoch_start: 0, expires_at: 1_000_000, allowed_pallets: [], active: true } as any;
    const breaker = { period_start: 0, tx_count: 1_000_000, total_spend: 10n ** 30n, tripped: false } as any;
    const r = roomOf({ head: 10, session: known(rec), breaker: known(breaker), constants: known({}), eraPeriod: ERA_PERIOD });
    expect(r).toMatchObject({ kind: "known", raw: 10n });
  });
});

describe("F2 (RP5B-5): show exits 1 when the seat's local caps are unknown", () => {
  it("in words and in JSON, the words and the JSON staying as they were", async () => {
    const home = seatHome(DEV1, null);
    const j = await session(home, ["show", "--owner", OWNER.ss58, "--json"], transportOf(scriptAt("A6")));
    const w = await session(home, ["show", "--owner", OWNER.ss58], transportOf(scriptAt("A6")));
    expect([j.code, w.code]).toEqual([1, 1]);
    expect(j.json().local_caps).toMatchObject({ state: "unknown", value: null });
    expect(w.out).toMatch(/local caps {2}unknown \(/);
  });
});

describe("F3 (RP5B-4): one function names a stored record for grant and revoke", () => {
  const rec = (active: boolean, expires_at: number) => ({ active, expires_at }) as any;
  it("names the four states, and the edge of the expiry is the head itself", () => {
    expect(storedName(null, 100)).toBe("no session");
    expect(storedName(rec(true, 101), 100)).toBe("an active session");
    expect(storedName(rec(true, 100), 100)).toBe("a session past its expiry");
    expect(storedName(rec(true, 99), 100)).toBe("a session past its expiry");
    expect(storedName(rec(false, 1000), 100)).toBe("a revoked session");
    expect(storedName(rec(false, 50), 100)).toBe("a revoked session");
  });

  it("revoke prints the name of each state in its line and in its JSON", async () => {
    const h = BigInt(headOf("A6"));
    const cases: [string, Script, string][] = [
      ["no session", withNone(scriptAt("A6"), K1.sessions), "no session"],
      ["active", scriptAt("A6"), "an active session"],
      ["past its expiry", withField(scriptAt("A6"), K1.sessions, "session", "expires_at", h - 1n), "a session past its expiry"],
      ["revoked", scriptAt("A10"), "a revoked session"],
    ];
    for (const [what, s, name] of cases) {
      const j = await run("revoke", s);
      const w = await run("revoke", s, false);
      expect([what, j.code, j.json().stored]).toEqual([what, 0, name]);
      expect(w.out).toContain(`Stored for this owner and device: ${name}.`);
    }
  });

  it("grant and revoke agree on one state: grant refuses exactly when revoke says an active session", async () => {
    const h = BigInt(headOf("A6"));
    for (const [s, active] of [[scriptAt("A6"), true], [withField(scriptAt("A6"), K1.sessions, "session", "expires_at", h), false], [scriptAt("A10"), false]] as const) {
      const g = await run("grant", s);
      const r = await run("revoke", s);
      expect([g.code === 5, r.json().stored === "an active session"]).toEqual([active, active]);
    }
  });
});

describe("F4 (RP5B-3): an option given twice is a usage error in the one parser", () => {
  const twice = (r: { code: number; out: string; err: string }, name: string) => {
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain(`--${name} is given more than once`);
  };
  it("session grant: --days twice, and --owner twice, name the option; nothing is asked of the node", async () => {
    const log: unknown[] = [];
    const t = transportOf(scriptAt("A10"), log as any);
    twice(await session(seatHome(), ["grant", "--owner", OWNER.ss58, "--days", "1", "--days", "2"], t), "days");
    twice(await session(seatHome(), ["grant", "--owner", OWNER.ss58, "--owner", OWNER.ss58, "--days", "1"], t), "owner");
    expect(log).toEqual([]);
  });
  it("session show: a boolean option twice (--json --json) is refused too", async () => {
    twice(await session(seatHome(), ["show", "--owner", OWNER.ss58, "--json", "--json"], transportOf(scriptAt("A6"))), "json");
  });
  it("cap set: --per-call twice", async () => {
    twice(await cli(seatHome(), ["cap", "set", "1", "--per-call", "0.5", "--per-call", "0.4"]), "per-call");
  });
  it("run: --prompt twice, before the command does anything", async () => {
    twice(await cli(seatHome(), ["run", "--prompt", "a", "--prompt", "b"]), "prompt");
  });
  it("the global --seat twice is refused", async () => {
    twice(await cli(seatHome(), ["cap", "show", "--seat", "42", "--seat", "42"]), "seat");
  });
  it("an argument after -- is a positional, not a second option", async () => {
    const r = await cli(seatHome(), ["cap", "set", "1", "--per-call", "0.5", "--", "--per-call"]);
    expect(r.err).not.toContain("given more than once");
  });
  it("one of each option still works", async () => {
    expect((await cli(seatHome(), ["cap", "set", "1", "--per-call", "0.5"])).code).toBe(0);
  });
});

describe("F5 (RP5B-2): --owner must be in its canonical form", () => {
  it("a reserved first byte and a two byte form of a prefix below 64 exit 2 with canonical words, echoing nothing", async () => {
    const { base58 } = await import("@scure/base");
    const { blake2b } = await import("@noble/hashes/blake2.js");
    const pub = Uint8Array.from(Buffer.from(OWNER.public_key.slice(2), "hex"));
    const addr = (prefix: number[]) => {
      const body = Uint8Array.from([...prefix, ...pub]);
      const sum = blake2b(Uint8Array.from([...new TextEncoder().encode("SS58PRE"), ...body]), { dkLen: 64 }).subarray(0, 2);
      return base58.encode(Uint8Array.from([...body, ...sum]));
    };
    for (const text of [addr([0x8a, 0x80]), addr([0x4a, 0x80])]) {
      const r = await session(seatHome(), ["show", "--owner", text], transportOf(scriptAt("A6")));
      expect([r.code, r.out]).toEqual([2, ""]);
      expect(r.err).toContain("not an SS58 account address in its canonical form");
      expect(r.err).not.toContain(text);
    }
  });
});

describe("F6 (RP5B-7): the days against the runtime's own constants", () => {
  it("at or below MaxSessionDuration passes", () => {
    expect(() => checkDaysAgainstRuntime(10, 86400, 864000)).not.toThrow();
    expect(() => checkDaysAgainstRuntime(1, 86400, 86400)).not.toThrow();
  });
  it("above it is exit 5 and names the days asked, the most whole days and both constants", () => {
    let e: unknown;
    try {
      checkDaysAgainstRuntime(6, 100, 599);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe(5);
    const m = (e as CliError).message;
    expect(m).toContain("--days 6");
    expect(m).toContain("SessionEpochLength is 100 blocks");
    expect(m).toContain("MaxSessionDuration is 599 blocks");
    expect(m).toContain("5 days");
  });
  it("the most is one day: singular, and zero days when a session is shorter than one epoch", () => {
    expect(() => checkDaysAgainstRuntime(2, 100, 150)).toThrow(/most it allows is 1 day \(/);
    expect(() => checkDaysAgainstRuntime(1, 100, 50)).toThrow(/most it allows is 0 days/);
  });
});
