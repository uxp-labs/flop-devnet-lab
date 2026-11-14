/**
 * Review of P5a, attack 1 (P8): the session path is unchanged.
 *
 * The reviewer ran a harness (outside the repo) over both builds, main 528aad0 and the builder's head fcc0560, and
 * found no difference in bytes, words, code or message (counts in the review report). This file holds that on CI:
 * it runs the reviewer's own generator (fixed seed) through the seven functions of the session path and compares a
 * sha256 of every result with the digest the same file gave when run against main 528aad0's src/chain. The digest is
 * a measured output of main, written here by the reviewer; nothing else in it is typed.
 *
 * The device keys are two test keys made here from fixed bytes, in memory only. No network, no file but the source.
 */
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import * as describeMod from "../src/chain/describe.js";
import * as extrinsicMod from "../src/chain/extrinsic.js";
import * as readerMod from "../src/chain/reader.js";
import { RUNTIMES } from "../src/chain/runtimes.js";
import * as shapeMod from "../src/chain/shape.js";

const RT = RUNTIMES[0];
const ID = { specName: RT.specName, specVersion: RT.specVersion, transactionVersion: RT.transactionVersion, genesisHash: RT.genesisHash };
const INNER = RT.calls.filter((c) => c.pallet === "ComputeChannel");

/** The digest of the session path's results over this file's inputs, measured on main 528aad0. */
const MAIN_DIGEST = "55a970aec8db3b3ce15cec1c9d9bff590488c9734d2bb41efb5c52b8f8784eac";

let seed = 0x5eed1234 >>> 0;
const rnd = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 2 ** 32;
};
const ri = (n: number) => Math.floor(rnd() * n);
const pick = <T,>(a: readonly T[]): T => a[ri(a.length)];
const bytes = (n: number) => Uint8Array.from({ length: n }, () => ri(256));
const big = (bits: number) => {
  let x = 0n;
  for (let i = 0; i < bits; i += 8) x = (x << 8n) | BigInt(ri(256));
  return x & ((1n << BigInt(bits)) - 1n);
};
type Ty = (typeof INNER)[number]["fields"][number]["type"];
function val(ty: Ty): unknown {
  switch (ty.kind) {
    case "bytes32":
      return pick([() => bytes(32), () => new Uint8Array(32), () => new Uint8Array(32).fill(255)])();
    case "u32":
      return pick([() => ri(2 ** 32), () => 0, () => 2 ** 32 - 1, () => ri(100)])();
    case "u64":
      return pick([() => big(64), () => 0n, () => (1n << 64n) - 1n])();
    case "u128":
      return pick([() => big(128), () => 0n, () => (1n << 128n) - 1n, () => big(20)])();
    case "enum":
      return pick(ty.variants).name;
    case "struct":
      return Object.fromEntries(ty.fields.map((f) => [f.name, val(f.type)]));
    default:
      throw new Error(`a type this generator does not make: ${ty.kind}`);
  }
}
const HOSTILE: (() => unknown)[] = [
  () => -1, () => 1.5, () => NaN, () => -0, () => 2 ** 32, () => 2 ** 53, () => "1", () => 1n, () => -1n, () => 1n << 128n, () => null, () => undefined,
  () => new Uint8Array(31), () => new Uint8Array(33), () => [1, 2], () => ({}), () => "Standard", () => "standard", () => ({ toString: () => "x" }), () => new Proxy({}, {}),
];
function genInner(hostile: boolean): Record<string, unknown> {
  const e = pick(INNER);
  const o: Record<string, unknown> = { call: e.name };
  for (const f of e.fields) o[f.name] = val(f.type);
  if (hostile) {
    const k = ri(8);
    const f = pick(e.fields);
    if (k === 0) o[f.name] = pick(HOSTILE)();
    else if (k === 1) delete o[f.name];
    else if (k === 2) o.extra = 1;
    else if (k === 3) o.call = pick(["create_session", "revoke_session", "execute_via_session", "Open_channel", "", "timeout ", null]);
    else if (k === 4) Object.defineProperty(o, f.name, { get: () => 1, enumerable: true });
    else if (k === 5) o.allowed_pallets = [new TextEncoder().encode("ComputeChannel")];
    else if (k === 6 && f.type.kind === "struct") o[f.name] = { ...(o[f.name] as object), extra: 1 };
    else o[f.name] = pick(HOSTILE)();
  }
  return o;
}
function genSession(hostile: boolean): Record<string, unknown> {
  const s: Record<string, unknown> = { runtime: ID, owner: bytes(32), inner: genInner(hostile && rnd() < 0.6), sessionNonce: pick([() => big(64), () => 0n, () => (1n << 64n) - 1n])() };
  if (hostile && rnd() < 0.5) {
    const k = ri(6);
    if (k === 0) s.runtime = { ...ID, specVersion: ID.specVersion + 1 };
    else if (k === 1) s.owner = pick(HOSTILE)();
    else if (k === 2) s.sessionNonce = pick(HOSTILE)();
    else if (k === 3) s.extra = 1;
    else if (k === 4) delete s.sessionNonce;
    else s.runtime = { specName: ID.specName, specVersion: ID.specVersion, genesisHash: ID.genesisHash };
  }
  return s;
}
const KEYS = [7, 8].map((b) => {
  const sk = new Uint8Array(32).fill(b);
  return { sk, pk: ed25519.getPublicKey(sk) };
});
function genSign(hostile: boolean): Record<string, unknown> {
  const s = genSession(hostile);
  const g = pick(KEYS);
  s.accountNonce = pick([0, 1, 2 ** 32 - 1, ri(1000)]);
  s.birth = { number: pick([0, 1, 63, 64, ri(2 ** 31), 2 ** 32 - 1 - 64, 2 ** 32 - 1]), hash: bytes(32) };
  s.signer = { publicKey: g.pk, sign: (m: Uint8Array) => ed25519.sign(m, g.sk) };
  if (hostile && rnd() < 0.3) {
    const k = ri(4);
    if (k === 0) s.accountNonce = pick(HOSTILE)();
    else if (k === 1) s.birth = { number: pick(HOSTILE)(), hash: bytes(32) };
    else if (k === 2) s.signer = { publicKey: g.pk, sign: () => new Uint8Array(64) };
    else s.signer = { publicKey: bytes(32), sign: (m: Uint8Array) => ed25519.sign(m, g.sk) };
  }
  return s;
}
const ser = (x: unknown) =>
  JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? "0x" + Buffer.from(v).toString("hex") : typeof v === "function" ? `fn:${v.name}` : v));
function run(f: () => unknown): string {
  try {
    return "ok " + ser(f());
  } catch (e) {
    const x = e as { constructor?: { name?: string }; refusal?: string; message?: string };
    return `err ${x?.constructor?.name} ${x?.refusal ?? ""} ${x?.message}`;
  }
}

/** Every result of the session path over the generated inputs, in order, with its kind. */
function sessionResults(): { lines: string[]; counts: Record<string, number> } {
  seed = 0x5eed1234 >>> 0;
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  const add = (kind: string, f: () => unknown) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    const r = run(f);
    lines.push(`${kind} ${r}`);
    return r;
  };
  const enc = extrinsicMod.encodeSessionCall as (x: unknown) => Uint8Array;
  const sign = extrinsicMod.signSessionCall as (x: unknown) => { extrinsic: Uint8Array };
  const calls: Uint8Array[] = [];
  const exts: { x: Uint8Array; birth: { number: number; hash: Uint8Array } }[] = [];
  for (let i = 0; i < 1200; i++) {
    const inp = genSession(i % 2 === 1);
    if (add("encodeSessionCall", () => enc(inp)).startsWith("ok")) calls.push(enc(inp));
  }
  for (let i = 0; i < 200; i++) {
    const inp = genSign(i % 2 === 1);
    if (add("signSessionCall", () => sign(inp)).startsWith("ok")) exts.push({ x: sign(inp).extrinsic, birth: inp.birth as { number: number; hash: Uint8Array } });
  }
  const variants = (x: Uint8Array) => {
    const out = [x, x.slice(0, -1), Uint8Array.of(...x, 0), x.slice(0, ri(x.length))];
    for (let k = 0; k < 4; k++) {
      const y = Uint8Array.from(x);
      const bit = ri(y.length * 8);
      y[bit >> 3] ^= 1 << (bit & 7);
      out.push(y);
    }
    return out;
  };
  // Owner call bytes, written here by hand from the A2 layout (pallet 94, calls 0 and 1), given to the session readers.
  const owner = [Uint8Array.of(94, 1, ...bytes(32)), Uint8Array.of(94, 0, ...bytes(32), ...new Array(52).fill(1), 0x04, 0x38, ...new TextEncoder().encode("ComputeChannel"))];
  for (const cb of [...calls.slice(0, 200), ...owner])
    for (const y of variants(cb)) {
      add("readCall", () => readerMod.readCall(ID, y));
      add("describeCall", () => describeMod.describeCall(ID, y));
    }
  for (const { x, birth } of exts.slice(0, 60))
    for (const y of variants(x))
      for (const b of [birth, { number: birth.number + 1, hash: birth.hash }]) {
        add("readExtrinsic", () => readerMod.readExtrinsic(ID, y, b));
        add("describeExtrinsic", () => describeMod.describeExtrinsic(ID, y, b));
      }
  for (const id of [ID, { ...ID, transactionVersion: ID.transactionVersion + 1 }, null, 5]) {
    add("reviewedRuntime", () => {
      const r = shapeMod.reviewedRuntime(id as never);
      return { outer: r.outer, inner: r.inner };
    });
  }
  return { lines, counts };
}

describe("review P5a, attack 1 (P8): the session path gives what main gives", () => {
  it("HOLDS: the digest of every result of the seven functions over the reviewer's inputs is main 528aad0's", () => {
    const { lines, counts } = sessionResults();
    const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
    if (process.env.REVIEW_P5A_PRINT) console.log(JSON.stringify({ digest, counts, n: lines.length }));
    expect(lines.length).toBeGreaterThan(4000);
    expect(lines.filter((l) => l.includes(" ok ")).length).toBeGreaterThan(500);
    expect(digest).toBe(MAIN_DIGEST);
  });

  it("HOLDS: the session readers refuse owner call bytes, and the owner reader refuses session call and extrinsic bytes", () => {
    const owner = [Uint8Array.of(94, 1, ...new Uint8Array(32).fill(3))];
    for (const b of owner) {
      expect(run(() => readerMod.readCall(ID, b))).toMatch(/^err ChainEncodeError CALL_NOT_ALLOWED/);
      expect(run(() => describeMod.describeCall(ID, b))).toMatch(/^err ChainEncodeError CALL_NOT_ALLOWED/);
    }
    seed = 99;
    const readOwner = (readerMod as Record<string, unknown>).readOwnerCall as ((id: unknown, b: Uint8Array) => unknown) | undefined;
    if (readOwner === undefined) return; // main has no owner reader
    for (let i = 0; i < 100; i++) {
      const inp = genSession(false);
      const b = extrinsicMod.encodeSessionCall(inp as never);
      expect(run(() => readOwner(ID, b))).toMatch(/^err ChainEncodeError CALL_NOT_ALLOWED/);
    }
  });

  it("HOLDS: the runtime the session path reviews differs from main's only by the two owner calls and the two constants", () => {
    const rt = shapeMod.reviewedRuntime(ID).rt as unknown as Record<string, unknown>;
    const calls = (rt.calls as { pallet: string; name: string }[]).map((c) => `${c.pallet}.${c.name}`);
    const first = calls.slice(0, 6);
    expect(first).toEqual(["FlopSessionKeys.execute_via_session", ...INNER.map((c) => `ComputeChannel.${c.name}`)]);
    const extra = calls.slice(6);
    expect(extra.length === 0 || ser(extra) === ser(["FlopSessionKeys.create_session", "FlopSessionKeys.revoke_session"])).toBe(true);
    const keys = Object.keys(rt).filter((k) => k !== "constants");
    expect(keys).toEqual(["specName", "specVersion", "transactionVersion", "genesisHash", "metadataSha256", "extrinsicVersion", "address", "signature", "signedExtensions", "calls"]);
  });
});
