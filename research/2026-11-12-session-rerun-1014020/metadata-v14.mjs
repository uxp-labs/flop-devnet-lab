// A small strict reader of runtime metadata version 14 (the answer of state_getMetadata), for the
// tables of this folder. It shares no code with observatory/src/scale/metadata.ts on purpose, so the
// two readings stay independent. Every byte is read and the value must end exactly at its end.
// It keeps what the tables need: pallets with their index, and the variants (name, index, field
// names) of each pallet's call, event and error type, and the constants with their raw value.

class In {
  constructor(bytes) { this.b = bytes; this.o = 0; }
  take(n) {
    if (n < 0 || this.o + n > this.b.length) throw new Error(`metadata ends early at byte ${this.o}`);
    const out = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  byte() { return this.take(1)[0]; }
  u32() { const b = this.take(4); return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] * 2 ** 24); }
  compact() {
    const first = this.b[this.o];
    const mode = first & 3;
    if (mode === 0) { this.o += 1; return first >> 2; }
    if (mode === 1) { const b = this.take(2); return (b[0] | (b[1] << 8)) >> 2; }
    if (mode === 2) return Math.floor(this.u32() / 4);
    const len = (this.byte() >> 2) + 4;
    const b = this.take(len);
    let n = 0n;
    for (let i = len - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("a compact length is too large");
    return Number(n);
  }
  text() { return Buffer.from(this.take(this.compact())).toString("utf8"); }
  list(item) { const n = this.compact(); const out = []; for (let i = 0; i < n; i++) out.push(item()); return out; }
  option(item) {
    const tag = this.byte();
    if (tag === 0) return null;
    if (tag === 1) return item();
    throw new Error(`option tag ${tag} at byte ${this.o - 1}`);
  }
}

const fields = (r) => r.list(() => ({ name: r.option(() => r.text()), type: r.compact(), typeName: r.option(() => r.text()), docs: r.list(() => r.text()) }));

function typeDef(r) {
  const kind = r.byte();
  if (kind === 0) return { kind: "composite", fields: fields(r) };
  if (kind === 1) {
    const variants = r.list(() => ({ name: r.text(), fields: fields(r), index: r.byte(), docs: r.list(() => r.text()) }));
    const names = new Set(variants.map((v) => v.name)), idx = new Set(variants.map((v) => v.index));
    if (names.size !== variants.length || idx.size !== variants.length) throw new Error("a variant name or index is used twice");
    return { kind: "variant", variants };
  }
  if (kind === 2) return { kind: "sequence", type: r.compact() };
  if (kind === 3) return { kind: "array", len: r.u32(), type: r.compact() };
  if (kind === 4) return { kind: "tuple", types: r.list(() => r.compact()) };
  if (kind === 5) { const p = r.byte(); if (p > 14) throw new Error(`primitive ${p}`); return { kind: "primitive", p }; }
  if (kind === 6) return { kind: "compact", type: r.compact() };
  if (kind === 7) return { kind: "bitSequence", store: r.compact(), order: r.compact() };
  throw new Error(`type kind ${kind}`);
}

function storageEntry(r) {
  const name = r.text();
  if (r.byte() > 1) throw new Error("storage modifier");
  const t = r.byte();
  if (t === 0) r.compact();
  else if (t === 1) { r.list(() => { if (r.byte() > 6) throw new Error("hasher"); }); r.compact(); r.compact(); }
  else throw new Error("storage kind");
  r.take(r.compact());
  r.list(() => r.text());
  return name;
}

/** Parses the bytes of a metadata answer (magic "meta", version 14). */
export function parseMetadataV14(bytes) {
  const r = new In(bytes);
  if (Buffer.from(r.take(4)).toString("latin1") !== "meta") throw new Error("no metadata magic");
  const version = r.byte();
  if (version !== 14) throw new Error(`metadata version ${version}, this reader reads 14`);
  const types = r.list(() => ({ id: r.compact(), path: r.list(() => r.text()), params: r.list(() => ({ name: r.text(), type: r.option(() => r.compact()) })), def: typeDef(r), docs: r.list(() => r.text()) }));
  types.forEach((t, i) => { if (t.id !== i) throw new Error(`type ids do not count from 0: ${t.id} at ${i}`); });
  const pallets = r.list(() => {
    const name = r.text();
    const storage = r.option(() => ({ prefix: r.text(), entries: r.list(() => storageEntry(r)) }));
    const calls = r.option(() => r.compact());
    const event = r.option(() => r.compact());
    const constants = r.list(() => ({ name: r.text(), type: r.compact(), value: Buffer.from(r.take(r.compact())), docs: r.list(() => r.text()) }));
    const error = r.option(() => r.compact());
    const index = r.byte();
    return { name, index, storage, calls, event, constants, error };
  });
  const extrinsic = { type: r.compact(), version: r.byte(), signedExtensions: r.list(() => ({ identifier: r.text(), type: r.compact(), additionalSigned: r.compact() })) };
  const runtimeType = r.compact();
  if (r.o !== bytes.length) throw new Error(`${bytes.length - r.o} bytes after the metadata`);
  return { version, types, pallets, extrinsic, runtimeType };
}

/** The variants of a pallet's call, event or error type, as [{ index, name, fields: [names] }], sorted by index. */
export function variantsOf(md, palletName, which) {
  const p = md.pallets.find((x) => x.name === palletName);
  if (!p) throw new Error(`no pallet ${palletName}`);
  const id = p[which];
  if (id === null) return [];
  const t = md.types[id];
  if (!t || t.def.kind !== "variant") throw new Error(`${palletName} ${which} type is not a variant`);
  return t.def.variants.map((v) => ({ index: v.index, name: v.name, fields: v.fields.map((f) => f.name), docs: v.docs.join("\n") })).sort((a, b) => a.index - b.index);
}

/** The primitive name of a type id when it is one, else null. */
export function primitiveOf(md, id) {
  const t = md.types[id];
  const names = ["bool", "char", "str", "u8", "u16", "u32", "u64", "u128", "u256", "i8", "i16", "i32", "i64", "i128", "i256"];
  return t && t.def.kind === "primitive" ? names[t.def.p] : null;
}
