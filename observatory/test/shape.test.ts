// The shape pin (src/scale/shape.ts) and the one entry point for real chain data
// (src/scale/block.ts): a block is decoded only when its spec, its metadata bytes and the shape
// derived from them are the ones a person reviewed, and its LastRuntimeUpgrade names that spec.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeBlockEvents } from "../src/scale/block.js";
import { decodeValue } from "../src/scale/decode.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { ScaleError } from "../src/scale/reader.js";
import { MAX_NAME_DEPTH, type PinInput, REVIEWED, STATED_ENTRIES, deriveShape, pinShape, shapeText, typeName } from "../src/scale/shape.js";
import { recorded } from "./helpers/recorded.js";
import { bytes, cat, compact, def, metadata, str } from "./helpers/scale-write.js";

const R = recorded();
const MD = parseMetadata(R.metadata);
const FILE = "shapes/tzkv-runtime-1014014.json";
const SHAPE = readFileSync(new URL(`../${FILE}`, import.meta.url), "utf8");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const block = R.blocks.at(4);
const input = (over: Partial<PinInput> = {}): PinInput => ({
  specName: String(R.runtimeVersion.specName),
  specVersion: Number(R.runtimeVersion.specVersion),
  metadata: R.metadata,
  lastRuntimeUpgrade: block?.lastRuntimeUpgrade ?? new Uint8Array(),
  shapeText: SHAPE,
  ...over,
});
const refused = (over: Partial<PinInput>): string => {
  const p = pinShape(input(over));
  return p.pinned ? "pinned" : p.refused;
};

describe("the reviewed shapes", () => {
  it("start with spec 1014014 of tzkv-runtime, its 482132 metadata bytes by sha256, and the committed shape file", () => {
    expect(REVIEWED.at(0)).toEqual({
      specName: "tzkv-runtime",
      specVersion: 1014014,
      metadataSha256: "f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444",
      metadataBytes: 482132,
      shapeFile: FILE,
      shapeSha256: sha256(SHAPE),
    });
    // The second line, spec 1014020, is held in test/upgrade-shape.test.ts.
    expect(REVIEWED.map((r) => `${r.specName} ${r.specVersion}`)).toEqual(["tzkv-runtime 1014014", "tzkv-runtime 1014020"]);
    expect(R.metadata.length).toBe(482132);
    expect(sha256(R.metadata)).toBe(REVIEWED.at(0)?.metadataSha256);
  });

  it("hold a shape file equal, byte for byte, to the shape derived again from the recorded metadata", () => {
    expect(shapeText(deriveShape(MD))).toBe(SHAPE);
  });

  it("name in the shape the ComputeChannel index, events, Channels entry and channel fields, and the System entries", () => {
    const s = JSON.parse(SHAPE);
    expect(Object.keys(s)).toEqual(["compute_channel", "flop_session_keys", "schema", "spec_name", "spec_version", "system", "types"]);
    expect(s).toMatchObject({ schema: "flop-observatory/decoder-shape@2", spec_name: "tzkv-runtime", spec_version: 1014014 });
    expect(s.compute_channel.index).toBe(103);
    expect(s.compute_channel.events.length).toBe(60);
    expect(s.compute_channel.events.at(23)).toEqual({
      index: 23,
      name: "Settled",
      fields: [
        { name: "channel_id", type: "H256#13" },
        { name: "miner_paid", type: "u128" },
        { name: "burned", type: "u128" },
        { name: "aggregate_gn", type: "u128" },
        { name: "cooperative", type: "bool" },
      ],
    });
    expect(s.compute_channel.channels).toMatchObject({ modifier: "Optional", hashers: ["Blake2_128Concat"], key: "H256#13", value: "Channel#805", default: "0x00" });
    expect(s.compute_channel.channels.fields.map((f: { name: string }) => f.name)).toEqual([
      "agent", "miner", "model_hash", "measured_root", "precision", "enclave_key", "agent_key", "escrow", "sla", "nonce", "opened_at", "last_attested_at", "state", "transcript_ref", "weights_pin", "locked_compute_consumed",
    ]);
    expect(s.compute_channel.channel_states.map((v: { name: string }) => v.name)).toEqual(["Open", "Settling", "Closed", "PendingAck"]);
    expect(s.system.events).toMatchObject({ modifier: "Default", hashers: [], key: null, value: "Vec<EventRecord<RuntimeEvent#21, H256#13>#20>", default: "0x00" });
    expect(s.system.last_runtime_upgrade).toMatchObject({ modifier: "Optional", hashers: [], key: null, value: "LastRuntimeUpgradeInfo#462", default: "0x00" });
  });

  it("name in the shape the FlopSessionKeys index and its Sessions, SessionNonces and CircuitBreakers entries, each with its modifier and default bytes", () => {
    const s = JSON.parse(SHAPE);
    const pair = ["Blake2_128Concat", "Blake2_128Concat"];
    expect(s.flop_session_keys).toEqual({
      index: 94,
      storage_prefix: "FlopSessionKeys",
      sessions: { modifier: "Optional", hashers: pair, key: "(AccountId32#0, AccountId32#0)", value: "SessionToken#697", default: "0x00" },
      session_nonces: { modifier: "Default", hashers: pair, key: "(AccountId32#0, AccountId32#0)", value: "u64", default: "0x0000000000000000" },
      circuit_breakers: { modifier: "Optional", hashers: ["Blake2_128Concat"], key: "AccountId32#0", value: "CircuitBreakerState#701", default: "0x00" },
    });
    const fields = (t: string) => (s.types[t].fields as { name: string }[]).map((f) => f.name);
    expect(fields("SessionToken#697")).toEqual(["owner", "delegate", "spending_cap", "per_tx_limit", "daily_cap", "epoch_spent", "epoch_start", "spent", "expires_at", "allowed_pallets", "active"]);
    expect(fields("CircuitBreakerState#701")).toEqual(["period_start", "tx_count", "total_spend", "tripped"]);
  });

  it("state the storage prefix of each stated pallet as the metadata gives it, so a changed prefix changes the shape", () => {
    const s = JSON.parse(SHAPE);
    const prefix = (name: string) => MD.pallets.find((p) => p.name === name)?.storage?.prefix;
    expect([s.system.storage_prefix, s.compute_channel.storage_prefix, s.flop_session_keys.storage_prefix]).toEqual([prefix("System"), prefix("ComputeChannel"), prefix("FlopSessionKeys")]);
  });

  it("state exactly the storage entries STATED_ENTRIES lists, each one the metadata's entry of that name", () => {
    const s = JSON.parse(SHAPE);
    const stated: [string, string, unknown][] = [
      ["System", "Events", s.system.events],
      ["System", "LastRuntimeUpgrade", s.system.last_runtime_upgrade],
      ["ComputeChannel", "Channels", s.compute_channel.channels],
      ["FlopSessionKeys", "Sessions", s.flop_session_keys.sessions],
      ["FlopSessionKeys", "SessionNonces", s.flop_session_keys.session_nonces],
      ["FlopSessionKeys", "CircuitBreakers", s.flop_session_keys.circuit_breakers],
    ];
    expect(STATED_ENTRIES).toEqual(stated.map(([p, e]) => [p, e]));
    for (const [p, e, shape] of stated) {
      const entry = MD.pallets.find((x) => x.name === p)?.storage?.entries.find((x) => x.name === e);
      expect(shape, `${p}.${e}`).toMatchObject({ modifier: entry?.modifier, hashers: entry?.hashers, value: typeName(MD, entry?.value ?? -1), default: `0x${Buffer.from(entry?.fallback ?? []).toString("hex")}` });
    }
  });
});

describe("the type closure in the shape", () => {
  const s = JSON.parse(SHAPE);
  /** Every type name a description names. */
  const named = (d: Record<string, unknown>): string[] => {
    const f = (fs: { type: string }[]) => fs.map((x) => x.type);
    if (d.kind === "composite") return f(d.fields as { type: string }[]);
    if (d.kind === "variant") return (d.variants as { fields: { type: string }[] }[]).flatMap((v) => f(v.fields));
    if (d.kind === "sequence" || d.kind === "array") return [d.element as string];
    if (d.kind === "tuple") return d.types as string[];
    if (d.kind === "compact") return [d.type as string];
    return [];
  };

  it("describes 469 types, and every type a description names is described too", () => {
    const types = s.types as Record<string, Record<string, unknown>>;
    expect(Object.keys(types).length).toBe(469);
    for (const [k, d] of Object.entries(types)) for (const x of named(d)) expect(types[x], `${k} names ${x}`).toBeDefined();
    // The entry points name described types.
    const fsk = s.flop_session_keys;
    for (const x of [s.system.events.value, s.system.last_runtime_upgrade.value, s.system.version, s.compute_channel.channels.value, s.compute_channel.channels.key, fsk.sessions.key, fsk.sessions.value, fsk.session_nonces.key, fsk.session_nonces.value, fsk.circuit_breakers.key, fsk.circuit_breakers.value]) expect(types[x], x).toBeDefined();
  });

  it("holds the outer event enum with every pallet's events, the phase, and the channel's fields and states", () => {
    const types = s.types as Record<string, Record<string, unknown>>;
    const outer = types["RuntimeEvent#21"] as { variants: { name: string; index: number; fields: { type: string }[] }[] };
    expect(outer.variants.length).toBe(MD.pallets.filter((p) => p.event !== null).length);
    expect(outer.variants.find((v) => v.name === "ComputeChannel")).toMatchObject({ index: 103 });
    expect(types["Phase#460"]).toMatchObject({ kind: "variant" });
    expect(types["Channel#805"]).toMatchObject({ kind: "composite", path: ["pallet_compute_channel", "pallet", "Channel"] });
    expect(types["ChannelState<u32>#806"]).toMatchObject({ kind: "variant" });
    expect(types["[u8; 32]"]).toEqual({ kind: "array", path: [], element: "u8", len: 32 });
  });

  it("is held to the review by its sha256: a file another deriver writes from the reviewed metadata passes the other checks and is refused by that alone", () => {
    // Another deriver: today's without the closure, as the shape was before this round. Its file is
    // what a changed deriveShape and a file written again from it would give. The metadata is the
    // reviewed bytes (refusal 2 passes), and that deriver's shape equals that file (refusal 4 passes
    // for it). Only the shape file's sha256 refuses it.
    const other = (md: ReturnType<typeof parseMetadata>) => {
      const x = deriveShape(md) as Record<string, unknown>;
      const { types, ...rest } = x;
      return { ...rest, schema: "flop-observatory/decoder-shape@0" };
    };
    const text = shapeText(other(MD) as never);
    expect(sha256(R.metadata)).toBe(REVIEWED.at(0)?.metadataSha256);
    expect(shapeText(other(parseMetadata(R.metadata)) as never)).toBe(text);
    expect(refused({ shapeText: text })).toBe(`the shape file given is not the reviewed ${FILE}`);
  });
});

describe("the pin", () => {
  it("decodes System.LastRuntimeUpgrade at each of the twelve blocks as spec 1014014, and pins each block", () => {
    const lru = MD.pallets.find((p) => p.name === "System")?.storage?.entries.find((e) => e.name === "LastRuntimeUpgrade")?.value ?? -1;
    for (const b of R.blocks) {
      expect(decodeValue(MD, lru, b.lastRuntimeUpgrade), `block ${b.number}`).toEqual({ spec_version: 1014014, spec_name: "tzkv-runtime" });
      const p = pinShape(input({ lastRuntimeUpgrade: b.lastRuntimeUpgrade }));
      expect(p.pinned, `block ${b.number}`).toBe(true);
    }
  });

  it("refuses a spec that is not reviewed, by version or by name", () => {
    expect(refused({ specVersion: 1014015 })).toBe("spec tzkv-runtime 1014015 is not a reviewed shape");
    expect(refused({ specName: "other-runtime" })).toBe("spec other-runtime 1014014 is not a reviewed shape");
  });

  it("refuses metadata that is not the reviewed bytes: one bit flipped, one byte more, one byte less", () => {
    const flipped = R.metadata.slice();
    flipped.set([(flipped.at(1000) ?? 0) ^ 1], 1000);
    expect(refused({ metadata: flipped })).toBe(
      `the metadata for spec 1014014 is 482132 bytes with sha256 ${sha256(flipped)}, not the reviewed 482132 bytes with sha256 f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444`,
    );
    expect(refused({ metadata: cat(R.metadata, bytes(0)) })).toMatch(/^the metadata for spec 1014014 is 482133 bytes with sha256 [0-9a-f]{64}, not the reviewed 482132 bytes/);
    expect(refused({ metadata: R.metadata.subarray(1) })).toMatch(/^the metadata for spec 1014014 is 482131 bytes with sha256 [0-9a-f]{64}, not the reviewed/);
  });

  it("refuses a shape file that is not the reviewed one, even one changed only in its spacing", () => {
    expect(refused({ shapeText: SHAPE.replace('"index": 103', '"index": 104') })).toBe(`the shape file given is not the reviewed ${FILE}`);
    expect(refused({ shapeText: `${SHAPE}\n` })).toBe(`the shape file given is not the reviewed ${FILE}`);
  });

  it("refuses a block whose LastRuntimeUpgrade names another spec, or is not one", () => {
    expect(refused({ lastRuntimeUpgrade: cat(compact(1014015), str("tzkv-runtime")) })).toBe("the block's LastRuntimeUpgrade names spec tzkv-runtime 1014015, not tzkv-runtime 1014014");
    expect(refused({ lastRuntimeUpgrade: cat(compact(1014014), str("other")) })).toBe("the block's LastRuntimeUpgrade names spec other 1014014, not tzkv-runtime 1014014");
    expect(refused({ lastRuntimeUpgrade: compact(1014014) })).toBe("the block's LastRuntimeUpgrade: type 464, a str at byte 4: needs 1 byte, 0 left");
  });
});

describe("the one entry point for real chain data", () => {
  it("decodes a block's events once pinned, and refuses them with the pin's reason when not", () => {
    for (const b of R.blocks) {
      const d = decodeBlockEvents({ ...input({ lastRuntimeUpgrade: b.lastRuntimeUpgrade }), events: b.events });
      expect(d.decoded && d.events.length > 0, `block ${b.number}`).toBe(true);
    }
    const no = decodeBlockEvents({ ...input({ specVersion: 1 }), events: block?.events ?? new Uint8Array() });
    expect(no).toEqual({ decoded: false, refused: "not decoded: spec tzkv-runtime 1 is not a reviewed shape" });
    const cut = decodeBlockEvents({ ...input(), events: block?.events.subarray(0, 100) ?? new Uint8Array() });
    expect(cut.decoded === false && cut.refused.startsWith("System.Events: ")).toBe(true);
  });
});

describe("naming types, bounded", () => {
  it("names a type that refers to itself through its fields in one step", () => {
    const md = parseMetadata(metadata([{ path: ["Tree"], def: def.composite([{ name: "kids", type: 1 }]) }, { def: def.sequence(0) }], []));
    expect(typeName(md, 1)).toBe("Vec<Tree#0>");
  });

  it(`refuses a list of itself, a parameter of itself, and nesting past ${MAX_NAME_DEPTH} levels`, () => {
    const refusal = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        if (e instanceof ScaleError) return e.message;
        throw e;
      }
      return "named";
    };
    const self = parseMetadata(metadata([{ def: def.sequence(0) }], []));
    expect(refusal(() => typeName(self, 0))).toBe("type 0 nests too deeply to be named");
    const param = parseMetadata(metadata([{ path: ["Box"], params: [{ name: "T", type: 0 }], def: def.composite([]) }], []));
    expect(refusal(() => typeName(param, 0))).toBe("type 0 nests too deeply to be named");
    // A chain of lists, each of the next: 15 deep is named, 16 is refused.
    const chain = (n: number) => parseMetadata(metadata([...Array.from({ length: n }, (_v, i) => ({ def: def.sequence(i + 1) })), { def: def.primitive("u8") }], []));
    expect(typeName(chain(MAX_NAME_DEPTH - 1), 0)).toBe(`${"Vec<".repeat(MAX_NAME_DEPTH - 1)}u8${">".repeat(MAX_NAME_DEPTH - 1)}`);
    expect(refusal(() => typeName(chain(MAX_NAME_DEPTH), 0))).toBe("type 0 nests too deeply to be named");
  });
});
