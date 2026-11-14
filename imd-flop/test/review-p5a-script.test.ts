/**
 * Review of P5a, attack 8 (P9, P14): the script's new branch for a sequence. The recorded metadata (SOURCES[0] of
 * scripts/chain-table.mjs, read by its readSource) is decoded, one type is changed, and it is encoded again with the
 * same reference codec (@polkadot-api, dev only). The unchanged metadata encodes back to its own bytes, so only the
 * one change differs. Each changed metadata is given to deriveRuntime with its own sha256.
 */
import { createHash } from "node:crypto";
import { decAnyMetadata, metadata as metadataCodec } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import { deriveRuntime, readSource, SOURCES } from "../scripts/chain-table.mjs";

const src = readSource(SOURCES[0]) as { metadata: Uint8Array; genesisHash: string; metadataSha256: string };
type LookupEntry = { id: number; path: string[]; params: unknown[]; def: { tag: string; value: unknown }; docs: string[] };

/** The metadata with the allow list of create_session given another type, built by `make` from fresh lookup ids. */
function withListType(make: (next: number, lookup: LookupEntry[]) => LookupEntry[]): Uint8Array {
  const any = decAnyMetadata(src.metadata) as unknown as { metadata: { value: { lookup: LookupEntry[]; pallets: { name: string; calls?: { type: number } | number }[] } } };
  const v = any.metadata.value;
  const lookup = v.lookup;
  const added = make(lookup.length, lookup);
  lookup.push(...added);
  const pallet = v.pallets.find((p) => p.name === "FlopSessionKeys")!;
  const callsId = typeof pallet.calls === "number" ? pallet.calls : pallet.calls!.type;
  const calls = lookup[callsId].def.value as { name: string; fields: { name?: string; type: number }[] }[];
  const field = calls.find((c) => c.name === "create_session")!.fields.find((f) => f.name === "allowed_pallets")!;
  field.type = added[added.length - 1].id;
  return metadataCodec.enc(any as never);
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function derive(bytes: Uint8Array): string {
  try {
    const rt = deriveRuntime({ metadata: bytes, genesisHash: src.genesisHash, metadataSha256: sha(bytes) });
    const f = rt.calls.find((c: { name: string }) => c.name === "create_session").fields.find((x: { name: string }) => x.name === "allowed_pallets");
    return `derived ${JSON.stringify(f.type)}`;
  } catch (e) {
    return `refused ${(e as Error).message.slice(0, 120)}`;
  }
}
const primitive = (lookup: LookupEntry[], tag: string) => lookup.find((t) => t.def.tag === "primitive" && (t.def.value as { tag: string }).tag === tag)!.id;

describe("review P5a, attack 8: the script's sequence branch", () => {
  it("HOLDS: the recorded metadata encodes back to its own bytes, so a changed copy differs only by its change", () => {
    const any = decAnyMetadata(src.metadata);
    expect(sha(metadataCodec.enc(any))).toBe(src.metadataSha256);
  });

  it("HOLDS: the allow list as a Vec<Vec<u8>> of fresh ids is derived as bytesList", () => {
    const bytes = withListType((n, l) => [
      { id: n, path: [], params: [], def: { tag: "sequence", value: primitive(l, "u8") }, docs: [] },
      { id: n + 1, path: [], params: [], def: { tag: "sequence", value: n }, docs: [] },
    ]);
    expect(derive(bytes)).toBe('derived {"kind":"bytesList"}');
  });

  it("HOLDS (kills mutant M36 of the review): a list of another element is refused: Vec<Vec<u32>>, Vec<Vec<u16>>, Vec<u8>, Vec<u32>, Vec<Vec<Vec<u8>>>, Vec<[u8; 32]>", () => {
    const cases: [string, (n: number, l: LookupEntry[]) => LookupEntry[]][] = [
      ["Vec<Vec<u32>>", (n, l) => [{ id: n, path: [], params: [], def: { tag: "sequence", value: primitive(l, "u32") }, docs: [] }, { id: n + 1, path: [], params: [], def: { tag: "sequence", value: n }, docs: [] }]],
      ["Vec<Vec<u16>>", (n, l) => [{ id: n, path: [], params: [], def: { tag: "sequence", value: primitive(l, "u16") }, docs: [] }, { id: n + 1, path: [], params: [], def: { tag: "sequence", value: n }, docs: [] }]],
      ["Vec<u8>", (n, l) => [{ id: n, path: [], params: [], def: { tag: "sequence", value: primitive(l, "u8") }, docs: [] }]],
      ["Vec<u32>", (n, l) => [{ id: n, path: [], params: [], def: { tag: "sequence", value: primitive(l, "u32") }, docs: [] }]],
      [
        "Vec<Vec<Vec<u8>>>",
        (n, l) => [
          { id: n, path: [], params: [], def: { tag: "sequence", value: primitive(l, "u8") }, docs: [] },
          { id: n + 1, path: [], params: [], def: { tag: "sequence", value: n }, docs: [] },
          { id: n + 2, path: [], params: [], def: { tag: "sequence", value: n + 1 }, docs: [] },
        ],
      ],
      ["Vec<[u8; 32]>", (n, l) => [{ id: n, path: [], params: [], def: { tag: "array", value: { len: 32, type: primitive(l, "u8") } }, docs: [] }, { id: n + 1, path: [], params: [], def: { tag: "sequence", value: n }, docs: [] }]],
    ];
    const got = cases.map(([what, make]) => `${what}: ${derive(withListType(make)).split(" ")[0]}`);
    expect(got).toEqual(cases.map(([what]) => `${what}: refused`));
  });
});
