// The timing helper of the wall clock tests (test/helpers/interleaved-fastest.ts, review round 28,
// N1), on a scripted clock: each case advances the clock by the cost the test gives its next
// sample, so the samples, their noise and their order are known exactly. Costs are whole numbers,
// so every difference of the clock is exact.
import { describe, expect, it } from "vitest";
import { ATTEMPTS, interleavedFastest } from "./helpers/interleaved-fastest.js";
import { seeded } from "./helpers/random.js";

/** A scripted clock and two cases that cost the given amounts, sample by sample, and log their order. */
function scripted(smallCosts: readonly number[], largeCosts: readonly number[]) {
  let now = 0;
  const order: string[] = [];
  const next = (costs: readonly number[], name: string) => () => {
    const cost = costs[order.filter((o) => o === name).length];
    if (cost === undefined) throw new Error(`${name} was timed more often than the script says`);
    order.push(name);
    now += cost;
  };
  return { clock: () => now, small: next(smallCosts, "small"), large: next(largeCosts, "large"), order };
}

/** ATTEMPTS samples of a true cost, each with noise added except the one at clean. */
function noisy(cost: number, clean: number, noise: () => number): number[] {
  return Array.from({ length: ATTEMPTS }, (_, i) => (i === clean ? cost : cost + noise()));
}

describe("interleavedFastest: the fastest of 15 interleaved samples of each case (round 28, N1)", () => {
  it("makes 15 attempts", () => {
    expect(ATTEMPTS).toBe(15);
  });

  it("a large case that truly costs 16 times the small one gives 16, whatever noise is added to single samples", () => {
    const rnd = seeded(28);
    for (let clean = 1; clean < ATTEMPTS; clean++) {
      // The clean sample of each case at another attempt, and never at the first.
      const cleanLarge = 1 + ((clean * 7) % (ATTEMPTS - 1));
      const s = scripted(
        noisy(10, clean, () => 1 + rnd.int(400)),
        noisy(160, cleanLarge, () => 1 + rnd.int(400)),
      );
      expect(interleavedFastest(s.small, s.large, s.clock)).toEqual({ small: 10, large: 160, ratio: 16 });
    }
  });

  it("a true 4 with heavy noise on most samples gives 4", () => {
    const rnd = seeded(4);
    // Twelve of the fifteen samples of each case held up by 50 to 549 times the small case's cost.
    const held = (cost: number, clean: readonly number[]) => Array.from({ length: ATTEMPTS }, (_, i) => (clean.includes(i) ? cost : cost + 50 * (1 + rnd.int(10)) * (1 + rnd.int(11))));
    const s = scripted(held(10, [4, 9, 13]), held(40, [2, 7, 14]));
    expect(interleavedFastest(s.small, s.large, s.clock)).toEqual({ small: 10, large: 40, ratio: 4 });
  });

  it("interleaves the samples: each attempt times the small case once and then the large case once", () => {
    const s = scripted(new Array(ATTEMPTS).fill(1), new Array(ATTEMPTS).fill(4));
    interleavedFastest(s.small, s.large, s.clock);
    expect(s.order).toEqual(Array.from({ length: ATTEMPTS }, () => ["small", "large"]).flat());
  });

  it("makes all 15 attempts, also when the first already gives a clean ratio", () => {
    const s = scripted(new Array(ATTEMPTS).fill(2), new Array(ATTEMPTS).fill(8));
    expect(interleavedFastest(s.small, s.large, s.clock).ratio).toBe(4);
    expect(s.order.filter((o) => o === "small").length).toBe(15);
    expect(s.order.filter((o) => o === "large").length).toBe(15);
  });

  it("times with performance.now when no clock is given", () => {
    const r = interleavedFastest(
      () => undefined,
      () => undefined,
    );
    expect(Number.isFinite(r.small) && r.small >= 0 && Number.isFinite(r.large) && r.large >= 0).toBe(true);
  });
});
