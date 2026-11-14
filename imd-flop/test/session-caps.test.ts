/**
 * P5b, rule C9: raw(x) is the amount's millionths times 10^12 and nothing else, and the grant's fields are derived
 * from the seat's local caps and the days. The epoch length is the recorded runtime's, from
 * research/2026-11-12-session-rerun-1014020/facts-1014020.json `constants.FlopSessionKeys.SessionEpochLength.value`.
 */
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { daysOf, grantCaps, localRaw, RAW_PER_MICRO, rawOf } from "../src/session/caps.js";
import { readJson, RERUN } from "./lib/chain-fixtures.js";

const EPOCH = Number(readJson(`${RERUN}/facts-1014020.json`).constants.FlopSessionKeys.SessionEpochLength.value);
const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof CliError ? e.code : -1;
  }
  return 0;
};

describe("C9: raw amounts and the grant's fields", () => {
  it("10^12 raw per millionth: 10^18 raw per FLOP", () => {
    expect(RAW_PER_MICRO * 1_000_000n).toBe(10n ** 18n);
  });

  it("an amount on the grid has its exact raw amount", () => {
    for (const [x, r] of [[0.000001, 10n ** 12n], [0.02, 2n * 10n ** 16n], [1, 10n ** 18n], [123.456789, 123456789n * 10n ** 12n], [1e9, 10n ** 27n]] as const) expect(rawOf(x, "cap", "42")).toBe(r);
  });

  it("an amount off the grid is exit 3", () => {
    for (const x of [0.0000015, 1.0000001, Number.NaN, Number.POSITIVE_INFINITY]) expect(codeOf(() => rawOf(x, "cap", "42"))).toBe(3);
  });

  it("localRaw refuses a missing or malformed cap with exit 3, as requireCap does", () => {
    expect(codeOf(() => localRaw({}, "42"))).toBe(3);
    expect(codeOf(() => localRaw({ "42": { daily: 1, perCall: 2 } }, "42"))).toBe(3);
    expect(localRaw({ "42": { daily: 0.025, perCall: 0.02 } }, "42")).toMatchObject({ perCall: 2n * 10n ** 16n, daily: 25n * 10n ** 15n });
  });

  it("the grant's fields: per_tx and daily as the local caps, spending the daily times days, duration the epoch times days", () => {
    const local = localRaw({ "42": { daily: 0.025, perCall: 0.02 } }, "42");
    for (const days of [1, 3, 10]) expect(grantCaps(local, days, EPOCH)).toEqual({ per_tx_limit: local.perCall, daily_cap: local.daily, spending_cap: local.daily * BigInt(days), duration_blocks: EPOCH * days });
  });

  it("the duration is the epoch length handed in times the days, never a typed epoch", () => {
    const local = localRaw({ "42": { daily: 0.025, perCall: 0.02 } }, "42");
    for (const epoch of [1, 7, EPOCH - 1, EPOCH + 1]) expect(grantCaps(local, 3, epoch).duration_blocks).toBe(epoch * 3);
  });

  it("--days: 1 to 10, whole, canonical, required", () => {
    for (let d = 1; d <= 10; d++) expect(daysOf(String(d))).toBe(d);
    for (const t of [undefined, "0", "11", "1.5", "01", "1e1", " 1", "10 ", "x", "", "-1", "+1"]) expect([t, codeOf(() => daysOf(t))]).toEqual([t, 2]);
  });
});
