// A seeded pseudo random source for property and fuzz tests (mulberry32): the same seed gives the
// same cases on every run, so a failure can be read again, and no test reads a clock for one.
export function seeded(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => int(256));
  return { next, int, bytes };
}
