/**
 * P6b, R3: once C has signed the receipt, close does not throw. For each failing answer the receipt is still
 * returned, and the state is unknown with exit 6, never settled or not settled.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { hex, HEX_RUN } from "./lib/miner-answers.js";
import { PAYABLE, rig, upTo } from "./lib/miner-run.js";
import type { Switches } from "./lib/scripted-miner.js";
import { referenceReady, referenceVerify } from "./lib/sr25519-reference.js";
import { receiptMessage } from "../src/channel/transcript.js";

beforeAll(referenceReady);

async function closed(sw: Switches) {
  const r = rig(sw);
  await upTo(r, "turn");
  const c = await r.run.close({ payable: PAYABLE });
  // The receipt is handed back, whole, and verifies under C over its own fields.
  expect(r.signs.receipt).toBe(1);
  const msg = receiptMessage({ channelId: c.receipt.channelId, finalRoot: c.receipt.finalRoot, aggregateGn: c.receipt.aggregateGn, payable: c.receipt.payable });
  expect(referenceVerify(r.key.publicKey(), msg, c.receipt.signature)).toBe(true);
  expect(c.receipt.payable).toBe(PAYABLE);
  expect(r.miner.seen.map((x) => x.call)).toEqual(["proof", "probe", "info", "open", "turn", "ack", "close"]);
  return { r, c };
}

describe("R3: what close returns", () => {
  it("a hint: the miner named our channel and a transaction hash", async () => {
    const { r, c } = await closed({});
    expect(c.answer.state).toBe("hint");
    expect(hex((c.answer as { txHash: Uint8Array }).txHash)).toBe(hex(r.miner.txHash));
  });

  it("no hint: a 200 answer with no settled", async () => {
    const { c } = await closed({ settled: "none" });
    expect(c.answer).toEqual({ state: "none" });
  });

  const unknowns: [string, Switches, RegExp][] = [
    ["a settled for another channel", { settled: "other" }, /another channel/],
    ["a status other than 200", { status: { close: 502 } }, /status 502/],
    ["a status of 202", { status: { close: 202 } }, /status 202/],
    ["garbage", { garbage: "close" }, /not JSON/],
    ["an answer over its limit", { oversize: "close" }, /transport failed/],
    ["no answer", { fail: "close" }, /transport failed/],
  ];
  for (const [what, sw, reason] of unknowns) {
    it(`unknown, exit 6, for ${what}; the receipt is still returned`, async () => {
      const { c } = await closed(sw);
      expect(c.answer.state).toBe("unknown");
      const u = c.answer as { reason: string; exit: number };
      expect(u.exit).toBe(6);
      expect(u.reason).toMatch(reason);
      expect(u.reason).not.toMatch(HEX_RUN);
    });
  }

  it("unknown when the clock fails after the receipt was signed: close still returns", async () => {
    let n = 0;
    let t = 10_000n;
    // Six calls of the clock come before the close's own request: info, open, turn, send, receive, ack.
    const r = rig({}, { now: () => {
      n += 1;
      if (n > 6) throw new Error("clock gone");
      return (t += 700n);
    } });
    await upTo(r, "turn");
    const c = await r.run.close({ payable: PAYABLE });
    expect(c.answer.state).toBe("unknown");
    expect(r.signs.receipt).toBe(1);
    expect(r.miner.seen.map((x) => x.call)).not.toContain("close");
  });

  it("after close, every step refuses and sends nothing", async () => {
    const { r } = await closed({});
    await expect(r.run.close({ payable: PAYABLE })).rejects.toThrow(expect.objectContaining({ refusal: "ORDER" }));
    await expect(r.run.prove()).rejects.toThrow(expect.objectContaining({ refusal: "ORDER" }));
    expect(r.signs.receipt).toBe(1);
    expect(r.miner.seen).toHaveLength(7);
  });
});
