/**
 * P5b, `session grant` and `session revoke` (rules C8 to C12), tests T3, T5, T6 and T9, and C8 for show. A scripted
 * node answers from the session rerun's recording. Every recorded value is read from
 * research/2026-11-12-session-rerun-1014020/results.json (steps A6, A10, B11: `call`, `block_hash`,
 * `finalized_in_block`) and the runtime's constants from its facts-1014020.json
 * (`constants.FlopSessionKeys.SessionEpochLength.value`, `MaxSessionDuration.value`).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { describeOwnerCall } from "../src/chain/describe.js";
import { encodeOwnerCall } from "../src/chain/owner-calls.js";
import { NETWORKS } from "../src/networks.js";
import { grant } from "../src/session/grant.js";
import { revoke } from "../src/session/revoke.js";
import { show } from "../src/session/show.js";
import { MAX_DAYS } from "../src/session/caps.js";
import { hex, readJson, ref, refCall, RERUN, RUNTIME_ID, unhex } from "./lib/chain-fixtures.js";
import { copyScript, DEV1, DEV2, keysOf, OWNER, scriptAt, seatHome, SEAT, session, stepOf, transportOf, withField, withNone } from "./lib/session-fixtures.js";
import type { Log } from "./lib/recorded-node.js";
import { referenceBlake2b256, referenceReady } from "./lib/sr25519-reference.js";

const facts = readJson(`${RERUN}/facts-1014020.json`).constants.FlopSessionKeys;
const EPOCH = Number(facts.SessionEpochLength.value);
const K1 = keysOf(OWNER.public_key, DEV1.public_key);
const account = ref.buildDefinition(0);

/** raw(x) from the decimal text of a cap, by the test's own arithmetic: its digits, padded to 18 decimals. */
function rawOfText(t: string): bigint {
  const [w, f = ""] = t.split(".");
  return BigInt(w + f.padEnd(18, "0"));
}

const grantAt = (home: string, script: ReturnType<typeof scriptAt>, days: string, json = true, log?: Log) => session(home, ["grant", "--owner", OWNER.ss58, "--days", days, ...(json ? ["--json"] : [])], transportOf(script, log));

beforeAll(async () => {
  await referenceReady();
});

describe("T5: the caps, derived exactly", () => {
  it("MAX_DAYS is MaxSessionDuration over SessionEpochLength of the recorded runtime", () => {
    expect(MAX_DAYS).toBe(Number(facts.MaxSessionDuration.value) / EPOCH);
  });

  const grid: [string, string][] = [
    ["0.000001", "0.000001"],
    ["0.02", "0.025"],
    ["0.5", "1"],
    ["1", "1000"],
    ["123.456789", "999999999.999999"],
    ["1000000000", "1000000000"],
  ];
  for (const [perCall, daily] of grid) {
    for (const days of [1, 2, 7, 10]) {
      it(`per call ${perCall}, daily ${daily}, ${days} days: the printed call is encodeOwnerCall of the derived values, and the reference reads it back`, async () => {
        const home = seatHome(DEV1, { daily: Number(daily), perCall: Number(perCall) });
        const r = await grantAt(home, scriptAt("A10"), String(days));
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        const j = r.json();
        const want = { spending_cap: rawOfText(daily) * BigInt(days), per_tx_limit: rawOfText(perCall), daily_cap: rawOfText(daily), duration_blocks: EPOCH * days };
        expect(j.call_hex).toBe(hex(encodeOwnerCall({ runtime: RUNTIME_ID, call: "create_session", delegate: unhex(DEV1.public_key), ...want })));
        expect(j.caps).toEqual({ spending_cap: String(want.spending_cap), per_tx_limit: String(want.per_tx_limit), daily_cap: String(want.daily_cap), duration_blocks: want.duration_blocks, days, epoch_length: EPOCH });
        const back = refCall.dec(unhex(j.call_hex));
        expect([back.type, back.value.type]).toEqual(["FlopSessionKeys", "create_session"]);
        const v = back.value.value;
        expect([hex(account.enc(v.delegate)), v.spending_cap, v.per_tx_limit, v.daily_cap, v.duration_blocks]).toEqual([DEV1.public_key, want.spending_cap, want.per_tx_limit, want.daily_cap, want.duration_blocks]);
      });
    }
  }

  it("two days of the A2 grant's local caps give the recorded A2 call's caps, byte for byte (A2's spending cap is twice its daily cap)", async () => {
    const two = (await grantAt(seatHome(), scriptAt("A10"), "2")).json();
    const a2 = stepOf("A2").call as string;
    // 0x, the pallet and call index, the delegate and the three u128 caps; A2's own duration (7200 blocks) is not an epoch.
    const capsEnd = 2 + 2 * (2 + 32 + 16 * 3);
    expect(two.call_hex.slice(0, capsEnd)).toBe(a2.slice(0, capsEnd));
  });

  const refused = async (caps: { daily: unknown; perCall: unknown } | null, words: RegExp) => {
    const log: Log = [];
    const r = await grantAt(seatHome(DEV1, caps), scriptAt("A10"), "1", false, log);
    expect(r.code).toBe(3);
    expect(r.out).toBe("");
    expect(r.err).toMatch(words);
    expect(log).toEqual([]);
  };

  it("a cap off the 6 decimal grid: exit 3, words that say to set a cap on the grid, no call, no node call", async () => {
    await refused({ daily: 1, perCall: 0.0000015 }, /per call cap of seat 42, 0\.0000015 FLOP, is not on the 6 decimal grid.*Set a cap with at most 6 decimals/);
    await refused({ daily: 0.1234567, perCall: 0.1 }, /daily cap of seat 42, 0\.1234567 FLOP, is not on the 6 decimal grid/);
  });

  it("a cap missing, malformed or zero: exit 3 as run refuses it", async () => {
    await refused(null, /no daily cap for seat 42/);
    await refused({ daily: "1", perCall: 0.5 }, /cap for seat 42 is malformed/);
    await refused({ daily: 1, perCall: 2 }, /cap for seat 42 is malformed/);
    await refused({ daily: 0, perCall: 0 }, /cap for seat 42 is malformed/);
    await refused({ daily: 1, perCall: 0 }, /cap for seat 42 is malformed/);
  });

  for (const days of [null, "0", "11", "1.5", "text", "01", "-1", ""]) {
    it(`--days ${days === null ? "missing" : JSON.stringify(days)}: exit 2, no call, no node call`, async () => {
      const log: Log = [];
      const args = ["grant", "--owner", OWNER.ss58, ...(days === null ? [] : ["--days", days])];
      const r = await session(seatHome(), args, transportOf(scriptAt("A10"), log));
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/--days/);
      expect(log).toEqual([]);
    });
  }

  it("--days is refused by revoke and show", async () => {
    for (const sub of ["revoke", "show"]) {
      const r = await session(seatHome(), [sub, "--owner", OWNER.ss58, "--days", "1"], transportOf(scriptAt("A10")));
      expect([sub, r.code, r.out]).toEqual([sub, 2, ""]);
    }
  });
});

describe("T6: the words and the hash are of the printed bytes", () => {
  it("grant: the words are describeOwnerCall of the printed hex, character for character, and the hash is the reference blake2b 256", async () => {
    const r = await grantAt(seatHome(), scriptAt("A10"), "3", false);
    const callHex = /^  call    (0x[0-9a-f]+)$/m.exec(r.out)![1];
    const words = describeOwnerCall(RUNTIME_ID, unhex(callHex));
    expect(r.out.split("\n")).toContain(`  ${words}`);
    const hash = /^  blake2b 256 of the call  (0x[0-9a-f]{64})$/m.exec(r.out)![1];
    expect(hash).toBe(hex(referenceBlake2b256(unhex(callHex))));
    const j = (await grantAt(seatHome(), scriptAt("A10"), "3")).json();
    expect([j.call_hex, j.words, j.call_blake2b_256]).toEqual([callHex, words, hash]);
  });

  it("grant: the sentence of what it allows, in blocks and epochs and never hours, and the owner's last line", async () => {
    const j = (await grantAt(seatHome(), scriptAt("A10"), "3")).json();
    expect(j.allows).toBe(
      `This grant lets the device spend at most 75000000000000000 raw (0.075 FLOP) over the whole session, at most 25000000000000000 raw (0.025 FLOP) per epoch, and at most 20000000000000000 raw (0.02 FLOP) per call, through ComputeChannel calls only, for ${3 * EPOCH} blocks, which is 3 epochs of the runtime's epoch length of ${EPOCH} blocks.`,
    );
    expect(j.allows).not.toMatch(/hour/);
    const text = await grantAt(seatHome(), scriptAt("A10"), "3", false);
    const lines = text.out.split("\n");
    expect(lines[lines.length - 1]).toBe("The owner signs this call with his own wallet. This tool does not hold the owner's key and signs nothing.");
    expect(lines.slice(0, 3)).toEqual([`seat ${SEAT} on devnet`, `  owner   ${OWNER.ss58}`, `  device  ${DEV1.ss58}`]);
  });

  it("revoke: the recorded A10 and B11 calls, byte for byte, with their words and hash", async () => {
    for (const [id, dev] of [["A10", DEV1], ["B11", DEV2]] as const) {
      const r = await session(seatHome(dev), ["revoke", "--owner", OWNER.ss58, "--json"], transportOf(scriptAt(id)));
      expect(r.code).toBe(0);
      const j = r.json();
      expect(j.call_hex).toBe(stepOf(id).call);
      expect(j.words).toBe(describeOwnerCall(RUNTIME_ID, unhex(j.call_hex)));
      expect(j.call_blake2b_256).toBe(hex(referenceBlake2b256(unhex(j.call_hex))));
      expect(j.stored).toBe("a revoked session");
    }
  });

  it("revoke says what is stored, and prints the call in each case: active (A6), revoked (A10), none (A6 with no Sessions value)", async () => {
    const at = async (s: ReturnType<typeof scriptAt>) => session(seatHome(), ["revoke", "--owner", OWNER.ss58], transportOf(s));
    for (const [s, words] of [[scriptAt("A6"), "an active session"], [scriptAt("A10"), "a revoked session"], [withNone(scriptAt("A6"), K1.sessions), "no session"]] as const) {
      const r = await at(s);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Stored for this owner and device: ${words}.`);
      expect(r.out).toContain(`  call    ${stepOf("A10").call}`);
    }
  });
});

describe("T9: the grant over a stored record", () => {
  it("an active session (A6) refuses with exit 5 and says to revoke first", async () => {
    const r = await grantAt(seatHome(), scriptAt("A6"), "1");
    expect(r.code).toBe(5);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/stored and active until block \d+: the chain would refuse a second one \(SessionAlreadyExists\)\. Revoke it first/);
  });

  it("a revoked session (A10) prints the call with the line of C10", async () => {
    const r = await grantAt(seatHome(), scriptAt("A10"), "1");
    expect(r.code).toBe(0);
    expect(r.json().stored_record).toBe("A record is stored for this pair, revoked. Whether the chain takes a new grant over a stored record for this owner and device is not shown yet.");
  });

  it("an expired one: A6 with expires_at set to the head prints the call with the line; one block later it refuses", async () => {
    const head = stepOf("A6").finalized_in_block as number;
    const at = await grantAt(seatHome(), withField(scriptAt("A6"), K1.sessions, "session", "expires_at", BigInt(head)), "1");
    expect(at.code).toBe(0);
    expect(at.json().stored_record).toBe(`A record is stored for this pair, past its expiry at block ${head}. Whether the chain takes a new grant over a stored record for this owner and device is not shown yet.`);
    const before = await grantAt(seatHome(), withField(scriptAt("A6"), K1.sessions, "session", "expires_at", BigInt(head + 1)), "1");
    expect(before.code).toBe(5);
  });

  it("no session (A6 with no Sessions value) prints the call with no line", async () => {
    const r = await grantAt(seatHome(), withNone(scriptAt("A6"), K1.sessions), "1");
    expect(r.code).toBe(0);
    expect(r.json().stored_record).toBeNull();
  });
});

describe("T3: unknown prints no call", () => {
  const unknowns: [string, () => Parameters<typeof transportOf>[0] | ((m: any, p: any) => Promise<unknown>)][] = [
    ["a head that cannot be read", () => {
      const s = copyScript(scriptAt("A10"));
      s.headers.delete(s.head);
      return s;
    }],
    ["a record of another pair", () => {
      const s = copyScript(scriptAt("A10"));
      const k = `${s.head} ${K1.sessions}`;
      s.storage.set(k, (s.storage.get(k) as string).replace(DEV1.public_key.slice(2), DEV2.public_key.slice(2)));
      return s;
    }],
  ];
  for (const [name, make] of unknowns) {
    for (const sub of ["grant", "revoke"]) {
      it(`${sub}: ${name}: exit 1 and nothing on stdout`, async () => {
        const r = await session(seatHome(), [sub, "--owner", OWNER.ss58, ...(sub === "grant" ? ["--days", "1"] : [])], transportOf(make() as any));
        expect(r.code).toBe(1);
        expect(r.out).toBe("");
        expect(r.err).toMatch(/unknown/);
      });
    }
  }

  for (const sub of ["grant", "revoke"]) {
    it(`${sub}: a transport that throws after block 0: exit 1 and nothing on stdout`, async () => {
      const base = transportOf(scriptAt("A10"));
      const r = await session(seatHome(), [sub, "--owner", OWNER.ss58, ...(sub === "grant" ? ["--days", "1"] : [])], async (m, p) => {
        if (m === "chain_getBlockHash" && p[0] === 0) return base(m, p);
        throw new Error("the node is gone");
      });
      expect([r.code, r.out]).toEqual([1, ""]);
      expect(r.err).toContain("the node is gone");
    });
  }
});

describe("C8: a runtime that is not in the encoder's table", () => {
  // chain-read's key table holds a line for 1014020 alone, as the encoder's table does, so no recorded read names a
  // runtime the encoder does not know. The case is made by a network whose pinned genesis is another hash, which the
  // scripted node also answers at height 0: the read is the recorded one, and runtimeIdOf finds no entry.
  const other = "0x" + "11".repeat(32);
  const net = Object.freeze({ ...NETWORKS.devnet, genesisHash: other });
  const t = () => {
    const s = copyScript(scriptAt("A10"));
    s.hashes.set(0, other);
    return transportOf(s);
  };
  const ctx = (days?: string) => ({ home: seatHome(), seat: SEAT, net, caps: { [SEAT]: { daily: 1, perCall: 1 } }, owner: OWNER.ss58, days, transport: t() });

  it("grant and revoke refuse with exit 5, and the words name the spec", async () => {
    for (const run of [() => grant(ctx("1")), () => revoke(ctx())]) {
      await expect(run()).rejects.toMatchObject({ code: 5, message: expect.stringMatching(/^the runtime at the head, tzkv-runtime 1014020, is not in the encoder's table: .*Refused, no call printed$/) });
    }
  });

  it("show prints the session and says the room is unknown because the runtime is not one the encoder knows", async () => {
    const o = await show(ctx());
    expect(o.code).toBe(1);
    expect((o.json as any).session.state).toBe("stored");
    expect((o.json as any).room).toMatchObject({ state: "unknown", value: null });
    expect((o.json as any).room.reason).toMatch(/^the runtime is not one the encoder knows \(the runtime at the head, tzkv-runtime 1014020, is not in the encoder's table/);
  });
});
