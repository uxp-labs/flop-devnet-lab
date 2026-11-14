/**
 * The lab's own money bounds (W17 to W19, M-7, M-8). The miner states G_n and nothing in FLOP's client checks it
 * against work, and a cooperative settle pays the whole escrow. So the lab holds its own bounds, all handed in by P7
 * as whole numbers of raw units, each a bigint inside a u128. A product or a sum past a u128 refuses.
 */
import { freezeFunction } from "../freeze.js";
import { bigIn, fieldsOf } from "./check.js";
import { refuseMiner } from "./errors.js";
import { u128Max } from "./forms.js";

/** The value, or null past a u128. */
function within(n: bigint): bigint | null {
  return n <= u128Max() ? n : null;
}

export interface TurnCostInput {
  readonly gN: bigint;
  /** The most G_n one turn may claim. */
  readonly gnCeiling: bigint;
  readonly pricePerGn: bigint;
  readonly basePerTurn: bigint;
  /** The escrow at open. */
  readonly floor: bigint;
  /** B, the most the run may pay. */
  readonly budget: bigint;
}

export interface TurnCost {
  /** G_n times pricePerGn plus basePerTurn. */
  readonly cost: bigint;
  /** floor plus cost. */
  readonly total: bigint;
}

const TURN_COST_FIELDS = Object.freeze(["gN", "gnCeiling", "pricePerGn", "basePerTurn", "floor", "budget"] as const);

/**
 * The turn's cost (W17). Refused (MONEY): G_n above the ceiling; a cost or a total past a u128; floor plus cost
 * above the budget. Equal to the budget is accepted.
 */
export function turnCost(input: TurnCostInput): TurnCost {
  const f = fieldsOf(input, TURN_COST_FIELDS, "turn cost");
  const v = Object.fromEntries(TURN_COST_FIELDS.map((k) => [k, bigIn("u128", f[k], `turn cost.${k}`)])) as Record<(typeof TURN_COST_FIELDS)[number], bigint>;
  if (v.gN > v.gnCeiling) refuseMiner("MONEY", "money.gnCeiling", "G_n is above the ceiling for one turn");
  const cost = within(v.gN * v.pricePerGn + v.basePerTurn);
  if (cost === null) return refuseMiner("MONEY", "money.cost", "G_n times the price plus the base is past a u128");
  const total = within(v.floor + cost);
  if (total === null) return refuseMiner("MONEY", "money.total", "the floor plus the cost is past a u128");
  if (total > v.budget) refuseMiner("MONEY", "money.budget", "the floor plus the cost is above the budget");
  return Object.freeze({ cost, total });
}
freezeFunction(turnCost);

export interface TariffInput {
  readonly basePerTurn: bigint;
  readonly turns: bigint;
  readonly aggregateGn: bigint;
}

/** The sum past a u128, or the chain's tariff. */
function tariffOf(base: bigint, turns: bigint, agg: bigint): bigint | null {
  return within(base * turns + agg);
}

/**
 * The chain's tariff (W18): basePerTurn times the number of turns plus the aggregate G_n, in raw units
 * (`transcript.js`, `forceSettlePayable`). Refused (MONEY) past a u128.
 */
export function chainTariff(input: TariffInput): bigint {
  const f = fieldsOf(input, ["basePerTurn", "turns", "aggregateGn"], "chain tariff");
  const t = tariffOf(bigIn("u128", f.basePerTurn, "chain tariff.basePerTurn"), bigIn("u128", f.turns, "chain tariff.turns"), bigIn("u128", f.aggregateGn, "chain tariff.aggregateGn"));
  if (t === null) return refuseMiner("MONEY", "money.tariff", "the chain's tariff is past a u128");
  return t;
}
freezeFunction(chainTariff);

export interface ReceiptPayableInput extends TariffInput {
  /** The escrow P7 read back from the chain. */
  readonly payable: bigint;
  readonly budget: bigint;
}

/**
 * The receipt's payable (W19). Refused (RECEIPT): the payable 0, above the budget, or below the chain's tariff (or
 * that tariff past a u128). No other rule: how the floor counts toward the bill is not shown by any file (M-8).
 * Returns the payable and the tariff.
 */
export function receiptPayable(input: ReceiptPayableInput): { readonly payable: bigint; readonly tariff: bigint } {
  const f = fieldsOf(input, ["payable", "budget", "basePerTurn", "turns", "aggregateGn"], "receipt payable");
  const payable = bigIn("u128", f.payable, "receipt payable.payable");
  const budget = bigIn("u128", f.budget, "receipt payable.budget");
  const tariff = tariffOf(bigIn("u128", f.basePerTurn, "receipt payable.basePerTurn"), bigIn("u128", f.turns, "receipt payable.turns"), bigIn("u128", f.aggregateGn, "receipt payable.aggregateGn"));
  if (payable === 0n) refuseMiner("RECEIPT", "receipt.payable", "the payable is 0");
  if (payable > budget) refuseMiner("RECEIPT", "receipt.budget", "the payable is above the budget");
  if (tariff === null) return refuseMiner("RECEIPT", "receipt.tariff", "the chain's tariff is past a u128");
  if (payable < tariff) refuseMiner("RECEIPT", "receipt.tariff", "the payable is below the chain's tariff");
  return Object.freeze({ payable, tariff });
}
freezeFunction(receiptPayable);
