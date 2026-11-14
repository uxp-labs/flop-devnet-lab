/**
 * Review of P4 (reviewer, not the builder): verifyChannelSignature against the reference sr25519 in bulk (attack 7),
 * bytes that make it throw, and the real cooperative settle of block 3479299 as a third voice (the brief's HOLDS).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ChannelError } from "../src/channel/errors.js";
import { channelKeyFromSeed, verifyChannelSignature } from "../src/channel/key.js";
import { receiptMessage } from "../src/channel/transcript.js";
import { referencePair, referenceReady, referenceSign, referenceVerify } from "./lib/sr25519-reference.js";

beforeAll(async () => {
  await referenceReady();
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const le = (n: bigint, w: number) => Uint8Array.from({ length: w }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const fromLe = (b: Uint8Array) => b.reduceRight((a, x) => (a << 8n) | BigInt(x), 0n);

/** The lab's verdict, or the text of what it threw. */
function lab(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean | string {
  try {
    return verifyChannelSignature({ publicKey, message, signature });
  } catch (e) {
    return `threw ${(e as Error).constructor.name}`;
  }
}
function ref(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean | string {
  try {
    return referenceVerify(publicKey, message, signature);
  } catch (e) {
    return `threw ${(e as Error).constructor.name}`;
  }
}

/** A small seeded generator, so every run sees the same bytes. */
function generator(seed: number) {
  let s = seed >>> 0;
  return (n: number) => Uint8Array.from({ length: n }, () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16) & 0xff);
}

/** The group order of ristretto255 and the field prime of curve25519, from their definitions. */
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const P = (1n << 255n) - 19n;

/** The identity point's encoding (all zero) as a key, and a signature of R = identity, s = 0, with the marker bit. */
const IDENTITY = new Uint8Array(32);
const ZERO_SIG = (() => {
  const s = new Uint8Array(64);
  s[63] = 0x80;
  return s;
})();

describe("attack 7: verifyChannelSignature against the reference, in bulk", () => {
  it("HOLDS: valid signatures of both sides, every bit flip of a signature and of a key, lengths 0 to 100, s + L, non canonical encodings: the two agree and neither throws", () => {
    const rnd = generator(0x5034);
    const disagree: string[] = [];
    const cmp = (name: string, pk: Uint8Array, m: Uint8Array, s: Uint8Array) => {
      const a = lab(pk, m, s);
      const b = ref(pk, m, s);
      if (a !== b || typeof a !== "boolean") disagree.push(`${name}: lab ${a}, reference ${b}, key ${hex(pk)}, signature ${hex(s)}, message ${hex(m)}`);
    };
    let count = 0;
    for (let k = 0; k < 4; k++) {
      const seed = rnd(32);
      const pair = referencePair(seed);
      const key = channelKeyFromSeed({ seed });
      expect(hex(key.publicKey())).toBe(hex(pair.publicKey));
      const message = rnd(1 + k * 40);
      const theirs = referenceSign(pair, message);
      const ours = key.signReceipt({ channelId: rnd(32), finalRoot: rnd(32), aggregateGn: 1n, payable: 2n });
      for (const [name, m, s] of [["reference", message, theirs], ["lab", ours.message, ours.signature]] as const) {
        cmp(`${name} valid`, pair.publicKey, m, s);
        for (let i = 0; i < 512; i++) {
          const x = Uint8Array.from(s);
          x[i >> 3]! ^= 1 << (i & 7);
          cmp(`${name} signature bit ${i}`, pair.publicKey, m, x);
          count++;
        }
        for (let i = 0; i < 256; i++) {
          const x = Uint8Array.from(pair.publicKey);
          x[i >> 3]! ^= 1 << (i & 7);
          cmp(`${name} key bit ${i}`, x, m, s);
          count++;
        }
        for (let i = 0; i < Math.min(m.length * 8, 64); i++) {
          const x = Uint8Array.from(m);
          x[i >> 3]! ^= 1 << (i & 7);
          cmp(`${name} message bit ${i}`, pair.publicKey, x, s);
          count++;
        }
        // The scalar part plus the group order: the same point equation, a scalar that is not canonical.
        const sc = Uint8Array.from(s.subarray(32));
        sc[31]! &= 0x7f;
        const big = le(fromLe(sc) + L, 32);
        big[31]! |= 0x80;
        const x = Uint8Array.from(s);
        x.set(big, 32);
        cmp(`${name} s + L`, pair.publicKey, m, x);
        // The marker bit cleared.
        const y = Uint8Array.from(s);
        y[63]! &= 0x7f;
        cmp(`${name} marker cleared`, pair.publicKey, m, y);
      }
      for (let n = 0; n <= 100; n++) {
        cmp(`signature of ${n} bytes`, pair.publicKey, message, rnd(n).map((b, i) => (i === 63 ? b | 0x80 : b)));
        cmp(`key of ${n} bytes`, rnd(n), message, theirs);
        count += 2;
      }
    }
    // Non canonical encodings: p is a second encoding of zero; p as R, as the key, and both.
    const pEnc = le(P, 32);
    const sigP = Uint8Array.from(ZERO_SIG);
    sigP.set(pEnc, 0);
    cmp("R = p, key identity, s = 0", IDENTITY, new Uint8Array(3), sigP);
    cmp("key = p, R = identity, s = 0", pEnc, new Uint8Array(3), ZERO_SIG);
    cmp("key = p, R = p, s = 0", pEnc, new Uint8Array(3), sigP);
    // A key and an R with the top bit set (a field element at or above 2^255), and an odd one (a negative element).
    const top = new Uint8Array(32);
    top[31] = 0x80;
    cmp("key with bit 255 set", top, new Uint8Array(3), ZERO_SIG);
    cmp("key of the odd element 1", Uint8Array.of(1, ...new Uint8Array(31)), new Uint8Array(3), ZERO_SIG);
    expect(count).toBeGreaterThan(6000);
    expect(disagree).toEqual([]);
  });

  it("HOLDS (a disagreement, named): under the identity key, R = identity and s = 0 verify every message under the reference, and the lab says false", () => {
    // The bytes: key 0x00 * 32; signature 0x00 * 63 then 0x80. The reference (schnorrkel in @polkadot/wasm-crypto
    // 7.5.4) accepts the identity point as a key, so this one signature verifies any message there. @scure/sr25519
    // refuses the identity key. The lab is the stricter of the two. Whether the chain's sr25519_verify accepts it
    // is not known from any file here.
    for (const m of [new Uint8Array(0), Uint8Array.of(1, 2, 3), receiptMessage({ channelId: new Uint8Array(32), finalRoot: new Uint8Array(32), aggregateGn: 0n, payable: 0n })]) {
      expect(ref(IDENTITY, m, ZERO_SIG)).toBe(true);
      expect(lab(IDENTITY, m, ZERO_SIG)).toBe(false);
    }
  });
});

/** A Uint8Array whose buffer has been transferred away: still a Uint8Array, now of 0 bytes. */
function detached(n: number): Uint8Array {
  const u = new Uint8Array(n);
  structuredClone(u.buffer, { transfer: [u.buffer] });
  return u;
}

describe("D7: verifyChannelSignature never throws on any bytes", () => {
  it("control: a detached array is still a Uint8Array, of 0 bytes", () => {
    const u = detached(32);
    expect(u instanceof Uint8Array).toBe(true);
    expect(u.byteLength).toBe(0);
  });

  for (const field of ["publicKey", "message", "signature"] as const) {
    it(`DEFECT R4: a detached Uint8Array as ${field} gives false, not a TypeError`, () => {
      const input = { publicKey: new Uint8Array(32), message: new Uint8Array(3), signature: Uint8Array.from(ZERO_SIG), [field]: detached(field === "signature" ? 64 : 32) };
      let got: unknown;
      try {
        got = verifyChannelSignature(input);
      } catch (e) {
        got = `threw ${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
      expect(got).toBe(false);
    });
  }
});

describe("A6, T3: signRequest refuses with a ChannelError, never a raw TypeError", () => {
  for (const field of ["channelId", "nonce"] as const) {
    it(`DEFECT R5: a detached Uint8Array as ${field} is a ChannelError`, () => {
      const key = channelKeyFromSeed({ seed: new Uint8Array(32).fill(3) });
      const input = { channelId: new Uint8Array(32), method: "GET", path: "/session/info", body: "", timestampMs: 1n, nonce: new Uint8Array(16), challenge: "a".repeat(64), [field]: detached(16) };
      let got: unknown;
      try {
        key.signRequest(input as never);
        got = "returned";
      } catch (e) {
        got = e instanceof ChannelError ? "ChannelError" : `${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
      expect(got).toBe("ChannelError");
    });
  }
});

/** The lead's saved copy of the fourth extrinsic of block 3479299; it is not in the repo. */
const SETTLE_HEX = "/home/claude/lead-logs/r1/settle-3479299-x3.hex";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TAPE = join(REPO, "observatory/fixtures/recording-20261112004113-0b2b505d2d4b703b/tape.jsonl");
const SHAPE = join(REPO, "observatory/shapes/tzkv-runtime-1014014.json");
/** The block hash of 3479299: the tape's own answer to chain_getBlockHash(3479299). */
const tape = () => readFileSync(TAPE, "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l) as { request: { method: string; params: unknown[] }; answer: { result: string } });

describe.skipIf(!existsSync(SETTLE_HEX))(`the real cooperative settle of block 3479299 (needs ${SETTLE_HEX}, which is not in the repo)`, () => {
  it("HOLDS: receiptMessage with payable = the stored escrow, and verifyChannelSignature under the stored agent_key, say true; other payables and the older form say false; the reference agrees", () => {
    const lines = tape();
    const hashAnswer = lines.filter((x) => x.request.method === "chain_getBlockHash" && x.request.params[0] === 3479299);
    expect(hashAnswer.length).toBe(1);
    const blockHash = hashAnswer[0]!.answer.result; // tape: chain_getBlockHash(3479299).result
    // The channel record: the state_getStorage answer at that block for the key of ComputeChannel.Channels.
    const records = lines.filter((x) => x.request.method === "state_getStorage" && x.request.params[1] === blockHash && String(x.request.params[0]).length === 2 + 2 * (32 + 16 + 32));
    expect(records.length).toBe(1);
    const storageKey = String(records[0]!.request.params[0]);
    const channel = unhex(storageKey.slice(-64)); // Blake2_128Concat: the key ends with the channel id
    const record = unhex(records[0]!.answer.result);
    // The record's field order and widths from the reviewed shape of 1014014 (compute_channel.channels.fields).
    const shape = JSON.parse(readFileSync(SHAPE, "utf8"));
    const fields = shape.compute_channel.channels.fields as { name: string; type: string }[];
    const precision = shape.types[fields.find((f) => f.name === "precision")!.type];
    expect(precision.kind).toBe("variant");
    for (const v of precision.variants) expect(v.fields).toEqual([]);
    const width: Record<string, number> = { "AccountId32#0": 32, "H256#13": 32, "[u8; 32]": 32, u128: 16, [fields.find((f) => f.name === "precision")!.type]: 1 };
    const at: Record<string, Uint8Array> = {};
    let o = 0;
    for (const f of fields) {
      const w = width[f.type];
      if (w === undefined) break;
      at[f.name] = record.subarray(o, o + w);
      o += w;
    }
    const agentKey = at.agent_key!;
    const escrow = fromLe(at.escrow!);
    // The extrinsic: call index 103, 2 (ComputeChannel.settle) followed by the channel id, found once.
    const x = unhex(readFileSync(SETTLE_HEX, "utf8").trim());
    const callHead = hex(Uint8Array.of(103, 2, ...channel));
    const parts = hex(x).split(callHead);
    expect(parts.length).toBe(2);
    let p = parts[0]!.length / 2 + 2 + 32;
    const finalRoot = x.subarray(p, (p += 32));
    const gn = fromLe(x.subarray(p, (p += 16)));
    const claimedMeasured = x.subarray(p, (p += 32));
    const sig = x.subarray(p, (p += 64));
    expect(hex(claimedMeasured)).toBe(hex(at.measured_root!)); // a check that the offsets are right
    const verdict = (payable: bigint) => {
      const m = receiptMessage({ channelId: channel, finalRoot, aggregateGn: gn, payable });
      expect(m.length).toBe(125);
      return [verifyChannelSignature({ publicKey: agentKey, message: m, signature: sig }), referenceVerify(agentKey, m, sig)];
    };
    expect(verdict(escrow)).toEqual([true, true]);
    for (const other of [0n, gn, escrow - 1n, escrow + 1n]) expect(verdict(other)).toEqual([false, false]);
    const legacy = Uint8Array.from([...channel, ...finalRoot, ...le(gn, 16), ...le(escrow, 16)]);
    expect(verifyChannelSignature({ publicKey: agentKey, message: legacy, signature: sig })).toBe(false);
  });
});
