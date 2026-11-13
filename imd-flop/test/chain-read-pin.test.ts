/**
 * The P2 fix round, rule X9 (decision S31): the pin is proven through the door before it is used. The block's
 * System.LastRuntimeUpgrade bytes are decoded as a stored value with the pin (door.ts provenPin, through valueOf), so
 * the door checks the metadata against the reviewed line, the shape file's text and the key from the key table. A
 * refusal makes the whole read unknown, for both entry points, with the door's words.
 *
 * Hashes and accounts come from research/2026-11-12-session-rerun-1014020/results.json (steps A6 .block_hash and
 * .finalized_in_block, accounts.owner and dev1 .public_key). The other reviewed runtime's metadata is the one the
 * upgrade recording answers at the parent of its block runtime-upgrade/carries-upgrade (that block was executed by
 * the old runtime), through test/lib/recorded-node.ts upgradeScript and upgradeBlocks.
 */
import { describe, expect, it } from "vitest";
import { bytesOf, hexOf } from "../src/chain-read/bytes.js";
import { provenPin, runtimeOf } from "../src/chain-read/door.js";
import { KEY_TABLE } from "../src/chain-read/key-table.js";
import { keyOf, lastRuntimeUpgradeKey } from "../src/chain-read/keys.js";
import { readBlockEvents, readSessionState } from "../src/chain-read/read.js";
import { shapeFileText } from "../src/chain-read/shape-file.js";
import { RERUN_RESULTS, repoJson, rerunScript, type Script, transportOf, upgradeBlocks, upgradeScript } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const OWNER: string = RESULTS.accounts.owner.public_key;
const DEV1: string = RESULTS.accounts.dev1.public_key;
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const AT = { number: A6.finalized_in_block as number, hash: A6.block_hash as string };
const LRU = KEY_TABLE.system.last_runtime_upgrade;

const reasonOf = (g: { kind: string }) => (g as { reason?: string }).reason ?? "";
const parentOf = (s: Script, hash: string) => (s.headers.get(hash) as { parentHash: string }).parentHash;

/** A6's script with the metadata at A6's parent replaced. */
function withParentMetadata(md: string): Script {
  const s = rerunScript(A6.block_hash);
  s.metadata.set(parentOf(s, A6.block_hash), md);
  return s;
}

/** The metadata of the other reviewed runtime: the upgrade recording's, at the parent of the block that carries the upgrade. */
function otherRuntimeMetadata(): string {
  const B = upgradeBlocks();
  const carries = B["runtime-upgrade/carries-upgrade"] as { hash: string };
  const later = B["runtime-upgrade/later-of-new-runtime"] as { hash: string };
  const u = upgradeScript(later.hash, carries.hash, [later.hash]);
  const md = u.metadata.get(parentOf(u, carries.hash));
  expect(typeof md).toBe("string");
  expect(md).not.toBe(rerunScript(A6.block_hash).metadata.get(parentOf(rerunScript(A6.block_hash), A6.block_hash)));
  return md as string;
}

/** A6's pin, built as pinAt builds it, before it is proven. */
function a6Pin() {
  const s = rerunScript(A6.block_hash);
  const lru = bytesOf(s.storage.get(`${A6.block_hash} ${hexOf(lastRuntimeUpgradeKey())}`) as string);
  const runtime = (runtimeOf(lru) as any).value;
  return { runtime, metadata: bytesOf(s.metadata.get(parentOf(s, A6.block_hash)) as string), lastRuntimeUpgrade: lru, shapeText: (shapeFileText(runtime.shapeFile) as any).value as string };
}

describe("X9: the pin is proven through the door before it is used", () => {
  it("the control: A6's pin is proven, and both reads are known", async () => {
    expect(provenPin(a6Pin(), { pallet: LRU.pallet, entry: LRU.entry, key: lastRuntimeUpgradeKey() }).kind).toBe("known");
    expect((await readSessionState(transportOf(rerunScript(A6.block_hash)), OWNER, DEV1)).kind).toBe("known");
    expect((await readBlockEvents(transportOf(rerunScript(A6.block_hash)), AT)).kind).toBe("known");
  });

  it('metadata "0x" makes the session read unknown as a whole, and the events read, by the door\'s words', async () => {
    for (const r of [await readSessionState(transportOf(withParentMetadata("0x")), OWNER, DEV1), await readBlockEvents(transportOf(withParentMetadata("0x")), AT)]) {
      expect(r.kind).toBe("unknown");
      expect(reasonOf(r)).toMatch(/^the pin: the decoder: not decoded: /);
    }
  });

  it("the metadata of the other reviewed runtime makes both reads unknown as a whole, by the door's words", async () => {
    const md = otherRuntimeMetadata();
    for (const r of [await readSessionState(transportOf(withParentMetadata(md)), OWNER, DEV1), await readBlockEvents(transportOf(withParentMetadata(md)), AT)]) {
      expect(r.kind).toBe("unknown");
      expect(reasonOf(r)).toMatch(/^the pin: the decoder: not decoded: /);
    }
  });

  it("a key table line whose LastRuntimeUpgrade entry part is changed gives a key the door refuses, by its words", () => {
    const part = LRU.entryPart;
    const changed = `${part.slice(0, -2)}${part.endsWith("00") ? "01" : "00"}`;
    const key = (keyOf({ ...LRU, entryPart: changed }, []) as any).value.key as Uint8Array;
    expect(hexOf(key)).not.toBe(hexOf(lastRuntimeUpgradeKey()));
    const p = provenPin(a6Pin(), { pallet: LRU.pallet, entry: LRU.entry, key });
    expect(p.kind).toBe("unknown");
    expect(reasonOf(p)).toBe("the decoder: System.LastRuntimeUpgrade: the key asked is not the key of this entry and these key parts");
  });

  it("the shape file's text changed by one byte is refused by the door", () => {
    const pin = a6Pin();
    const p = provenPin({ ...pin, shapeText: `${pin.shapeText} ` }, { pallet: LRU.pallet, entry: LRU.entry, key: lastRuntimeUpgradeKey() });
    expect(p.kind).toBe("unknown");
    expect(reasonOf(p)).toMatch(/^the decoder: not decoded: /);
  });
});
