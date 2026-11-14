/**
 * Review of piece A1 (reviewer, not the builder), promises P8 and P9: rpcCall's limits, its frame cap, its close
 * handler, the order of events, and the node's cap. No socket is opened: a fake WebSocket class of this file stands
 * in for the global one and is driven by hand. The hash is networks.ts NETWORKS.devnet.genesisHash.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CAPS, FRAME_CAP_CHARS, nodeTransport } from "../src/chain-read/node.js";
import { NETWORKS } from "../src/networks.js";
import { MAX_TIMEOUT_MS, rpcCall } from "../src/node-rpc.js";

const real = globalThis.WebSocket;
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = real;
});

const HASH = NETWORKS.devnet.genesisHash;
const ANSWER = JSON.stringify({ jsonrpc: "2.0", id: 1, result: HASH });

interface Fake {
  onopen?: () => void;
  onmessage?: (ev: { data: unknown }) => void;
  onerror?: () => void;
  onclose?: () => void;
  closes: number;
}

/** Installs a fake socket class that does nothing by itself, and hands back every socket it made. */
function manual(): Fake[] {
  const made: Fake[] = [];
  (globalThis as { WebSocket: unknown }).WebSocket = class {
    onopen?: () => void;
    onmessage?: (ev: { data: unknown }) => void;
    onerror?: () => void;
    onclose?: () => void;
    closes = 0;
    constructor() {
      made.push(this);
    }
    send() {}
    close() {
      this.closes++;
    }
  };
  return made;
}

/** How a promise settled: its value, or the words it failed with; "pending" when it has not settled by then. */
async function state(p: Promise<unknown>, waitMs = 30): Promise<string> {
  let out = "pending";
  p.then(
    (v) => (out = `ok ${String(v)}`),
    (e: Error) => (out = `err ${e.message}`),
  );
  await new Promise((r) => setTimeout(r, waitMs));
  return out;
}

const LIMITS = { timeoutMs: 5000, maxFrameChars: 65536 };

describe("review A1, P9: the limits", () => {
  it("HOLDS (was DEFECT RA1-2): a timeoutMs above the longest a timer holds (2^31 ms) is refused in its own words, before any socket is made", async () => {
    const made = manual();
    const words = "rpc limits refused: the rpc limits' timeoutMs must be at most 2147483647";
    expect(MAX_TIMEOUT_MS).toBe(2147483647);
    for (const timeoutMs of [2 ** 31, MAX_TIMEOUT_MS + 1]) {
      await expect(rpcCall("ws://scripted.invalid", "chain_getBlockHash", [0], { timeoutMs, maxFrameChars: 65536 })).rejects.toThrow(words);
    }
    expect(made).toHaveLength(0);
  });

  it("MAX_TIMEOUT_MS is accepted: the call is still pending after a short wait, and a close ends it", async () => {
    const made = manual();
    const p = rpcCall("ws://scripted.invalid", "chain_getBlockHash", [0], { timeoutMs: MAX_TIMEOUT_MS, maxFrameChars: 65536 });
    expect(made).toHaveLength(1);
    const s = await state(p, 50);
    made[0].onclose?.();
    await p.catch(() => undefined);
    expect(s).toBe("pending");
  });

  it("HOLDS: a bad limits object is refused before any socket is made", async () => {
    const made = manual();
    const accessor = Object.defineProperty({ maxFrameChars: 10 }, "timeoutMs", { enumerable: true, get: () => 10 });
    const bad: unknown[] = [
      undefined,
      null,
      {},
      { timeoutMs: 10 },
      { timeoutMs: 10, maxFrameChars: 10, extra: 1 },
      { timeoutMs: 0, maxFrameChars: 10 },
      { timeoutMs: 10, maxFrameChars: 0 },
      { timeoutMs: 1.5, maxFrameChars: 10 },
      { timeoutMs: 10n, maxFrameChars: 10 },
      { timeoutMs: -1, maxFrameChars: 10 },
      { timeoutMs: Number.NaN, maxFrameChars: 10 },
      { timeoutMs: "10", maxFrameChars: 10 },
      accessor,
      [10, 10],
      new Proxy({ timeoutMs: 10, maxFrameChars: 10 }, { get: () => 10, ownKeys: () => [] }),
    ];
    for (const [i, limits] of bad.entries()) {
      await expect(rpcCall("ws://scripted.invalid", "m", [], limits as never), `bad limits ${i}`).rejects.toThrow(/^rpc limits refused: /);
    }
    expect(made).toHaveLength(0);
  });
});

describe("review A1, P9: every order of events settles once", () => {
  it("HOLDS: close before any message settles at once with its reason; a message after it changes nothing", async () => {
    const made = manual();
    const p = rpcCall("ws://scripted.invalid", "m", [], LIMITS);
    made[0].onopen?.();
    made[0].onclose?.();
    made[0].onmessage?.({ data: ANSWER });
    made[0].onerror?.();
    expect(await state(p, 5)).toBe("err rpc socket closed before an answer");
  });

  it("HOLDS: an answer, then close, error and a second message: the first answer stands", async () => {
    const made = manual();
    const p = rpcCall("ws://scripted.invalid", "m", [], LIMITS);
    made[0].onmessage?.({ data: ANSWER });
    made[0].onclose?.();
    made[0].onerror?.();
    made[0].onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "other" }) });
    expect(await state(p, 5)).toBe(`ok ${HASH}`);
    expect(made[0].closes).toBe(1);
  });

  it("HOLDS: an error first, then close and an answer: the error stands", async () => {
    const made = manual();
    const p = rpcCall("ws://scripted.invalid", "m", [], LIMITS);
    made[0].onerror?.();
    made[0].onclose?.();
    made[0].onmessage?.({ data: ANSWER });
    expect(await state(p, 5)).toBe("err rpc websocket error");
  });

  it("HOLDS: the timer, then an answer: the timeout stands", async () => {
    const made = manual();
    const p = rpcCall("ws://scripted.invalid", "m", [], { timeoutMs: 5, maxFrameChars: 65536 });
    const s = state(p, 25);
    await new Promise((r) => setTimeout(r, 20));
    made[0].onmessage?.({ data: ANSWER });
    expect(await s).toBe("err rpc timeout");
  });

  it("HOLDS: a frame that is not an answer, then the answer: the first frame ends the call", async () => {
    const made = manual();
    const p = rpcCall("ws://scripted.invalid", "m", [], LIMITS);
    made[0].onmessage?.({ data: "[]" });
    made[0].onmessage?.({ data: ANSWER });
    expect(await state(p, 5)).toMatch(/^err rpc returned a frame that is not an answer/);
  });
});

describe("review A1, P9: what a frame is", () => {
  it("HOLDS: the cap at N-1, N and N+1 characters", async () => {
    const n = ANSWER.length;
    for (const [cap, want] of [
      [n + 1, `ok ${HASH}`],
      [n, `ok ${HASH}`],
      [n - 1, `err rpc frame of ${n} characters is over its cap of ${n - 1}`],
    ] as const) {
      const made = manual();
      const p = rpcCall("ws://scripted.invalid", "m", [], { timeoutMs: 5000, maxFrameChars: cap });
      made[0].onmessage?.({ data: ANSWER });
      expect(await state(p, 5), String(cap)).toBe(want);
    }
  });

  it("HOLDS: data that is a String object, an ArrayBuffer, a Blob, a byte array, null or a number is not text", async () => {
    for (const data of [new String(ANSWER), new TextEncoder().encode(ANSWER).buffer, new Blob([ANSWER]), new TextEncoder().encode(ANSWER), null, undefined, 1]) {
      const made = manual();
      const p = rpcCall("ws://scripted.invalid", "m", [], LIMITS);
      made[0].onmessage?.({ data });
      expect(await state(p, 5)).toBe("err rpc frame is not text");
    }
  });

  it("DEFECT RA1-3: the node's cap refuses a frame that holds the largest answer a read accepts when the frame is written with whitespace", async () => {
    // The largest answer any read accepts: 0x and two hex digits for each of CAPS.metadata bytes (bytesWithin).
    const result = `0x${"00".repeat(CAPS.metadata)}`;
    // Legal JSON: a node may write whitespace between tokens. 300 spaces is a pretty printed frame of a few lines.
    const frame = `{"jsonrpc":"2.0","id":1,${" ".repeat(300)}"result":"${result}"}`;
    expect(JSON.parse(frame).result).toBe(result);
    expect(frame.length).toBeGreaterThan(FRAME_CAP_CHARS);
    (globalThis as { WebSocket: unknown }).WebSocket = class {
      onopen?: () => void;
      onmessage?: (ev: { data: string }) => void;
      constructor() {
        setTimeout(() => this.onopen?.(), 0);
      }
      send() {
        setTimeout(() => this.onmessage?.({ data: frame }), 0);
      }
      close() {}
    };
    const got = await nodeTransport("ws://scripted.invalid", 5000)("state_getMetadata", [HASH]).then(
      (v) => (v === result ? "the answer" : "another value"),
      (e: Error) => e.message,
    );
    expect(got).toBe("the answer");
  });
});
