/**
 * The room for one call through a session (P5b, rule C14, the lead's G-17). Pure: it takes the read's values, the
 * head's number, the runtime's constants and the encoder's era period, and answers a value with a reason.
 *
 *  - known: the least of per_tx_limit, daily_cap less epoch_spent, and spending_cap less spent, never below 0.
 *  - none, with every reason that applies: no session; the session is not active; the head plus the era period
 *    reaches expires_at (a call signed now may land up to that many blocks later); the allow list is neither empty
 *    nor holds ComputeChannel in any case of letters; the breaker is tripped.
 *  - unknown, with the reasons: the runtime is not one the encoder knows (rule C8), or a value the room needs is
 *    unknown and no known value already rules a call out.
 *
 * A known reason for none wins over an unknown value: whatever the unknown value is, a call cannot be made. An empty
 * allow list means every pallet, so the room is computed (show says that is not a grant this tool writes).
 */
import type { CircuitBreakerRecord, SessionRecord } from "../chain-read/session-state.js";
import type { Got, Stored } from "../chain-read/result.js";

/** The pallet a session call of this tool goes to. */
export const CHANNEL_PALLET = "ComputeChannel";

export interface RoomInput {
  readonly head: number;
  readonly session: Stored<SessionRecord>;
  readonly breaker: Stored<CircuitBreakerRecord>;
  /** The runtime's constants, unknown when the runtime is not in the encoder's table. Only whether they are known matters here. */
  readonly constants: Got<unknown>;
  /** The encoder's era period in blocks (chain/era.ts ERA_PERIOD). */
  readonly eraPeriod: number;
}

/** The three bounds of a known room, in raw units, each never below 0. */
export interface Bounds {
  readonly per_tx_limit: bigint;
  readonly epoch_left: bigint;
  readonly lifetime_left: bigint;
}

export type Room =
  | { readonly kind: "known"; readonly raw: bigint; readonly bounds: Bounds }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/** The bytes of 0x hex. */
const bytesOf = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.slice(2), "hex"));

/** ASCII letters lowered, other bytes kept: the chain matched `computechannel` to ComputeChannel (rerun B1). */
const lowered = (b: Uint8Array): string => Array.from(b, (x) => (x >= 0x41 && x <= 0x5a ? x + 0x20 : x)).join(",");
const CHANNEL_LOWERED = lowered(new TextEncoder().encode(CHANNEL_PALLET.toLowerCase()));

/** Whether an allow list, as the read gives it (0x hex names), holds ComputeChannel in any case of letters. */
export function holdsChannel(allowed: readonly string[]): boolean {
  return allowed.some((h) => lowered(bytesOf(h)) === CHANNEL_LOWERED);
}

const atLeastZero = (n: bigint): bigint => (n < 0n ? 0n : n);
const least = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));

/** The reasons a known session rules a call out. */
function sessionNone(s: SessionRecord, head: number, eraPeriod: number): string[] {
  const out: string[] = [];
  if (!s.active) out.push("the session is not active (revoked)");
  if (head + eraPeriod >= s.expires_at) out.push(`the head ${head} plus the era period of ${eraPeriod} blocks reaches expires_at ${s.expires_at}: a call signed now may land up to ${eraPeriod} blocks later, at or past the expiry`);
  if (s.allowed_pallets.length > 0 && !holdsChannel(s.allowed_pallets)) out.push(`the allow list does not hold ${CHANNEL_PALLET}`);
  return out;
}

export function roomOf(i: RoomInput): Room {
  if (i.constants.kind === "unknown") return { kind: "unknown", reason: `the runtime is not one the encoder knows (${i.constants.reason})` };
  const none: string[] = [];
  const unknowns: string[] = [];
  if (i.session.kind === "absent") none.push("no session is stored for this owner and device");
  else if (i.session.kind === "unknown") unknowns.push(`the session is unknown (${i.session.reason})`);
  else none.push(...sessionNone(i.session.value, i.head, i.eraPeriod));
  if (i.breaker.kind === "unknown") unknowns.push(`the circuit breaker is unknown (${i.breaker.reason})`);
  else if (i.breaker.kind === "known" && i.breaker.value.tripped) none.push("the circuit breaker is tripped");
  if (none.length > 0) return { kind: "none", reason: none.join("; ") };
  if (unknowns.length > 0 || i.session.kind !== "known") return { kind: "unknown", reason: unknowns.join("; ") };
  const s = i.session.value;
  const bounds: Bounds = { per_tx_limit: s.per_tx_limit, epoch_left: atLeastZero(s.daily_cap - s.epoch_spent), lifetime_left: atLeastZero(s.spending_cap - s.spent) };
  return { kind: "known", raw: least(bounds.per_tx_limit, bounds.epoch_left, bounds.lifetime_left), bounds };
}
