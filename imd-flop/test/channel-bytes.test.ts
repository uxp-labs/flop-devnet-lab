/**
 * P4, rules B2, B3, C1, C2 and T2: the exact bytes of the receipt, the turn ack and the request message, and the
 * texts of the five headers. The expected bytes are laid out in this file's own lines as hex text, not through
 * src/channel/bytes.ts, over inputs whose fields all differ (so a swap shows) and at the edges of each integer.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { describe, expect, it } from "vitest";
import { REQUEST_DOMAIN, requestHeaders, sessionRequestMessage } from "../src/channel/auth.js";
import { RECEIPT_DOMAIN, RECEIPT_VERSION, receiptMessage, turnAckMessage } from "../src/channel/transcript.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const run = (start: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);

const CHANNEL = run(0x01, 32); // 0102...20
const ROOT = run(0x41, 32); // 4142...60
const LEAF = run(0x81, 32); // 8182...a0
const NONCE16 = run(0xc1, 16); // c1c2...d0

const CHANNEL_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const ROOT_HEX = "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60";
const LEAF_HEX = "8182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0";
const NONCE16_HEX = "c1c2c3c4c5c6c7c8c9cacbcccdcecfd0";
/** "FLOP/COMPUTE_CHANNEL/RECEIPT" as ASCII, 28 bytes. */
const RECEIPT_DOMAIN_HEX = "464c4f502f434f4d505554455f4348414e4e454c2f52454345495054";

describe("B2, T2: the receipt message, 125 bytes", () => {
  it("the domain is 28 ASCII bytes and the version byte is 1", () => {
    expect(RECEIPT_DOMAIN).toBe("FLOP/COMPUTE_CHANNEL/RECEIPT");
    expect(Buffer.from(RECEIPT_DOMAIN, "ascii").toString("hex")).toBe(RECEIPT_DOMAIN_HEX);
    expect(RECEIPT_VERSION).toBe(1);
  });

  it("domain, version, channel id, final root, aggregateGn u128 LE, payable u128 LE, in that order", () => {
    const m = receiptMessage({ channelId: CHANNEL, finalRoot: ROOT, aggregateGn: 0x0f0e0d0c0b0a09080706050403020100n, payable: 0x1f1e1d1c1b1a19181716151413121110n });
    expect(m.length).toBe(125);
    expect(hex(m)).toBe(
      RECEIPT_DOMAIN_HEX +
        "01" +
        CHANNEL_HEX +
        ROOT_HEX +
        "000102030405060708090a0b0c0d0e0f" + // aggregateGn
        "101112131415161718191a1b1c1d1e1f", // payable
    );
  });

  it("at the edges: 0 and 2^128 - 1", () => {
    const max = (1n << 128n) - 1n;
    expect(hex(receiptMessage({ channelId: CHANNEL, finalRoot: ROOT, aggregateGn: 0n, payable: max }))).toBe(RECEIPT_DOMAIN_HEX + "01" + CHANNEL_HEX + ROOT_HEX + "00".repeat(16) + "ff".repeat(16));
    expect(hex(receiptMessage({ channelId: CHANNEL, finalRoot: ROOT, aggregateGn: max, payable: 0n }))).toBe(RECEIPT_DOMAIN_HEX + "01" + CHANNEL_HEX + ROOT_HEX + "ff".repeat(16) + "00".repeat(16));
    expect(hex(receiptMessage({ channelId: CHANNEL, finalRoot: ROOT, aggregateGn: 1n, payable: 1n << 120n }))).toBe(RECEIPT_DOMAIN_HEX + "01" + CHANNEL_HEX + ROOT_HEX + "01" + "00".repeat(15) + "00".repeat(15) + "01");
  });
});

describe("B3, T2: the turn ack message, 84 bytes", () => {
  it("channel id, turnIndex u32 LE, leaf hash, agentSendMs u64 LE, agentRecvMs u64 LE, in that order, with no domain", () => {
    const m = turnAckMessage({ channelId: CHANNEL, turnIndex: 0x24232221, leafHash: LEAF, agentSendMs: 0x3736353433323130n, agentRecvMs: 0x4746454443424140n });
    expect(m.length).toBe(84);
    expect(hex(m)).toBe(
      CHANNEL_HEX +
        "21222324" + // turnIndex
        LEAF_HEX +
        "3031323334353637" + // agentSendMs
        "4041424344454647", // agentRecvMs
    );
  });

  it("at the edges: 0 and 2^32 - 1, 0 and 2^64 - 1, and no rule on the order of the two times", () => {
    expect(hex(turnAckMessage({ channelId: CHANNEL, turnIndex: 0, leafHash: LEAF, agentSendMs: (1n << 64n) - 1n, agentRecvMs: 0n }))).toBe(CHANNEL_HEX + "00000000" + LEAF_HEX + "ff".repeat(8) + "00".repeat(8));
    expect(hex(turnAckMessage({ channelId: CHANNEL, turnIndex: 2 ** 32 - 1, leafHash: LEAF, agentSendMs: 0n, agentRecvMs: (1n << 64n) - 1n }))).toBe(CHANNEL_HEX + "ffffffff" + LEAF_HEX + "00".repeat(8) + "ff".repeat(8));
    expect(hex(turnAckMessage({ channelId: CHANNEL, turnIndex: 1, leafHash: LEAF, agentSendMs: 1n << 56n, agentRecvMs: 1n }))).toBe(CHANNEL_HEX + "01000000" + LEAF_HEX + "00".repeat(7) + "01" + "01" + "00".repeat(7));
  });
});

const CHALLENGE = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

describe("C1, T2: the request message", () => {
  it("the domain text", () => {
    expect(REQUEST_DOMAIN).toBe("flop-session-request-v1");
  });

  it("a POST: the UTF-8 of the compact JSON of eight strings, laid out here", () => {
    const body = '{"channelId":"x","agentKey":"y","n":"é€😀"}';
    const m = sessionRequestMessage({ channelId: CHANNEL, method: "POST", path: "/session/open", body, timestampMs: 1731550000123n, nonce: NONCE16, challenge: CHALLENGE });
    const bodyHash = hex(blake2b(Buffer.from(body, "utf8"), { dkLen: 32 }));
    const text = `["flop-session-request-v1","0x${CHANNEL_HEX}","POST","/session/open","0x${bodyHash}","1731550000123","0x${NONCE16_HEX}","${CHALLENGE}"]`;
    expect(Buffer.from(m).toString("hex")).toBe(Buffer.from(text, "utf8").toString("hex"));
    const back = JSON.parse(Buffer.from(m).toString("utf8"));
    expect(back).toEqual(["flop-session-request-v1", `0x${CHANNEL_HEX}`, "POST", "/session/open", `0x${bodyHash}`, "1731550000123", `0x${NONCE16_HEX}`, CHALLENGE]);
    expect(back.length).toBe(8);
    for (const s of back) expect(typeof s).toBe("string");
  });

  it("a GET: the body is the empty text, whose blake2b-256 is in the fourth place after the domain", () => {
    const m = sessionRequestMessage({ channelId: CHANNEL, method: "GET", path: "/session/info", body: "", timestampMs: 0n, nonce: NONCE16, challenge: CHALLENGE });
    const empty = hex(blake2b(new Uint8Array(0), { dkLen: 32 }));
    expect(empty).toBe("0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
    expect(Buffer.from(m).toString("utf8")).toBe(`["flop-session-request-v1","0x${CHANNEL_HEX}","GET","/session/info","0x${empty}","0","0x${NONCE16_HEX}","${CHALLENGE}"]`);
  });

  it("the timestamp at the top of the u64 range is its decimal text", () => {
    const m = sessionRequestMessage({ channelId: CHANNEL, method: "GET", path: "/a", body: "", timestampMs: (1n << 64n) - 1n, nonce: NONCE16, challenge: CHALLENGE });
    expect(JSON.parse(Buffer.from(m).toString("utf8"))[5]).toBe("18446744073709551615");
  });

  it("a body with characters JSON escapes is hashed as the exact text, and the message holds the hash, not the body", () => {
    const body = '"quote" \\ back\nline\u0000';
    const m = sessionRequestMessage({ channelId: CHANNEL, method: "POST", path: "/session/turn", body, timestampMs: 5n, nonce: NONCE16, challenge: CHALLENGE });
    const back = JSON.parse(Buffer.from(m).toString("utf8"));
    expect(back[4]).toBe(`0x${hex(blake2b(Buffer.from(body, "utf8"), { dkLen: 32 }))}`);
    expect(Buffer.from(m).toString("utf8")).not.toContain("back");
  });
});

describe("C2, T2: the five headers", () => {
  it("exactly these five names and texts, in a frozen object", () => {
    const sig = run(0x10, 64);
    const h = requestHeaders({ channelId: CHANNEL, timestampMs: 1731550000123n, nonce: NONCE16, challenge: CHALLENGE, signature: sig });
    expect(Object.keys(h)).toEqual(["x-flop-channel", "x-flop-timestamp", "x-flop-nonce", "x-flop-challenge", "x-flop-signature"]);
    expect({ ...h }).toEqual({
      "x-flop-channel": `0x${CHANNEL_HEX}`,
      "x-flop-timestamp": "1731550000123",
      "x-flop-nonce": `0x${NONCE16_HEX}`,
      "x-flop-challenge": CHALLENGE,
      "x-flop-signature": `0x${hex(sig)}`,
    });
    expect(h["x-flop-signature"]).toMatch(/^0x[0-9a-f]{128}$/);
    expect(Object.isFrozen(h)).toBe(true);
  });
});
