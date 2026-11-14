/**
 * P6b, R6 and the request bodies: the ack's unsigned timing fields as FLOP's SDK 0.6.0 `evaluateReceiptTiming`
 * computes them with its defaults (a skew of 250 ms and a pad of 100 ms), and each body text as the SDK writes it.
 * The expected texts are written here by hand.
 */
import { describe, expect, it } from "vitest";
import { ackTiming } from "../src/miner/timing.js";
import { ackBody, closeBody, openBody, proofBody, turnBody } from "../src/miner/requests.js";

const t = (send: bigint, recv: bigint, mRecv: bigint, mDone: bigint, lat = mDone - mRecv) => ackTiming({ agentSendMs: send, agentRecvMs: recv, minerRecvMs: mRecv, minerDoneMs: mDone, latencyMs: lat });

describe("R6: the timing status and the scored latency", () => {
  it("Eligible, and the buyer's latency scored when it is the smaller", () => {
    expect(t(1000n, 1700n, 50n, 637n)).toEqual({ timingStatus: "Eligible", scoredLatencyMs: 700n });
  });
  it("Eligible, and the miner's latency plus 350 scored when the buyer's is larger", () => {
    expect(t(1000n, 5000n, 0n, 100n)).toEqual({ timingStatus: "Eligible", scoredLatencyMs: 450n });
  });
  it("Eligible at the boundary: the buyer's latency plus 350 equal to the miner's", () => {
    expect(t(0n, 650n, 0n, 1000n)).toEqual({ timingStatus: "Eligible", scoredLatencyMs: 650n });
  });
  it("Ambiguous one below the boundary, and the miner's latency scored", () => {
    expect(t(0n, 649n, 0n, 1000n)).toEqual({ timingStatus: "Ambiguous", scoredLatencyMs: 1000n });
  });
  it("Invalid is never sent: the buyer's clock reversed, the miner's clock reversed, a latency mismatch", () => {
    expect(() => t(10n, 9n, 0n, 1n)).toThrow(expect.objectContaining({ check: "turn.timing.agent" }));
    expect(() => t(0n, 9n, 5n, 1n, 0n)).toThrow(expect.objectContaining({ check: "turn.timing.order" }));
    expect(() => t(0n, 9n, 0n, 5n, 4n)).toThrow(expect.objectContaining({ check: "turn.timing.latency" }));
  });
});

const id = new Uint8Array(32).fill(0x77);
const h = (b: number, n: number) => b.toString(16).padStart(2, "0").repeat(n);

describe("the request bodies, as the SDK writes them", () => {
  it("proof: the challenge as bare hex", () => {
    expect(proofBody({ challenge: new Uint8Array(32).fill(0xab) })).toBe(`{"challenge":"${h(0xab, 32)}"}`);
  });
  it("open: the channel id and C's public key, 0x hex, in that order", () => {
    expect(openBody({ channelId: id, agentKey: new Uint8Array(32).fill(1) })).toBe(`{"channelId":"0x${h(0x77, 32)}","agentKey":"0x${h(1, 32)}"}`);
  });
  it("turn: the channel id and the input bytes, 0x hex", () => {
    expect(turnBody({ channelId: id, input: Uint8Array.of(0x7b, 0x7d) })).toBe(`{"channelId":"0x${h(0x77, 32)}","input":"0x7b7d"}`);
  });
  it("ack: the SDK's eight fields in its order, the turn index a number and the times decimal texts", () => {
    const text = ackBody({ channelId: id, turnIndex: 0, leafHash: new Uint8Array(32).fill(2), agentSendMs: 10n, agentRecvMs: 20n, agentSig: new Uint8Array(64).fill(3), timingStatus: "Eligible", scoredLatencyMs: 10n });
    expect(text).toBe(`{"channelId":"0x${h(0x77, 32)}","turnIndex":0,"leafHash":"0x${h(2, 32)}","agentSendMs":"10","agentRecvMs":"20","agentSig":"0x${h(3, 64)}","timingStatus":"Eligible","scoredLatencyMs":"10"}`);
  });
  it("ack: a timing status of Invalid or anything else is refused", () => {
    const base = { channelId: id, turnIndex: 0, leafHash: new Uint8Array(32), agentSendMs: 1n, agentRecvMs: 2n, agentSig: new Uint8Array(64), scoredLatencyMs: 1n };
    for (const s of ["Invalid", "eligible", ""]) expect(() => ackBody({ ...base, timingStatus: s as never })).toThrow();
  });
  it("close: the SDK's seven fields in its order, the counts decimal texts, the transcript reference null", () => {
    const text = closeBody({ channelId: id, finalRoot: new Uint8Array(32).fill(4), aggregateGn: 38n, payable: 123456789n, agentReceiptSig: new Uint8Array(64).fill(5), claimedMeasuredRoot: new Uint8Array(32).fill(6) });
    expect(text).toBe(`{"channelId":"0x${h(0x77, 32)}","finalRoot":"0x${h(4, 32)}","aggregateGn":"38","payable":"123456789","agentReceiptSig":"0x${h(5, 64)}","claimedMeasuredRoot":"0x${h(6, 32)}","transcriptRef":null}`);
  });
  it("close: there is no field for a transcript reference", () => {
    const base = { channelId: id, finalRoot: new Uint8Array(32), aggregateGn: 1n, payable: 1n, agentReceiptSig: new Uint8Array(64), claimedMeasuredRoot: new Uint8Array(32) };
    expect(() => closeBody({ ...base, transcriptRef: {} } as never)).toThrow();
  });
});
