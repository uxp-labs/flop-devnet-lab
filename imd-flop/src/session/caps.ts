/**
 * The caps of a grant, derived exactly from the seat's own local caps (P5b, rule C9, the lead's G-14):
 *  - per_tx_limit = raw(the seat's per call cap)
 *  - daily_cap = raw(the seat's daily cap)
 *  - spending_cap = raw(the daily cap) times days
 *  - duration_blocks = the runtime's SessionEpochLength times days
 * raw(x) is x's count of millionths (rounding.ts gridMicro) times 10^12, as a bigint, and nothing else. A cap off the
 * 6 decimal grid has no exact raw amount and refuses with exit 3. A missing or malformed cap refuses as `run` refuses
 * it (policy.ts requireCap, exit 3). Pure.
 */
import type { SeatCap } from "../config.js";
import { CliError, EXIT } from "../errors.js";
import { requireCap } from "../policy.js";
import { gridMicro } from "../rounding.js";

/** Raw units per millionth of a FLOP: 10^18 raw per FLOP over 10^6 millionths. */
export const RAW_PER_MICRO = 10n ** 12n;

/** The most days a grant may stand: ten epochs, the runtime's MaxSessionDuration of 864000 blocks at 1014020. */
export const MAX_DAYS = 10;

/** The raw amount of a local cap on the 6 decimal grid, or exit 3 with words that say to set a cap on the grid. */
export function rawOf(x: number, what: string, seat: string): bigint {
  const micro = gridMicro(x);
  if (micro === null) {
    throw new CliError(`the ${what} of seat ${seat}, ${x} FLOP, is not on the 6 decimal grid, so it has no exact raw amount and no grant is printed. Set a cap with at most 6 decimals with \`imd-flop cap set <FLOP/day> --per-call <FLOP>\``, EXIT.REFUSED_CAP);
  }
  return BigInt(micro) * RAW_PER_MICRO;
}

/** The seat's two local caps in raw units: checked by requireCap, then each on the grid. */
export interface LocalRaw {
  readonly cap: SeatCap;
  readonly perCall: bigint;
  readonly daily: bigint;
}

export function localRaw(caps: Record<string, SeatCap>, seat: string): LocalRaw {
  const cap = requireCap(caps, seat);
  return Object.freeze({ cap, perCall: rawOf(cap.perCall, "per call cap", seat), daily: rawOf(cap.daily, "daily cap", seat) });
}

/**
 * `--days`: required, a whole number from 1 to MAX_DAYS written in decimal with no leading zero, with no default.
 * Anything else is a usage error, exit 2.
 */
export function daysOf(text: string | undefined): number {
  if (text === undefined) throw new CliError(`--days <1..${MAX_DAYS}> is required: how many epochs of the chain's daily cap the grant stands, with no default`, EXIT.USAGE);
  if (!/^[1-9][0-9]?$/.test(text) || Number(text) > MAX_DAYS) throw new CliError(`--days must be a whole number from 1 to ${MAX_DAYS}`, EXIT.USAGE);
  return Number(text);
}

/** The values of a grant, with the metadata's field names. */
export interface GrantCaps {
  readonly spending_cap: bigint;
  readonly per_tx_limit: bigint;
  readonly daily_cap: bigint;
  readonly duration_blocks: number;
}

/** The grant's caps from the seat's local caps, the days and the runtime's epoch length. */
export function grantCaps(local: LocalRaw, days: number, epochLength: number): GrantCaps {
  return Object.freeze({
    per_tx_limit: local.perCall,
    daily_cap: local.daily,
    spending_cap: local.daily * BigInt(days),
    duration_blocks: epochLength * days,
  });
}
