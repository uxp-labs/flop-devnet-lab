// The upgrade watch (src/upgrade-watch.ts, RULES.md 7.2), pure: every state of the runtime that
// executed the block and of the authorisation, hostile answers, and the comparison with an earlier
// watch. Values come from research/2026-11-12-runtime-upgrade/results.json, each named in
// test/helpers/upgrade.ts.
import { describe, expect, it } from "vitest";
import { runtimeOfBlock } from "../src/scale/block.js";
import { fromHex } from "../src/scale/reader.js";
import { REVIEWED } from "../src/scale/shape.js";
import { twox128 } from "../src/scale/storage-key.js";
import type { UpgradeWatch } from "../src/types.js";
import { DETAIL, type EarlierUpgrade, UPGRADE_KEYS, UPGRADE_SCHEMA, type UpgradeReading, watchUpgrade } from "../src/upgrade-watch.js";
import { AUTH, AUTHORIZED_AT, AUTHORIZED_BYTES, BEFORE_AUTH, FIRST_NEW, LAST_OLD, NOT_REVIEWED, NOT_REVIEWED_HEX, RESULTS } from "./helpers/upgrade.js";
import { bytes, cat, compact, str } from "./helpers/scale-write.js";
import { toHex } from "../src/scale/reader.js";

const G = RESULTS.genesis as string;
const OTHER_G = "0x" + "11".repeat(32);
const AT = AUTHORIZED_AT.get(AUTH)?.hash as string;
const BEFORE = AUTHORIZED_AT.get(BEFORE_AUTH)?.hash as string;
const OLD_HEX = LAST_OLD.last_runtime_upgrade.hex;
const NEW_HEX = FIRST_NEW.last_runtime_upgrade.hex;
const [OLD, NEW] = REVIEWED;

/** A reading at the authorising block: the two answers given whole, an Answer each. */
const reading = (lru: UpgradeReading["lastRuntimeUpgrade"], au: UpgradeReading["authorizedUpgrade"], at = AT, number: number | null = AUTH): UpgradeReading => ({
  hash: at,
  number,
  observedAt: "2026-11-12T04:04:20.000Z",
  trust: "trusted RPC",
  lastRuntimeUpgrade: lru,
  authorizedUpgrade: au,
});
const watch = (r: UpgradeReading, earlier: readonly EarlierUpgrade[] = [], genesis: string | null = G): UpgradeWatch => watchUpgrade({ reading: r, genesis, earlier });
const executing = (lru: unknown) => watch(reading({ result: lru }, { result: null })).executing;
const authorized = (au: unknown) => watch(reading({ result: OLD_HEX }, { result: au })).authorized;
const NONE = { spec_name: null, spec_version: null };

describe("the two storage keys", () => {
  it("are twox128 of System then of each entry, and the keys the lab read in results.json", () => {
    const key = (entry: string) => toHex(cat(twox128(new TextEncoder().encode("System")), twox128(new TextEncoder().encode(entry))));
    expect(UPGRADE_KEYS).toEqual({ lastRuntimeUpgrade: key("LastRuntimeUpgrade"), authorizedUpgrade: key("AuthorizedUpgrade") });
    expect(UPGRADE_KEYS.lastRuntimeUpgrade).toBe(RESULTS.keys["System.LastRuntimeUpgrade"]);
    expect(UPGRADE_KEYS.authorizedUpgrade).toBe(RESULTS.authorization.keys["System.AuthorizedUpgrade"]);
  });
});

describe("which runtime executed the block: System.LastRuntimeUpgrade through runtimeOfBlock", () => {
  it("reviewed: names the line runtimeOfBlock finds, the old runtime at 3528527 and the new one at 3528529, as results.json says", () => {
    expect(executing(OLD_HEX)).toEqual({ state: "reviewed", spec_name: LAST_OLD.last_runtime_upgrade.spec_name, spec_version: LAST_OLD.last_runtime_upgrade.spec_version, detail: null });
    expect(executing(NEW_HEX)).toEqual({ state: "reviewed", spec_name: FIRST_NEW.last_runtime_upgrade.spec_name, spec_version: FIRST_NEW.last_runtime_upgrade.spec_version, detail: null });
    expect([executing(OLD_HEX).spec_version, executing(NEW_HEX).spec_version]).toEqual([OLD?.specVersion, NEW?.specVersion]);
    // Never the version state_getRuntimeVersion read at the block: at 3528528 it already names the new one.
    expect(RESULTS.boundary[1].state_getRuntimeVersion_spec).toBe(NEW?.specVersion);
    expect(executing(RESULTS.boundary[1].last_runtime_upgrade.hex).spec_version).toBe(OLD?.specVersion);
  });

  it("not reviewed: a whole record no reviewed line names gives the name and version it states, and a fixed reason", () => {
    expect(executing(NOT_REVIEWED_HEX)).toEqual({ state: "not reviewed", spec_name: NOT_REVIEWED.specName, spec_version: NOT_REVIEWED.specVersion, detail: DETAIL.notReviewed });
    const other = toHex(cat(compact(7), str("other-runtime")));
    expect(executing(other)).toEqual({ state: "not reviewed", spec_name: "other-runtime", spec_version: 7, detail: DETAIL.notReviewed });
  });

  it("absent: only the null the node sent, with a reason", () => {
    expect(executing(null)).toEqual({ state: "absent", ...NONE, detail: DETAIL.lruAbsent });
  });

  it("unknown: a call that failed on the way, named by its call and never by the error's text", () => {
    const x = watch(reading({ error: "rpc socket error: <script>steal()</script>" }, { result: null })).executing;
    expect(x).toEqual({ state: "unknown", ...NONE, detail: DETAIL.lruFailed });
    expect(JSON.stringify(x)).not.toContain("script");
  });

  it("unknown: an answer that is no storage answer, and none of it is echoed", () => {
    const big = "0x" + "zz".repeat(512 * 1024);
    for (const v of [42, 0, true, {}, { result: OLD_HEX }, [OLD_HEX], OLD_HEX.toUpperCase().replace("0X", "0x"), OLD_HEX.slice(0, -1), OLD_HEX.slice(2), ` ${OLD_HEX}`, `${OLD_HEX}\n`, "0X" + OLD_HEX.slice(2), big, "", undefined]) {
      const x = executing(v);
      expect(x, JSON.stringify(v)?.slice(0, 40)).toEqual({ state: "unknown", ...NONE, detail: DETAIL.lruMalformed });
    }
    expect(JSON.stringify(executing(big)).length).toBeLessThan(400);
  });

  it("unknown: bytes that are no whole record, with runtimeOfBlock's refusal as the reason", () => {
    const good = fromHex(OLD_HEX);
    const cases = [cat(good, bytes(0)), good.subarray(0, good.length - 1), new Uint8Array(), cat(compact(2n ** 32n), str(String(OLD?.specName))), cat(bytes(0x01, 0x00), str("x"))];
    for (const b of cases) {
      const r = runtimeOfBlock(b);
      if (r.found) throw new Error("found");
      expect(executing(toHex(b)), toHex(b)).toEqual({ state: "unknown", ...NONE, detail: r.refused });
      expect(r.named).toBeNull();
    }
    expect(executing("0x")).toEqual({ state: "unknown", ...NONE, detail: "no reviewed runtime: the spec version at byte 0: needs 1 byte, 0 left" });
  });
});

describe("whether an upgrade is authorised: System.AuthorizedUpgrade kept as the bytes answered, never decoded", () => {
  it("present: the 33 bytes the lab read at the authorising block, as answered, with their count", () => {
    expect(authorized(AUTHORIZED_BYTES)).toEqual({ state: "present", bytes: AUTHORIZED_BYTES, length: 33, detail: null });
    expect(AUTHORIZED_BYTES.length).toBe(2 + 2 * 33);
  });

  it("present: bytes of any other length, none and one more included, are never judged by their length", () => {
    expect(authorized("0x")).toEqual({ state: "present", bytes: "0x", length: 0, detail: null });
    expect(authorized(AUTHORIZED_BYTES + "00")).toEqual({ state: "present", bytes: AUTHORIZED_BYTES + "00", length: 34, detail: null });
    expect(authorized(AUTHORIZED_BYTES.slice(0, -2))).toEqual({ state: "present", bytes: AUTHORIZED_BYTES.slice(0, -2), length: 32, detail: null });
  });

  it("absent: only the null the node sent, as results.json read at 3528477 and 3528528", () => {
    expect([AUTHORIZED_AT.get(BEFORE_AUTH)?.value, AUTHORIZED_AT.get(RESULTS.boundary[1].height)?.value]).toEqual([null, null]);
    expect(authorized(null)).toEqual({ state: "absent", bytes: null, length: null, detail: null });
  });

  it("unknown, never absent: a failed call, named by its call, and any answer that is no storage answer, none echoed", () => {
    expect(watch(reading({ result: OLD_HEX }, { error: "evil words" })).authorized).toEqual({ state: "unknown", bytes: null, length: null, detail: DETAIL.auFailed });
    for (const v of [0, 33, false, {}, [], AUTHORIZED_BYTES.toUpperCase().replace("0X", "0x"), AUTHORIZED_BYTES.slice(0, -1), AUTHORIZED_BYTES.slice(2), "0x" + "zz".repeat(8), "", undefined]) {
      expect(authorized(v), JSON.stringify(v)).toEqual({ state: "unknown", bytes: null, length: null, detail: DETAIL.auMalformed });
    }
  });
});

describe("the watch itself", () => {
  it("is read at the block it was given, with its time and trust, and holds exactly its fields", () => {
    const w = watch(reading({ result: OLD_HEX }, { result: AUTHORIZED_BYTES }));
    expect(w).toEqual({
      schema: UPGRADE_SCHEMA,
      observed_at: "2026-11-12T04:04:20.000Z",
      trust: "trusted RPC",
      at: { hash: AT, number: AUTH },
      executing: { state: "reviewed", spec_name: OLD?.specName, spec_version: OLD?.specVersion, detail: null },
      authorized: { state: "present", bytes: AUTHORIZED_BYTES, length: 33, detail: null },
      compared_with: null,
      executing_changed: null,
      authorization_appeared: null,
    });
    expect(watch(reading({ result: OLD_HEX }, { result: null }, AT, null)).at).toEqual({ hash: AT, number: null });
  });

  it("reads each answer once, and the two reads are not taken for each other", () => {
    const w = watch(reading({ result: null }, { result: OLD_HEX }));
    expect([w.executing.state, w.authorized.state, w.authorized.bytes]).toEqual(["absent", "present", OLD_HEX]);
  });
});

describe("the comparison with the latest earlier watch on the same RPC genesis at a lower block", () => {
  const at = (n: number, lru: unknown, au: unknown, hash = "0x" + n.toString(16).padStart(64, "0")) => watch(reading({ result: lru }, { result: au }, hash, n));
  const on = (g: string, w: UpgradeWatch): EarlierUpgrade => ({ genesis: g, watch: w });

  it("3528527 then 3528529: the executing runtime changed, as results.json's boundary says", () => {
    const before = at(LAST_OLD.height, OLD_HEX, null, LAST_OLD.hash);
    const w = watch(reading({ result: NEW_HEX }, { result: null }, FIRST_NEW.hash, FIRST_NEW.height), [on(G, before)]);
    expect([w.compared_with, w.executing_changed, w.authorization_appeared]).toEqual([LAST_OLD.height, true, false]);
  });

  it("3528477 then 3528478: the authorisation appeared, as results.json's authorization says", () => {
    const before = watch(reading({ result: OLD_HEX }, { result: AUTHORIZED_AT.get(BEFORE_AUTH)?.value }, BEFORE, BEFORE_AUTH));
    const w = watch(reading({ result: OLD_HEX }, { result: AUTHORIZED_AT.get(AUTH)?.value }), [on(G, before)]);
    expect([w.compared_with, w.executing_changed, w.authorization_appeared]).toEqual([BEFORE_AUTH, false, true]);
  });

  it("an authorisation appears when present now and absent before, or present before with other bytes; else it did not", () => {
    const now = (au: unknown, was: unknown) => watch(reading({ result: OLD_HEX }, { result: au }), [on(G, at(AUTH - 1, OLD_HEX, was))]).authorization_appeared;
    expect([now(AUTHORIZED_BYTES, null), now(AUTHORIZED_BYTES, AUTHORIZED_BYTES), now(AUTHORIZED_BYTES, AUTHORIZED_BYTES + "00"), now(AUTHORIZED_BYTES, "0x"), now(null, AUTHORIZED_BYTES), now(null, null)]).toEqual([true, false, true, true, false, false]);
  });

  it("a runtime changed when its name or its version differs", () => {
    const now = (lru: string, was: string) => watch(reading({ result: lru }, { result: null }), [on(G, at(AUTH - 1, was, null))]).executing_changed;
    const otherName = toHex(cat(compact(Number(OLD?.specVersion)), str("other-runtime")));
    expect([now(OLD_HEX, OLD_HEX), now(NEW_HEX, OLD_HEX), now(otherName, OLD_HEX), now(OLD_HEX, NOT_REVIEWED_HEX), now(NOT_REVIEWED_HEX, NOT_REVIEWED_HEX)]).toEqual([false, true, true, true, false]);
  });

  it("says nothing of a side it does not know: an unknown or absent runtime, an unknown authorisation", () => {
    const pair = (now: [unknown, unknown], was: [unknown, unknown]) => {
      const w = watch(reading({ result: now[0] }, { result: now[1] }), [on(G, at(AUTH - 1, was[0], was[1]))]);
      return [w.compared_with, w.executing_changed, w.authorization_appeared];
    };
    expect(pair([42, AUTHORIZED_BYTES], [OLD_HEX, null])).toEqual([AUTH - 1, null, true]);
    expect(pair([OLD_HEX, AUTHORIZED_BYTES], [null, 7])).toEqual([AUTH - 1, null, null]);
    expect(pair([null, "0XAB"], [OLD_HEX, null])).toEqual([AUTH - 1, null, null]);
    const failed = watch(reading({ error: "x" }, { error: "x" }), [on(G, at(AUTH - 1, OLD_HEX, null))]);
    expect([failed.compared_with, failed.executing_changed, failed.authorization_appeared]).toEqual([AUTH - 1, null, null]);
  });

  it("takes the latest earlier watch below the block, never the oldest, one at or above it, or one on another genesis", () => {
    const old = at(AUTH - 9, OLD_HEX, AUTHORIZED_BYTES);
    const late = at(AUTH - 2, OLD_HEX, null);
    const above = at(AUTH + 5, NEW_HEX, null);
    const same = at(AUTH, NEW_HEX, null);
    const otherChain = at(AUTH - 1, NEW_HEX, null);
    const w = watch(reading({ result: OLD_HEX }, { result: AUTHORIZED_BYTES }), [on(G, old), on(G, late), on(G, above), on(G, same), on(OTHER_G, otherChain)]);
    expect([w.compared_with, w.executing_changed, w.authorization_appeared]).toEqual([AUTH - 2, false, true]);
    // In log order: a watch logged later at a lower block is the latest.
    const w2 = watch(reading({ result: OLD_HEX }, { result: AUTHORIZED_BYTES }), [on(G, late), on(G, old)]);
    expect([w2.compared_with, w2.authorization_appeared]).toEqual([AUTH - 9, false]);
  });

  it("compares with none on another genesis only, with no genesis now, at a height not known, or with no earlier watch", () => {
    const before = at(AUTH - 1, OLD_HEX, null);
    const none = (w: UpgradeWatch) => [w.compared_with, w.executing_changed, w.authorization_appeared];
    expect(none(watch(reading({ result: NEW_HEX }, { result: AUTHORIZED_BYTES }), [on(OTHER_G, before)]))).toEqual([null, null, null]);
    expect(none(watch(reading({ result: NEW_HEX }, { result: AUTHORIZED_BYTES }), [on(G, before)], null))).toEqual([null, null, null]);
    expect(none(watch(reading({ result: NEW_HEX }, { result: AUTHORIZED_BYTES }, AT, null), [on(G, before)]))).toEqual([null, null, null]);
    expect(none(watch(reading({ result: NEW_HEX }, { result: AUTHORIZED_BYTES })))).toEqual([null, null, null]);
    // An earlier watch at a height not known is never one to compare with.
    const unknownHeight = watch(reading({ result: OLD_HEX }, { result: null }, BEFORE, null));
    expect(none(watch(reading({ result: NEW_HEX }, { result: AUTHORIZED_BYTES }), [on(G, unknownHeight)]))).toEqual([null, null, null]);
    // At block 0 nothing is lower.
    expect(none(watch(reading({ result: NEW_HEX }, { result: null }, AT, 0), [on(G, at(0, OLD_HEX, null))]))).toEqual([null, null, null]);
  });
});
