// A SCALE writer for tests only: builds the synthetic metadata and values the decoder tests read,
// so every type definition kind and every refusal can be shown on bytes small enough to read. It
// writes what the specification says and nothing is taken from the decoder under test.
export const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
export const bytes = (...b: number[]) => Uint8Array.from(b);
export const le = (v: bigint | number, width: number): Uint8Array => {
  let x = BigInt.asUintN(width * 8, BigInt(v));
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};
export const u8 = (v: number) => le(v, 1);
export const u32 = (v: number) => le(v, 4);
export function compact(v: bigint | number): Uint8Array {
  const n = BigInt(v);
  if (n < 1n << 6n) return le(n << 2n, 1);
  if (n < 1n << 14n) return le((n << 2n) | 1n, 2);
  if (n < 1n << 30n) return le((n << 2n) | 2n, 4);
  let len = 0;
  for (let x = n; x > 0n; x >>= 8n) len++;
  return cat(u8(((len - 4) << 2) | 3), le(n, len));
}
export const str = (s: string) => {
  const b = new TextEncoder().encode(s);
  return cat(compact(b.length), b);
};
export const vec = (items: Uint8Array[]) => cat(compact(items.length), ...items);
export const byteVec = (b: Uint8Array) => cat(compact(b.length), b);
export const none = () => u8(0);
export const some = (b: Uint8Array) => cat(u8(1), b);
export const opt = (b: Uint8Array | null) => (b === null ? none() : some(b));
export const bool = (v: boolean) => u8(v ? 1 : 0);

// Metadata V14 (scale-info's PortableRegistry and frame-metadata's RuntimeMetadataV14).
export type Field = { name?: string; type: number; typeName?: string };
export const field = (f: Field) => cat(opt(f.name === undefined ? null : str(f.name)), compact(f.type), opt(f.typeName === undefined ? null : str(f.typeName)), vec([]));
export const PRIMITIVES = ["bool", "char", "str", "u8", "u16", "u32", "u64", "u128", "u256", "i8", "i16", "i32", "i64", "i128", "i256"] as const;
export const def = {
  composite: (fields: Field[]) => cat(u8(0), vec(fields.map(field))),
  variant: (variants: { name: string; index: number; fields?: Field[] }[]) =>
    cat(u8(1), vec(variants.map((v) => cat(str(v.name), vec((v.fields ?? []).map(field)), u8(v.index), vec([]))))),
  sequence: (t: number) => cat(u8(2), compact(t)),
  array: (len: number, t: number) => cat(u8(3), u32(len), compact(t)),
  tuple: (ts: number[]) => cat(u8(4), vec(ts.map((t) => compact(t)))),
  primitive: (p: (typeof PRIMITIVES)[number]) => cat(u8(5), u8(PRIMITIVES.indexOf(p))),
  compact: (t: number) => cat(u8(6), compact(t)),
  bitSequence: (store: number, order: number) => cat(u8(7), compact(store), compact(order)),
};
export type TypeSpec = { path?: string[]; params?: { name: string; type: number | null }[]; def: Uint8Array };
export const typeEntry = (id: number, t: TypeSpec) =>
  cat(compact(id), vec((t.path ?? []).map(str)), vec((t.params ?? []).map((p) => cat(str(p.name), opt(p.type === null ? null : compact(p.type))))), t.def, vec([]));
export const HASHERS = ["Blake2_128", "Blake2_256", "Blake2_128Concat", "Twox128", "Twox256", "Twox64Concat", "Identity"] as const;
export type Entry = { name: string; modifier?: 0 | 1; plain?: number; map?: { hashers: (typeof HASHERS)[number][]; key: number; value: number }; fallback?: Uint8Array };
export const storageEntry = (e: Entry) =>
  cat(
    str(e.name),
    u8(e.modifier ?? 0),
    e.map === undefined ? cat(u8(0), compact(e.plain ?? 0)) : cat(u8(1), vec(e.map.hashers.map((h) => u8(HASHERS.indexOf(h)))), compact(e.map.key), compact(e.map.value)),
    byteVec(e.fallback ?? new Uint8Array()),
    vec([]),
  );
export type PalletSpec = { name: string; index: number; prefix?: string; entries?: Entry[]; calls?: number; event?: number; error?: number; constants?: { name: string; type: number; value: Uint8Array }[] };
export const pallet = (p: PalletSpec) =>
  cat(
    str(p.name),
    p.entries === undefined ? none() : some(cat(str(p.prefix ?? p.name), vec(p.entries.map(storageEntry)))),
    opt(p.calls === undefined ? null : compact(p.calls)),
    opt(p.event === undefined ? null : compact(p.event)),
    vec((p.constants ?? []).map((c) => cat(str(c.name), compact(c.type), byteVec(c.value), vec([])))),
    opt(p.error === undefined ? null : compact(p.error)),
    u8(p.index),
  );
export const META = bytes(0x6d, 0x65, 0x74, 0x61);
/** A whole metadata V14: the magic, the version, the types (ids from 0 in order), the pallets, the extrinsic and the runtime type. */
export function metadata(types: TypeSpec[], pallets: PalletSpec[], extrinsic = { type: 0, version: 4 }, runtime = 0, version = 14): Uint8Array {
  return cat(
    META,
    u8(version),
    vec(types.map((t, i) => typeEntry(i, t))),
    vec(pallets.map(pallet)),
    cat(compact(extrinsic.type), u8(extrinsic.version), vec([cat(str("CheckNonce"), compact(0), compact(0))])),
    compact(runtime),
  );
}
