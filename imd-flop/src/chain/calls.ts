/**
 * The calls the chain encoder writes (rule E3) and what each one moves (rule E5). One outer call,
 * FlopSessionKeys.execute_via_session, around exactly one of five inner calls of ComputeChannel. The
 * encoder and the strict reader both stand on this list; nothing else is written or read.
 */
import { refuse } from "./errors.js";

export const OUTER = Object.freeze({ pallet: "FlopSessionKeys", name: "execute_via_session" } as const);
export const INNER_PALLET = "ComputeChannel";

/**
 * The five inner calls, each with the one field whose amount it moves out of the owner's account, or null
 * when it moves nothing out (a refund call). The declared spend of the outer call is that amount: it is
 * computed here, never passed in.
 */
export const INNER_CALLS = Object.freeze({
  open_channel: "escrow",
  top_up_escrow: "additional",
  timeout: null,
  force_open: "escrow",
  expire_force_open: null,
} as const);

export type InnerName = keyof typeof INNER_CALLS;
export const INNER_NAMES = Object.freeze(Object.keys(INNER_CALLS)) as readonly InnerName[];

export function isInnerName(name: unknown): name is InnerName {
  return typeof name === "string" && Object.hasOwn(INNER_CALLS, name);
}

/** Exactly 32 bytes: an account, a hash, a key. */
export type Bytes32 = Uint8Array;

export interface Sla {
  readonly max_turns: number;
  readonly max_duration: number;
  readonly reattest_every: number;
}

/** The inputs of the five inner calls, with the field names of the metadata. */
export type InnerCall =
  | {
      readonly call: "open_channel";
      readonly miner: Bytes32;
      readonly model_hash: Bytes32;
      readonly measured_root: Bytes32;
      readonly decode_policy_hash: Bytes32;
      /** A ModelPrecision name of the table, such as BF16. */
      readonly precision: string;
      readonly enclave_key: Bytes32;
      readonly agent_key: Bytes32;
      readonly sla: Sla;
      readonly escrow: bigint;
      readonly nonce: bigint;
      /** A SettlementClass name of the table, such as Standard. */
      readonly settlement_class: string;
    }
  | { readonly call: "top_up_escrow"; readonly channel_id: Bytes32; readonly additional: bigint }
  | { readonly call: "timeout"; readonly channel_id: Bytes32 }
  | {
      readonly call: "force_open";
      readonly miner: Bytes32;
      readonly model_hash: Bytes32;
      readonly measured_root: Bytes32;
      readonly decode_policy_hash: Bytes32;
      readonly precision: string;
      readonly agent_key: Bytes32;
      readonly sla: Sla;
      readonly escrow: bigint;
      readonly nonce: bigint;
    }
  | { readonly call: "expire_force_open"; readonly channel_id: Bytes32 };

/** The declared spend of an inner call: the amount it moves, or 0 for a call that moves nothing out. */
export function spendOf(inner: InnerCall): bigint {
  const name: unknown = (inner as { call?: unknown } | null)?.call;
  if (!isInnerName(name)) refuse("CALL_NOT_ALLOWED", `${String(name)} is not one of ${INNER_NAMES.join(", ")}`);
  const field = INNER_CALLS[inner.call];
  if (field === null) return 0n;
  const amount = (inner as unknown as Record<string, unknown>)[field];
  if (typeof amount !== "bigint") refuse("BAD_INPUT", `${inner.call}.${field} must be a bigint amount`);
  return amount;
}
