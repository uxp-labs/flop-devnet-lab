/**
 * The P2 fix round, the rules of chain-read/node.ts: X2 with X6 (nothing but the five, from a frozen list), X4 (no
 * transport makes a read throw) and X8 (each cap stated as a number with its reason, and held at its edge). No socket
 * is opened: a fake WebSocket class stands in for the global one, and it counts the sockets made and the frames sent.
 * Hashes, accounts and answers come from the committed rerun through test/lib/recorded-node.ts and
 * research/2026-11-12-session-rerun-1014020/results.json (fields named where used).
 */
import { afterEach, describe, expect, it } from "vitest";
import { CAPS, nodeTransport, READ_METHODS } from "../src/chain-read/node.js";
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
