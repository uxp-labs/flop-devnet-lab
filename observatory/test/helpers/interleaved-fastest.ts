// A timing ratio that one noisy sample cannot decide (review round 28, N1). A wall clock test
// compares the time of a large case with the time of a small one. On a busy machine any single
// sample can be held up, so each case is timed ATTEMPTS times, interleaved: each attempt times the
// small case once and then the large case once, so both see the same weather. Only after every
// attempt is the fastest time of each compared. It never decides early, since an early pass could
// let a slow build through on one sample where the small case was held up.
// The clock is an argument, so the helper's own tests can script it.

/** How many times each case is timed. Fixed: every call makes exactly this many attempts. */
export const ATTEMPTS = 15;

/** A clock in milliseconds. */
export type Clock = () => number;

/** The fastest time of each case over every attempt, and their ratio, large over small. */
export interface FastestRatio {
  small: number;
  large: number;
  ratio: number;
}

function timeOnce(f: () => unknown, clock: Clock): number {
  const t = clock();
  f();
  return clock() - t;
}

/** Times small and then large, ATTEMPTS times, and compares the fastest time of each. */
export function interleavedFastest(small: () => unknown, large: () => unknown, clock: Clock = () => performance.now()): FastestRatio {
  let bestSmall = Number.POSITIVE_INFINITY;
  let bestLarge = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ATTEMPTS; i++) {
    const s = timeOnce(small, clock);
    const l = timeOnce(large, clock);
    if (s < bestSmall) bestSmall = s;
    if (l < bestLarge) bestLarge = l;
  }
  return { small: bestSmall, large: bestLarge, ratio: bestLarge / bestSmall };
}
