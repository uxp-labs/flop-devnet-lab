/** SS58 and did:key encodings of one Ed25519 public key. */
import { base58 } from "@scure/base";
import { blake2b } from "@noble/hashes/blake2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const SS58PRE = utf8ToBytes("SS58PRE");

function prefixBytes(prefix: number): Uint8Array {
  if (prefix < 0 || prefix > 16383 || prefix === 46 || prefix === 47) throw new Error(`bad ss58 prefix ${prefix}`);
  if (prefix < 64) return Uint8Array.of(prefix);
  return Uint8Array.of(((prefix & 0xfc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 0x03) << 6));
}

export function ss58Encode(pub: Uint8Array, prefix = 42): string {
  if (pub.length !== 32) throw new Error("ss58: expected a 32-byte public key");
  const body = concatBytes(prefixBytes(prefix), pub);
  const sum = blake2b(concatBytes(SS58PRE, body), { dkLen: 64 }).subarray(0, 2);
  return base58.encode(concatBytes(body, sum));
}

export function ss58Decode(addr: string): { prefix: number; pub: Uint8Array } {
  const raw = base58.decode(addr);
  if (raw[0] >= 128) throw new Error("ss58: reserved first byte");
  const plen = raw[0] < 64 ? 1 : 2;
  if (raw.length !== plen + 32 + 2) throw new Error("ss58: not a 32-byte account address");
  const body = raw.subarray(0, plen + 32);
  const sum = blake2b(concatBytes(SS58PRE, body), { dkLen: 64 }).subarray(0, 2);
  if (sum[0] !== raw[plen + 32] || sum[1] !== raw[plen + 33]) throw new Error("ss58: bad checksum");
  const prefix = plen === 1 ? raw[0] : ((raw[0] & 0x3f) << 2) | (raw[1] >> 6) | ((raw[1] & 0x3f) << 8);
  if (plen === 2 && prefix < 64) throw new Error("ss58: two byte form of a prefix below 64, not canonical");
  return { prefix, pub: raw.slice(plen, plen + 32) };
}

const ED25519_PUB_MULTICODEC = Uint8Array.of(0xed, 0x01);

export function didKeyFromPub(pub: Uint8Array): string {
  if (pub.length !== 32) throw new Error("did:key: expected a 32-byte public key");
  return "did:key:z" + base58.encode(concatBytes(ED25519_PUB_MULTICODEC, pub));
}

export function pubFromDidKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) throw new Error("did:key: expected base58btc ('z') multibase");
  const raw = base58.decode(did.slice("did:key:z".length));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) throw new Error("did:key: not an ed25519-pub (0xed01) key");
  return raw.slice(2);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
