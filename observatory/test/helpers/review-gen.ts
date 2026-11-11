// A random value writer for the review tests only: walks a type of a parsed metadata and writes one
// valid SCALE value of it, in the shortest compact forms, from a seeded source. It takes nothing
// from the decoder under test but the parsed type table, which test/reference.test.ts proves equal
// to the reference's parse of the same bytes.
import type { Metadata } from "../../src/scale/metadata.js";
import { seeded } from "./random.js";
import { cat, compact, le, u8 } from "./scale-write.js";

const WIDTHS: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, u256: 32, i8: 1, i16: 2, i32: 4, i64: 8, i128: 16, i256: 32 };

export class TooDeep extends Error {}

export function writer(md: Metadata, seed: number) {
  const rnd = seeded(seed);
  /** A random integer of width bytes, biased to its edges. */
  const intBytes = (w: number, signed: boolean): Uint8Array => {
    const bits = BigInt(8 * w);
    const k = rnd.int(8);
    let v: bigint;
    if (k === 0) v = 0n;
    else if (k === 1) v = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
    else if (k === 2) v = signed ? -(1n << (bits - 1n)) : 1n;
    else if (k === 3) v = signed ? -1n : 1n << (bits - 1n);
    else if (k === 4) v = BigInt(rnd.int(256));
    else if (k === 5) v = (1n << 53n) + BigInt(rnd.int(3)) - 1n;
    else v = BigInt(`0x${Buffer.from(rnd.bytes(w)).toString("hex")}`);
    return le(BigInt.asUintN(8 * w, v), w);
  };
  const compactValue = (w: number): bigint => {
    const max = (1n << BigInt(8 * w)) - 1n;
    const edges = [0n, 63n, 64n, 16383n, 16384n, (1n << 30n) - 1n, 1n << 30n, (1n << 32n) - 1n, 1n << 32n, (1n << 53n) + 1n, max];
    const k = rnd.int(3);
    let v = k === 0 ? (edges.at(rnd.int(edges.length)) as bigint) : BigInt(`0x${Buffer.from(rnd.bytes(1 + rnd.int(w))).toString("hex")}`);
    if (v > max) v = max;
    return v;
  };
  const char = (): Uint8Array => {
    let c = rnd.int(0x110000);
    if (c >= 0xd800 && c <= 0xdfff) c = 0x41;
    return le(c, 4);
  };
  const text = (): Uint8Array => {
    const pool = ["", "a", "é", "€", "😀", "\u0000", "﻿", "__proto__", "x"];
    let s = "";
    const n = rnd.int(5);
    for (let i = 0; i < n; i++) s += pool.at(rnd.int(pool.length));
    const b = new TextEncoder().encode(s);
    return cat(compact(b.length), b);
  };
  const compactOf = (id: number, depth: number): Uint8Array => {
    const d = md.types.at(id)?.def;
    if (d?.kind === "primitive") return compact(compactValue(WIDTHS[d.primitive] ?? 16));
    if (d?.kind === "composite" && d.fields.length === 1) return compactOf(d.fields[0]?.type ?? -1, depth + 1);
    // Compact<()> is written as nothing (parity-scale-codec), as in MultiAddress::Index here.
    if (d?.kind === "tuple" && d.types.length === 0) return new Uint8Array();
    throw new Error(`no compact of type ${id}`);
  };
  const value = (id: number, depth: number): Uint8Array => {
    if (depth > 24) throw new TooDeep();
    const t = md.types.at(id);
    if (t === undefined) throw new Error(`no type ${id}`);
    const d = t.def;
    switch (d.kind) {
      case "primitive":
        if (d.primitive === "bool") return u8(rnd.int(2));
        if (d.primitive === "char") return char();
        if (d.primitive === "str") return text();
        return intBytes(WIDTHS[d.primitive] ?? 1, d.primitive.startsWith("i"));
      case "compact":
        return compactOf(d.type, depth + 1);
      case "composite":
        return cat(...d.fields.map((f) => value(f.type, depth + 1)));
      case "variant": {
        if (d.variants.length === 0) throw new TooDeep();
        const pool = depth > 12 ? d.variants.filter((v) => v.fields.length === 0) : d.variants;
        const v = (pool.length > 0 ? pool : d.variants).at(rnd.int((pool.length > 0 ? pool : d.variants).length));
        if (v === undefined) throw new TooDeep();
        return cat(u8(v.index), ...v.fields.map((f) => value(f.type, depth + 1)));
      }
      case "sequence": {
        const el = md.types.at(d.type)?.def;
        const isByte = el?.kind === "primitive" && el.primitive === "u8";
        const n = depth > 12 ? 0 : rnd.int(isByte ? 40 : 3);
        return cat(compact(n), ...Array.from({ length: n }, () => value(d.type, depth + 1)));
      }
      case "array":
        return cat(...Array.from({ length: d.len }, () => value(d.type, depth + 1)));
      case "tuple":
        return cat(...d.types.map((x) => value(x, depth + 1)));
      case "bitSequence":
        throw new TooDeep();
    }
  };
  return { value: (id: number) => value(id, 0), rnd };
}
