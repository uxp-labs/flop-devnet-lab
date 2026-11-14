/**
 * P4, rules A6, E1, E2, C1 and T3: the refusals of every function of src/channel. For every field, each wrong
 * kind, length and range; the accessor and the extra field; a path with a query, a dot or an empty segment; a GET
 * with a body; a lone surrogate; a challenge with 0x or an upper case digit. A refusal is a ChannelError with its
 * code, the exit of a rule, and a message that names the field and never carries the bytes or hex of an input.
 */
import { describe, expect, it } from "vitest";
import { requestHeaders, sessionRequestMessage } from "../src/channel/auth.js";
import { CHANNEL_REFUSAL, ChannelError, type ChannelRefusalCode } from "../src/channel/errors.js";
import { channelKeyFromSeed, verifyChannelSignature } from "../src/channel/key.js";
import { channelId, receiptMessage, turnAckMessage } from "../src/channel/transcript.js";
import { EXIT } from "../src/errors.js";

/** A byte that appears in no expected text: 0xab, so "abab" in a message would be hex of an input. */
const fill = (n: number) => new Uint8Array(n).fill(0xab);
const CHALLENGE = "c".repeat(64);
const KEY = channelKeyFromSeed({ seed: new Uint8Array(32).fill(9) });

type Kind = "b32" | "b16" | "b64" | "u32" | "u64" | "u128" | "method" | "path" | "body" | "challenge" | "bytes";

interface Fn {
  readonly name: string;
  readonly call: (input: unknown) => unknown;
  readonly fields: Readonly<Record<string, Kind>>;
  readonly good: () => Record<string, unknown>;
}

const RECEIPT = { channelId: fill(32), finalRoot: fill(32), aggregateGn: 1n, payable: 2n };
const ACK = { channelId: fill(32), turnIndex: 1, leafHash: fill(32), agentSendMs: 1n, agentRecvMs: 2n };
const REQUEST = { channelId: fill(32), method: "POST", path: "/session/open", body: "{}", timestampMs: 1n, nonce: fill(16), challenge: CHALLENGE };

const FNS: Fn[] = [
  { name: "channelId", call: (i) => channelId(i as never), fields: { genesis: "b32", agent: "b32", miner: "b32", nonce: "u64" }, good: () => ({ genesis: fill(32), agent: fill(32), miner: fill(32), nonce: 1n }) },
  { name: "receiptMessage", call: (i) => receiptMessage(i as never), fields: { channelId: "b32", finalRoot: "b32", aggregateGn: "u128", payable: "u128" }, good: () => ({ ...RECEIPT }) },
  { name: "turnAckMessage", call: (i) => turnAckMessage(i as never), fields: { channelId: "b32", turnIndex: "u32", leafHash: "b32", agentSendMs: "u64", agentRecvMs: "u64" }, good: () => ({ ...ACK }) },
  { name: "sessionRequestMessage", call: (i) => sessionRequestMessage(i as never), fields: { channelId: "b32", method: "method", path: "path", body: "body", timestampMs: "u64", nonce: "b16", challenge: "challenge" }, good: () => ({ ...REQUEST }) },
  { name: "requestHeaders", call: (i) => requestHeaders(i as never), fields: { channelId: "b32", timestampMs: "u64", nonce: "b16", challenge: "challenge", signature: "b64" }, good: () => ({ channelId: fill(32), timestampMs: 1n, nonce: fill(16), challenge: CHALLENGE, signature: fill(64) }) },
  { name: "signReceipt", call: (i) => KEY.signReceipt(i as never), fields: { channelId: "b32", finalRoot: "b32", aggregateGn: "u128", payable: "u128" }, good: () => ({ ...RECEIPT }) },
  { name: "signTurnAck", call: (i) => KEY.signTurnAck(i as never), fields: { channelId: "b32", turnIndex: "u32", leafHash: "b32", agentSendMs: "u64", agentRecvMs: "u64" }, good: () => ({ ...ACK }) },
  { name: "signRequest", call: (i) => KEY.signRequest(i as never), fields: { channelId: "b32", method: "method", path: "path", body: "body", timestampMs: "u64", nonce: "b16", challenge: "challenge" }, good: () => ({ ...REQUEST }) },
  { name: "channelKeyFromSeed", call: (i) => channelKeyFromSeed(i as never), fields: { seed: "b32" }, good: () => ({ seed: fill(32) }) },
  { name: "verifyChannelSignature", call: (i) => verifyChannelSignature(i as never), fields: { publicKey: "bytes", message: "bytes", signature: "bytes" }, good: () => ({ publicKey: fill(32), message: fill(3), signature: fill(64) }) },
];

const WIDTH: Record<string, number> = { b16: 16, b32: 32, b64: 64 };
const MAX: Record<string, bigint> = { u64: (1n << 64n) - 1n, u128: (1n << 128n) - 1n };

/** The wrong values of a kind, each with the code it must be refused with. */
function wrongs(kind: Kind): [string, unknown, ChannelRefusalCode][] {
  const kinds: [string, unknown, ChannelRefusalCode][] = [
    ["undefined", undefined, "BAD_INPUT"],
    ["null", null, "BAD_INPUT"],
  ];
  switch (kind) {
    case "b16":
    case "b32":
    case "b64": {
      const n = WIDTH[kind] as number;
      return [
        ...kinds,
        ["a hex text", "ab".repeat(n), "BAD_INPUT"],
        ["an array of numbers", Array.from(fill(n)), "BAD_INPUT"],
        ["a Uint16Array", new Uint16Array(n / 2), "BAD_INPUT"],
        ["a DataView", new DataView(new ArrayBuffer(n)), "BAD_INPUT"],
        ["a Proxy over bytes", new Proxy(fill(n), {}), "BAD_INPUT"],
        ["one byte short", fill(n - 1), "WRONG_LENGTH"],
        ["one byte long", fill(n + 1), "WRONG_LENGTH"],
        ["empty", new Uint8Array(0), "WRONG_LENGTH"],
      ];
    }
    case "bytes":
      return [...kinds, ["a hex text", "abab", "BAD_INPUT"], ["an array of numbers", [0xab, 0xab], "BAD_INPUT"], ["a Proxy over bytes", new Proxy(fill(32), {}), "BAD_INPUT"]];
    case "u32":
      return [...kinds, ["a bigint", 1n, "BAD_INPUT"], ["a text", "1", "BAD_INPUT"], ["a fraction", 1.5, "BAD_INPUT"], ["NaN", Number.NaN, "BAD_INPUT"], ["-1", -1, "OUT_OF_RANGE"], ["2^32", 2 ** 32, "OUT_OF_RANGE"]];
    case "u64":
    case "u128":
      return [...kinds, ["a number", 1, "BAD_INPUT"], ["a text", "1", "BAD_INPUT"], ["-1", -1n, "OUT_OF_RANGE"], ["the max plus one", (MAX[kind] as bigint) + 1n, "OUT_OF_RANGE"]];
    case "method":
      return [...kinds, ["lower case get", "get", "BAD_INPUT"], ["PUT", "PUT", "BAD_INPUT"], ["DELETE", "DELETE", "BAD_INPUT"], ["GET with a space", "GET ", "BAD_INPUT"], ["a number", 1, "BAD_INPUT"]];
    case "path":
      return [
        ...kinds,
        ["a number", 1, "BAD_INPUT"],
        ["empty", "", "BAD_INPUT"],
        ["a lone slash", "/", "BAD_INPUT"],
        ["a query", "/session/info?x=1", "BAD_INPUT"],
        ["a dot", "/session/../info", "BAD_INPUT"],
        ["a dot in a segment", "/session/info.json", "BAD_INPUT"],
        ["an empty segment", "/session//info", "BAD_INPUT"],
        ["a trailing slash", "/session/info/", "BAD_INPUT"],
        ["no leading slash", "session/info", "BAD_INPUT"],
        ["a full URL", "https://x.example/session/info", "BAD_INPUT"],
        ["a fragment", "/session/info#x", "BAD_INPUT"],
        ["a space", "/session/ info", "BAD_INPUT"],
        ["a non ASCII letter", "/sessión", "BAD_INPUT"],
      ];
    case "body":
      return [...kinds, ["a number", 1, "BAD_INPUT"], ["bytes", fill(2), "BAD_INPUT"], ["a lone high surrogate", "{\ud800}", "BAD_INPUT"], ["a lone low surrogate", "\udc00", "BAD_INPUT"]];
    case "challenge":
      return [
        ...kinds,
        ["a number", 1, "BAD_INPUT"],
        ["with 0x", `0x${"c".repeat(64)}`, "BAD_INPUT"],
        ["an upper case digit", `C${"c".repeat(63)}`, "BAD_INPUT"],
        ["63 digits", "c".repeat(63), "BAD_INPUT"],
        ["65 digits", "c".repeat(65), "BAD_INPUT"],
        ["a letter past f", `g${"c".repeat(63)}`, "BAD_INPUT"],
        ["bytes", fill(32), "BAD_INPUT"],
      ];
  }
}

function refusalOf(f: () => unknown): ChannelError {
  try {
    f();
  } catch (e) {
    if (e instanceof ChannelError) return e;
    throw e;
  }
  throw new Error("did not refuse");
}

/**
 * The message holds no hex run of an input of 0xab bytes, no long run of a hex text, and no base64 of them. An
 * integer out of range is named by its decimal value, as the shared check names it: a number, not bytes.
 */
function carriesNoInput(message: string, kind: Kind): void {
  expect(message).not.toMatch(/abab/i);
  if (kind === "u32" || kind === "u64" || kind === "u128") expect(message).toMatch(/ (?:-1|\d+) is not a u(?:32|64|128)$|must be a (?:whole number|bigint)|lacks|accessor|must be an object/);
  else expect(message).not.toMatch(/[0-9a-f]{16}/i);
  expect(message).not.toContain(Buffer.from(fill(8)).toString("base64").slice(0, 8));
}

describe("E1: the refusal codes and the error", () => {
  it("the codes are exactly these five, in a frozen object", () => {
    expect({ ...CHANNEL_REFUSAL }).toEqual({ WRONG_LENGTH: "WRONG_LENGTH", OUT_OF_RANGE: "OUT_OF_RANGE", BAD_INPUT: "BAD_INPUT", SELF_CHECK: "SELF_CHECK", SIGN_FAILED: "SIGN_FAILED" });
    expect(Object.isFrozen(CHANNEL_REFUSAL)).toBe(true);
  });

  it("a refusal is a ChannelError with its code, the exit of a rule, and the message channel key refused (<code>): <words>", () => {
    const e = refusalOf(() => channelId({ genesis: fill(31), agent: fill(32), miner: fill(32), nonce: 1n }));
    expect(e.refusal).toBe("WRONG_LENGTH");
    expect(e.code).toBe(EXIT.REFUSED_RULE);
    expect(e.message).toBe("channel key refused (WRONG_LENGTH): channelId genesis has 31 bytes, not 32");
    expect(Object.keys(e)).not.toContain("cause");
  });
});

for (const fn of FNS) {
  describe(`T3: ${fn.name} refuses`, () => {
    it("what is not an object", () => {
      for (const v of [undefined, null, 1, "x", [], fill(32)]) expect(refusalOf(() => fn.call(v)).refusal).toBe("BAD_INPUT");
    });

    it("an extra field, and an extra field that is not enumerable", () => {
      const e = refusalOf(() => fn.call({ ...fn.good(), extra: 1 }));
      expect(e.refusal).toBe("BAD_INPUT");
      expect(e.message).toContain("extra");
      const hidden = fn.good();
      Object.defineProperty(hidden, "hidden", { value: 1, enumerable: false });
      expect(refusalOf(() => fn.call(hidden)).refusal).toBe("BAD_INPUT");
    });

    for (const field of Object.keys(fn.fields)) {
      it(`a missing ${field}`, () => {
        const v = fn.good();
        delete v[field];
        const e = refusalOf(() => fn.call(v));
        expect(e.refusal).toBe("BAD_INPUT");
        expect(e.message).toContain(`lacks the field ${field}`);
      });

      it(`${field} as an accessor, never called`, () => {
        const v = fn.good();
        const value = v[field];
        let calls = 0;
        delete v[field];
        Object.defineProperty(v, field, { get: () => (calls++, value), enumerable: true });
        const e = refusalOf(() => fn.call(v));
        expect(e.refusal).toBe("BAD_INPUT");
        expect(e.message).toContain(`${field} is an accessor`);
        expect(calls).toBe(0);
      });

      for (const [label, wrong, code] of wrongs(fn.fields[field] as Kind)) {
        it(`${field} ${label}: ${code}, naming the field, with no bytes or hex of the input`, () => {
          const e = refusalOf(() => fn.call({ ...fn.good(), [field]: wrong }));
          expect(e.refusal).toBe(code);
          expect(e.message).toContain(field);
          carriesNoInput(e.message, fn.fields[field] as Kind);
        });
      }
    }
  });
}

describe("T3: the rules across fields", () => {
  for (const [name, call] of [["sessionRequestMessage", (i: unknown) => sessionRequestMessage(i as never)], ["signRequest", (i: unknown) => KEY.signRequest(i as never)]] as const) {
    it(`${name}: a GET with a body is refused, a GET with the empty body is not, and a POST may have an empty body`, () => {
      const e = refusalOf(() => call({ ...REQUEST, method: "GET", body: "x" }));
      expect(e.refusal).toBe("BAD_INPUT");
      expect(e.message).toBe("channel key refused (BAD_INPUT): request body of a GET has 1 bytes, not 0");
      expect(() => call({ ...REQUEST, method: "GET", body: "" })).not.toThrow();
      expect(() => call({ ...REQUEST, method: "POST", body: "" })).not.toThrow();
    });
  }

  it("a well formed surrogate pair is not refused", () => {
    expect(() => sessionRequestMessage({ ...REQUEST, body: "😀" } as never)).not.toThrow();
  });

  it("the edges of each integer are accepted", () => {
    expect(() => turnAckMessage({ ...ACK, turnIndex: 2 ** 32 - 1, agentSendMs: (1n << 64n) - 1n, agentRecvMs: 0n })).not.toThrow();
    expect(() => receiptMessage({ ...RECEIPT, aggregateGn: (1n << 128n) - 1n, payable: 0n })).not.toThrow();
    expect(() => channelId({ genesis: fill(32), agent: fill(32), miner: fill(32), nonce: (1n << 64n) - 1n })).not.toThrow();
  });

  it("the messages name the path's and the challenge's length, never the text", () => {
    const p = refusalOf(() => sessionRequestMessage({ ...REQUEST, path: "/secretword?x" } as never));
    expect(p.message).toBe("channel key refused (BAD_INPUT): request path of 13 characters is not one or more segments of a slash and letters, digits, _ or -");
    const c = refusalOf(() => sessionRequestMessage({ ...REQUEST, challenge: `0x${"d".repeat(64)}` } as never));
    expect(c.message).toBe("channel key refused (BAD_INPUT): request challenge of 66 characters is not 64 lower case hex digits with no 0x");
  });
});
