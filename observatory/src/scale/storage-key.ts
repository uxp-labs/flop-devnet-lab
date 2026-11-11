// Storage keys (RULES.md section 9): the bytes a node stores a value under, built from a pallet's
// storage prefix, an entry name and the entry's map keys, with the hashers the parsed metadata
// (src/scale/metadata.ts) states for that entry. Pure: no file, network, clock or random access.
//
// A key is twox128(prefix) ++ twox128(entry) ++ one hashed part for each map key, in order. Each
// map key is given as its SCALE bytes, and each must be one whole value of its key type, which the
// decoder checks (src/scale/decode.ts), so a key part that is cut short, too long or of another
// type is refused instead of hashed. Every refusal is a ScaleError.
import { blake2b } from "../hash/blake2b.js";
import { xxhash64 } from "../hash/xxhash64.js";
import { decodeValue } from "./decode.js";
import type { Hasher, Metadata, StorageEntry } from "./metadata.js";
import { ScaleError } from "./reader.js";

const UTF8 = new TextEncoder();

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A 64 bit unsigned integer as 8 little endian bytes. */
function le64(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out.set([Number((v >> BigInt(8 * i)) & 0xffn)], i);
  return out;
}

/** xxHash64 with seeds 0 to n - 1, each little endian, one after the other: 8 bytes a seed. */
function twox(bytes: Uint8Array, seeds: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < seeds; i++) parts.push(le64(xxhash64(bytes, BigInt(i))));
  return cat(...parts);
}

export const twox64 = (bytes: Uint8Array): Uint8Array => twox(bytes, 1);
export const twox128 = (bytes: Uint8Array): Uint8Array => twox(bytes, 2);
export const twox256 = (bytes: Uint8Array): Uint8Array => twox(bytes, 4);
/** The 8 byte hash, then the key itself, so the key can be read back from the storage key. */
export const twox64concat = (bytes: Uint8Array): Uint8Array => cat(twox64(bytes), bytes);
/** The 16 byte BLAKE2b hash, then the key itself. */
export const blake2_128concat = (bytes: Uint8Array): Uint8Array => cat(blake2b(bytes, 16), bytes);

/** One map key's SCALE bytes through one of the seven storage hashers. */
export function hashKeyPart(hasher: Hasher, bytes: Uint8Array): Uint8Array {
  switch (hasher) {
    case "Blake2_128":
      return blake2b(bytes, 16);
    case "Blake2_256":
      return blake2b(bytes, 32);
    case "Blake2_128Concat":
      return blake2_128concat(bytes);
    case "Twox128":
      return twox128(bytes);
    case "Twox256":
      return twox256(bytes);
    case "Twox64Concat":
      return twox64concat(bytes);
    case "Identity":
      return bytes.slice();
  }
}

/** The pallet's storage entry of that name, as the parsed metadata states it, or a refusal. */
export function storageEntryOf(md: Metadata, pallet: string, entry: string): { prefix: string; entry: StorageEntry } {
  const p = md.pallets.find((x) => x.name === pallet);
  if (p === undefined) throw new ScaleError(`the metadata has no pallet ${JSON.stringify(pallet)}`);
  if (p.storage === null) throw new ScaleError(`pallet ${pallet} has no storage`);
  const e = p.storage.entries.find((x) => x.name === entry);
  if (e === undefined) throw new ScaleError(`pallet ${pallet} has no storage entry ${JSON.stringify(entry)}`);
  return { prefix: p.storage.prefix, entry: e };
}

/** The type of each map key part: the key type for one hasher, the tuple's types for several. */
function keyTypes(md: Metadata, e: StorageEntry): number[] {
  if (e.key === null) return [];
  if (e.hashers.length === 1) return [e.key];
  const def = md.types.at(e.key)?.def;
  // The metadata parser refuses a map of several hashers whose key is no tuple of as many types.
  if (def?.kind !== "tuple" || def.types.length !== e.hashers.length) throw new ScaleError(`the key of ${e.name} is no tuple of ${e.hashers.length} types`);
  return def.types;
}

/**
 * The whole storage key of pallet.entry at the map keys given (none for a plain entry, one for
 * each hasher of a map), each key the SCALE bytes of one whole value of its key type. Refused when
 * the pallet or entry does not exist, when the number of keys is not the entry's, or when a key is
 * not one whole value of its type.
 */
export function storageKey(md: Metadata, pallet: string, entry: string, keys: readonly Uint8Array[]): Uint8Array {
  const { prefix, entry: e } = storageEntryOf(md, pallet, entry);
  const types = keyTypes(md, e);
  if (keys.length !== types.length) {
    throw new ScaleError(`storage ${pallet}.${entry} takes ${types.length} map keys, not ${keys.length}`);
  }
  const parts = keys.map((k, i) => {
    const type = types.at(i) as number;
    const hasher = e.hashers.at(i) as Hasher;
    try {
      decodeValue(md, type, k);
    } catch (err) {
      if (err instanceof ScaleError) throw new ScaleError(`storage ${pallet}.${entry}, map key ${i}: ${err.message}`);
      throw err;
    }
    return hashKeyPart(hasher, k);
  });
  return cat(twox128(UTF8.encode(prefix)), twox128(UTF8.encode(entry)), ...parts);
}
