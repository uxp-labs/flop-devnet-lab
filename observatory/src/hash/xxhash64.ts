// xxHash64, written from its specification (github.com/Cyan4973/xxHash, doc/xxhash_spec.md) with
// no dependency. Substrate builds its twox storage hashers from it (src/scale/storage-key.ts).
// Pure: bytes and a seed in, a 64 bit unsigned bigint out. It is not a cryptographic hash.

const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;

const u64 = (v: bigint): bigint => BigInt.asUintN(64, v);
const rotl = (v: bigint, r: bigint): bigint => u64((v << r) | (v >> (64n - r)));
const round = (acc: bigint, lane: bigint): bigint => u64(rotl(u64(acc + lane * P2), 31n) * P1);
const merge = (acc: bigint, v: bigint): bigint => u64((acc ^ round(0n, v)) * P1 + P4);

/** The xxHash64 of the bytes with the seed given, a 64 bit unsigned integer. */
export function xxhash64(bytes: Uint8Array, seed: bigint): bigint {
  if (seed < 0n || seed >= 1n << 64n) throw new RangeError("an xxHash64 seed is a 64 bit unsigned integer");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.length;
  let at = 0;
  let h: bigint;
  if (n >= 32) {
    let v1 = u64(seed + P1 + P2);
    let v2 = u64(seed + P2);
    let v3 = seed;
    let v4 = u64(seed - P1);
    for (; at + 32 <= n; at += 32) {
      v1 = round(v1, view.getBigUint64(at, true));
      v2 = round(v2, view.getBigUint64(at + 8, true));
      v3 = round(v3, view.getBigUint64(at + 16, true));
      v4 = round(v4, view.getBigUint64(at + 24, true));
    }
    h = u64(rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n));
    h = merge(merge(merge(merge(h, v1), v2), v3), v4);
  } else {
    h = u64(seed + P5);
  }
  h = u64(h + BigInt(n));
  for (; at + 8 <= n; at += 8) h = u64(rotl(h ^ round(0n, view.getBigUint64(at, true)), 27n) * P1 + P4);
  if (at + 4 <= n) {
    h = u64(rotl(h ^ u64(BigInt(view.getUint32(at, true)) * P1), 23n) * P2 + P3);
    at += 4;
  }
  for (; at < n; at++) h = u64(rotl(h ^ u64(BigInt(view.getUint8(at)) * P5), 11n) * P1);
  h = u64((h ^ (h >> 33n)) * P2);
  h = u64((h ^ (h >> 29n)) * P3);
  return h ^ (h >> 32n);
}
