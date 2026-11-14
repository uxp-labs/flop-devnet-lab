/**
 * The body text of each request the client sends, written here from what FLOP's SDK 0.6.0 does, read and not
 * imported. Each is `JSON.stringify` of an object whose keys are in the SDK's order, hex in lower case. Pure: no
 * I/O, no clock, no signing. The signatures are handed in, made by C before.
 *
 * - proof: `{challenge}`, bare hex of 32 bytes (`miner-admission.js`, `fetchSessionInfoProof`).
 * - open: `{channelId, agentKey}`, 0x hex (`transport-http.js`, `notifyMinerOpen`).
 * - turn: `{channelId, input}`, 0x hex (`transport-http.js`, `serveTurn`).
 * - ack: `{channelId, turnIndex, leafHash, agentSendMs, agentRecvMs, agentSig, timingStatus, scoredLatencyMs}`, the
 *   turn index a number and the times decimal texts (`transport-http.js`, `recordAck`).
 * - close: `{channelId, finalRoot, aggregateGn, payable, agentReceiptSig, claimedMeasuredRoot, transcriptRef}`, the
 *   counts decimal texts and the transcript reference null (`transport-http.js`, `cooperativeCloseBody`; M-10).
 */
import { hexOf } from "../channel/bytes.js";
import { freezeFunction } from "../freeze.js";
import { bigIn, bytesIn, fieldsOf, wholeIn } from "./check.js";
import { refuseMiner } from "./errors.js";
import { TIMING_STATUSES, type TimingStatus } from "./timing.js";

/** The proof request: the challenge as bare hex. */
export function proofBody(input: { readonly challenge: Uint8Array }): string {
  const f = fieldsOf(input, ["challenge"], "proof body");
  return JSON.stringify({ challenge: hexOf(bytesIn(f.challenge, 32, "proof body.challenge")).slice(2) });
}
freezeFunction(proofBody);

/** The open notice: the channel id and C's public key. */
export function openBody(input: { readonly channelId: Uint8Array; readonly agentKey: Uint8Array }): string {
  const f = fieldsOf(input, ["channelId", "agentKey"], "open body");
  return JSON.stringify({ channelId: hexOf(bytesIn(f.channelId, 32, "open body.channelId")), agentKey: hexOf(bytesIn(f.agentKey, 32, "open body.agentKey")) });
}
freezeFunction(openBody);

/** The turn request: the channel id and the input bytes. */
export function turnBody(input: { readonly channelId: Uint8Array; readonly input: Uint8Array }): string {
  const f = fieldsOf(input, ["channelId", "input"], "turn body");
  return JSON.stringify({ channelId: hexOf(bytesIn(f.channelId, 32, "turn body.channelId")), input: hexOf(bytesIn(f.input, null, "turn body.input")) });
}
freezeFunction(turnBody);

export interface AckBodyInput {
  readonly channelId: Uint8Array;
  readonly turnIndex: number;
  readonly leafHash: Uint8Array;
  readonly agentSendMs: bigint;
  readonly agentRecvMs: bigint;
  readonly agentSig: Uint8Array;
  readonly timingStatus: TimingStatus;
  readonly scoredLatencyMs: bigint;
}
const ACK_FIELDS = Object.freeze(["channelId", "turnIndex", "leafHash", "agentSendMs", "agentRecvMs", "agentSig", "timingStatus", "scoredLatencyMs"] as const);

/** The ack. The timing status and the scored latency are not signed (`recordAck`); timing.ts computes them. */
export function ackBody(input: AckBodyInput): string {
  const f = fieldsOf(input, ACK_FIELDS, "ack body");
  if (typeof f.timingStatus !== "string" || !(TIMING_STATUSES as readonly string[]).includes(f.timingStatus)) refuseMiner("BAD_INPUT", "ack body.timingStatus", `ack body.timingStatus must be one of ${TIMING_STATUSES.join(", ")}`);
  return JSON.stringify({
    channelId: hexOf(bytesIn(f.channelId, 32, "ack body.channelId")),
    turnIndex: wholeIn(f.turnIndex, 0, 0xffffffff, "ack body.turnIndex"),
    leafHash: hexOf(bytesIn(f.leafHash, 32, "ack body.leafHash")),
    agentSendMs: bigIn("u64", f.agentSendMs, "ack body.agentSendMs").toString(10),
    agentRecvMs: bigIn("u64", f.agentRecvMs, "ack body.agentRecvMs").toString(10),
    agentSig: hexOf(bytesIn(f.agentSig, 64, "ack body.agentSig")),
    timingStatus: f.timingStatus,
    scoredLatencyMs: bigIn("u64", f.scoredLatencyMs, "ack body.scoredLatencyMs").toString(10),
  });
}
freezeFunction(ackBody);

export interface CloseBodyInput {
  readonly channelId: Uint8Array;
  readonly finalRoot: Uint8Array;
  readonly aggregateGn: bigint;
  readonly payable: bigint;
  readonly agentReceiptSig: Uint8Array;
  readonly claimedMeasuredRoot: Uint8Array;
}
const CLOSE_FIELDS = Object.freeze(["channelId", "finalRoot", "aggregateGn", "payable", "agentReceiptSig", "claimedMeasuredRoot"] as const);

/** The cooperative close. The transcript reference is always null: a reference that is not null is refused outright (M-10). */
export function closeBody(input: CloseBodyInput): string {
  const f = fieldsOf(input, CLOSE_FIELDS, "close body");
  return JSON.stringify({
    channelId: hexOf(bytesIn(f.channelId, 32, "close body.channelId")),
    finalRoot: hexOf(bytesIn(f.finalRoot, 32, "close body.finalRoot")),
    aggregateGn: bigIn("u128", f.aggregateGn, "close body.aggregateGn").toString(10),
    payable: bigIn("u128", f.payable, "close body.payable").toString(10),
    agentReceiptSig: hexOf(bytesIn(f.agentReceiptSig, 64, "close body.agentReceiptSig")),
    claimedMeasuredRoot: hexOf(bytesIn(f.claimedMeasuredRoot, 32, "close body.claimedMeasuredRoot")),
    transcriptRef: null,
  });
}
freezeFunction(closeBody);
