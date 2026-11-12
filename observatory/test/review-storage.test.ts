// Independent review of the storage round (round 19, 4e011e3 to f517fac): each test asserts what
// the promise says SHOULD hold and fails on f517fac. The builder fixes the code or the tests and
// renames each test when it passes. Not in test/test-counts.json on purpose.
//
// Assert gaps (DEFECT 1 and 2) cannot be shown by running the builder's tests from here (the
// harness blocks processes), so they are held two ways: a mutant in
// test/helpers/review-storage-mutants.json that survives test/storage-values.test.ts, and a test
// here over the text of that test file that fails until the missing assert exists.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type StorageRead as DoorRead, decodeStorageValue } from "../src/scale/block.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { MAX_INPUT_BYTES } from "../src/scale/reader.js";
import { REVIEWED, deriveShape, shapeText } from "../src/scale/shape.js";
import { storageKey } from "../src/scale/storage-key.js";
import { hexBytes } from "./helpers/recorded.js";
import { type StorageRead, recordedStorage } from "./helpers/recorded-storage.js";

const S = recordedStorage();
const SHAPE = readFileSync(new URL(`../${REVIEWED.at(0)?.shapeFile}`, import.meta.url), "utf8");
const VALUES_TEST = readFileSync(new URL("./storage-values.test.ts", import.meta.url), "utf8");
const ESC = JSON.parse(readFileSync(new URL("../../research/2026-11-11-session-escrow/results.json", import.meta.url), "utf8"));

const breaker = S.reads.find((r) => r.read.entry === "CircuitBreakers" && r.height === 3497611) as StorageRead;
const device2 = hexBytes(S.inputs.accounts.device_2.value);
const door = (over: Partial<DoorRead> = {}): DoorRead => ({
  specName: "tzkv-runtime",
  specVersion: 1014014,
  metadata: S.metadata,
  lastRuntimeUpgrade: S.lastRuntimeUpgrade.get(breaker.block) ?? new Uint8Array(),
  shapeText: SHAPE,
  pallet: breaker.read.pallet,
  entry: breaker.read.entry,
  keys: [device2],
  key: hexBytes(breaker.key),
  answer: breaker.answer,
  ...over,
});
const outcome = (f: () => unknown): string => {
  try {
    const v = f() as { decoded: boolean };
    return v.decoded ? "decoded" : "refused";
  } catch (e) {
    return `threw ${(e as Error).constructor.name}`;
  }
};

describe("review of the storage round", () => {
  it("DEFECT 1 (medium): the six System.Events reads are decoded but never held to the results files, which give the sha256 of four of them and the outcome of each step", () => {
    // What a results file gives for these reads: the escrow test names the sha256 of the events
    // value (of its 0x hex text) at each step's block. They all match the recording, so the assert
    // is there to be made; storage-values.test.ts makes none. Mutants rs-data-events-swapped and
    // rs-data-probe-events-swapped (another block's events) survive that file.
    const events = S.reads.filter((r) => r.read.pallet === "System");
    expect(events.length).toBe(6);
    const named = events.filter((r) => ESC.steps.some((s: { block_hash: string }) => s.block_hash === r.hash));
    expect(named.length).toBe(4);
    expect(VALUES_TEST).toContain("events_value_sha256");
  });

  it("DEFECT 2 (low): fields of the two channel records are held to nothing but themselves: our channel's last_attested_at, transcript_ref and locked_compute_consumed, and every field of the gateway channel but its state and escrow", () => {
    // Our channel at step 4 is checked with toMatchObject on 13 of its 16 fields; at step 7 the rest
    // is compared with step 4's decode of the same layout. The gateway channel is checked on state
    // and escrow at 3479299 and compared with itself at 3498313. A decode wrong the same way at
    // both blocks passes: mutants rs-data-ours-last-attested, rs-data-ours-locked-consumed,
    // rs-data-gateway-miner and rs-data-gateway-agent-key survive. The first recording names the
    // gateway's miner (ToplocEvidenceSubmitted) and the escrow file our channel's opening, so
    // expected values exist, or the asserts can be marked READ with the value read.
    for (const f of ["last_attested_at", "transcript_ref", "locked_compute_consumed"]) expect(VALUES_TEST, f).toContain(f);
    const gateway = VALUES_TEST.slice(VALUES_TEST.indexOf('describe("values of the gateway channel'), VALUES_TEST.indexOf('describe("damaged values'));
    for (const f of ["agent", "miner", "agent_key", "enclave_key", "nonce", "opened_at"]) expect(gateway, f).toMatch(new RegExp(`\\.${f}\\b`));
  });

  it("DEFECT 3 (low): the storage prefix the door builds and checks keys with is not in the shape: a metadata whose FlopSessionKeys prefix differs gives the same shape file", () => {
    const m = Buffer.from(S.metadata);
    const name = Buffer.from([0x3c, ...Buffer.from("FlopSessionKeys")]);
    const at = m.indexOf(Buffer.concat([name, Buffer.from([0x01]), name]));
    expect(at).toBeGreaterThan(0);
    const changed = Buffer.from(m);
    changed.set([0x7a], at + 17 + 15); // "FlopSessionKeyz", the storage prefix only; the pallet name stays
    const md = parseMetadata(new Uint8Array(changed));
    expect(md.pallets.find((p) => p.name === "FlopSessionKeys")?.storage?.prefix).toBe("FlopSessionKeyz");
    // Every key of the three entries changes ...
    expect(Buffer.from(storageKey(md, "FlopSessionKeys", "CircuitBreakers", [device2]))).not.toEqual(Buffer.from(storageKey(S.md, "FlopSessionKeys", "CircuitBreakers", [device2])));
    // ... so the shape must change too, or the pin cannot refuse it.
    expect(shapeText(deriveShape(md))).not.toBe(SHAPE);
  });

  it("DEFECT 4 (low): an input that is not plain data ends in another exception or in bytes the caller's array does not hold, not in a refusal", () => {
    expect(outcome(() => decodeStorageValue(null as never))).toBe("refused");
    const getter = door();
    Object.defineProperty(getter, "pallet", {
      get() {
        throw new Error("from the caller");
      },
    });
    expect(outcome(() => decodeStorageValue(getter))).toBe("refused");
    const keys = new Proxy([device2], {
      get(t, k) {
        if (k === Symbol.iterator) throw new TypeError("no iterator");
        return Reflect.get(t, k);
      },
    });
    expect(outcome(() => decodeStorageValue(door({ keys })))).toBe("refused");
    // A Proxy passes instanceof Uint8Array; the copy then reads its iterator, as long as it runs.
    let pulls = 0;
    const answer = new Proxy(new Uint8Array(breaker.answer ?? []), {
      get(t, k) {
        if (k === Symbol.iterator)
          return function* () {
            while (pulls < 1_000_000) {
              pulls++;
              yield 0;
            }
          };
        return Reflect.get(t, k);
      },
    });
    expect(decodeStorageValue(door({ answer }))).toEqual({ decoded: false, refused: "not decoded: the answer is not bytes" });
    expect(pulls).toBe(0);
  });

  it("DEFECT 5 (low): the storage key asked has no size bound: a key past MAX_INPUT_BYTES is copied and turned into hex whole before it is compared", () => {
    // 16 MiB takes about 3 s and 64 MiB about 11 s here, in toHex; the other inputs are refused unread past 16 MiB.
    const v = decodeStorageValue(door({ key: new Uint8Array(MAX_INPUT_BYTES + 1) }));
    expect(v).toMatchObject({ decoded: false, refused: expect.stringMatching(/bytes, more than/) });
  }, 60_000);
});
