/**
 * P5a, the owner's two session calls (rules O1 to O11): the recorded calls of the lab's devnet tests are the byte
 * vectors (T1), the rerun's B1 grant of nine names is refused (T2), every refusal has its code and words (T4), the
 * words come from the bytes alone (T5), and the bytes are read back before they are returned (O11).
 *
 * Every input value is read from the files that recorded the call:
 *  - research/2026-11-12-session-rerun-1014020/results.json, steps A2, A10, B1, B11: the call bytes in `call`, the
 *    delegate and the caps in the FlopSessionKeys event's fields, and the duration as the event's `expires_at`
 *    less `finalized_in_block` (expires_at is the inclusion block plus the duration: facts file, the planner's
 *    section 1 of the P5 facts).
 *  - research/2026-11-12-encoder-devnet-test/run-2026-11-13/calls/T2.json and T8.json: the call bytes in `call`;
 *    the values from the same steps of ../results.final.json, by the same fields.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_ALLOWED_PALLET } from "../src/chain/calls.js";
import { describeOwnerCall } from "../src/chain/describe.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import { encodeOwnerCall, type CreateSessionInput } from "../src/chain/owner-calls.js";
import { readOwnerCall } from "../src/chain/reader.js";
import { compact, concat } from "../src/chain/scale.js";
import { amountText } from "../src/chain/describe.js";
import { hex, readJson, RERUN, results, RT, RUNTIME_ID, U128_MAX, U32_MAX, unhex } from "./lib/chain-fixtures.js";

const D1 = "research/2026-11-12-encoder-devnet-test";
const finalRecord = readJson(`${D1}/results.final.json`);
const callFile = (step: string) => readJson(`${D1}/run-2026-11-13/calls/${step}.json`).call as string;
const facts = readJson(`${RERUN}/facts-1014020.json`);
const MAX = Number(facts.constants.FlopSessionKeys.MaxSessionDuration.value);

type Step = { step: string; call: string; finalized_in_block: number; events: { pallet: string; name: string; fields: Record<string, string | number> }[] };
const stepOf = (record: { steps: Step[] }, id: string) => record.steps.find((s) => s.step === id)!;
const eventOf = (s: Step, name: string) => s.events.find((e) => e.pallet === "FlopSessionKeys" && e.name === name)!.fields;

/** The grant a recorded step made, from its SessionCreated event and its block. */
function grantOf(s: Step): CreateSessionInput {
  const f = eventOf(s, "SessionCreated");
  return {
    runtime: RUNTIME_ID,
    call: "create_session",
    delegate: unhex(f.delegate as string),
    spending_cap: BigInt(f.spending_cap),
    per_tx_limit: BigInt(f.per_tx_limit),
    daily_cap: BigInt(f.daily_cap),
    duration_blocks: (f.expires_at as number) - s.finalized_in_block,
  };
}
const revokeOf = (s: Step) => ({ runtime: RUNTIME_ID, call: "revoke_session" as const, delegate: unhex(eventOf(s, "SessionRevoked").delegate as string) });

const A2 = stepOf(results, "A2");
const GRANT = grantOf(A2);

function codeOf(f: () => unknown): string | null {
  try {
    f();
  } catch (e) {
    return e instanceof ChainEncodeError ? e.refusal : `not a ChainEncodeError: ${String(e)}`;
  }
  return null;
}
function refusal(f: () => unknown): { code: string; words: string } {
  try {
    f();
  } catch (e) {
    if (e instanceof ChainEncodeError) return { code: e.refusal, words: e.message };
    return { code: `not a ChainEncodeError: ${String(e)}`, words: "" };
  }
  return { code: "none", words: "" };
}

describe("T1: the encoder's owner calls equal the recorded calls byte for byte", () => {
  for (const id of ["A2"]) {
    it(`create_session equals the rerun's ${id}`, () => {
      const s = stepOf(results, id);
      expect(hex(encodeOwnerCall(grantOf(s)))).toBe(s.call);
    });
  }
  it("create_session equals the devnet test's T2 (calls/T2.json, values from results.final.json)", () => {
    const s = stepOf(finalRecord, "T2");
    expect(s.call).toBe(callFile("T2"));
    expect(hex(encodeOwnerCall(grantOf(s)))).toBe(callFile("T2"));
  });
  for (const id of ["A10", "B11"]) {
    it(`revoke_session equals the rerun's ${id}`, () => {
      const s = stepOf(results, id);
      expect(hex(encodeOwnerCall(revokeOf(s)))).toBe(s.call);
    });
  }
  it("revoke_session equals the devnet test's T8 (calls/T8.json, values from results.final.json)", () => {
    const s = stepOf(finalRecord, "T8");
    expect(s.call).toBe(callFile("T8"));
    expect(hex(encodeOwnerCall(revokeOf(s)))).toBe(callFile("T8"));
  });
  it("the strict reader reads each recorded call back as the values the files state", () => {
    expect(readOwnerCall(RUNTIME_ID, unhex(A2.call))).toEqual({ ...GRANT, runtime: undefined, allowed_pallets: [new TextEncoder().encode(OWNER_ALLOWED_PALLET)] } as never);
    const t8 = stepOf(finalRecord, "T8");
    expect(readOwnerCall(RUNTIME_ID, unhex(callFile("T8")))).toEqual({ call: "revoke_session", delegate: revokeOf(t8).delegate });
  });
});

describe("T2: the rerun's B1 grant of nine names is a refusal vector (O7)", () => {
  const B1 = stepOf(results, "B1");
  it("the strict reader refuses it with CALL_NOT_ALLOWED and its words", () => {
    const r = refusal(() => readOwnerCall(RUNTIME_ID, unhex(B1.call)));
    expect(r.code).toBe("CALL_NOT_ALLOWED");
    expect(r.words).toContain("allowed_pallets holds 9 names");
  });
  it("the words function refuses it too", () => {
    expect(codeOf(() => describeOwnerCall(RUNTIME_ID, unhex(B1.call)))).toBe("CALL_NOT_ALLOWED");
  });
  it("B1 with its list replaced by exactly ComputeChannel reads (control: only the list is refused)", () => {
    const g = grantOf(B1);
    expect(hex(encodeOwnerCall(g)).slice(0, 2 + 2 * (2 + 32 + 16 * 3 + 4))).toBe(B1.call.slice(0, 2 + 2 * (2 + 32 + 16 * 3 + 4)));
  });
});

/** A2's call with its allow list replaced by `list`. */
function withList(list: Uint8Array[]): Uint8Array {
  const bytes = unhex(A2.call);
  const head = bytes.slice(0, 2 + 32 + 16 * 3 + 4);
  return concat(head, compact(BigInt(list.length)), ...list.flatMap((b) => [compact(BigInt(b.length)), b]));
}
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("O7: the allow list is exactly ComputeChannel, and not an input", () => {
  it("the reader refuses an empty list, two names, another name, another case", () => {
    for (const list of [[], [utf8(OWNER_ALLOWED_PALLET), utf8(OWNER_ALLOWED_PALLET)], [utf8("Balances")], [utf8(OWNER_ALLOWED_PALLET.toLowerCase())], [utf8(OWNER_ALLOWED_PALLET.toUpperCase())]]) {
      expect(codeOf(() => readOwnerCall(RUNTIME_ID, withList(list)))).toBe("CALL_NOT_ALLOWED");
    }
    expect(readOwnerCall(RUNTIME_ID, withList([utf8(OWNER_ALLOWED_PALLET)]))).toBeTruthy();
  });
  it("an allowed_pallets field of the input is refused (BAD_INPUT), whatever it holds", () => {
    for (const v of [[], [utf8(OWNER_ALLOWED_PALLET)], [OWNER_ALLOWED_PALLET]]) {
      const r = refusal(() => encodeOwnerCall({ ...GRANT, allowed_pallets: v } as never));
      expect(r.code).toBe("BAD_INPUT");
      expect(r.words).toContain("allowed_pallets is not an input");
    }
  });
  it("a list's string longer than its bytes, or more strings than the bytes hold, is BAD_BYTES", () => {
    const head = unhex(A2.call).slice(0, 2 + 32 + 16 * 3 + 4);
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, concat(head, compact(1n), compact(100n), utf8(OWNER_ALLOWED_PALLET))))).toBe("BAD_BYTES");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, concat(head, compact(1n << 40n))))).toBe("BAD_BYTES");
  });
});

describe("T4, O8: refused before any byte is returned, each with a code and its own words", () => {
  const cases: [string, Partial<Record<string, unknown>>, string, string][] = [
    ["a spending cap of 0", { spending_cap: 0n }, "OUT_OF_RANGE", "spending_cap is 0 raw"],
    ["a per transaction limit of 0", { per_tx_limit: 0n }, "OUT_OF_RANGE", "per_tx_limit is 0 raw"],
    ["a daily cap of 0", { daily_cap: 0n, per_tx_limit: 0n }, "OUT_OF_RANGE", "is 0 raw"],
    ["a per transaction limit above the daily cap", { per_tx_limit: GRANT.daily_cap + 1n }, "OUT_OF_RANGE", "per_tx_limit"],
    ["a daily cap above the spending cap", { daily_cap: GRANT.spending_cap + 1n }, "OUT_OF_RANGE", "daily_cap"],
    ["a cap above u128", { spending_cap: U128_MAX + 1n }, "OUT_OF_RANGE", "spending_cap"],
    ["a cap below 0", { spending_cap: -1n }, "OUT_OF_RANGE", "spending_cap"],
    ["a cap that is a number", { spending_cap: 5e16 }, "BAD_INPUT", "spending_cap"],
    ["a cap that is text", { daily_cap: "25000000000000000" }, "BAD_INPUT", "daily_cap"],
    ["a duration of 0", { duration_blocks: 0 }, "OUT_OF_RANGE", "duration_blocks 0 is not from 1 to MaxSessionDuration"],
    ["a duration above MaxSessionDuration", { duration_blocks: MAX + 1 }, "OUT_OF_RANGE", `MaxSessionDuration ${MAX}`],
    ["a duration above u32", { duration_blocks: U32_MAX + 1 }, "OUT_OF_RANGE", "duration_blocks"],
    ["a duration not a whole number", { duration_blocks: 7200.5 }, "BAD_INPUT", "duration_blocks"],
    ["a duration as a bigint", { duration_blocks: 7200n }, "BAD_INPUT", "duration_blocks"],
    ["a delegate of 31 bytes", { delegate: new Uint8Array(31) }, "WRONG_LENGTH", "delegate"],
    ["a delegate as hex", { delegate: hex(GRANT.delegate) }, "BAD_INPUT", "delegate"],
    ["a call that is not one of the two", { call: "update_session_limits" }, "CALL_NOT_ALLOWED", "update_session_limits is not one of create_session, revoke_session"],
    ["a session call's name", { call: "execute_via_session" }, "CALL_NOT_ALLOWED", "is not one of"],
    ["a runtime not in the table", { runtime: { ...RUNTIME_ID, specVersion: 1014014 } }, "RUNTIME_UNKNOWN", "no reviewed runtime"],
  ];
  for (const [label, change, code, words] of cases) {
    it(`${label}: ${code}`, () => {
      const r = refusal(() => encodeOwnerCall({ ...GRANT, ...change } as never));
      expect(r.code).toBe(code);
      expect(r.words).toContain(words);
    });
  }

  it("the edges are written: caps all 1, caps all u128 max, durations 1 and MaxSessionDuration", () => {
    for (const g of [
      { ...GRANT, spending_cap: 1n, per_tx_limit: 1n, daily_cap: 1n },
      { ...GRANT, spending_cap: U128_MAX, per_tx_limit: U128_MAX, daily_cap: U128_MAX },
      { ...GRANT, duration_blocks: 1 },
      { ...GRANT, duration_blocks: MAX },
      { ...GRANT, per_tx_limit: GRANT.daily_cap, daily_cap: GRANT.spending_cap },
    ]) {
      expect(readOwnerCall(RUNTIME_ID, encodeOwnerCall(g))).toMatchObject({ spending_cap: g.spending_cap, per_tx_limit: g.per_tx_limit, daily_cap: g.daily_cap, duration_blocks: g.duration_blocks });
    }
  });
});

describe("T4, O2 and O6: the input is read once, own fields, exactly these", () => {
  it("a field missing is refused", () => {
    for (const k of ["delegate", "spending_cap", "per_tx_limit", "daily_cap", "duration_blocks", "runtime"]) {
      const g: Record<string, unknown> = { ...GRANT };
      delete g[k];
      expect(codeOf(() => encodeOwnerCall(g as never))).toBe("BAD_INPUT");
    }
    expect(codeOf(() => encodeOwnerCall({ runtime: RUNTIME_ID, call: "revoke_session" } as never))).toBe("BAD_INPUT");
    const { call: _c, ...noName } = GRANT;
    expect(codeOf(() => encodeOwnerCall(noName as never))).toBe("CALL_NOT_ALLOWED");
  });

  it("an extra field is refused, a signer, nonce, era or tip above all (O2)", () => {
    for (const k of ["signer", "nonce", "accountNonce", "era", "birth", "tip", "memo"]) {
      const r = refusal(() => encodeOwnerCall({ ...GRANT, [k]: 0 } as never));
      expect(r.code).toBe("BAD_INPUT");
      expect(r.words).toContain(`a field ${k}`);
    }
    expect(codeOf(() => encodeOwnerCall({ ...revokeOf(stepOf(results, "A10")), spending_cap: 1n } as never))).toBe("BAD_INPUT");
  });

  it("an accessor is refused, on any field and on the call's name", () => {
    for (const k of ["call", "runtime", "delegate", "spending_cap", "duration_blocks"]) {
      const g: Record<string, unknown> = { ...GRANT };
      const v = g[k];
      Object.defineProperty(g, k, { get: () => v, enumerable: true });
      expect(codeOf(() => encodeOwnerCall(g as never))).toBe("BAD_INPUT");
    }
  });

  it("a Proxy's get trap is not used, and each field is read once", () => {
    let gets = 0;
    const descriptors: Record<string, number> = {};
    const proxy = new Proxy(
      { ...GRANT },
      {
        get: (t, k) => (gets++, Reflect.get(t, k)),
        getOwnPropertyDescriptor: (t, k) => ((descriptors[String(k)] = (descriptors[String(k)] ?? 0) + 1), Reflect.getOwnPropertyDescriptor(t, k)),
      },
    );
    expect(hex(encodeOwnerCall(proxy))).toBe(A2.call);
    expect(gets).toBe(0);
    expect(Object.values(descriptors).every((n) => n === 1)).toBe(true);
    expect(Object.keys(descriptors).sort()).toEqual(Object.keys(GRANT).sort());
  });

  it("an inherited field is not read, and the input must be an object", () => {
    expect(codeOf(() => encodeOwnerCall(Object.create(GRANT)))).toBe("CALL_NOT_ALLOWED");
    for (const v of [null, undefined, 1, "create_session", [GRANT], new Uint8Array(1)]) expect(codeOf(() => encodeOwnerCall(v as never))).toBe("BAD_INPUT");
  });

  it("the input is copied: changing it after the call changes nothing returned", () => {
    const g = { ...GRANT, delegate: Uint8Array.from(GRANT.delegate) };
    const bytes = encodeOwnerCall(g);
    g.delegate[0] ^= 1;
    expect(hex(bytes)).toBe(A2.call);
  });
});

describe("T4, O9: the strict reader reads the whole of the bytes or refuses", () => {
  const a2 = unhex(A2.call);
  it("a wrong pallet or call index", () => {
    for (const [p, c] of [[a2[0] + 1, a2[1]], [a2[0], 2], [a2[0], 5]]) {
      const b = Uint8Array.from(a2);
      b[0] = p;
      b[1] = c;
      expect(codeOf(() => readOwnerCall(RUNTIME_ID, b))).toBe("CALL_NOT_ALLOWED");
    }
  });
  it("a session call is not an owner call", () => {
    const b = Uint8Array.from(a2);
    b[1] = RT.calls[0].callIndex;
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, b))).not.toBeNull();
  });
  it("bytes left over, bytes short, no bytes", () => {
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, concat(a2, Uint8Array.of(0))))).toBe("BAD_BYTES");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, a2.slice(0, -1)))).toBe("BAD_BYTES");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, new Uint8Array(0)))).toBe("BAD_BYTES");
    const t8 = unhex(callFile("T8"));
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, concat(t8, Uint8Array.of(0))))).toBe("BAD_BYTES");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, t8.slice(0, -1)))).toBe("BAD_BYTES");
  });

  /** A2's bytes with one u128 cap (0, 1, 2) or the duration replaced. */
  const at = { spending_cap: 34, per_tx_limit: 50, daily_cap: 66, duration_blocks: 82 } as const;
  function changed(field: keyof typeof at, value: bigint): Uint8Array {
    const b = Uint8Array.from(a2);
    const width = field === "duration_blocks" ? 4 : 16;
    for (let i = 0; i < width; i++) b[at[field] + i] = Number((value >> BigInt(8 * i)) & 0xffn);
    return b;
  }
  it("the offsets of the fixture are A2's own fields (control)", () => {
    expect(hex(changed("spending_cap", GRANT.spending_cap))).toBe(A2.call);
    expect(hex(changed("duration_blocks", BigInt(GRANT.duration_blocks)))).toBe(A2.call);
  });
  it("a cap of 0, caps out of order, a duration of 0 or above the longest: OUT_OF_RANGE, as the encoder", () => {
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, changed("spending_cap", 0n)))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, changed("per_tx_limit", 0n)))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, changed("daily_cap", 0n)))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, changed("per_tx_limit", GRANT.daily_cap + 1n)))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, changed("daily_cap", GRANT.spending_cap + 1n)))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, changed("duration_blocks", 0n)))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, changed("duration_blocks", BigInt(MAX) + 1n)))).toBe("OUT_OF_RANGE");
    expect(readOwnerCall(RUNTIME_ID, changed("duration_blocks", BigInt(MAX)))).toMatchObject({ duration_blocks: MAX });
  });
  it("a runtime not in the table, and bytes that are not a Uint8Array", () => {
    expect(codeOf(() => readOwnerCall({ ...RUNTIME_ID, specVersion: 1014014 }, a2))).toBe("RUNTIME_UNKNOWN");
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, [...a2] as never))).toBe("BAD_INPUT");
  });
});

describe("T5, O10: the words come from the bytes alone", () => {
  const words = describeOwnerCall(RUNTIME_ID, unhex(A2.call));
  it("A2's words hold the values its file states", () => {
    const f = eventOf(A2, "SessionCreated");
    expect(words).toContain("FlopSessionKeys.create_session");
    expect(words).toContain("call bytes only and not signed here");
    expect(words).toContain(`delegate ${f.delegate}`);
    expect(words).toContain(`spending_cap ${amountText(BigInt(f.spending_cap))}`);
    expect(words).toContain(`per_tx_limit ${amountText(BigInt(f.per_tx_limit))}`);
    expect(words).toContain(`daily_cap ${amountText(BigInt(f.daily_cap))}`);
    expect(words).toContain(`duration_blocks ${(f.expires_at as number) - A2.finalized_in_block} blocks`);
    expect(words).toContain(`allowed_pallets [${OWNER_ALLOWED_PALLET}]`);
  });
  it("the FLOP figures are those of the escrow test's session (0.05, 0.02, 0.025)", () => {
    expect(words).toContain("(0.05 FLOP)");
    expect(words).toContain("(0.02 FLOP)");
    expect(words).toContain("(0.025 FLOP)");
  });
  it("a revoke's words name the call and the delegate", () => {
    const s = stepOf(finalRecord, "T8");
    expect(describeOwnerCall(RUNTIME_ID, unhex(callFile("T8")))).toBe(
      `FlopSessionKeys.revoke_session, a call of the session's owner, call bytes only and not signed here: delegate ${eventOf(s, "SessionRevoked").delegate}`,
    );
  });
  it("every one bit change of A2's bytes gives other words or a refusal, never the same words", () => {
    const a2 = unhex(A2.call);
    let refused = 0;
    let other = 0;
    for (let i = 0; i < a2.length * 8; i++) {
      const b = Uint8Array.from(a2);
      b[i >> 3] ^= 1 << (i & 7);
      let w: string | null = null;
      try {
        w = describeOwnerCall(RUNTIME_ID, b);
      } catch (e) {
        expect(e).toBeInstanceOf(ChainEncodeError);
        refused++;
        continue;
      }
      expect(w).not.toBe(words);
      other++;
    }
    expect(refused + other).toBe(a2.length * 8);
    expect(refused).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(0);
  });
});

describe("O11: the bytes are read back and compared with the copy of the input before they are returned", () => {
  afterEach(() => {
    vi.doUnmock("../src/chain/fields.js");
    vi.resetModules();
  });
  async function withBadWriter(kind: string, change: (b: Uint8Array) => void) {
    vi.resetModules();
    vi.doMock("../src/chain/fields.js", async (orig) => {
      const real = (await orig()) as typeof import("../src/chain/fields.js");
      return {
        ...real,
        writeValue: (ty: { kind: string }, value: never, what: string) => {
          const b = real.writeValue(ty as never, value, what);
          if (ty.kind === kind) change(b);
          return b;
        },
      };
    });
    const o = await import("../src/chain/owner-calls.js");
    const e = await import("../src/chain/errors.js");
    return (f: (x: typeof o) => unknown) => {
      try {
        f(o);
      } catch (err) {
        return err instanceof e.ChainEncodeError ? err.refusal : String(err);
      }
      return null;
    };
  }
  it("a delegate written with one bit changed: READ_BACK, for the grant and the revoke", async () => {
    const run = await withBadWriter("bytes32", (b) => void (b[0] ^= 1));
    expect(run((o) => o.encodeOwnerCall(GRANT))).toBe("READ_BACK");
    expect(run((o) => o.encodeOwnerCall(revokeOf(stepOf(results, "A10"))))).toBe("READ_BACK");
  });
  it("a cap written one higher (still in order): READ_BACK", async () => {
    const run = await withBadWriter("u128", (b) => void (b[0] ^= 1));
    expect(run((o) => o.encodeOwnerCall({ ...GRANT, spending_cap: GRANT.spending_cap + 2n }))).toBe("READ_BACK");
  });
  it("control: the same mock with no change writes A2", async () => {
    const run = await withBadWriter("none", () => undefined);
    expect(run((o) => expect(hex(o.encodeOwnerCall(GRANT))).toBe(A2.call))).toBeNull();
  });
});
