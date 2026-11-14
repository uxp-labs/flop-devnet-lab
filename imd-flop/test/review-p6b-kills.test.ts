/**
 * Review of P6b, attack 10: tests for rules the builder's tests leave unheld (mutants C-turn2xx and H-dropCancel
 * lived against them). Each fails with its mutant.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { minerEndpoint } from "../src/miner/endpoint.js";
import { minerHttp } from "../src/miner/http.js";
import { rig, turnArgs, upTo } from "./lib/miner-run.js";
import { referenceReady } from "./lib/sr25519-reference.js";

beforeAll(referenceReady);

describe("C7: the turn's answer must be status 200, whatever the transport hands back", () => {
  it("HOLDS: a 201 answer that carries a receipt body is refused, and C signs no ack", async () => {
    const r = rig({ status: { turn: 201 } });
    await upTo(r, "notifyOpen");
    await expect(r.run.turn(turnArgs())).rejects.toThrow(expect.objectContaining({ refusal: "ANSWER", code: 1 }));
    expect(r.signs.ack).toBe(0);
  });
});

describe("C4: a refused answer's body is cancelled, not left open", () => {
  it("HOLDS: a redirect and a type not JSON each cancel the body they will not read", async () => {
    for (const [status, type] of [[302, "application/json"], [200, "text/html"]] as const) {
      let cancelled = false;
      const s = new ReadableStream({ pull() { return new Promise(() => undefined); }, cancel() { cancelled = true; } });
      const t = minerHttp(minerEndpoint("https://qzhost.example"), async () => new Response(s, { status, headers: { "content-type": type } }));
      await expect(t({ call: "info", body: null, signed: { "x-flop-channel": `0x${"77".repeat(32)}`, "x-flop-timestamp": "1", "x-flop-nonce": `0x${"5a".repeat(16)}`, "x-flop-challenge": "ab".repeat(32), "x-flop-signature": `0x${"12".repeat(64)}` }, maxBytes: 100, timeMs: 500 })).rejects.toThrow();
      await Promise.resolve();
      expect(cancelled, String(status)).toBe(true);
    }
  });
});
