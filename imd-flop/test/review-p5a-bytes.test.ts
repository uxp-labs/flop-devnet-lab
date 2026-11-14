/**
 * Review of P5a (the owner's two session calls), the reviewer's own tests: attacks 2, 3, 4 and 7 of the review brief.
 *
 * The bytes here are written a third way: by lines of this file, with the pallet index, the call indices and the
 * field order read from observatory/shapes/tzkv-runtime-1014020.json (types RuntimeCall#61, variant FlopSessionKeys,
 * and the variants of its call type), never from src/chain/runtimes.ts. The recorded calls are the `call` of steps
 * A2, A10, B1, B11 of research/2026-11-12-session-rerun-1014020/results.json and of
 * research/2026-11-12-encoder-devnet-test/run-2026-11-13/calls/T2.json and T8.json.
 * The values of A2 come from its SessionCreated event and its block (expires_at less finalized_in_block).
 */
import { describe, expect, it } from "vitest";
import { describeOwnerCall } from "../src/chain/describe.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import { encodeOwnerCall, sessionConstants, type CreateSessionInput } from "../src/chain/owner-calls.js";
import { readOwnerCall } from "../src/chain/reader.js";
import { amountText } from "../src/chain/describe.js";
import { hex, readJson, RERUN, results, RUNTIME_ID, unhex } from "./lib/chain-fixtures.js";

// ---- the chain's layout, read from the recorded shape file ----
const SHAPE = readJson("observatory/shapes/tzkv-runtime-1014020.json");
const palletVariant = SHAPE.types["RuntimeCall#61"].variants.find((v: { name: string }) => v.name === "FlopSessionKeys");
const PALLET: number = palletVariant.index;
const callType = SHAPE.types[palletVariant.fields[0].type];
const variantOf = (name: string) => callType.variants.find((v: { name: string }) => v.name === name);
const CREATE = variantOf("create_session");
const REVOKE = variantOf("revoke_session");

// ---- the reviewer's own SCALE lines ----
function le(v: bigint, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  if (v >> BigInt(8 * n) !== 0n || v < 0n) throw new Error("does not fit");
  return out;
}
function cpt(v: number): number[] {
  if (v < 64) return [v << 2];
  if (v < 1 << 14) return le(BigInt((v << 2) | 1), 2);
  return le((BigInt(v) << 2n) | 2n, 4);
}
type Grant = { delegate: Uint8Array; spending_cap: bigint; per_tx_limit: bigint; daily_cap: bigint; duration_blocks: number };
function mine(call: "create_session" | "revoke_session", g: Grant, list: Uint8Array[] = [new TextEncoder().encode("ComputeChannel")]): Uint8Array {
  const v = call === "create_session" ? CREATE : REVOKE;
  const out: number[] = [PALLET, v.index];
  for (const f of v.fields as { name: string; type: string }[]) {
    if (f.type === "AccountId32#0") out.push(...g.delegate);
    else if (f.type === "u128") out.push(...le(g[f.name as "spending_cap"], 16));
    else if (f.type === "u32") out.push(...le(BigInt(g[f.name as "duration_blocks"]), 4));
    else if (f.type === "Vec<Vec<u8>>") {
      out.push(...cpt(list.length));
      for (const b of list) out.push(...cpt(b.length), ...b);
    } else throw new Error(`a field type this test does not write: ${f.type}`);
  }
  return Uint8Array.from(out);
}

type Step = { step: string; call: string; finalized_in_block: number; events: { pallet: string; name: string; fields: Record<string, string | number> }[] };
const stepOf = (id: string) => (results.steps as Step[]).find((s) => s.step === id)!;
const ev = (s: Step, n: string) => s.events.find((e) => e.pallet === "FlopSessionKeys" && e.name === n)!.fields;
function grantOf(s: Step): Grant {
  const f = ev(s, "SessionCreated");
  return { delegate: unhex(f.delegate as string), spending_cap: BigInt(f.spending_cap), per_tx_limit: BigInt(f.per_tx_limit), daily_cap: BigInt(f.daily_cap), duration_blocks: (f.expires_at as number) - s.finalized_in_block };
}
const T = (id: string) => readJson(`research/2026-11-12-encoder-devnet-test/run-2026-11-13/calls/${id}.json`).call as string;
const A2 = stepOf("A2");
const G: Grant = grantOf(A2);
const MAX = Number(readJson(`${RERUN}/facts-1014020.json`).constants.FlopSessionKeys.MaxSessionDuration.value);
const enc = (g: Grant) => encodeOwnerCall({ runtime: RUNTIME_ID, call: "create_session", ...g } as CreateSessionInput);

function codeOf(f: () => unknown): string | null {
  try {
    f();
  } catch (e) {
    return e instanceof ChainEncodeError ? e.refusal : `not a ChainEncodeError: ${String(e)}`;
  }
  return null;
}
let seed = 0x0fa5e5a1;
const rnd = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 2 ** 32;
};
const rbig = (bits: number) => {
  let x = 0n;
  for (let i = 0; i < bits; i += 8) x = (x << 8n) | BigInt(Math.floor(rnd() * 256));
  return x & ((1n << BigInt(bits)) - 1n);
};
const rbytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
function randomGrant(): Grant {
  const caps = [1n + rbig(Math.floor(rnd() * 128)), 1n + rbig(Math.floor(rnd() * 128)), 1n + rbig(Math.floor(rnd() * 128))].map((c) => (c > (1n << 128n) - 1n ? (1n << 128n) - 1n : c)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { delegate: rbytes(32), per_tx_limit: caps[0], daily_cap: caps[1], spending_cap: caps[2], duration_blocks: 1 + Math.floor(rnd() * MAX) };
}

describe("review P5a, attack 2 (P1): the bytes by a third way, from the recorded shape file", () => {
  it("HOLDS: the shape file names the layout this test writes: pallet 94, create_session 0 with six fields, revoke_session 1 with one", () => {
    expect(PALLET).toBe(94);
    expect(CREATE.index).toBe(0);
    expect(CREATE.fields.map((f: { name: string }) => f.name)).toEqual(["delegate", "spending_cap", "per_tx_limit", "daily_cap", "duration_blocks", "allowed_pallets"]);
    expect(REVOKE.index).toBe(1);
    expect(REVOKE.fields.map((f: { name: string }) => f.name)).toEqual(["delegate"]);
  });

  it("HOLDS: the third way writes the recorded grant and revokes byte for byte (A2, T2, A10, B11, T8)", () => {
    expect(hex(mine("create_session", G))).toBe(A2.call);
    expect(hex(mine("create_session", { ...G, delegate: unhex(T("T8").slice(6)) }))).toBe(T("T2"));
    expect(hex(mine("revoke_session", { ...G, delegate: unhex(ev(stepOf("A10"), "SessionRevoked").delegate as string) }))).toBe(stepOf("A10").call);
    expect(hex(mine("revoke_session", { ...G, delegate: unhex(ev(stepOf("B11"), "SessionRevoked").delegate as string) }))).toBe(stepOf("B11").call);
  });

  it("HOLDS: the third way and the encoder write the same bytes for 400 random grants and 100 revokes, and the edges", () => {
    const grants: Grant[] = Array.from({ length: 400 }, randomGrant);
    const U = (1n << 128n) - 1n;
    grants.push({ ...G, spending_cap: 1n, per_tx_limit: 1n, daily_cap: 1n, duration_blocks: 1 });
    grants.push({ ...G, spending_cap: U, per_tx_limit: U, daily_cap: U, duration_blocks: MAX });
    grants.push({ ...G, delegate: new Uint8Array(32), duration_blocks: MAX - 1 });
    for (const g of grants) expect(hex(enc(g))).toBe(hex(mine("create_session", g)));
    for (let i = 0; i < 100; i++) {
      const d = rbytes(32);
      expect(hex(encodeOwnerCall({ runtime: RUNTIME_ID, call: "revoke_session", delegate: d }))).toBe(hex(mine("revoke_session", { ...G, delegate: d })));
    }
  });
});

describe("review P5a, attack 3 (P3): one reading", () => {
  const grant = unhex(A2.call);
  const revoke = unhex(stepOf("A10").call);

  it("HOLDS: every one bit flip of the A2 grant and the A10 revoke is refused or reads as other data that writes back to exactly itself", () => {
    let read = 0;
    let refused = 0;
    for (const base of [grant, revoke]) {
      for (let bit = 0; bit < base.length * 8; bit++) {
        const y = Uint8Array.from(base);
        y[bit >> 3] ^= 1 << (bit & 7);
        let d: ReturnType<typeof readOwnerCall> | null = null;
        try {
          d = readOwnerCall(RUNTIME_ID, y);
        } catch (e) {
          expect(e).toBeInstanceOf(ChainEncodeError);
          refused++;
          continue;
        }
        read++;
        const back = d.call === "create_session" ? enc({ delegate: d.delegate, spending_cap: d.spending_cap, per_tx_limit: d.per_tx_limit, daily_cap: d.daily_cap, duration_blocks: d.duration_blocks }) : encodeOwnerCall({ runtime: RUNTIME_ID, call: "revoke_session", delegate: d.delegate });
        expect(hex(back)).toBe(hex(y));
        expect(hex(back)).not.toBe(hex(base));
      }
    }
    expect(read + refused).toBe((grant.length + revoke.length) * 8);
    expect(read).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("HOLDS: every cut and every extension by one byte (all 256 values) is refused, BAD_BYTES", () => {
    for (const base of [grant, revoke]) {
      for (let n = 0; n < base.length; n++) expect(codeOf(() => readOwnerCall(RUNTIME_ID, base.slice(0, n)))).toBe(n < 2 ? "BAD_BYTES" : "BAD_BYTES");
      for (let b = 0; b < 256; b++) expect(codeOf(() => readOwnerCall(RUNTIME_ID, Uint8Array.of(...base, b)))).toBe("BAD_BYTES");
    }
  });

  it("HOLDS: the list's count and the name's length in every longer compact form are refused, BAD_BYTES", () => {
    const head = grant.slice(0, grant.length - 16);
    const name = new TextEncoder().encode("ComputeChannel");
    expect(hex(Uint8Array.of(...head, 0x04, 0x38, ...name))).toBe(hex(grant));
    const longCount = [[0x05, 0x00], [0x06, 0x00, 0x00, 0x00], [0x03, 0x01, 0x00, 0x00, 0x00], [0x07, 0x01, 0x00, 0x00, 0x00, 0x00], [0x0b, 0x01, 0, 0, 0, 0, 0]];
    const longLen = [[0x39, 0x00], [0x3a, 0x00, 0x00, 0x00], [0x03, 0x0e, 0x00, 0x00, 0x00], [0x07, 0x0e, 0, 0, 0, 0]];
    for (const c of longCount) expect(codeOf(() => readOwnerCall(RUNTIME_ID, Uint8Array.of(...head, ...c, 0x38, ...name)))).toBe("BAD_BYTES");
    for (const l of longLen) expect(codeOf(() => readOwnerCall(RUNTIME_ID, Uint8Array.of(...head, 0x04, ...l, ...name)))).toBe("BAD_BYTES");
    for (const c of longCount) for (const l of longLen) expect(codeOf(() => readOwnerCall(RUNTIME_ID, Uint8Array.of(...head, ...c, ...l, ...name)))).toBe("BAD_BYTES");
  });

  it("HOLDS: a wrong index is refused, CALL_NOT_ALLOWED, for every pallet and call byte but the two", () => {
    for (let p = 0; p < 256; p++)
      for (const c of [0, 1, 2, 3, 255]) {
        if (p === PALLET && (c === 0 || c === 1)) continue;
        expect(codeOf(() => readOwnerCall(RUNTIME_ID, Uint8Array.of(p, c, ...grant.slice(2))))).toBe("CALL_NOT_ALLOWED");
      }
  });

  it("HOLDS: a count that claims more names than the bytes hold, up to the largest compact, is refused BAD_BYTES and does not hang", () => {
    const head = grant.slice(0, grant.length - 16);
    const huge = [[0xfe, 0xff, 0xff, 0xff], [0x03, 0xff, 0xff, 0xff, 0xff], [0xff, ...new Array(67).fill(0xff)]];
    for (const c of huge) expect(codeOf(() => readOwnerCall(RUNTIME_ID, Uint8Array.of(...head, ...c, 0x38, ...new TextEncoder().encode("ComputeChannel"))))).toBe("BAD_BYTES");
    for (const l of huge) expect(codeOf(() => readOwnerCall(RUNTIME_ID, Uint8Array.of(...head, 0x04, ...l)))).toBe("BAD_BYTES");
  });
});

describe("review P5a, attack 4 (P2): the allow list is exactly ComputeChannel", () => {
  const te = (s: string) => new TextEncoder().encode(s);
  const lists: [string, Uint8Array[]][] = [
    ["lower case", [te("computechannel")]],
    ["upper case", [te("COMPUTECHANNEL")]],
    ["one letter changed case", [te("Computechannel")]],
    ["a space after", [te("ComputeChannel ")]],
    ["a space before", [te(" ComputeChannel")]],
    ["a NUL after", [te("ComputeChannel\0")]],
    ["a NUL before", [te("\0ComputeChannel")]],
    ["one letter short", [te("ComputeChanne")]],
    ["one letter long", [te("ComputeChannels")]],
    ["twice", [te("ComputeChannel"), te("ComputeChannel")]],
    ["with another", [te("ComputeChannel"), te("Balances")]],
    ["another first", [te("Balances"), te("ComputeChannel")]],
    ["an empty name", [new Uint8Array(0)]],
    ["an empty name and the name", [te("ComputeChannel"), new Uint8Array(0)]],
    ["an empty list", []],
    ["sixteen names", Array.from({ length: 16 }, () => te("ComputeChannel"))],
    ["seventeen names", Array.from({ length: 17 }, () => te("ComputeChannel"))],
    ["not UTF-8", [Uint8Array.of(0xff, 0xfe, 0x43)]],
    ["a lone surrogate in WTF-8", [Uint8Array.of(...te("ComputeChanne"), 0xed, 0xa0, 0x80)]],
    ["an overlong l", [Uint8Array.of(...te("ComputeChanne"), 0xc1, 0xac)]],
    ["a BOM before", [Uint8Array.of(0xef, 0xbb, 0xbf, ...te("ComputeChannel"))]],
    ["a fullwidth C", [te("ＣomputeChannel")]],
    ["a Cyrillic o", [te("CоmputeChannel")]],
    ["the pallet of the outer call", [te("FlopSessionKeys")]],
    ["the B1 nine names", [te("Utility"), te("Proxy"), te("Multisig"), te("Sudo"), te("Scheduler"), te("EmergencyOverride"), te("FlopSessionKeys"), te("System"), te("computechannel")]],
  ];

  it("HOLDS: the reader refuses every look alike list, CALL_NOT_ALLOWED, and so do the words", () => {
    for (const [, list] of lists) {
      const b = mine("create_session", G, list);
      expect(codeOf(() => readOwnerCall(RUNTIME_ID, b))).toBe("CALL_NOT_ALLOWED");
      expect(codeOf(() => describeOwnerCall(RUNTIME_ID, b))).toBe("CALL_NOT_ALLOWED");
    }
    expect(codeOf(() => readOwnerCall(RUNTIME_ID, unhex(stepOf("B1").call)))).toBe("CALL_NOT_ALLOWED");
  });

  it("HOLDS: no field name of the input brings a list in: each is refused BAD_INPUT, and so is a list by a Proxy that hides it from the keys", () => {
    const L = [te("ComputeChannel"), te("Balances")];
    const base = { runtime: RUNTIME_ID, call: "create_session", ...G };
    for (const k of ["allowed_pallets", "allowedPallets", "allowed", "pallets", "allow", "allowed_pallet", "allowed_pallets ", "Allowed_pallets", "list", "__proto__x"]) {
      expect(codeOf(() => encodeOwnerCall({ ...base, [k]: L } as never))).toBe("BAD_INPUT");
    }
    // A Proxy whose keys omit the list but whose get and descriptor traps would give it: the bytes are A2's.
    const p = new Proxy({ ...base, allowed_pallets: L }, { ownKeys: (t) => Reflect.ownKeys(t).filter((k) => k !== "allowed_pallets") });
    expect(hex(encodeOwnerCall(p as never))).toBe(A2.call);
    // An inherited list is not an own field: the bytes are A2's.
    const inh = Object.assign(Object.create({ allowed_pallets: L }), base);
    expect(hex(encodeOwnerCall(inh))).toBe(A2.call);
    // A symbol keyed list is not a field: the bytes are A2's.
    expect(hex(encodeOwnerCall({ ...base, [Symbol("allowed_pallets")]: L } as never))).toBe(A2.call);
  });

  it("HOLDS (was DEFECT RP5A-1): the allow list's bytes are fixed when the module loads, so a change of the global TextEncoder after load changes neither what the encoder writes nor what the reader accepts", () => {
    const proto = TextEncoder.prototype;
    const real = proto.encode;
    let bytes: Uint8Array | null = null;
    let readBack: string | null = null;
    let readsWritten: string | null = "not run";
    let readsOther: string | null = "not run";
    try {
      Object.defineProperty(proto, "encode", {
        configurable: true,
        writable: true,
        value(this: TextEncoder, s?: string) {
          return real.call(this, s === "ComputeChannel" ? "Balances" : s);
        },
      });
      try {
        bytes = encodeOwnerCall({ runtime: RUNTIME_ID, call: "create_session", ...G });
        readBack = codeOf(() => readOwnerCall(RUNTIME_ID, unhex(A2.call)));
        const w = bytes;
        readsWritten = codeOf(() => readOwnerCall(RUNTIME_ID, w));
        const other = mine("create_session", G, [new TextEncoder().encode("Balances")]);
        readsOther = codeOf(() => readOwnerCall(RUNTIME_ID, other));
      } catch {
        bytes = null;
      }
    } finally {
      Object.defineProperty(proto, "encode", { configurable: true, writable: true, value: real });
    }
    // The bytes are fixed at load: the encoder writes A2's bytes under the patched encoder, the real A2 grant still
    // reads, the grant it wrote reads (null, no refusal), and a grant whose list is [Balances] is refused.
    expect({ bytes: bytes === null ? null : hex(bytes), readBack, readsWritten, readsOther }).toEqual({ bytes: A2.call, readBack: null, readsWritten: null, readsOther: "CALL_NOT_ALLOWED" });
  });
});

describe("review P5a, attack 7 (P4): words from bytes", () => {
  it("HOLDS: the words of A2 hold the event's values, each cap worded as amountText words it, the duration in blocks, the one name", () => {
    const w = describeOwnerCall(RUNTIME_ID, unhex(A2.call));
    expect(w).toContain(`delegate ${hex(G.delegate)}`);
    expect(w).toContain(`spending_cap ${amountText(G.spending_cap)}`);
    expect(w).toContain(`per_tx_limit ${amountText(G.per_tx_limit)}`);
    expect(w).toContain(`daily_cap ${amountText(G.daily_cap)}`);
    expect(w).toContain(`duration_blocks ${G.duration_blocks} blocks`);
    expect(w).toContain("allowed_pallets [ComputeChannel]");
    expect(w.startsWith("FlopSessionKeys.create_session")).toBe(true);
    const r = describeOwnerCall(RUNTIME_ID, unhex(stepOf("A10").call));
    expect(r).toBe(`FlopSessionKeys.revoke_session, a call of the session's owner, call bytes only and not signed here: delegate ${ev(stepOf("A10"), "SessionRevoked").delegate}`);
  });

  it("HOLDS: no two of the readable one bit flips of A2 and A10 give the same words, and none gives the words of the base", () => {
    const seen = new Map<string, string>();
    for (const base of [unhex(A2.call), unhex(stepOf("A10").call)]) {
      seen.set(describeOwnerCall(RUNTIME_ID, base), hex(base));
      for (let bit = 0; bit < base.length * 8; bit++) {
        const y = Uint8Array.from(base);
        y[bit >> 3] ^= 1 << (bit & 7);
        let w: string;
        try {
          w = describeOwnerCall(RUNTIME_ID, y);
        } catch {
          continue;
        }
        expect(seen.get(w)).toBeUndefined();
        seen.set(w, hex(y));
      }
    }
    expect(seen.size).toBeGreaterThan(300);
  });

  it("HOLDS: the duration's words name the runtime's constant at the edge: MAX reads, MAX + 1 and 0 are refused OUT_OF_RANGE", () => {
    expect(sessionConstants(RUNTIME_ID).maxSessionDuration).toBe(MAX);
    expect(describeOwnerCall(RUNTIME_ID, mine("create_session", { ...G, duration_blocks: MAX }))).toContain(`duration_blocks ${MAX} blocks`);
    expect(codeOf(() => describeOwnerCall(RUNTIME_ID, mine("create_session", { ...G, duration_blocks: MAX + 1 })))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => describeOwnerCall(RUNTIME_ID, mine("create_session", { ...G, duration_blocks: 0 })))).toBe("OUT_OF_RANGE");
    expect(codeOf(() => describeOwnerCall(RUNTIME_ID, mine("create_session", { ...G, duration_blocks: 2 ** 32 - 1 })))).toBe("OUT_OF_RANGE");
  });
});
