/**
 * The bytes of a compute channel that the channel key works with: the channel id, the receipt and the turn ack
 * (rules B1 to B5). Bytes only: no hex, no signing. Every integer is fixed width and little endian.
 *
 * The layouts are FLOP's SDK 0.6.0 as shipped, `dist/compute-channel/transcript.js`, read and not imported. The
 * pallet's own source is not public, so what the chain has shown is said at each function.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { asciiOf, bytesOf, concat, takeFields, uintLE, uintOf } from "./bytes.js";
import { freezeFunction } from "../freeze.js";

/** The domain text of the channel id, 23 ASCII bytes. */
export const CHANNEL_ID_DOMAIN = "FLOP/COMPUTE_CHANNEL/ID";
/** The version byte of the channel id, after its domain. */
export const CHANNEL_ID_VERSION = 1;
/** The domain text of the receipt, 28 ASCII bytes. */
export const RECEIPT_DOMAIN = "FLOP/COMPUTE_CHANNEL/RECEIPT";
/** The version byte of the receipt, after its domain. */
export const RECEIPT_VERSION = 1;

/** The fields of each function, in their order in the bytes. */
const CHANNEL_ID_FIELDS = Object.freeze(["genesis", "agent", "miner", "nonce"] as const);
const RECEIPT_FIELDS = Object.freeze(["channelId", "finalRoot", "aggregateGn", "payable"] as const);
const TURN_ACK_FIELDS = Object.freeze(["channelId", "turnIndex", "leafHash", "agentSendMs", "agentRecvMs"] as const);

export interface ChannelIdInput {
  /** The genesis hash of the chain, 32 bytes. */
  readonly genesis: Uint8Array;
  /** The account that opens the channel, 32 bytes: the session's owner when the open goes through a session. Not the channel key. */
  readonly agent: Uint8Array;
  /** The miner's account, 32 bytes. */
  readonly miner: Uint8Array;
  /** The channel nonce, a u64. */
  readonly nonce: bigint;
}

export interface ReceiptInput {
  readonly channelId: Uint8Array;
  readonly finalRoot: Uint8Array;
  /** u128. */
  readonly aggregateGn: bigint;
  /** u128. */
  readonly payable: bigint;
}

export interface TurnAckInput {
  readonly channelId: Uint8Array;
  /** u32. */
  readonly turnIndex: number;
  readonly leafHash: Uint8Array;
  /** u64, milliseconds. */
  readonly agentSendMs: bigint;
  /** u64, milliseconds. */
  readonly agentRecvMs: bigint;
}

/**
 * The channel id, 32 bytes:
 * `blake2b-256( "FLOP/COMPUTE_CHANNEL/ID" ‖ 0x01 ‖ genesis[32] ‖ agent[32] ‖ miner[32] ‖ nonce u64 LE )`.
 *
 * Source: FLOP's SDK 0.6.0, `dist/compute-channel/transcript.js`, `channelIdV1`.
 * Status: shown on chain for `force_open`, on three of the lab's records at spec 1014014 and 1014020. Inferred,
 * not shown, for `open_channel`.
 */
export function channelId(input: ChannelIdInput): Uint8Array {
  const f = takeFields(input, CHANNEL_ID_FIELDS, "channelId input");
  const genesis = bytesOf(f.genesis, 32, "channelId genesis");
  const agent = bytesOf(f.agent, 32, "channelId agent");
  const miner = bytesOf(f.miner, 32, "channelId miner");
  const nonce = uintOf("u64", f.nonce, "channelId nonce");
  const preimage = concat(asciiOf(CHANNEL_ID_DOMAIN, "the channel id domain"), Uint8Array.of(CHANNEL_ID_VERSION), genesis, agent, miner, uintLE(nonce, 8));
  return blake2b(preimage, { dkLen: 32 });
}
freezeFunction(channelId);

/**
 * The receipt message, 125 bytes, not hashed:
 * `"FLOP/COMPUTE_CHANNEL/RECEIPT" ‖ 0x01 ‖ channelId[32] ‖ finalRoot[32] ‖ aggregateGn u128 LE ‖ payable u128 LE`.
 * There is no rule on what payable is: the cooperative receipt and the checkpoint are both this layout.
 *
 * Source: FLOP's SDK 0.6.0, `dist/compute-channel/transcript.js`, `receiptMessage`.
 * Status: in two cooperative settles the chain took at spec 1014014 (blocks 3479299 and 3479277), the settle call's
 * agent_receipt_sig verifies over these bytes under the stored agent_key, with payable equal to the channel's stored
 * escrow (test/channel-receipt-vector.test.ts, on the observatory's sixth recording). Every u128 in those settles is
 * below 2^64, so the upper 8 bytes of aggregateGn and of payable are as the SDK describes them. Not shown: that the
 * chain checks that signature or refuses a settle signed over other bytes, anything at spec 1014020, a settle that is
 * not cooperative.
 */
export function receiptMessage(input: ReceiptInput): Uint8Array {
  const f = takeFields(input, RECEIPT_FIELDS, "receipt input");
  const id = bytesOf(f.channelId, 32, "receipt channelId");
  const root = bytesOf(f.finalRoot, 32, "receipt finalRoot");
  const gn = uintOf("u128", f.aggregateGn, "receipt aggregateGn");
  const payable = uintOf("u128", f.payable, "receipt payable");
  return concat(asciiOf(RECEIPT_DOMAIN, "the receipt domain"), Uint8Array.of(RECEIPT_VERSION), id, root, uintLE(gn, 16), uintLE(payable, 16));
}
freezeFunction(receiptMessage);

/**
 * The turn ack message, 84 bytes, not hashed, with no domain:
 * `channelId[32] ‖ turnIndex u32 LE ‖ leafHash[32] ‖ agentSendMs u64 LE ‖ agentRecvMs u64 LE`.
 * There is no rule on the order of the two times.
 *
 * Source: FLOP's SDK 0.6.0, `dist/compute-channel/transcript.js`, `turnAckMessage`.
 * Status: as the SDK describes it. Not yet held to a miner.
 */
export function turnAckMessage(input: TurnAckInput): Uint8Array {
  const f = takeFields(input, TURN_ACK_FIELDS, "turn ack input");
  const id = bytesOf(f.channelId, 32, "turn ack channelId");
  const turn = uintOf("u32", f.turnIndex, "turn ack turnIndex");
  const leaf = bytesOf(f.leafHash, 32, "turn ack leafHash");
  const send = uintOf("u64", f.agentSendMs, "turn ack agentSendMs");
  const recv = uintOf("u64", f.agentRecvMs, "turn ack agentRecvMs");
  return concat(id, uintLE(BigInt(turn), 4), leaf, uintLE(send, 8), uintLE(recv, 8));
}
freezeFunction(turnAckMessage);
