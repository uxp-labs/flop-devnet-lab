// BLAKE2b, unkeyed, written from RFC 7693 with no dependency, for the blake2 storage hashers
// (src/scale/storage-key.ts). Node's own hash offers only the 512 bit digest, and a shorter BLAKE2b
// digest is not a cut of the longer one: the length is part of the parameter block. Pure: bytes and
// an output length in, the digest out.
//
// An output length outside 1 to 64 is a RangeError, not a ScaleError: it is a caller's mistake in
// code, never something read from bytes. No caller in src passes one.

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

/** The four words each G mixes, for the four columns and then the four diagonals of a round. */
const MIX: readonly (readonly [number, number, number, number])[] = [
  [0, 4, 8, 12],
  [1, 5, 9, 13],
  [2, 6, 10, 14],
  [3, 7, 11, 15],
  [0, 5, 10, 15],
  [1, 6, 11, 12],
  [2, 7, 8, 13],
  [3, 4, 9, 14],
];

const BLOCK = 128;
const rotr = (v: bigint, r: bigint): bigint => BigInt.asUintN(64, (v >> r) | (v << (64n - r)));
const at = (w: BigUint64Array, i: number): bigint => w.at(i) as bigint;
const put = (w: BigUint64Array, i: number, v: bigint): void => w.set([BigInt.asUintN(64, v)], i);

/** RFC 7693 section 3.2: one block into the state, t the bytes taken so far, last for the final block. */
function compress(h: BigUint64Array, block: DataView, t: bigint, last: boolean): void {
  const v = new BigUint64Array(16);
  v.set(h, 0);
  v.set(IV, 8);
  put(v, 12, at(v, 12) ^ BigInt.asUintN(64, t));
  put(v, 13, at(v, 13) ^ (t >> 64n));
  if (last) put(v, 14, ~at(v, 14));
  const m = BigUint64Array.from({ length: 16 }, (_, i) => block.getBigUint64(8 * i, true));
  for (let r = 0; r < 12; r++) {
    const s = SIGMA.at(r % 10) as number[];
    MIX.forEach(([ia, ib, ic, id], g) => {
      const x = at(m, s.at(2 * g) as number);
      const y = at(m, s.at(2 * g + 1) as number);
      put(v, ia, at(v, ia) + at(v, ib) + x);
      put(v, id, rotr(at(v, id) ^ at(v, ia), 32n));
      put(v, ic, at(v, ic) + at(v, id));
      put(v, ib, rotr(at(v, ib) ^ at(v, ic), 24n));
      put(v, ia, at(v, ia) + at(v, ib) + y);
      put(v, id, rotr(at(v, id) ^ at(v, ia), 16n));
      put(v, ic, at(v, ic) + at(v, id));
      put(v, ib, rotr(at(v, ib) ^ at(v, ic), 63n));
    });
  }
  for (let i = 0; i < 8; i++) put(h, i, at(h, i) ^ at(v, i) ^ at(v, i + 8));
}

/** The unkeyed BLAKE2b digest of the bytes, outLength bytes long (1 to 64). */
export function blake2b(bytes: Uint8Array, outLength: number): Uint8Array {
  if (!Number.isInteger(outLength) || outLength < 1 || outLength > 64) throw new RangeError("a BLAKE2b digest is 1 to 64 bytes");
  const h = BigUint64Array.from(IV);
  // The parameter block: digest length, no key, fanout 1, depth 1.
  put(h, 0, at(h, 0) ^ (0x01010000n | BigInt(outLength)));
  // Every block but the last is compressed as it comes; the last, padded with zeros, is final. The
  // empty input is one block of zeros.
  const blocks = Math.max(1, Math.ceil(bytes.length / BLOCK));
  for (let i = 0; i < blocks; i++) {
    const padded = new Uint8Array(BLOCK);
    padded.set(bytes.subarray(i * BLOCK, (i + 1) * BLOCK));
    const last = i === blocks - 1;
    compress(h, new DataView(padded.buffer), BigInt(last ? bytes.length : (i + 1) * BLOCK), last);
  }
  const out = new Uint8Array(64);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) view.setBigUint64(8 * i, at(h, i), true);
  return out.slice(0, outLength);
}
