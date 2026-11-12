// What the upgrade watch tests read (src/upgrade-watch.ts, RULES.md 7.2): the lab's own reads of the
// runtime upgrade in research/2026-11-12-runtime-upgrade/results.json, each value named by its field,
// and one honest watch at a snapshot's finalized head for the snapshot check tables.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { REVIEWED } from "../../src/scale/shape.js";
import type { Snapshot, UpgradeWatch } from "../../src/types.js";
import { type UpgradeReading, watchUpgrade } from "../../src/upgrade-watch.js";
import { cat, compact, str } from "./scale-write.js";
import { toHex } from "../../src/scale/reader.js";

export const RESULTS = JSON.parse(readFileSync(new URL("../../../research/2026-11-12-runtime-upgrade/results.json", import.meta.url), "utf8"));

/** results.json authorization.authorized_upgrade_at, by height: the value read there (null when the node held none). */
export const AUTHORIZED_AT: ReadonlyMap<number, { hash?: string; value: string | null }> = new Map(
  (RESULTS.authorization.authorized_upgrade_at as { height: number; hash?: string; value: string | null }[]).map((x) => [x.height, x]),
);
/** The authorising block: the last absent read is block_before, the first present one the block itself. */
export const BEFORE_AUTH: number = RESULTS.authorization.authorizing_block.block_before.height;
export const AUTH: number = RESULTS.authorization.authorizing_block.height;
/** The bytes authorised (results.json authorization.authorized_upgrade_at at the authorising block), never decoded. */
export const AUTHORIZED_BYTES = AUTHORIZED_AT.get(AUTH)?.value as string;

/** The sha256 of the bytes a 0x hex string holds, lower case hex, computed here and never typed. */
export const SHA = (hex: string): string => createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex");
/** The authorised bytes' sha256. */
export const AUTHORIZED_SHA = SHA(AUTHORIZED_BYTES);

/** results.json boundary: 3528527 the last block of the old runtime, 3528529 the first of the new. */
export const LAST_OLD = RESULTS.boundary[0] as { height: number; hash: string; last_runtime_upgrade: { hex: string; spec_version: number; spec_name: string } };
export const FIRST_NEW = RESULTS.boundary[2] as typeof LAST_OLD;

/** A whole LastRuntimeUpgrade record of the reviewed spec name at the version one past the newest reviewed line: no line names it. */
export const NOT_REVIEWED = { specName: String(REVIEWED.at(-1)?.specName), specVersion: Number(REVIEWED.at(-1)?.specVersion) + 1 };
export const NOT_REVIEWED_HEX = toHex(cat(compact(NOT_REVIEWED.specVersion), str(NOT_REVIEWED.specName)));

/** A reading at a block, by its fields, trust fixture. */
export function readingAt(hash: string, number: number | null, lru: unknown, au: unknown, observedAt = "2026-11-12T04:04:20.000Z"): UpgradeReading {
  return { hash, number, observedAt, trust: "fixture", lastRuntimeUpgrade: { result: lru }, authorizedUpgrade: { result: au } };
}

/**
 * An honest watch at the snapshot's finalized head, its genesis and its time: the old runtime's record
 * (results.json boundary.0) and the authorised bytes, compared with a watch one block below it that read
 * no authorisation, as at the authorising block. So every field of it is set.
 */
export function watchOf(s: Snapshot): UpgradeWatch {
  const genesis = s.status.genesis.rpc as string;
  const n = s.status.finalized_height as number;
  const lru = LAST_OLD.last_runtime_upgrade.hex;
  const before = watchUpgrade({ reading: readingAt("0x" + "be".repeat(32), n - 1, lru, null, s.status.observed_at), genesis, earlier: [] });
  return watchUpgrade({ reading: readingAt(s.status.finalized_hash as string, n, lru, AUTHORIZED_BYTES, s.status.observed_at), genesis, earlier: [{ genesis, watch: before }] });
}
