/**
 * Review of P4 (reviewer): the three layouts at the edges and over random inputs, laid out here from the brief's
 * B2, B3 and C1 (attack 3), and the request rules at their edges (attack 8). Nothing here goes through bytes.ts.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { describe, expect, it } from "vitest";
import { requestHeaders, sessionRequestMessage } from "../src/channel/auth.js";
import { ChannelError } from "../src/channel/errors.js";
import { channelKeyFromSeed } from "../src/channel/key.js";
import { receiptMessage, turnAckMessage } from "../src/channel/transcript.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const le = (n: bigint, w: number) => Uint8Array.from({ length: w }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => Array.from(x)));
function generator(seed: number) {
  let s = seed >>> 0;
  const byte = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16) & 0xff;
  return {
    bytes: (n: number) => Uint8Array.from({ length: n }, byte),
    big: (bits: number) => {
      let v = 0n;
      for (let i = 0; i < bits / 8; i++) v = (v << 8n) | BigInt(byte());
      return v;
    },
    int: (n: number) => (byte() * 256 * 256 + byte() * 256 + byte()) % n,
  };
}

/** One value at each edge of a width, and random ones. */
const edges = (bits: number) => [0n, 1n, (1n << BigInt(bits)) - 1n, (1n << BigInt(bits)) - 2n, 1n << BigInt(bits - 1), 0xffn, 0x100n];

describe("attack 3: the layouts at the edges and with random fields", () => {
  it("HOLDS: the receipt is domain, 1, id, root, gn u128 LE, payable u128 LE, for 400 random and every edge value", () => {
    const g = generator(7);
    const cases: [bigint, bigint][] = [];
    for (const a of edges(128)) for (const b of edges(128)) cases.push([a, b]);
    for (let i = 0; i < 400; i++) cases.push([g.big(128), g.big(128)]);
    for (const [gn, payable] of cases) {
      const id = g.bytes(32);
      const root = g.bytes(32);
      const want = cat(Buffer.from("FLOP/COMPUTE_CHANNEL/RECEIPT", "ascii"), Uint8Array.of(1), id, root, le(gn, 16), le(payable, 16));
      expect(want.length).toBe(125);
      expect(hex(receiptMessage({ channelId: id, finalRoot: root, aggregateGn: gn, payable }))).toBe(hex(want));
    }
  });

  it("HOLDS: the ack is id, turn u32 LE, leaf, send u64 LE, recv u64 LE, for 400 random and every edge value", () => {
    const g = generator(8);
    const cases: [number, bigint, bigint][] = [];
    for (const t of [0, 1, 255, 256, 2 ** 31, 2 ** 32 - 1]) for (const a of edges(64)) for (const b of edges(64)) cases.push([t, a, b]);
    for (let i = 0; i < 400; i++) cases.push([Number(g.big(32)), g.big(64), g.big(64)]);
    for (const [turn, send, recv] of cases) {
      const id = g.bytes(32);
      const leaf = g.bytes(32);
      const want = cat(id, le(BigInt(turn), 4), leaf, le(send, 8), le(recv, 8));
      expect(want.length).toBe(84);
      expect(hex(turnAckMessage({ channelId: id, turnIndex: turn, leafHash: leaf, agentSendMs: send, agentRecvMs: recv }))).toBe(hex(want));
    }
  });

  it("HOLDS: no two of the three layouts can give the same bytes: their lengths never meet (125, 84, and a request of at least the shortest form)", () => {
    // The shortest request: GET, a path of two characters, a timestamp of one digit.
    const shortest = sessionRequestMessage({ channelId: new Uint8Array(32), method: "GET", path: "/a", body: "", timestampMs: 0n, nonce: new Uint8Array(16), challenge: "0".repeat(64) });
    expect(shortest.length).toBeGreaterThan(125);
    // A receipt starts with "F", a request with "[", an ack with whatever the caller's id holds; the ack is 84 bytes and the other two are longer.
    expect(shortest[0]).toBe(0x5b);
    expect(receiptMessage({ channelId: new Uint8Array(32), finalRoot: new Uint8Array(32), aggregateGn: 0n, payable: 0n })[0]).toBe(0x46);
  });
});

const BASE = () => ({ channelId: new Uint8Array(32).fill(0x11), method: "POST", path: "/session/turn", body: "{}", timestampMs: 1n, nonce: new Uint8Array(16).fill(0x22), challenge: "ab".repeat(32) });
function refused(over: Record<string, unknown>): string | null {
  try {
    sessionRequestMessage({ ...BASE(), ...over } as never);
    return null;
  } catch (e) {
    return e instanceof ChannelError ? e.refusal : `not a ChannelError: ${(e as Error).constructor.name}`;
  }
}

describe("attack 8: the request rules at their edges", () => {
  it("HOLDS: the path: a newline at the end, a percent escape, a double slash, a unicode letter, a dot, a query, a space, a trailing slash, the empty text, a lone slash, a backslash: each BAD_INPUT", () => {
    for (const path of ["/a\n", "/a%2F", "//a", "/a//b", "/é", "/ａ", "/a.b", "/a?b", "/a b", "/a/", "", "/", "/a\\b", "a", "/a ", "\n/a", "/a\r"]) expect(refused({ path }), JSON.stringify(path)).toBe("BAD_INPUT");
    for (const path of ["/a", "/A-z_0/9", "/session/info", `/${"x".repeat(5000)}`]) expect(refused({ path }), path.slice(0, 20)).toBeNull();
  });

  it("HOLDS: the body: NUL and a BOM are hashed as they are; a lone surrogate at either end is BAD_INPUT; a very long text is accepted", () => {
    for (const body of ["\u0000", "﻿{}", "a\u0000b", "x".repeat(1 << 20)]) {
      const m = JSON.parse(Buffer.from(sessionRequestMessage({ ...BASE(), body } as never)).toString("utf8"));
      expect(m[4]).toBe(`0x${hex(blake2b(Buffer.from(body, "utf8"), { dkLen: 32 }))}`);
    }
    for (const body of ["\ud800", "\udfff", "\ud800x", "x\ud800", "\udc00x", "x\udbff", "\udc00\ud800"]) expect(refused({ body }), JSON.stringify(body)).toBe("BAD_INPUT");
    expect(refused({ body: "😀" })).toBeNull();
  });

  it("HOLDS: the method: only GET and POST, in exactly that case, with nothing around them", () => {
    for (const method of ["get", "Get", "post", "PUT", " GET", "GET ", "GET\n", "POST\u0000", "", null, 1, ["GET"], new String("GET")]) expect(refused({ method, body: "" }), String(method)).toBe("BAD_INPUT");
  });

  it("HOLDS: the timestamp: 0 and 2^64 - 1 accepted, 2^64 and -1n OUT_OF_RANGE, a number BAD_INPUT", () => {
    expect(refused({ timestampMs: 0n })).toBeNull();
    expect(refused({ timestampMs: (1n << 64n) - 1n })).toBeNull();
    expect(refused({ timestampMs: 1n << 64n })).toBe("OUT_OF_RANGE");
    expect(refused({ timestampMs: -1n })).toBe("OUT_OF_RANGE");
    expect(refused({ timestampMs: 1 })).toBe("BAD_INPUT");
  });

  it("HOLDS: the challenge: 0x, upper case, 63 and 65 digits, a newline at the end, each BAD_INPUT, in the message and in the headers", () => {
    for (const challenge of [`0x${"a".repeat(62)}`, `0x${"a".repeat(64)}`, "A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(64)}\n`, "g".repeat(64)]) {
      expect(refused({ challenge }), challenge).toBe("BAD_INPUT");
      expect(() => requestHeaders({ channelId: new Uint8Array(32), timestampMs: 0n, nonce: new Uint8Array(16), challenge, signature: new Uint8Array(64) })).toThrow(ChannelError);
    }
  });

  it("HOLDS: for 300 random accepted inputs, the signed message parses as JSON to eight strings with no escape, and the headers' texts are the message's texts", () => {
    const g = generator(11);
    const key = channelKeyFromSeed({ seed: new Uint8Array(32).fill(4) });
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    for (let i = 0; i < 300; i++) {
      const segments = 1 + g.int(4);
      let path = "";
      for (let s = 0; s < segments; s++) {
        path += "/";
        const n = 1 + g.int(12);
        for (let c = 0; c < n; c++) path += ALPHA[g.int(ALPHA.length)];
      }
      const method = g.int(2) === 0 ? "GET" : "POST";
      const body = method === "GET" ? "" : JSON.stringify({ i, t: Buffer.from(g.bytes(g.int(40))).toString("latin1") });
      const input = { channelId: g.bytes(32), method, path, body, timestampMs: g.big(64), nonce: g.bytes(16), challenge: hex(g.bytes(32)) };
      const s = key.signRequest(input as never);
      const text = Buffer.from(s.message).toString("utf8");
      expect(text.includes("\\")).toBe(false);
      const m = JSON.parse(text) as string[];
      expect(m.length).toBe(8);
      for (const x of m) expect(typeof x).toBe("string");
      expect(JSON.stringify(m)).toBe(text);
      expect(m).toEqual(["flop-session-request-v1", `0x${hex(input.channelId)}`, method, path, `0x${hex(blake2b(Buffer.from(body, "utf8"), { dkLen: 32 }))}`, input.timestampMs.toString(), `0x${hex(input.nonce)}`, input.challenge]);
      expect(s.headers["x-flop-channel"]).toBe(m[1]);
      expect(s.headers["x-flop-timestamp"]).toBe(m[5]);
      expect(s.headers["x-flop-nonce"]).toBe(m[6]);
      expect(s.headers["x-flop-challenge"]).toBe(m[7]);
      expect(s.headers["x-flop-signature"]).toBe(`0x${hex(s.signature)}`);
    }
  });
});
