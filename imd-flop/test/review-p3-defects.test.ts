/**
 * Review of P3 (the chain encoder), reviewer's own tests. Each test in this file states a line of the
 * promise (P1 to P15 of the review brief) and fails on 165432c when the encoder breaks it.
 * Test keys are made in memory by testDevice() and never written.
 *
 * The lead ruled in brief 2026-11-12-fix-p3-chain-extrinsic (H11) that the two tests of findings 7 and 8
 * (P2/P8 describeCall and P2/P9 readCall) are rewritten by the builder to hold the new guarantee of H5 and
 * H6: no exported function takes a caller's data for words, and none takes a caller's Runtime. Every other
 * test body here is the reviewer's, unchanged.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import type { InnerCall } from "../src/chain/calls.js";
import { describeCall } from "../src/chain/describe.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import { encodeSessionCall, signSessionCall, type ExtrinsicInput } from "../src/chain/extrinsic.js";
import { readCall } from "../src/chain/reader.js";
import type { Runtime } from "../src/chain/table.js";
import { hex, OWNER, refCall, RT, RUNTIME_ID, sampleInner, testDevice, unhex } from "./lib/chain-fixtures.js";

const S = sampleInner();
const BIRTH_HASH = "0xa85d1dcb67ae73c8c910634c75c043e62f83cf06dd4a90bbb5abe19c8674d08e";
const birth = () => ({ number: 3552594, hash: unhex(BIRTH_HASH) });

function codeOf(f: () => unknown): string | null {
  try {
    f();
  } catch (e) {
    return e instanceof ChainEncodeError ? e.refusal : `not a ChainEncodeError: ${String(e)}`;
  }
  return null;
}

/** The declared spend and the moved amount of call bytes, read by the reference decoder, not by src/chain. */
function refSpend(bytes: Uint8Array): { declared: bigint; moves: bigint; inner: string } {
  const d = refCall.dec(bytes).value.value;
  const inner = d.call.value;
  const moves = inner.type === "top_up_escrow" ? inner.value.additional : inner.type === "open_channel" || inner.type === "force_open" ? inner.value.escrow : 0n;
  return { declared: d.spend_amount, moves, inner: inner.type };
}

/** A force_open whose escrow answers `first` on its first read and `later` after. */
function flipEscrow(first: bigint, later: bigint): InnerCall {
  let reads = 0;
  const o: Record<string, unknown> = { ...S.force_open };
  delete o.escrow;
  Object.defineProperty(o, "escrow", { enumerable: true, get: () => (reads++ === 0 ? first : later) });
  return o as unknown as InnerCall;
}

describe("P3: the declared spend always equals what the inner call moves", () => {
  it("P3 encodeSessionCall: an escrow getter that answers 1000 FLOP then 1 raw cannot make the declared spend 1 raw", () => {
    const big = 1000n * 10n ** 18n;
    let bytes: Uint8Array | null = null;
    const code = codeOf(() => (bytes = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: flipEscrow(big, 1n), sessionNonce: 1n })));
    if (code === null) {
      const s = refSpend(bytes!);
      expect({ declared: s.declared, moves: s.moves }).toEqual({ declared: s.moves, moves: s.moves });
    } else expect(code).not.toMatch(/^not a/);
  });

  it("P3 encodeSessionCall: a call name getter (force_open, then timeout) cannot make a force_open declare 0", () => {
    let reads = 0;
    const o: Record<string, unknown> = { ...S.force_open };
    delete o.call;
    Object.defineProperty(o, "call", { enumerable: true, get: () => (reads++ === 0 ? "force_open" : "timeout") });
    let bytes: Uint8Array | null = null;
    const code = codeOf(() => (bytes = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: o as unknown as InnerCall, sessionNonce: 1n })));
    if (code === null) {
      const s = refSpend(bytes!);
      expect(s.inner).toBe("force_open");
      expect(s.declared).toBe(s.moves);
    } else expect(code).not.toMatch(/^not a/);
  });

  it("P3 encodeSessionCall: an input whose inner getter answers two different calls cannot declare the spend of the second", () => {
    let reads = 0;
    const big = { ...S.open_channel, escrow: 5n * 10n ** 18n } as InnerCall;
    const small = { ...S.open_channel, escrow: 0n } as InnerCall;
    const input = { runtime: RUNTIME_ID, owner: OWNER, sessionNonce: 1n } as Record<string, unknown>;
    Object.defineProperty(input, "inner", { enumerable: true, get: () => (reads++ < 1 ? big : small) });
    let bytes: Uint8Array | null = null;
    const code = codeOf(() => (bytes = encodeSessionCall(input as never)));
    if (code === null) {
      const s = refSpend(bytes!);
      expect(s.declared).toBe(s.moves);
    } else expect(code).not.toMatch(/^not a/);
  });

  it("P3 encodeSessionCall: a Proxy over top_up_escrow that answers the amount differently on each read cannot lower the spend", () => {
    let reads = 0;
    const target = { ...S.top_up_escrow };
    const p = new Proxy(target, { get: (t, k) => (k === "additional" ? (reads++ === 0 ? 7n * 10n ** 18n : 0n) : Reflect.get(t, k)) });
    let bytes: Uint8Array | null = null;
    const code = codeOf(() => (bytes = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: p as InnerCall, sessionNonce: 1n })));
    if (code === null) {
      const s = refSpend(bytes!);
      expect(s.declared).toBe(s.moves);
    } else expect(code).not.toMatch(/^not a/);
  });
});

describe("P10: every refusal comes before any call of sign", () => {
  it("P10 signSessionCall: the changing escrow getter is refused before sign is called, not after", () => {
    const device = testDevice();
    const i = { runtime: RUNTIME_ID, owner: OWNER, inner: flipEscrow(10n ** 21n, 1n), sessionNonce: 1n, accountNonce: 0, birth: birth(), signer: device } as ExtrinsicInput;
    const code = codeOf(() => signSessionCall(i));
    expect(code).not.toBeNull();
    // The payload with an understated spend must never reach the device key.
    expect(device.calls).toHaveLength(0);
  });

  it("P10 signSessionCall: a 32 byte field whose length lies (33 real bytes) is refused before sign is called", () => {
    class Liar extends Uint8Array {
      override get length() {
        return 32;
      }
    }
    const device = testDevice();
    const miner = new Liar(33).fill(0x11);
    const i = { runtime: RUNTIME_ID, owner: OWNER, inner: { ...S.force_open, miner }, sessionNonce: 1n, accountNonce: 0, birth: birth(), signer: device } as ExtrinsicInput;
    codeOf(() => signSessionCall(i));
    expect(device.calls).toHaveLength(0);
  });
});

describe("P4: a 32 byte field is exactly 32 bytes", () => {
  it("P4 encodeSessionCall: a Uint8Array subclass that says length 32 but holds 33 bytes is refused or written as 32", () => {
    class Liar extends Uint8Array {
      override get length() {
        return 32;
      }
    }
    const channel_id = new Liar(33).fill(0x22);
    let bytes: Uint8Array | null = null;
    const code = codeOf(() => (bytes = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: { call: "timeout", channel_id }, sessionNonce: 1n })));
    if (code === null) {
      const honest = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: { call: "timeout", channel_id: new Uint8Array(32).fill(0x22) }, sessionNonce: 1n });
      expect(bytes!.length).toBe(honest.length);
    } else expect(code).not.toMatch(/^not a/);
  });
});

describe("P4: an input changed during sign or after the result cannot make the result say something else", () => {
  it("P4: the birth hash changed inside sign leaves the description naming the hash that was signed", () => {
    const device = testDevice();
    const b = birth();
    const signer = {
      publicKey: device.publicKey,
      sign(m: Uint8Array) {
        const sig = device.sign(m);
        b.hash.fill(0xee);
        return sig;
      },
    };
    const out = signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 1n, accountNonce: 0, birth: b, signer });
    // The payload holds BIRTH_HASH (verified: the signature checks against it). The words must say so.
    expect(out.description).toContain(BIRTH_HASH);
    expect(hex(out.fields.birth.hash)).toBe(BIRTH_HASH);
  });

  it("P4: changing the caller's birth hash after the result is returned does not change the result", () => {
    const device = testDevice();
    const b = birth();
    const out = signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 1n, accountNonce: 0, birth: b, signer: device });
    b.hash.fill(0);
    expect(hex(out.fields.birth.hash)).toBe(BIRTH_HASH);
  });

  it("P4: the public key swapped inside sign cannot make the result name another signer", () => {
    const device = testDevice();
    const other = ed25519.utils.randomSecretKey();
    const otherPub = ed25519.getPublicKey(other);
    const pk = Uint8Array.from(device.publicKey);
    const signer = {
      publicKey: pk,
      sign(m: Uint8Array) {
        pk.set(otherPub);
        return ed25519.sign(m, other);
      },
    };
    const original = Uint8Array.from(device.publicKey);
    const code = codeOf(() => {
      const out = signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 1n, accountNonce: 0, birth: birth(), signer });
      expect(hex(out.fields.signer)).toBe(hex(original));
    });
    expect(code === null || code === "SIGNATURE_INVALID").toBe(true);
  });
});

describe("P7: a signer that throws gets a typed refusal", () => {
  it("P7: a sign function that throws gives a ChainEncodeError, not its own error", () => {
    const device = testDevice();
    const signer = {
      publicKey: device.publicKey,
      sign(): Uint8Array {
        throw new Error("device unplugged");
      },
    };
    const code = codeOf(() => signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 1n, accountNonce: 0, birth: birth(), signer }));
    expect(code).not.toBeNull();
    expect(code).not.toMatch(/^not a/);
  });
});

describe("P2, P8, P9: no exported function describes or reads as allowed what the table does not allow", () => {
  it("P2/P8 describeCall (rewritten for H5): words come from bytes only; data whose spend is below the move is refused as data and as bytes", () => {
    const data = { owner: OWNER, inner: { ...S.force_open, escrow: 10n ** 21n } as InnerCall, spend: 1n, sessionNonce: 1n };
    // Data is not bytes: no exported function words it.
    expect(codeOf(() => describeCall(RUNTIME_ID, data as never))).toBe("BAD_INPUT");
    // The same call as bytes, with the spend lowered to 1 raw, is refused by the strict reader.
    const bytes = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: data.inner, sessionNonce: 1n });
    const low = Uint8Array.from(bytes);
    low.fill(0, low.length - 24, low.length - 8);
    low[low.length - 24] = 1;
    expect(refSpend(low).declared).toBe(1n);
    expect(codeOf(() => describeCall(RUNTIME_ID, low))).toBe("SPEND_MISMATCH");
    // And the words functions of describe.ts take bytes: each exported function's parameters are a runtime id and bytes.
    const text = readFileSync(join(import.meta.dirname, "..", "src", "chain", "describe.ts"), "utf8");
    const sigs = [...text.matchAll(/export function (\w+)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`);
    expect(sigs).toEqual([
      "amountText(raw: bigint)",
      "describeCall(runtime: RuntimeId, callBytes: Uint8Array)",
      "describeExtrinsic(runtime: RuntimeId, extrinsic: Uint8Array, birth: { readonly number: number; readonly hash: Uint8Array })",
    ]);
  });

  it("P2/P9 readCall (rewritten for H6): no exported function takes a Runtime; a forged one with the four names is read by the frozen table", () => {
    // A copy of the reviewed runtime in which "ComputeChannel" sits at Balances' index 4.
    const fake = JSON.parse(JSON.stringify(RT)) as Runtime & { calls: { pallet: string; palletIndex: number }[] };
    for (const c of fake.calls) if (c.pallet === "ComputeChannel") c.palletIndex = 4;
    const real = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 1n });
    const forged = Uint8Array.from(real);
    forged[2 + 32] = 4; // the inner pallet byte: Balances
    // The forged object is taken as names only: the frozen table's entry is used, and pallet 4 is refused.
    expect(codeOf(() => readCall(fake, forged))).toBe("CALL_NOT_ALLOWED");
    expect(codeOf(() => readCall({ ...fake, specVersion: fake.specVersion + 1 }, forged))).toBe("RUNTIME_UNKNOWN");
    // And no exported function of src/chain has a parameter typed Runtime or Reviewed.
    const dir = join(import.meta.dirname, "..", "src", "chain");
    const takes = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/export function (\w+)(?:<[^>]*>)?\(([^)]*)\)/g)].filter((m) => /:\s*(?:Runtime|Reviewed)\b/.test(m[2])).map((m) => `${f} ${m[1]}`));
    expect(takes).toEqual([]);
  });
});

describe("P9: the table cannot be changed at run time", () => {
  it("P9: a module that imports runtimes.ts before table.ts is evaluated can move ComputeChannel to Balances' index; the encoder must not follow", async () => {
    vi.resetModules();
    const fresh = await import("../src/chain/runtimes.js");
    const entry = fresh.RUNTIMES[0].calls.find((c) => c.pallet === "ComputeChannel" && c.name === "timeout") as { palletIndex: number };
    let changed = true;
    try {
      entry.palletIndex = 4;
    } catch {
      changed = false;
    }
    const x = await import("../src/chain/extrinsic.js");
    let bytes: Uint8Array | null = null;
    const code = codeOf(() => (bytes = x.encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 1n })));
    vi.resetModules();
    // The table must be frozen when it is first loaded, or the encoder must refuse; it must never write pallet 4.
    if (code === null) expect(bytes![2 + 32]).toBe(103);
    expect(changed && code === null && bytes![2 + 32] === 4).toBe(false);
  });
});
