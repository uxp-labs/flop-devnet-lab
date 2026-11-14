/**
 * The P2 fix round, rule X1: the frame of an answer, in node-rpc.ts rpcCall. No socket is opened: a fake WebSocket
 * class stands in for the global one and answers the one request with a frame this file writes. The id the call
 * sends is node-rpc.ts CALL_ID; the pinned genesis is networks.ts NETWORKS.devnet.genesisHash.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Fetch } from "../src/gateway.js";
import { checkGenesis } from "../src/gateway.js";
import { NETWORKS } from "../src/networks.js";
import { CALL_ID, NOT_AN_ANSWER, rpcCall } from "../src/node-rpc.js";

const real = globalThis.WebSocket;
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = real;
});

/** A fake socket that answers the one request with this frame text, and records what was sent. */
function answering(frame: string, sent: unknown[] = []): void {
  (globalThis as { WebSocket: unknown }).WebSocket = class {
    onopen?: () => void;
    onmessage?: (ev: { data: string }) => void;
    onerror?: () => void;
    constructor() {
      setTimeout(() => this.onopen?.(), 0);
    }
    send(text: string) {
      sent.push(JSON.parse(text));
      setTimeout(() => this.onmessage?.({ data: frame }), 0);
    }
    close() {}
  };
}

/** What rpcCall does with one frame: its result, or the words it fails with. */
async function outcome(frame: string): Promise<{ result: unknown } | { error: string }> {
  answering(frame);
  return rpcCall("ws://scripted.invalid", "chain_getBlockHash", [0], 2000).then(
    (result) => ({ result }),
    (e: Error) => ({ error: e.message }),
  );
}

const HASH = `0x${"ab".repeat(32)}`;
const frame = (o: Record<string, unknown>) => JSON.stringify(o);

describe("X1: the frame of an answer", () => {
  it("the request carries CALL_ID, the number 1, and jsonrpc 2.0", async () => {
    const sent: any[] = [];
    answering(frame({ jsonrpc: "2.0", id: 1, result: HASH }), sent);
    await rpcCall("ws://scripted.invalid", "chain_getBlockHash", [0], 2000);
    expect(CALL_ID).toBe(1);
    expect(sent).toEqual([{ id: 1, jsonrpc: "2.0", method: "chain_getBlockHash", params: [0] }]);
  });

  it("a faithful frame ends the call with its result as it is", async () => {
    expect(await outcome(frame({ jsonrpc: "2.0", id: 1, result: HASH }))).toEqual({ result: HASH });
  });

  it("a faithful frame whose result is null ends the call with null: the node wrote null", async () => {
    expect(await outcome(frame({ jsonrpc: "2.0", id: 1, result: null }))).toEqual({ result: null });
  });

  describe("a frame that is not an object is not an answer, and is never quoted", () => {
    for (const [what, text] of [
      ["a list", JSON.stringify([{ jsonrpc: "2.0", id: 1, result: HASH }])],
      ["a text", JSON.stringify(HASH)],
      ["a number", "1"],
      ["null", "null"],
    ] as const) {
      it(what, async () => {
        const o = await outcome(text);
        expect(o).toEqual({ error: NOT_AN_ANSWER });
      });
    }
  });

  describe("a frame whose jsonrpc is not exactly the text 2.0 is not an answer", () => {
    for (const [what, f] of [
      ["jsonrpc missing", { id: 1, result: HASH }],
      ['jsonrpc "1.0"', { jsonrpc: "1.0", id: 1, result: HASH }],
      ["jsonrpc the number 2", { jsonrpc: 2, id: 1, result: HASH }],
    ] as const) {
      it(what, async () => {
        expect(await outcome(frame(f))).toEqual({ error: NOT_AN_ANSWER });
      });
    }
  });

  describe("a frame whose id is not exactly the id sent is not an answer", () => {
    for (const [what, f] of [
      ["id missing", { jsonrpc: "2.0", result: HASH }],
      ['id the text "1"', { jsonrpc: "2.0", id: "1", result: HASH }],
      ["id the number 2", { jsonrpc: "2.0", id: 2, result: HASH }],
      ["id null", { jsonrpc: "2.0", id: null, result: HASH }],
    ] as const) {
      it(what, async () => {
        expect(await outcome(frame(f))).toEqual({ error: NOT_AN_ANSWER });
      });
    }
  });

  describe("a frame with an own error key is a failed call, whatever its value, even beside a result", () => {
    for (const [what, error] of [
      ["null", null],
      ["0", 0],
      ["an empty text", ""],
      ["an object with no message", { code: -32000 }],
      ["an object whose message is not text", { code: -32000, message: 5 }],
    ] as const) {
      it(`error ${what}: "rpc error"`, async () => {
        expect(await outcome(frame({ jsonrpc: "2.0", id: 1, error, result: HASH }))).toEqual({ error: "rpc error" });
      });
    }

    it("error an object with a text message: quoted through server-text.ts", async () => {
      expect(await outcome(frame({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "the node is busy" }, result: HASH }))).toEqual({ error: "rpc error: the node is busy" });
    });

    it("a long message is cut by server-text.ts, never the frame", async () => {
      const o = (await outcome(frame({ jsonrpc: "2.0", id: 1, error: { message: "x".repeat(5000) } }))) as { error: string };
      expect(o.error.startsWith("rpc error: x")).toBe(true);
      expect(o.error.length).toBeLessThan(1000);
    });
  });

  it("a frame with no result key is not an answer", async () => {
    expect(await outcome(frame({ jsonrpc: "2.0", id: 1 }))).toEqual({ error: NOT_AN_ANSWER });
  });

  it("the words of a frame that is not an answer never quote it", async () => {
    const o = (await outcome(frame({ jsonrpc: "2.0", id: 2, result: "SECRETSHAPEDTEXT" }))) as { error: string };
    expect(o.error).toBe(NOT_AN_ANSWER);
    expect(o.error).not.toContain("SECRETSHAPEDTEXT");
  });

  it("the genesis check fails on a frame that is { result } alone", async () => {
    const pin = NETWORKS.devnet.genesisHash;
    const faucet = (async () => new Response(JSON.stringify({ genesisHash: pin }))) as Fetch;
    answering(JSON.stringify({ result: pin }));
    const g = await checkGenesis(NETWORKS.devnet, faucet);
    expect(g.ok).toBe(false);
    expect(g.rpcGenesis).toBeNull();
    expect(g.error).toContain(`rpc unavailable: ${NOT_AN_ANSWER}`);
    // The control: the same pin in a faithful frame passes.
    answering(JSON.stringify({ jsonrpc: "2.0", id: 1, result: pin }));
    expect((await checkGenesis(NETWORKS.devnet, faucet)).ok).toBe(true);
  });
});

/**
 * Piece A1 part 8 (audit note 7): answerOf is rpcCall's own. It is not exported, and it is handed only what
 * readOutsideJson returned for a text frame: plain data. Through rpcCall, a frame of every JSON kind settles the call
 * with an answer or one of the frame rule's own reasons, and nothing else is thrown. A throw inside answerOf would
 * show here as "rpc returned malformed JSON", which no valid JSON text may give.
 */
describe("N2: answerOf is rpcCall's own and never throws for plain data", () => {
  const KINDS: readonly unknown[] = [null, true, false, 0, -1.5, 1e300, "", "x", [], [1, [2, [null]]], {}, { a: { b: { c: [{}] } } }, { message: "m" }, { message: 7 }, { message: null }, { __proto__: { message: "m" } }];
  const REASONS = (e: string) => e === NOT_AN_ANSWER || e === "rpc error" || e.startsWith("rpc error: ");

  it("answerOf is not exported", async () => {
    const mod = (await import("../src/node-rpc.js")) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual(["CALL_ID", "NOT_AN_ANSWER", "rpcCall"]);
  });

  it("frames of every JSON kind, an error of every kind and a result of every kind: an answer or a reason, nothing else", async () => {
    const frames: [string, unknown][] = [
      ...KINDS.map((k): [string, unknown] => [JSON.stringify(k), undefined]),
      ...KINDS.map((k): [string, unknown] => [frame({ jsonrpc: "2.0", id: 1, error: k }), undefined]),
      ...KINDS.map((k): [string, unknown] => [frame({ jsonrpc: "2.0", id: 1, error: k, result: HASH }), undefined]),
      ...KINDS.map((k): [string, unknown] => [frame({ jsonrpc: "2.0", id: 1, result: k }), k]),
      ...KINDS.map((k): [string, unknown] => [frame({ jsonrpc: k, id: k, result: HASH }), undefined]),
      ['{"jsonrpc":"2.0","id":1,"__proto__":{"result":1}}', undefined],
      ['{"jsonrpc":"2.0","id":1,"error":{"__proto__":{"message":"m"}}}', undefined],
    ];
    expect(frames.length).toBe(5 * KINDS.length + 2);
    for (const [text, result] of frames) {
      const o = await outcome(text);
      if ("result" in o) expect([text, o.result]).toEqual([text, result]);
      else expect([text, REASONS(o.error)]).toEqual([text, true]);
    }
  });
});
