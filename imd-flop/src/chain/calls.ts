/**
 * The calls the chain encoder writes (rule E3) and what each one moves (rule E5). One outer call,
 * FlopSessionKeys.execute_via_session, around exactly one of five inner calls of ComputeChannel. The
 * encoder and the strict reader both stand on this list; nothing else is written or read, but for the two
 * calls of the session's owner below (P5a), which are call bytes only and never go inside a session call.
 */
import { refuse } from "./errors.js";
import { freezeFunction } from "../freeze.js";

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
freezeFunction(isInnerName);

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
freezeFunction(spendOf);

/**
 * The two calls of the session's owner (P5a, O1): the grant and the revoke of FlopSessionKeys. The encoder writes
 * them as call bytes only, for the owner to sign with his own tool: it never signs one (O2).
 */
export const OWNER_PALLET = OUTER.pallet;
export const OWNER_NAMES = Object.freeze(["create_session", "revoke_session"] as const);
export type OwnerName = (typeof OWNER_NAMES)[number];

export function isOwnerName(name: unknown): name is OwnerName {
  return typeof name === "string" && (OWNER_NAMES as readonly string[]).includes(name);
}
freezeFunction(isOwnerName);

/**
 * The one name a grant's allow list holds (P5a, O7): the pallet of the five inner calls, as its UTF-8 bytes. It is
 * not an input: the encoder writes exactly this list and the strict reader reads no other.
 */
export const OWNER_ALLOWED_PALLET = INNER_PALLET;

/** The two constants of the owner's pallet the grant is bounded by (P5a, O3, O13), by their metadata names. */
export const OWNER_CONSTANTS = Object.freeze({ maxSessionDuration: "MaxSessionDuration", sessionEpochLength: "SessionEpochLength" } as const);

/** The allow list of a grant as bytes (P5a, O7): the UTF-8 bytes of OWNER_ALLOWED_PALLET, alone, in a fresh list each time. */
export function allowedPallets(): Uint8Array[] {
  return [new TextEncoder().encode(OWNER_ALLOWED_PALLET)];
}
freezeFunction(allowedPallets);
