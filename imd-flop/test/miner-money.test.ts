/**
 * P6a, T6: the money bounds of src/miner/money.ts at their edges, each side of each bound, and a product or a sum
 * past a u128.
 */
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/errors.js";
import { MinerError } from "../src/miner/errors.js";
import { chainTariff, receiptPayable, turnCost } from "../src/miner/money.js";
import { HEX_RUN } from "./lib/miner-answers.js";

const MAX128 = (1n << 128n) - 1n;

function refused(run: () => unknown): MinerError {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(MinerError);
    expect((e as MinerError).message).not.toMatch(HEX_RUN);
    expect((e as MinerError).code).toBe(EXIT.ERROR);
    return e as MinerError;
  }
  throw new Error("not refused");
}

describe("T6: turnCost (W17)", () => {
  const base = { gN: 38n, gnCeiling: 100n, pricePerGn: 3_000_000_000_000_000n, basePerTurn: 1n, floor: 2n, budget: 114_000_000_000_000_003n };

  it("the cost is G_n times the price plus the base, and the total the floor plus the cost", () => {
    expect(turnCost(base)).toEqual({ cost: 114_000_000_000_000_001n, total: 114_000_000_000_000_003n });
  });

  it("the ceiling: G_n equal to it is accepted, one more is refused", () => {
    expect(turnCost({ ...base, gN: 100n, budget: MAX128 }).cost).toBe(300_000_000_000_000_001n);
    expect([refused(() => turnCost({ ...base, gN: 101n, budget: MAX128 })).refusal, refused(() => turnCost({ ...base, gN: 101n, budget: MAX128 })).check]).toEqual(["MONEY", "money.gnCeiling"]);
  });

  it("the budget: floor plus cost equal to it is accepted, one more is refused", () => {
    expect(turnCost(base).total).toBe(base.budget);
    expect(refused(() => turnCost({ ...base, budget: base.budget - 1n })).check).toBe("money.budget");
    expect(refused(() => turnCost({ ...base, floor: 3n })).check).toBe("money.budget");
    expect(refused(() => turnCost({ ...base, basePerTurn: 2n })).check).toBe("money.budget");
  });

  it("a product past a u128 is refused, and a product at its edge is not", () => {
    expect(refused(() => turnCost({ ...base, gN: 1n << 64n, gnCeiling: MAX128, pricePerGn: 1n << 64n, basePerTurn: 0n, floor: 0n, budget: MAX128 })).check).toBe("money.cost");
    expect(turnCost({ ...base, gN: MAX128, gnCeiling: MAX128, pricePerGn: 1n, basePerTurn: 0n, floor: 0n, budget: MAX128 }).cost).toBe(MAX128);
    expect(refused(() => turnCost({ ...base, gN: MAX128, gnCeiling: MAX128, pricePerGn: 1n, basePerTurn: 1n, floor: 0n, budget: MAX128 })).check).toBe("money.cost");
  });

  it("a sum of the floor and the cost past a u128 is refused", () => {
    expect(refused(() => turnCost({ ...base, gN: 0n, pricePerGn: 0n, basePerTurn: MAX128, floor: 1n, budget: MAX128 })).check).toBe("money.total");
    expect(turnCost({ ...base, gN: 0n, pricePerGn: 0n, basePerTurn: MAX128 - 1n, floor: 1n, budget: MAX128 }).total).toBe(MAX128);
  });

  it("each field must be a bigint inside a u128 (BAD_INPUT), and the object exactly its fields", () => {
    for (const k of Object.keys(base) as (keyof typeof base)[]) {
      for (const v of [-1n, MAX128 + 1n, 1, "1", null]) expect(refused(() => turnCost({ ...base, [k]: v } as never)).refusal).toBe("BAD_INPUT");
    }
    expect(refused(() => turnCost({ ...base, extra: 1n } as never)).refusal).toBe("BAD_INPUT");
    const { budget: _b, ...short } = base;
    expect(refused(() => turnCost(short as never)).refusal).toBe("BAD_INPUT");
  });
});

describe("T6: chainTariff (W18)", () => {
  it("is basePerTurn times the turns plus the aggregate G_n", () => {
    expect(chainTariff({ basePerTurn: 1n, turns: 1n, aggregateGn: 38n })).toBe(39n);
    expect(chainTariff({ basePerTurn: 5n, turns: 3n, aggregateGn: 0n })).toBe(15n);
    expect(chainTariff({ basePerTurn: 0n, turns: 0n, aggregateGn: MAX128 })).toBe(MAX128);
  });
  it("past a u128 is refused", () => {
    expect(refused(() => chainTariff({ basePerTurn: 1n, turns: 1n, aggregateGn: MAX128 })).check).toBe("money.tariff");
    expect(refused(() => chainTariff({ basePerTurn: 1n << 64n, turns: 1n << 64n, aggregateGn: 0n })).check).toBe("money.tariff");
  });
});

describe("T6: receiptPayable (W19)", () => {
  const base = { payable: 114_000_000_000_000_002n, budget: 114_000_000_000_000_002n, basePerTurn: 1n, turns: 1n, aggregateGn: 38n };

  it("accepts a payable at the budget and at the tariff", () => {
    expect(receiptPayable(base)).toEqual({ payable: base.payable, tariff: 39n });
    expect(receiptPayable({ ...base, payable: 39n })).toEqual({ payable: 39n, tariff: 39n });
  });
  it("refuses a payable of 0", () => {
    const e = refused(() => receiptPayable({ ...base, payable: 0n, basePerTurn: 0n, aggregateGn: 0n }));
    expect([e.refusal, e.check]).toEqual(["RECEIPT", "receipt.payable"]);
  });
  it("refuses a payable one above the budget", () => {
    expect(refused(() => receiptPayable({ ...base, budget: base.payable - 1n })).check).toBe("receipt.budget");
  });
  it("refuses a payable one below the tariff", () => {
    const e = refused(() => receiptPayable({ ...base, payable: 38n }));
    expect([e.refusal, e.check]).toEqual(["RECEIPT", "receipt.tariff"]);
  });
  it("refuses when the tariff is past a u128", () => {
    expect(refused(() => receiptPayable({ ...base, aggregateGn: MAX128 })).check).toBe("receipt.tariff");
  });
});
