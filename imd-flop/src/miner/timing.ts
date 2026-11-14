/**
 * The two unsigned fields of the ack (R6): the timing status and the scored latency, computed as FLOP's SDK 0.6.0
 * computes them, read and not imported: `dist/compute-channel/protocol.js`, `evaluateReceiptTiming`, called from
 * `agent-client.js` (`buildTurnAck`) with no bounds by `session.js` (`turn`, `chatTurn`), so with the SDK's own
 * defaults: a clock skew of 250 ms and a network pad of 100 ms. Every input is a value the client already holds:
 * the buyer's send and receive times around the turn call, and the miner's three times from the verified turn.
 *
 * The SDK signs no ack whose timing is Invalid: the buyer's clock reversed, the miner's clock reversed, or a latency
 * that is not done minus receive. Those refuse here (TURN), before C signs. verifyTurn has refused the last two
 * already; they are kept here so this function is the SDK's whole rule.
 */
import { freezeFunction } from "../freeze.js";
import { bigIn, fieldsOf } from "./check.js";
import { refuseMiner } from "./errors.js";

/** The SDK's default `maxClockSkewMs`. */
export const CLOCK_SKEW_MS = 250;
/** The SDK's default `networkPadMs`. */
export const NETWORK_PAD_MS = 100;
/** The statuses an ack may carry. Invalid is never sent. */
export const TIMING_STATUSES = Object.freeze(["Eligible", "Ambiguous"] as const);
export type TimingStatus = (typeof TIMING_STATUSES)[number];

export interface AckTimingInput {
  readonly agentSendMs: bigint;
  readonly agentRecvMs: bigint;
  readonly minerRecvMs: bigint;
  readonly minerDoneMs: bigint;
  readonly latencyMs: bigint;
}

export interface AckTiming {
  readonly timingStatus: TimingStatus;
  readonly scoredLatencyMs: bigint;
}

const FIELDS = Object.freeze(["agentSendMs", "agentRecvMs", "minerRecvMs", "minerDoneMs", "latencyMs"] as const);

/**
 * In the SDK's order: the buyer's receive before its send refuses; the miner's done before its receive refuses; a
 * latency other than done minus receive refuses. Then, with the pad of skew plus network (350 ms): when the latency
 * the buyer saw plus the pad is below the miner's latency, Ambiguous and the miner's latency is scored; otherwise
 * Eligible and the smaller of the buyer's latency and the miner's latency plus the pad is scored.
 */
export function ackTiming(input: AckTimingInput): AckTiming {
  const f = fieldsOf(input, FIELDS, "ack timing");
  const v = Object.fromEntries(FIELDS.map((k) => [k, bigIn("u64", f[k], `ack timing.${k}`)])) as Record<(typeof FIELDS)[number], bigint>;
  if (v.agentRecvMs < v.agentSendMs) refuseMiner("TURN", "turn.timing.agent", "the buyer's receive time is before its send time: the SDK signs no ack for that turn");
  if (v.minerDoneMs < v.minerRecvMs) refuseMiner("TURN", "turn.timing.order", "the miner's done time is before its receive time");
  const minerLatency = v.minerDoneMs - v.minerRecvMs;
  if (v.latencyMs !== minerLatency) refuseMiner("TURN", "turn.timing.latency", "the latency is not done minus receive");
  const observed = v.agentRecvMs - v.agentSendMs;
  const pad = BigInt(CLOCK_SKEW_MS + NETWORK_PAD_MS);
  if (observed + pad < v.latencyMs) return Object.freeze({ timingStatus: "Ambiguous", scoredLatencyMs: v.latencyMs });
  const capped = v.latencyMs + pad;
  return Object.freeze({ timingStatus: "Eligible", scoredLatencyMs: observed < capped ? observed : capped });
}
freezeFunction(ackTiming);
