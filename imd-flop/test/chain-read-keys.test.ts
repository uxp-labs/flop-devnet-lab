/**
 * P2, rule C2: the storage keys of the chain reads. The frozen table is what scripts/read-key-table.mjs derives from
 * the committed shape and recorded metadata, byte for byte. Each key built by src/chain-read/keys.ts equals the key
 * the reference library (dev only) builds, and the key the observatory's request list asked at the rerun's step A6:
 * observatory/fixtures/recording-20261112132634-0a472f1b49f7b661/requests.json, field calls[i].params[0] of the one
 * state_queryStorageAt call whose params[1] is A6's block_hash in the rerun's results.json.
 */
import { readFileSync } from "node:fs";
import { Blake2128Concat, Twox128 } from "@polkadot-api/substrate-bindings";
import { describe, expect, it } from "vitest";
import { deriveKeyTable, OUT, renderKeyTable } from "../scripts/read-key-table.mjs";
import { hexOf } from "../src/chain-read/bytes.js";
import { KEY_TABLE } from "../src/chain-read/key-table.js";
import { accountOf, eventsKey, keyOf, lastRuntimeUpgradeKey, lineOf, sessionKeys } from "../src/chain-read/keys.js";
import { RERUN_RECORDING, RERUN_RESULTS, repoJson } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const OWNER: string = RESULTS.accounts.owner.public_key;
const DEV1: string = RESULTS.accounts.dev1.public_key;
const LINE = KEY_TABLE.runtimes[0] as (typeof KEY_TABLE.runtimes)[number];
const acc = (h: string) => (accountOf(h) as { value: Uint8Array }).value;
const text = (s: string) => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));

/** The keys the observatory's list asked at A6's block, in its order. */
function askedAtA6(): string[] {
  const calls = repoJson(`${RERUN_RECORDING}/requests.json`).calls as { method: string; params: [string[], string] }[];
  const found = calls.filter((c) => c.method === "state_queryStorageAt" && c.params[1] === A6.block_hash);
  expect(found.length).toBe(1);
  return (found[0] as { params: [string[], string] }).params[0];
}

/** The reference library's key: twox128 of the storage prefix and of the entry name, then Blake2_128Concat of each part. */
const reference = (prefix: string, entry: string, parts: Uint8Array[]) => hexOf(cat(Twox128(text(prefix)), Twox128(text(entry)), ...parts.map((p) => Blake2128Concat(p))));

describe("C2: the key table", () => {
  it("is what scripts/read-key-table.mjs derives, byte for byte", () => {
    expect(readFileSync(OUT, "utf8")).toBe(renderKeyTable(deriveKeyTable()));
  });

  it("is frozen to its leaves", () => {
    const walk = (v: unknown): void => {
      if (v !== null && typeof v === "object") {
        expect(Object.isFrozen(v)).toBe(true);
        for (const x of Object.values(v)) walk(x);
      }
    };
    walk(KEY_TABLE);
  });

  it("names the hasher of each account part as the shape file states it", () => {
    for (const e of Object.values(LINE.entries)) for (const h of e.hashers) expect(h).toBe("Blake2_128Concat");
  });
});

describe("C2: each key equals the reference library's and the key the recording asked", () => {
  it("System.Events, System.LastRuntimeUpgrade, and Sessions, SessionNonces and CircuitBreakers of the owner and dev1, in the list's order", () => {
    const k = (sessionKeys(LINE, acc(OWNER), acc(DEV1)) as any).value;
    const ours = [eventsKey(), lastRuntimeUpgradeKey(), k.sessions.key, k.sessionNonces.key, k.circuitBreakers.key].map(hexOf);
    expect(ours).toEqual(askedAtA6());
    const ref = [
      reference("System", "Events", []),
      reference("System", "LastRuntimeUpgrade", []),
      reference("FlopSessionKeys", "Sessions", [acc(OWNER), acc(DEV1)]),
      reference("FlopSessionKeys", "SessionNonces", [acc(OWNER), acc(DEV1)]),
      reference("FlopSessionKeys", "CircuitBreakers", [acc(DEV1)]),
    ];
    expect(ours).toEqual(ref);
  });

  it("each key part handed to the door is the account's own 32 bytes", () => {
    const k = (sessionKeys(LINE, acc(OWNER), acc(DEV1)) as any).value;
    expect(k.sessions.parts.map(hexOf)).toEqual([OWNER, DEV1]);
    expect(k.circuitBreakers.parts.map(hexOf)).toEqual([DEV1]);
  });
});

describe("C2: keyOf refuses what it cannot build", () => {
  it("a count of parts other than the entry's hashers", () => {
    expect(keyOf(LINE.entries.sessions, [acc(OWNER)]).kind).toBe("unknown");
    expect(keyOf(LINE.entries.circuit_breakers, [acc(OWNER), acc(DEV1)]).kind).toBe("unknown");
  });

  it("a hasher it does not compute", () => {
    const line = { ...LINE.entries.circuit_breakers, hashers: ["Twox64Concat"] };
    expect((keyOf(line, [acc(DEV1)]) as any).reason).toMatch(/is not one chain-read computes/);
  });

  it("a part that is not 32 bytes, and an account text that is not 0x and 32 bytes of lower case hex", () => {
    expect(keyOf(LINE.entries.circuit_breakers, [acc(DEV1).slice(1)]).kind).toBe("unknown");
    for (const bad of [DEV1.slice(0, -2), DEV1.toUpperCase(), DEV1.slice(2), 7]) expect(accountOf(bad).kind).toBe("unknown");
  });

  it("lineOf: a runtime the table holds no line for, or a line naming another shape file", () => {
    expect(lineOf({ specName: LINE.specName, specVersion: LINE.specVersion + 1, shapeFile: LINE.shapeFile }).kind).toBe("unknown");
    expect(lineOf({ specName: LINE.specName, specVersion: LINE.specVersion, shapeFile: `${LINE.shapeFile}.other` }).kind).toBe("unknown");
    expect(lineOf({ specName: LINE.specName, specVersion: LINE.specVersion, shapeFile: LINE.shapeFile }).kind).toBe("known");
  });
});
