/**
 * The P2 fix round, the rules of chain-read/node.ts: X2 with X6 (nothing but the five, from a frozen list), X4 (no
 * transport makes a read throw) and X8 (each cap stated as a number with its reason, and held at its edge). No socket
 * is opened: a fake WebSocket class stands in for the global one, and it counts the sockets made and the frames sent.
 * Hashes, accounts and answers come from the committed rerun through test/lib/recorded-node.ts and
 * research/2026-11-12-session-rerun-1014020/results.json (fields named where used).
 */
import { afterEach, describe, expect, it } from "vitest";
import { CAPS, FRAME_CAP_CHARS, FRAME_WRAPPER_CHARS, header, metadata, nodeTransport, READ_METHODS, storage, type StorageKind } from "../src/chain-read/node.js";
import { readSessionState } from "../src/chain-read/read.js";
import { RERUN_RESULTS, repoJson, rerunScript } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
/** results.json accounts.owner / dev1 .public_key; step A6 is dev1's first successful session call. */
const OWNER: string = RESULTS.accounts.owner.public_key;
const DEV1: string = RESULTS.accounts.dev1.public_key;
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");

const real = globalThis.WebSocket;
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = real;
});

/** A fake socket that answers every request with a faithful frame of a 32 byte hash, and counts what it did. */
function counting(): { sockets: number; sent: any[] } {
  const seen = { sockets: 0, sent: [] as any[] };
  (globalThis as { WebSocket: unknown }).WebSocket = class {
    onopen?: () => void;
    onmessage?: (ev: { data: string }) => void;
    constructor() {
      seen.sockets++;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(text: string) {
      const req = JSON.parse(text);
      seen.sent.push(req);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: req.id, result: `0x${"00".repeat(32)}` }) }), 0);
    }
    close() {}
  };
  return seen;
}

describe("X2 with X6: nothing but the five", () => {
  it("READ_METHODS is frozen: a write to it throws and changes nothing", () => {
    const before = [...READ_METHODS];
    expect(Object.isFrozen(READ_METHODS)).toBe(true);
    expect(() => (READ_METHODS as unknown as string[]).push("author_submitExtrinsic")).toThrow(TypeError);
    expect(() => {
      (READ_METHODS as unknown as string[])[0] = "author_submitExtrinsic";
    }).toThrow(TypeError);
    expect([...READ_METHODS]).toEqual(before);
  });

  for (const m of ["author_submitExtrinsic", "state_call", "system_health", "CHAIN_GETHEADER", "", 5, null]) {
    it(`nodeTransport refuses ${JSON.stringify(m)} before rpcCall: no socket is made and nothing is sent`, async () => {
      const seen = counting();
      const t = nodeTransport("ws://scripted.invalid", 2000);
      await expect(t(m as any, ["0x00"])).rejects.toThrow("the method is not one of the five a chain read calls; nothing was sent");
      expect(seen.sockets).toBe(0);
      expect(seen.sent).toEqual([]);
    });
  }

  it("the control: each of the five is put on the wire as asked, in a socket of its own", async () => {
    const seen = counting();
    const t = nodeTransport("ws://scripted.invalid", 2000);
    for (const m of READ_METHODS) await t(m, []);
    expect(seen.sockets).toBe(5);
    expect(seen.sent.map((f) => f.method)).toEqual([...READ_METHODS]);
  });
});

describe("X4: nothing a transport does makes a read throw", () => {
  it("a thrown value whose message cannot be read gives the transport failed", async () => {
    const bad = { get message(): string { throw new Error("no"); } };
    Object.setPrototypeOf(bad, Error.prototype);
    const t = async () => {
      throw bad;
    };
    const r = await readSessionState(t, OWNER, DEV1);
    expect(r).toEqual({ kind: "unknown", reason: "the finalized head: chain_getFinalizedHead: the transport failed" });
  });

  it("a thrown value that is not an Error gives the transport failed", async () => {
    const t = async () => {
      throw "a text";
    };
    expect(await readSessionState(t, OWNER, DEV1)).toEqual({ kind: "unknown", reason: "the finalized head: chain_getFinalizedHead: the transport failed" });
  });

  it("a header that cannot be measured is unknown", async () => {
    const base = rerunScript(A6.block_hash);
    const loop: Record<string, unknown> = { number: "0x1", parentHash: `0x${"00".repeat(32)}` };
    loop.self = loop;
    const t = async (m: string, p: readonly unknown[]) => (m === "chain_getHeader" ? loop : m === "chain_getFinalizedHead" ? base.head : null);
    const r = await readSessionState(t as any, OWNER, DEV1);
    expect(r).toEqual({ kind: "unknown", reason: "the finalized head's header: chain_getHeader: the answer cannot be measured" });
  });
});

describe("X8: the caps, each a number with its reason, and held at its edge", () => {
  it("each cap is stated as a number, with its reason", () => {
    expect({ ...CAPS }).toEqual({
      // A Compact<u32> spec version (5 bytes at most), a Compact length of the spec name (5 bytes at most), and a spec
      // name the door reads only to 256 characters, 4 bytes of UTF-8 each at most: 5 + 5 + 1024.
      lastRuntimeUpgrade: 1034,
      // A SessionToken: two accounts, five u128, two u32, a bool and its allow list. The recorded ones are 169 and 248
      // bytes; 64 KiB leaves room for a long allow list.
      session: 65536,
      // A u64.
      sessionNonce: 8,
      // A CircuitBreakerState: two u32, a u128 and a bool: 4 + 4 + 16 + 1.
      circuitBreaker: 25,
      // A header's JSON text, in characters: a number, three hashes and the digest logs. The recorded ones are under
      // 700 characters; 64 KiB leaves room for many logs.
      header: 65536,
      // The decoder refuses metadata and System.Events past its MAX_INPUT_BYTES, 16 MiB (observatory RULES.md section 9).
      metadata: 16777216,
      events: 16777216,
    });
  });

  const AT = `0x${"11".repeat(32)}`;
  const KEY = new Uint8Array(32);
  const answering = (a: unknown) => async () => a;
  const hexOfLength = (n: number) => `0x${"00".repeat(n)}`;
  const KINDS: StorageKind[] = ["lastRuntimeUpgrade", "session", "sessionNonce", "circuitBreaker", "events"];

  for (const kind of KINDS) {
    it(`${kind}: an answer of its cap in bytes is taken; one byte more is unknown by the cap's words`, async () => {
      const cap = CAPS[kind];
      const at = await storage(answering(hexOfLength(cap)), kind, KEY, AT);
      expect(at.kind).toBe("known");
      expect((at as any).value.length).toBe(cap);
      expect(await storage(answering(hexOfLength(cap + 1)), kind, KEY, AT)).toEqual({ kind: "unknown", reason: `state_getStorage: the answer for ${kind} is more than its cap of ${cap} bytes` });
    });
  }

  it("metadata: an answer of its cap in bytes is taken; one byte more is unknown by the cap's words", async () => {
    expect((await metadata(answering(hexOfLength(CAPS.metadata)), AT)).kind).toBe("known");
    expect(await metadata(answering(hexOfLength(CAPS.metadata + 1)), AT)).toEqual({ kind: "unknown", reason: `state_getMetadata: the answer for the metadata is more than its cap of ${CAPS.metadata} bytes` });
  });

  it("header: a JSON text of its cap in characters is taken; one character more is unknown by the cap's words", async () => {
    const base = { number: "0x1", parentHash: AT, pad: "" };
    const pad = CAPS.header - JSON.stringify(base).length;
    const edge = { ...base, pad: "x".repeat(pad) };
    expect(JSON.stringify(edge).length).toBe(CAPS.header);
    expect((await header(answering(edge), AT)).kind).toBe("known");
    const over = { ...base, pad: "x".repeat(pad + 1) };
    expect(await header(answering(over), AT)).toEqual({ kind: "unknown", reason: `chain_getHeader: the answer is more than its cap of ${CAPS.header} characters` });
  });
});

describe("C4: the frame cap the node's transport hands rpcCall", () => {
  it("is the largest answer any read accepts plus FRAME_WRAPPER_CHARS for the frame around it, computed from CAPS", () => {
    const largest = 2 + 2 * Math.max(...Object.values(CAPS));
    const wrapper = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "" }).length;
    expect(wrapper).toBe(36);
    expect(FRAME_WRAPPER_CHARS).toBeGreaterThanOrEqual(wrapper);
    expect(FRAME_CAP_CHARS).toBe(largest + FRAME_WRAPPER_CHARS);
    expect(FRAME_CAP_CHARS).toBeGreaterThanOrEqual(2 + 2 * CAPS.metadata + wrapper);
  });

  it("is the cap nodeTransport passes: a frame one character over it is refused with that cap", async () => {
    const over = "x".repeat(FRAME_CAP_CHARS + 1);
    (globalThis as { WebSocket: unknown }).WebSocket = class {
      onopen?: () => void;
      onmessage?: (ev: { data: string }) => void;
      constructor() {
        setTimeout(() => this.onopen?.(), 0);
      }
      send() {
        setTimeout(() => this.onmessage?.({ data: over }), 0);
      }
      close() {}
    };
    await expect(nodeTransport("ws://scripted.invalid", 2000)("chain_getFinalizedHead", [])).rejects.toThrow(`rpc frame of ${FRAME_CAP_CHARS + 1} characters is over its cap of ${FRAME_CAP_CHARS}`);
  });
});
