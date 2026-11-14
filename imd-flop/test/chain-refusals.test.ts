/**
 * P3, rules E3, E4, E5, E8, E10 and E1, E13: every refusal of the chain encoder is a typed error with a
 * code, thrown before the sign function is called (except SIGNATURE_INVALID, which checks what it gave);
 * the strict reader refuses bytes it does not know; a table entry of another shape is refused; the module
 * is pure and no command uses it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { INNER_NAMES, type InnerCall } from "../src/chain/calls.js";
import { ChainEncodeError } from "../src/chain/errors.js";
import { encodeSessionCall, signSessionCall, type ExtrinsicInput } from "../src/chain/extrinsic.js";
import { readCall, readExtrinsic } from "../src/chain/reader.js";
import { compact, concat } from "../src/chain/scale.js";
import type { Runtime } from "../src/chain/table.js";
import { EXIT } from "../src/errors.js";
import { filled, OWNER, PKG, RT, RUNTIME_ID, sampleInner, testDevice, U128_MAX, U32_MAX, U64_MAX, unhex } from "./lib/chain-fixtures.js";

const S = sampleInner();
const BIRTH = { number: 3552594, hash: unhex("0xa85d1dcb67ae73c8c910634c75c043e62f83cf06dd4a90bbb5abe19c8674d08e") };

function input(over: Partial<Record<keyof ExtrinsicInput, unknown>> = {}, device = testDevice()) {
  return { device, input: { runtime: RUNTIME_ID, owner: OWNER, inner: S.force_open, sessionNonce: 1n, accountNonce: 4, birth: BIRTH, signer: device, ...over } as ExtrinsicInput };
}

function codeOf(f: () => unknown): string | null {
  try {
    f();
  } catch (e) {
    return e instanceof ChainEncodeError ? e.refusal : `not a ChainEncodeError: ${String(e)}`;
  }
  return null;
}

/** The input is refused with `code`, and the sign function was never called. */
function refusedBeforeSigning(over: Partial<Record<keyof ExtrinsicInput, unknown>>, code: string) {
  const { device, input: i } = input(over);
  expect(codeOf(() => signSessionCall(i))).toBe(code);
  expect(device.calls).toHaveLength(0);
}

const withInner = (base: InnerCall, change: Record<string, unknown>) => ({ inner: { ...base, ...change } });

describe("E10: each refusal has its code and comes before any signature", () => {
  it("the error is a CliError with the rule exit and a code", () => {
    const { input: i } = input({ runtime: { ...RUNTIME_ID, specVersion: 1014014 } });
    try {
      signSessionCall(i);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ChainEncodeError);
      expect((e as ChainEncodeError).refusal).toBe("RUNTIME_UNKNOWN");
      expect((e as ChainEncodeError).code).toBe(EXIT.REFUSED_RULE);
    }
  });

  it("RUNTIME_UNKNOWN: a runtime not in the table by any one of its four names", () => {
    refusedBeforeSigning({ runtime: { ...RUNTIME_ID, specVersion: 1014014 } }, "RUNTIME_UNKNOWN");
    refusedBeforeSigning({ runtime: { ...RUNTIME_ID, transactionVersion: 3 } }, "RUNTIME_UNKNOWN");
    refusedBeforeSigning({ runtime: { ...RUNTIME_ID, specName: "other-runtime" } }, "RUNTIME_UNKNOWN");
    refusedBeforeSigning({ runtime: { ...RUNTIME_ID, genesisHash: "0x" + "00".repeat(32) } }, "RUNTIME_UNKNOWN");
    refusedBeforeSigning({ runtime: { ...RUNTIME_ID, genesisHash: RUNTIME_ID.genesisHash.toUpperCase() } }, "RUNTIME_UNKNOWN");
    refusedBeforeSigning({ runtime: undefined }, "RUNTIME_UNKNOWN");
  });

  it("WRONG_LENGTH: a 32 byte value of another length", () => {
    refusedBeforeSigning({ owner: filled(1).slice(0, 31) }, "WRONG_LENGTH");
    refusedBeforeSigning(withInner(S.timeout, { channel_id: new Uint8Array(33) }), "WRONG_LENGTH");
    refusedBeforeSigning(withInner(S.force_open, { miner: new Uint8Array(0) }), "WRONG_LENGTH");
    refusedBeforeSigning({ birth: { number: 1, hash: new Uint8Array(31) } }, "WRONG_LENGTH");
    const device = testDevice();
    refusedBeforeSigning({ signer: { publicKey: device.publicKey.slice(1), sign: device.sign } }, "WRONG_LENGTH");
  });

  it("OUT_OF_RANGE: an amount, a u64, a u32, a nonce or a birth out of its range", () => {
    refusedBeforeSigning(withInner(S.force_open, { escrow: U128_MAX + 1n }), "OUT_OF_RANGE");
    refusedBeforeSigning(withInner(S.top_up_escrow, { additional: -1n }), "OUT_OF_RANGE");
    refusedBeforeSigning(withInner(S.open_channel, { nonce: U64_MAX + 1n }), "OUT_OF_RANGE");
    refusedBeforeSigning(withInner(S.force_open, { sla: { ...(S.force_open as { sla: object }).sla, max_turns: U32_MAX + 1 } }), "OUT_OF_RANGE");
    refusedBeforeSigning(withInner(S.force_open, { sla: { ...(S.force_open as { sla: object }).sla, max_duration: -1 } }), "OUT_OF_RANGE");
    refusedBeforeSigning({ sessionNonce: U64_MAX + 1n }, "OUT_OF_RANGE");
    refusedBeforeSigning({ sessionNonce: -1n }, "OUT_OF_RANGE");
    refusedBeforeSigning({ accountNonce: U32_MAX + 1 }, "OUT_OF_RANGE");
    refusedBeforeSigning({ accountNonce: -1 }, "OUT_OF_RANGE");
    refusedBeforeSigning({ birth: { number: -1, hash: BIRTH.hash } }, "OUT_OF_RANGE");
    refusedBeforeSigning({ birth: { number: U32_MAX - 62, hash: BIRTH.hash } }, "OUT_OF_RANGE");
    refusedBeforeSigning({ birth: { number: 1.5, hash: BIRTH.hash } }, "OUT_OF_RANGE");
  });

  it("ENUM_UNKNOWN: an enum name the table does not have", () => {
    refusedBeforeSigning(withInner(S.force_open, { precision: "bf16" }), "ENUM_UNKNOWN");
    refusedBeforeSigning(withInner(S.open_channel, { precision: "FP8" }), "ENUM_UNKNOWN");
    refusedBeforeSigning(withInner(S.open_channel, { settlement_class: "Premium" }), "ENUM_UNKNOWN");
  });

  it("CALL_NOT_ALLOWED: an inner call not among the five", () => {
    for (const call of ["force_settle", "finalize", "settle", "remark", "transfer_keep_alive", "create_session", "__proto__", "toString", undefined]) {
      refusedBeforeSigning({ inner: { call, channel_id: filled(1) } }, "CALL_NOT_ALLOWED");
      expect(codeOf(() => encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: { call, channel_id: filled(1) } as unknown as InnerCall, sessionNonce: 0n }))).toBe("CALL_NOT_ALLOWED");
    }
  });

  it("SIGNATURE_INVALID: a signature by another key, over another message, or not 64 bytes", () => {
    const other = ed25519.utils.randomSecretKey();
    const device = testDevice();
    const cases: ((m: Uint8Array) => Uint8Array)[] = [
      (m) => ed25519.sign(m, other),
      (m) => device.sign(concat(m, Uint8Array.of(0))),
      (m) => device.sign(m).slice(0, 63),
      () => new Uint8Array(64),
      () => "signature" as unknown as Uint8Array,
    ];
    for (const sign of cases) {
      const { input: i } = input({ signer: { publicKey: device.publicKey, sign } });
      expect(codeOf(() => signSessionCall(i))).toBe("SIGNATURE_INVALID");
    }
  });
});

describe("E4: typed inputs, no free bytes and no number for an amount", () => {
  it("BAD_INPUT: an amount as a number or a string, bytes as hex, a u32 as a bigint, a nonce as a number", () => {
    refusedBeforeSigning(withInner(S.force_open, { escrow: 10000000000000000 }), "BAD_INPUT");
    refusedBeforeSigning(withInner(S.top_up_escrow, { additional: "5" }), "BAD_INPUT");
    refusedBeforeSigning(withInner(S.timeout, { channel_id: "0x" + "11".repeat(32) }), "BAD_INPUT");
    refusedBeforeSigning(withInner(S.timeout, { channel_id: Array.from(filled(1)) }), "BAD_INPUT");
    refusedBeforeSigning(withInner(S.force_open, { sla: { max_turns: 1n, max_duration: 1, reattest_every: 1 } }), "BAD_INPUT");
    refusedBeforeSigning(withInner(S.force_open, { nonce: 5 }), "BAD_INPUT");
    refusedBeforeSigning({ sessionNonce: 0 }, "BAD_INPUT");
    refusedBeforeSigning({ accountNonce: 1n }, "BAD_INPUT");
  });

  it("BAD_INPUT: a field missing or one the table does not have, in the call, the sla or the input", () => {
    const { escrow: _e, ...noEscrow } = S.force_open as Record<string, unknown>;
    refusedBeforeSigning({ inner: noEscrow }, "BAD_INPUT");
    refusedBeforeSigning(withInner(S.timeout, { data: filled(2) }), "BAD_INPUT");
    refusedBeforeSigning(withInner(S.force_open, { enclave_key: filled(3) }), "BAD_INPUT");
    refusedBeforeSigning(withInner(S.force_open, { sla: { max_turns: 1, max_duration: 1 } }), "BAD_INPUT");
    refusedBeforeSigning(withInner(S.force_open, { sla: { max_turns: 1, max_duration: 1, reattest_every: 1, extra: 1 } }), "BAD_INPUT");
    refusedBeforeSigning({ inner: null }, "CALL_NOT_ALLOWED");
  });
});

describe("E5 and E7: the spend is computed and the era is mortal; neither can be passed", () => {
  const expected: Record<InnerCall["call"], bigint> = {
    open_channel: (S.open_channel as { escrow: bigint }).escrow,
    top_up_escrow: (S.top_up_escrow as { additional: bigint }).additional,
    timeout: 0n,
    force_open: (S.force_open as { escrow: bigint }).escrow,
    expire_force_open: 0n,
  };
  for (const name of INNER_NAMES) {
    it(`${name}: the declared spend is ${expected[name]} raw, what the call moves`, () => {
      const { input: i } = input({ inner: S[name] });
      expect(signSessionCall(i).fields.spend).toBe(expected[name]);
    });
  }

  it("a spend, an era, a tip or any other key passed with the input is refused, before signing", () => {
    refusedBeforeSigning({ spend: 0n } as never, "BAD_INPUT");
    refusedBeforeSigning({ spend_amount: 0n } as never, "BAD_INPUT");
    refusedBeforeSigning({ era: "immortal" } as never, "BAD_INPUT");
    refusedBeforeSigning({ tip: 0n } as never, "BAD_INPUT");
    refusedBeforeSigning({ birth: { ...BIRTH, period: 0 } }, "BAD_INPUT");
    refusedBeforeSigning(withInner(S.force_open, { spend_amount: 0n }), "BAD_INPUT");
    expect(codeOf(() => encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n, spend: 0n } as never))).toBe("BAD_INPUT");
  });

  it("E3: the input type allows only the five calls and bigint amounts (tsc)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chain-type-"));
    const file = join(dir, "t.ts");
    const calls = join(PKG, "src", "chain", "calls.js");
    const head = `import type { InnerCall } from ${JSON.stringify(calls)};\n`;
    const tsc = join(PKG, "node_modules", ".bin", "tsc");
    const run = (body: string) => {
      writeFileSync(file, head + body + "\n");
      try {
        execFileSync(tsc, ["--ignoreConfig", "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2023", "--skipLibCheck", "--types", "node", file], { cwd: PKG, stdio: "pipe" });
        return "ok";
      } catch (e) {
        return String((e as { stdout?: Buffer }).stdout ?? e);
      }
    };
    expect(run(`export const a: InnerCall = { call: "timeout", channel_id: new Uint8Array(32) };`)).toBe("ok");
    expect(run(`export const a: InnerCall = { call: "force_settle", channel_id: new Uint8Array(32) };`)).toContain("force_settle");
    expect(run(`export const a: InnerCall = { call: "top_up_escrow", channel_id: new Uint8Array(32), additional: 5 };`)).toContain("TS2322");
    expect(run(`export const a: InnerCall = { call: "timeout", channel_id: "0x00" };`)).toContain("TS2322");
  }, 60000);
});

describe("the strict reader refuses bytes it does not know", () => {
  const device = testDevice();
  const signed = signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.force_open, sessionNonce: 1n, accountNonce: 4, birth: BIRTH, signer: device });
  const call = signed.call;
  const patch = (b: Uint8Array, at: number, v: number) => {
    const c = Uint8Array.from(b);
    c[at] = v;
    return c;
  };
  // force_open: 2 index bytes, 4 x 32 bytes, precision at 130 of the inner call; the inner call starts at 34.
  const PRECISION_AT = 34 + 2 + 128;

  it("call bytes: left over, ending early, another outer call, another inner call, an unknown enum index", () => {
    expect(codeOf(() => readCall(RT, concat(call, Uint8Array.of(0))))).toBe("BAD_BYTES");
    expect(codeOf(() => readCall(RT, call.slice(0, -1)))).toBe("BAD_BYTES");
    expect(codeOf(() => readCall(RT, patch(call, 1, 0)))).toBe("CALL_NOT_ALLOWED");
    expect(codeOf(() => readCall(RT, patch(call, 0, 4)))).toBe("CALL_NOT_ALLOWED");
    expect(codeOf(() => readCall(RT, patch(call, 35, 3)))).toBe("CALL_NOT_ALLOWED"); // force_settle
    expect(codeOf(() => readCall(RT, patch(call, 35, 4)))).toBe("CALL_NOT_ALLOWED"); // finalize
    expect(codeOf(() => readCall(RT, patch(call, 34, 0)))).toBe("CALL_NOT_ALLOWED"); // System
    expect(codeOf(() => readCall(RT, patch(call, PRECISION_AT, 6)))).toBe("ENUM_UNKNOWN");
    expect(readCall(RT, patch(call, PRECISION_AT, 5)).inner).toMatchObject({ precision: "Mixed" });
  });

  it("call bytes: a declared spend other than what the call moves", () => {
    const spendAt = call.length - 8 - 16;
    expect(codeOf(() => readCall(RT, patch(call, spendAt, call[spendAt] ^ 1)))).toBe("SPEND_MISMATCH");
    const timeout = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n });
    expect(codeOf(() => readCall(RT, patch(timeout, timeout.length - 24, 1)))).toBe("SPEND_MISMATCH");
  });

  /** Rebuilds a signed extrinsic from its parts, with one part changed. */
  function rebuild(change: Partial<Record<"version" | "addr" | "sigKind" | "era" | "nonce" | "tip" | "mode" | "tail", Uint8Array>>) {
    const x = readExtrinsic(RT, signed.extrinsic, BIRTH);
    const parts = {
      version: Uint8Array.of(0x84),
      addr: Uint8Array.of(0),
      pub: x.signer,
      sigKind: Uint8Array.of(0),
      sig: x.signature,
      era: Uint8Array.of(0x05 | ((BIRTH.number % 64) << 4) & 0xff, ((BIRTH.number % 64) << 4) >> 8),
      nonce: compact(4n),
      tip: compact(0n),
      mode: Uint8Array.of(0),
      call: x.callBytes,
      tail: new Uint8Array(0),
      ...change,
    };
    const body = concat(parts.version, parts.addr, parts.pub, parts.sigKind, parts.sig, parts.era, parts.nonce, parts.tip, parts.mode, parts.call, parts.tail);
    return concat(compact(BigInt(body.length)), body);
  }

  it("extrinsic bytes: the rebuild of the parts is the encoder's own bytes (control)", () => {
    expect(rebuild({})).toEqual(signed.extrinsic);
  });

  it("extrinsic bytes: unsigned or another version, another address or signature kind", () => {
    expect(codeOf(() => readExtrinsic(RT, rebuild({ version: Uint8Array.of(0x04) }), BIRTH))).toBe("BAD_BYTES");
    expect(codeOf(() => readExtrinsic(RT, rebuild({ version: Uint8Array.of(0x85) }), BIRTH))).toBe("BAD_BYTES");
    expect(codeOf(() => readExtrinsic(RT, rebuild({ addr: Uint8Array.of(3) }), BIRTH))).toBe("BAD_BYTES");
    expect(codeOf(() => readExtrinsic(RT, rebuild({ sigKind: Uint8Array.of(1) }), BIRTH))).toBe("BAD_BYTES");
  });

  it("extrinsic bytes: an immortal era, a period other than 64, a phase at or above its period", () => {
    expect(codeOf(() => readExtrinsic(RT, rebuild({ era: Uint8Array.of(0) }), BIRTH))).toBe("BAD_BYTES");
    expect(codeOf(() => readExtrinsic(RT, rebuild({ era: Uint8Array.of(0x04, 0x00) }), BIRTH))).toBe("BAD_BYTES"); // period 32
    expect(codeOf(() => readExtrinsic(RT, rebuild({ era: Uint8Array.of(0x06, 0x00) }), BIRTH))).toBe("BAD_BYTES"); // period 128
    expect(codeOf(() => readExtrinsic(RT, rebuild({ era: Uint8Array.of(0x05, 0x04) }), BIRTH))).toBe("BAD_BYTES"); // phase 64
    expect(codeOf(() => readExtrinsic(RT, rebuild({ era: Uint8Array.of(0xf5, 0x03) }), BIRTH))).toBe("BAD_BYTES"); // phase 63, not the birth's
  });

  it("extrinsic bytes: a birth whose phase is not the era's, or whose hash was not signed, is refused", () => {
    expect(readExtrinsic(RT, signed.extrinsic, BIRTH).birth.number).toBe(BIRTH.number);
    expect(codeOf(() => readExtrinsic(RT, signed.extrinsic, { number: BIRTH.number + 1, hash: BIRTH.hash }))).toBe("BAD_BYTES");
    expect(codeOf(() => readExtrinsic(RT, signed.extrinsic, { number: BIRTH.number, hash: new Uint8Array(32) }))).toBe("SIGNATURE_INVALID");
    const sig = Uint8Array.from(signed.extrinsic);
    sig[2 + 1 + 1 + 32 + 1] ^= 1;
    expect(codeOf(() => readExtrinsic(RT, sig, BIRTH))).toBe("SIGNATURE_INVALID");
  });

  it("extrinsic bytes: a tip, the metadata hash check on, a nonce above u32, a length prefix that lies, bytes left over", () => {
    expect(codeOf(() => readExtrinsic(RT, rebuild({ tip: compact(1n) }), BIRTH))).toBe("BAD_BYTES");
    expect(codeOf(() => readExtrinsic(RT, rebuild({ mode: Uint8Array.of(1) }), BIRTH))).toBe("BAD_BYTES");
    expect(codeOf(() => readExtrinsic(RT, rebuild({ mode: Uint8Array.of(2) }), BIRTH))).toBe("ENUM_UNKNOWN");
    expect(codeOf(() => readExtrinsic(RT, rebuild({ nonce: compact(1n << 32n) }), BIRTH))).toBe("BAD_BYTES");
    expect(codeOf(() => readExtrinsic(RT, rebuild({ nonce: Uint8Array.of(0x11, 0x00) }), BIRTH))).toBe("BAD_BYTES"); // 4 not in canonical form
    expect(codeOf(() => readExtrinsic(RT, rebuild({ tail: Uint8Array.of(0) }), BIRTH))).toBe("BAD_BYTES");
    expect(codeOf(() => readExtrinsic(RT, signed.extrinsic.slice(0, -1), BIRTH))).toBe("BAD_BYTES");
    const lying = Uint8Array.from(signed.extrinsic);
    lying[0] ^= 4;
    expect(codeOf(() => readExtrinsic(RT, lying, BIRTH))).toBe("BAD_BYTES");
  });
});

describe("a table entry of a shape the encoder does not write is refused", () => {
  // The shape check has no export: it is reached only through the public functions, with the table of
  // runtimes.ts. So each case replaces that module with one forged entry, in a fresh module graph.
  const copy = () => structuredClone(RT) as unknown as { -readonly [K in keyof Runtime]: any };
  async function refusedShape(rt: unknown) {
    vi.resetModules();
    vi.doMock("../src/chain/runtimes.js", () => ({ RUNTIMES: [rt] }));
    try {
      const x = await import("../src/chain/extrinsic.js");
      const r = await import("../src/chain/reader.js");
      const e = await import("../src/chain/errors.js");
      const freshCode = (f: () => unknown) => {
        try {
          f();
        } catch (err) {
          return err instanceof e.ChainEncodeError ? err.refusal : `not a ChainEncodeError: ${String(err)}`;
        }
        return null;
      };
      const call = encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n });
      expect(freshCode(() => x.encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n }))).toBe("RUNTIME_UNKNOWN");
      expect(freshCode(() => r.readCall(RUNTIME_ID, call))).toBe("RUNTIME_UNKNOWN");
    } finally {
      vi.doUnmock("../src/chain/runtimes.js");
      vi.resetModules();
    }
  }

  it("the committed entry is accepted, also through the mock (control)", async () => {
    vi.resetModules();
    vi.doMock("../src/chain/runtimes.js", () => ({ RUNTIMES: [copy()] }));
    try {
      const x = await import("../src/chain/extrinsic.js");
      expect(x.encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n })).toEqual(encodeSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: S.timeout, sessionNonce: 0n }));
    } finally {
      vi.doUnmock("../src/chain/runtimes.js");
      vi.resetModules();
    }
  });

  it("an extrinsic version other than 4", async () => {
    const rt = copy();
    rt.extrinsicVersion = 5;
    await refusedShape(rt);
  });

  it("an unknown, a doubled or a missing signed extension, or one whose types changed", async () => {
    let rt = copy();
    rt.signedExtensions.push({ identifier: "CheckSomethingNew", extra: { kind: "unit" }, additionalSigned: { kind: "unit" } });
    await refusedShape(rt);
    rt = copy();
    rt.signedExtensions.push(rt.signedExtensions[0]);
    await refusedShape(rt);
    for (const id of ["CheckSpecVersion", "CheckTxVersion", "CheckGenesis", "CheckMortality", "CheckNonce", "ChargeTransactionPayment", "CheckMetadataHash"]) {
      rt = copy();
      rt.signedExtensions = rt.signedExtensions.filter((e: { identifier: string }) => e.identifier !== id);
      await refusedShape(rt);
    }
    rt = copy();
    rt.signedExtensions.find((e: { identifier: string }) => e.identifier === "CheckNonce").extra = { kind: "compact", of: "u64" };
    await refusedShape(rt);
    rt = copy();
    rt.signedExtensions.find((e: { identifier: string }) => e.identifier === "CheckMetadataHash").additionalSigned = { kind: "bytes32" };
    await refusedShape(rt);
  });

  it("an outer call with another field, an inner call missing, a spend field not an amount, two calls on one index", async () => {
    let rt = copy();
    rt.calls[0].fields.push({ name: "memo", type: { kind: "u32" } });
    await refusedShape(rt);
    rt = copy();
    rt.calls[0].fields[2].type = { kind: "u64" };
    await refusedShape(rt);
    rt = copy();
    rt.calls = rt.calls.filter((c: { name: string }) => c.name !== "top_up_escrow");
    await refusedShape(rt);
    rt = copy();
    rt.calls.find((c: { name: string }) => c.name === "force_open").fields.find((f: { name: string }) => f.name === "escrow").type = { kind: "u64" };
    await refusedShape(rt);
    rt = copy();
    rt.calls.find((c: { name: string }) => c.name === "timeout").callIndex = rt.calls.find((c: { name: string }) => c.name === "expire_force_open").callIndex;
    await refusedShape(rt);
    rt = copy();
    rt.calls.find((c: { name: string }) => c.name === "timeout").fields.push({ name: "call", type: { kind: "call" } });
    await refusedShape(rt);
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("E1 and E13: the encoder is pure and not wired", () => {
  const chain = files(join(PKG, "src", "chain"));

  it("src/chain holds only the encoder and what it owns", () => {
    expect(chain.map((f) => relative(join(PKG, "src", "chain"), f)).sort()).toEqual([
      "calls.ts",
      "describe.ts",
      "era.ts",
      "errors.ts",
      "extrinsic.ts",
      "fields.ts",
      "payload.ts",
      "reader.ts",
      "runtimes.ts",
      "scale.ts",
      "shape.ts",
      "table.ts",
    ]);
  });

  it("no file under src/chain reads a file, the network, the clock, the process or randomness", () => {
    const banned = /\bnode:|from "fs"|readFileSync|\bfetch\b|WebSocket|\bDate\b|performance\.|Math\.random|randomBytes|\bprocess\.|setTimeout|setInterval|\bBuffer\b/;
    const found = chain.filter((f) => banned.test(readFileSync(f, "utf8"))).map((f) => relative(PKG, f));
    expect(found).toEqual([]);
  });

  it("the scan's pattern finds each banned form (control)", () => {
    const banned = /\bnode:|from "fs"|readFileSync|\bfetch\b|WebSocket|\bDate\b|performance\.|Math\.random|randomBytes|\bprocess\.|setTimeout|setInterval|\bBuffer\b/;
    for (const s of [`import x from "node:fs"`, "readFileSync(p)", "await fetch(u)", "new WebSocket(u)", "Date.now()", "Math.random()", "process.env.X", "Buffer.from(x)"]) expect(banned.test(s)).toBe(true);
  });

  it("no file outside src/chain imports it", () => {
    const outside = files(join(PKG, "src")).filter((f) => !f.startsWith(join(PKG, "src", "chain")));
    const found = outside.filter((f) => /["'`][^"'`]*chain\/[^"'`]*["'`]/.test(readFileSync(f, "utf8"))).map((f) => relative(PKG, f));
    expect(found).toEqual([]);
  });
});
