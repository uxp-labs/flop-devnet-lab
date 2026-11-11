// Storage keys (src/scale/storage-key.ts): the twox and blake2 hashers, and whole keys built from
// the recorded metadata's own hashers, held to three keys read by hand and to the reference.
import { Blake2128, Blake2128Concat, Blake2256, Identity, Twox128, Twox256, Twox64Concat } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import { parseMetadata } from "../src/scale/metadata.js";
import { ScaleError, toHex } from "../src/scale/reader.js";
import { blake2_128concat, hashKeyPart, storageKey, twox128, twox64concat } from "../src/scale/storage-key.js";
import { seeded } from "./helpers/random.js";
import { EVENTS_KEY, LAST_RUNTIME_UPGRADE_KEY, hexBytes, recorded } from "./helpers/recorded.js";
import { def, metadata } from "./helpers/scale-write.js";

const text = (s: string) => new TextEncoder().encode(s);
const CHANNEL = "0x9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7";
const CHANNELS_KEY =
  "0x130ba67ef498736437f36679a246a7547759ccc18de172078306ca5973251a7b4cbe4c8d8d511e4fa7196fdba7c3819c9f81f65bc93855d394329e4996bc78d949bb786178f3471c13d3853f9813ddd7";
const MD = parseMetadata(recorded().metadata);
const refusal = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof ScaleError) return e.message;
    throw e;
  }
  throw new Error("built, not refused");
};

describe("the hashers", () => {
  it("twox128 of System is the prefix every System key starts with", () => {
    expect(toHex(twox128(text("System")))).toBe("0x26aa394eea5630e07c48ae0c9558cef7");
    expect(toHex(twox128(text("Events")))).toBe("0x80d41e5e16056765bc8461851072c9d7");
  });

  it("twox64concat and blake2_128concat end with the key itself", () => {
    const k = hexBytes(CHANNEL);
    expect(toHex(blake2_128concat(k))).toBe(`0x4cbe4c8d8d511e4fa7196fdba7c3819c${CHANNEL.slice(2)}`);
    expect(toHex(twox64concat(text("ab"))).endsWith("6162")).toBe(true);
    expect(twox64concat(text("ab")).length).toBe(10);
  });

  it("agrees with the reference's seven hashers on 200 random keys of 0 to 79 bytes", () => {
    const rand = seeded(1828);
    const ref = { Blake2_128: Blake2128, Blake2_256: Blake2256, Blake2_128Concat: Blake2128Concat, Twox128, Twox256, Twox64Concat, Identity } as const;
    for (let n = 0; n < 200; n++) {
      const b = rand.bytes(rand.int(80));
      for (const [h, f] of Object.entries(ref)) expect(toHex(hashKeyPart(h as keyof typeof ref, b)), `${h} of ${toHex(b)}`).toBe(toHex(f(b)));
    }
  });
});

describe("whole keys, with the hashers the recorded metadata states", () => {
  it("builds System.Events and System.LastRuntimeUpgrade, two plain entries, as read by hand", () => {
    expect(toHex(storageKey(MD, "System", "Events", []))).toBe(EVENTS_KEY);
    expect(toHex(storageKey(MD, "System", "LastRuntimeUpgrade", []))).toBe(LAST_RUNTIME_UPGRADE_KEY);
    expect(EVENTS_KEY).toBe("0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7");
    expect(LAST_RUNTIME_UPGRADE_KEY).toBe("0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8");
  });

  it("builds ComputeChannel.Channels for one channel with its Blake2_128Concat hasher, as read by hand", () => {
    expect(toHex(storageKey(MD, "ComputeChannel", "Channels", [hexBytes(CHANNEL)]))).toBe(CHANNELS_KEY);
  });

  it("refuses a pallet or entry that does not exist, a plain entry given a key, and a map given none or two", () => {
    expect(refusal(() => storageKey(MD, "Nope", "Events", []))).toBe('the metadata has no pallet "Nope"');
    expect(refusal(() => storageKey(MD, "System", "Nope", []))).toBe('pallet System has no storage entry "Nope"');
    expect(refusal(() => storageKey(MD, "System", "Events", [hexBytes(CHANNEL)]))).toBe("storage System.Events takes 0 map keys, not 1");
    expect(refusal(() => storageKey(MD, "ComputeChannel", "Channels", []))).toBe("storage ComputeChannel.Channels takes 1 map keys, not 0");
    expect(refusal(() => storageKey(MD, "ComputeChannel", "Channels", [hexBytes(CHANNEL), hexBytes(CHANNEL)]))).toBe("storage ComputeChannel.Channels takes 1 map keys, not 2");
  });

  it("refuses a key part that is not one whole value of its key type: cut short or one byte long", () => {
    expect(refusal(() => storageKey(MD, "ComputeChannel", "Channels", [hexBytes(CHANNEL).subarray(1)]))).toBe("storage ComputeChannel.Channels, map key 0: type 1 at byte 0: 32 elements cannot fit in the 31 bytes left");
    expect(refusal(() => storageKey(MD, "ComputeChannel", "Channels", [hexBytes(`${CHANNEL}00`)]))).toBe("storage ComputeChannel.Channels, map key 0: type 13 (primitive_types::H256) ends at byte 32, 1 bytes before the end");
  });

  it("builds a map of two hashers part by part, each over its own key type, as the reference does", () => {
    // FcuServiceQualifications: (H256, H256), Blake2_128Concat twice.
    const a = hexBytes(CHANNEL);
    const b = new Uint8Array(32).fill(7);
    const want = `0x${[twox128(text("ComputeChannel")), twox128(text("FcuServiceQualifications")), blake2_128concat(a), blake2_128concat(b)].map((x) => toHex(x).slice(2)).join("")}`;
    expect(toHex(storageKey(MD, "ComputeChannel", "FcuServiceQualifications", [a, b]))).toBe(want);
  });

  it("uses the storage prefix the metadata states, not the pallet name", () => {
    const md = parseMetadata(metadata([{ def: def.primitive("u8") }], [{ name: "Shown", prefix: "Stored", index: 1, entries: [{ name: "Count", plain: 0 }] }]));
    expect(toHex(storageKey(md, "Shown", "Count", []))).toBe(toHex(new Uint8Array([...twox128(text("Stored")), ...twox128(text("Count"))])));
  });
});
