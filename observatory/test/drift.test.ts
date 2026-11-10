// Drift tests: the two drift fixtures site by site, then one test per comparison rule.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { drift, DriftSpecError, parseSpec, SpecDecimal, type DriftOptions } from "../src/drift.js";
import { FixtureSource } from "../src/source.js";
import type { DriftItem, DriftReport, RuntimeConstants } from "../src/types.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const EXCERPT = readFileSync(join(FIXTURES, "params", "flop-protocol-params.excerpt.yaml"), "utf8");
const NOW = "2026-11-10T00:00:00.000Z";
const OPTS: DriftOptions = { observedAt: NOW, trust: "fixture", specSource: "fixtures/params/flop-protocol-params.excerpt.yaml" };
const FLOP = 10n ** 18n;

function rc(values: Record<string, unknown>, extra: Partial<RuntimeConstants> = {}): RuntimeConstants {
  return { observed_at: NOW, runtime_spec_version: null, values, ...extra };
}

function site(rep: DriftReport, param: string, path?: string | null): DriftItem {
  const hits = rep.items.filter((i) => i.param === param && (path === undefined || i.runtime_path === path));
  expect(hits, `${param} ${path ?? ""}`).toHaveLength(1);
  return hits[0]!;
}

/** Runtime constants that match the excerpt everywhere a match is possible. */
function allMatch(): Record<string, unknown> {
  return {
    "validators.initialMinimumStake": (1_200_000n * FLOP).toString(),
    "blockRewards.initialRewardPerBlock": (96n * FLOP).toString(),
    "blockRewards.halvingIntervalBlocks": 63072000,
    "minerStaking.capacityStakePerGflop": (FLOP / 100n).toString(),
    "hasStation.finalityFreezeThreshold": 120,
    "computeChannel.finalityFreezeThreshold": 120,
    "hasStation.htlcBurnShare": 0,
    "validators.extendedDowntimeSlash": 50000000,
    "computeChannel.minForceOpenEscrowForFailedAck": (FLOP / 20n).toString(),
    "daRegistry.depositPerByte": "200000000000",
    "flopSessionKeys.maxSessionDuration": 864000,
  };
}

/** A one-entry spec with meta.decimals 18, unless meta is given. */
function spec(entry: string, meta = "meta:\n  decimals: 18\n"): string {
  return `${meta}parameters:\n${entry}`;
}
function entry(name: string, onChain: string, value: string, unit = "blocks"): string {
  return `  - name: ${name}\n    on_chain: ${onChain}\n    value: ${value}\n    unit: ${unit}\n`;
}

async function loadFixture(name: string) {
  const src = FixtureSource.fromDir(join(FIXTURES, name));
  expect(src.data.loadErrors).toEqual([]);
  const meta = src.data.meta as typeof src.data.meta & { params_spec?: string };
  expect(meta.synthetic).toBe(true);
  expect(meta.params_spec).toBeDefined();
  const text = readFileSync(join(FIXTURES, name, meta.params_spec!), "utf8");
  return { meta, report: drift(text, await src.runtimeConstants(), { ...OPTS, observedAt: meta.now }) };
}

type Row = [param: string, path: string | null, status: DriftItem["status"]];
const SEEDED: Row[] = [
  ["validator_min_stake", "api.consts.validators.initialMinimumStake", "match"],
  ["initial_block_reward", "api.consts.blockRewards.initialRewardPerBlock", "match"],
  ["halving_interval_blocks", "api.consts.blockRewards.halvingIntervalBlocks", "match"],
  ["miner_capacity_stake_per_gflop", "api.consts.minerStaking.capacityStakePerGflop", "unknown"],
  ["finality_freeze_threshold", "api.consts.hasStation.finalityFreezeThreshold", "match"],
  ["finality_freeze_threshold", "api.consts.computeChannel.finalityFreezeThreshold", "mismatch"],
  ["htlc_burn_share_ppt", "api.consts.hasStation.htlcBurnShare", "unknown"],
  ["validator_extended_downtime_slash_percent", "api.consts.validators.extendedDowntimeSlash", "match"],
  ["min_force_open_escrow_for_failed_ack", "api.consts.computeChannel.minForceOpenEscrowForFailedAck", "match"],
  ["da_lease_deposit_per_byte", "api.consts.daRegistry.depositPerByte", "match"],
  ["da_lease_deposit_per_byte", "api.query.daRegistry.depositPerByteValue", "unknown"],
  ["agent_identity_min_stake", null, "unknown"],
  ["session_key_expiry_days", "api.consts.flopSessionKeys.maxSessionDuration", "match"],
];
const ALL_MATCH: Row[] = SEEDED.map(([p, path, s]) =>
  path === "api.consts.computeChannel.finalityFreezeThreshold" || path === "api.consts.hasStation.htlcBurnShare"
    ? [p, path, "match"]
    : [p, path, s],
);

function checkInvariants(rep: DriftReport) {
  expect(rep.matches + rep.mismatches + rep.unknown).toBe(rep.items.length);
  for (const i of rep.items) {
    if (i.status !== "unknown") {
      expect(i.expected, i.param).not.toBeNull();
      expect(i.runtime, i.param).not.toBeNull();
      expect(i.mapping).toBe("constant");
    }
    if (i.status === "match") expect(BigInt(String(i.runtime))).toBe(BigInt(i.expected!));
  }
  expect(JSON.parse(JSON.stringify(rep))).toEqual(rep);
}

describe("drift fixtures", () => {
  it("drift-seeded: exactly one seeded mismatch, eight matches and four unknown, site by site", async () => {
    const { meta, report } = await loadFixture("drift-seeded");
    expect(report.items.map((i) => [i.param, i.runtime_path, i.status])).toEqual(SEEDED);
    expect([report.matches, report.mismatches, report.unknown]).toEqual([8, 1, 4]);
    expect(meta.description).toContain("Expected: items 13; matches 8; mismatches 1; unknown 4");
    const bad = site(report, "finality_freeze_threshold", "api.consts.computeChannel.finalityFreezeThreshold");
    expect(bad.runtime).toBe(100);
    expect(bad.expected).toBe("120");
    expect(bad.note).toBe("runtime holds 100, the spec asks for 120");
    expect(site(report, "htlc_burn_share_ppt").runtime).toBeNull();
    expect(site(report, "htlc_burn_share_ppt").spec).toBe(0);
    checkInvariants(report);
  });

  it("drift-all-match: every checkable site matches, and the three that cannot be checked stay unknown", async () => {
    const { meta, report } = await loadFixture("drift-all-match");
    expect(report.items.map((i) => [i.param, i.runtime_path, i.status])).toEqual(ALL_MATCH);
    expect([report.matches, report.mismatches, report.unknown]).toEqual([10, 0, 3]);
    expect(meta.description).toContain("Expected: items 13; matches 10; mismatches 0; unknown 3");
    checkInvariants(report);
  });

  it("drift-long-decimal: decimals longer than a JS number keeps are read exactly, never matched from a rounded value", async () => {
    const { meta, report } = await loadFixture("drift-long-decimal");
    expect(report.items.map((i) => [i.param, i.status, i.expected, i.spec])).toEqual([
      ["p_short_decimal", "match", "50000000000000000", 0.05],
      ["p_exact_long", "match", "1000000000000000001", "1.000000000000000001"],
      ["p_mismatch", "mismatch", "1200000000000000000001000", "1200000.000000000000001"],
      ["p_tiny_fraction", "unknown", null, "1.0000000000000000001"],
    ]);
    expect([report.matches, report.mismatches, report.unknown]).toEqual([2, 1, 1]);
    expect(meta.description).toContain("Expected: items 4; matches 2; mismatches 1; unknown 1.");
    expect(site(report, "p_tiny_fraction").note).toContain("does not say how it rounds");
    checkInvariants(report);
  });

  it("drift-long-decimal's spec still holds the long literals, which a JS number cannot hold", () => {
    const text = readFileSync(join(FIXTURES, "drift-long-decimal", "spec.yaml"), "utf8");
    for (const literal of ["1.000000000000000001", "1200000.000000000000001", "1.0000000000000000001"]) {
      expect(text).toContain(`value: ${literal}\n`);
      expect(String(Number(literal))).not.toBe(literal);
    }
  });

  it("reports carry observed_at, trust, the spec source and what the runtime constants say about themselves", async () => {
    const { report } = await loadFixture("drift-seeded");
    expect(report.schema).toBe("flop-observatory/drift@0");
    expect(report.observed_at).toBe(NOW);
    expect(report.trust).toBe("fixture");
    expect(report.spec_source).toBe(OPTS.specSource);
    expect(report.runtime_observed_at).toBe(NOW);
    expect(report.runtime_version).toBeNull();
    expect(report.genesis).toBeNull();
    expect(report.finalized_height).toBeNull();
    const withChain = drift(EXCERPT, rc({}, { runtime_spec_version: 7 }), { ...OPTS, genesis: "0xab", finalizedHeight: 12 });
    expect([withChain.runtime_version, withChain.genesis, withChain.finalized_height]).toEqual([7, "0xab", 12]);
  });
});

describe("unknown, never match by default", () => {
  it("a missing runtime value is unknown, even when the spec value is 0", () => {
    const rep = drift(EXCERPT, rc({}), OPTS);
    const it0 = site(rep, "htlc_burn_share_ppt");
    expect(it0.status).toBe("unknown");
    expect(it0.runtime).toBeNull();
    expect(it0.note).toBe("the runtime value is missing");
    expect(rep.matches).toBe(0);
    expect(rep.mismatches).toBe(0);
    expect(rep.unknown).toBe(rep.items.length);
  });

  it("no runtime constants at all leaves every item unknown", () => {
    const rep = drift(EXCERPT, null, OPTS);
    expect(rep.items.every((i) => i.status === "unknown")).toBe(true);
    expect(site(rep, "halving_interval_blocks").note).toBe("no runtime constants were read");
    expect(rep.runtime_observed_at).toBeNull();
  });

  it("a null runtime value is unknown", () => {
    const rep = drift(EXCERPT, rc({ ...allMatch(), "hasStation.htlcBurnShare": null }), OPTS);
    expect(site(rep, "htlc_burn_share_ppt").status).toBe("unknown");
  });

  it("source_only is unknown with its reason, and never looks up a runtime value", () => {
    const rep = drift(EXCERPT, rc({ ...allMatch(), "agentIdentity.minStake": (10n * FLOP).toString() }), OPTS);
    const so = site(rep, "agent_identity_min_stake");
    expect(so).toMatchObject({ status: "unknown", mapping: "source_only", runtime_path: null, runtime: null, expected: null });
    expect(so.note).toBe("source only: Not exported as a FRAME constant; verified against source only.");
  });

  it("a spec value that is an expression is unknown, even with a runtime value present", () => {
    const rep = drift(EXCERPT, rc(allMatch()), OPTS);
    const ex = site(rep, "miner_capacity_stake_per_gflop");
    expect(ex.status).toBe("unknown");
    expect(ex.spec).toBe("VFY / 100");
    expect(ex.runtime).toBe("10000000000000000");
    expect(ex.note).toContain("is not a number");
  });

  it("storage sites are unknown in M0", () => {
    const rep = drift(EXCERPT, rc({ ...allMatch(), "daRegistry.depositPerByteValue": "200000000000" }), OPTS);
    const st = site(rep, "da_lease_deposit_per_byte", "api.query.daRegistry.depositPerByteValue");
    expect(st).toMatchObject({ status: "unknown", mapping: "storage", runtime: null });
  });

  it("an entry with no mapping, with an empty source_only, or with both source_only and constants is unknown", () => {
    const text = spec(
      "  - {name: a, value: 1, unit: blocks}\n" +
        "  - {name: b, value: 1, unit: blocks, on_chain: {source_only: ''}}\n" +
        "  - {name: c, value: 1, unit: blocks, on_chain: {source_only: x, constants: [P.C]}}\n" +
        "  - {name: d, value: 1, unit: blocks, on_chain: {}}\n",
    );
    const rep = drift(text, rc({ "p.c": 1 }), OPTS);
    expect(rep.items.map((i) => [i.param, i.status, i.mapping])).toEqual([
      ["a", "unknown", "none"],
      ["b", "unknown", "none"],
      ["c", "unknown", "none"],
      ["d", "unknown", "none"],
    ]);
  });

  it("a constant that is not Pallet.Item is unknown", () => {
    const rep = drift(spec(entry("x", "{constants: [NoDot]}", "1")), rc({ NoDot: 1 }), OPTS);
    expect(rep.items[0]).toMatchObject({ status: "unknown", runtime_path: null });
  });
});

describe("exact scaling: decimals, multiplier, divisor", () => {
  it("meta.decimals scales FLOP amounts", () => {
    const ok = drift(EXCERPT, rc(allMatch()), OPTS);
    expect(site(ok, "validator_min_stake")).toMatchObject({ status: "match", expected: "1200000000000000000000000" });
    expect(site(ok, "initial_block_reward").status).toBe("match");
    const raw = drift(EXCERPT, rc({ ...allMatch(), "validators.initialMinimumStake": 1200000 }), OPTS);
    expect(site(raw, "validator_min_stake").status).toBe("mismatch");
  });

  it("a fraction of a FLOP is exact: 0.05 FLOP is 5 * 10^16 base units", () => {
    const ok = drift(EXCERPT, rc(allMatch()), OPTS);
    expect(site(ok, "min_force_open_escrow_for_failed_ack")).toMatchObject({ status: "match", expected: "50000000000000000" });
    const off = drift(EXCERPT, rc({ ...allMatch(), "computeChannel.minForceOpenEscrowForFailedAck": "50000000000000001" }), OPTS);
    expect(site(off, "min_force_open_escrow_for_failed_ack").status).toBe("mismatch");
  });

  it("multiplier turns percent into Perbill parts", () => {
    const ok = drift(EXCERPT, rc(allMatch()), OPTS);
    expect(site(ok, "validator_extended_downtime_slash_percent")).toMatchObject({ status: "match", expected: "50000000" });
    const raw = drift(EXCERPT, rc({ ...allMatch(), "validators.extendedDowntimeSlash": 5 }), OPTS);
    expect(site(raw, "validator_extended_downtime_slash_percent").status).toBe("mismatch");
  });

  it("multiplier turns days into blocks", () => {
    const ok = drift(EXCERPT, rc(allMatch()), OPTS);
    expect(site(ok, "session_key_expiry_days")).toMatchObject({ status: "match", expected: "864000" });
    const raw = drift(EXCERPT, rc({ ...allMatch(), "flopSessionKeys.maxSessionDuration": 10 }), OPTS);
    expect(site(raw, "session_key_expiry_days").status).toBe("mismatch");
  });

  it("divisor and token_units give the per byte deposit in base units", () => {
    const path = "api.consts.daRegistry.depositPerByte";
    const ok = drift(EXCERPT, rc(allMatch()), OPTS);
    expect(site(ok, "da_lease_deposit_per_byte", path)).toMatchObject({ status: "match", expected: "200000000000" });
    const undivided = drift(EXCERPT, rc({ ...allMatch(), "daRegistry.depositPerByte": (200n * FLOP).toString() }), OPTS);
    expect(site(undivided, "da_lease_deposit_per_byte", path).status).toBe("mismatch");
    const unscaled = drift(EXCERPT, rc({ ...allMatch(), "daRegistry.depositPerByte": 0 }), OPTS);
    expect(site(unscaled, "da_lease_deposit_per_byte", path).status).toBe("mismatch");
  });

  it("scaling that leaves a fraction is unknown, not rounded", () => {
    const rep = drift(spec(entry("third", "{constants: [P.C], divisor: 3}", "1")), rc({ "p.c": 0 }), OPTS);
    expect(rep.items[0]).toMatchObject({ status: "unknown", expected: null });
    expect(rep.items[0]!.note).toContain("does not say how it rounds");
  });

  it("without meta.decimals FLOP amounts are unknown, other items still compare", () => {
    const text = spec(entry("flop", "{constants: [P.F]}", "2", "FLOP") + entry("plain", "{constants: [P.B]}", "7"), "");
    const rep = drift(text, rc({ "p.f": "2000000000000000000", "p.b": 7 }), OPTS);
    expect(rep.items.map((i) => i.status)).toEqual(["unknown", "match"]);
    expect(rep.items[0]!.note).toContain("meta.decimals");
  });

  it("an invalid multiplier or divisor is unknown", () => {
    const text = spec(entry("m", "{constants: [P.M], multiplier: 0}", "1") + entry("d", "{constants: [P.D], divisor: x}", "1"));
    const rep = drift(text, rc({ "p.m": 0, "p.d": 1 }), OPTS);
    expect(rep.items.map((i) => i.status)).toEqual(["unknown", "unknown"]);
  });
});

describe("reading runtime values exactly", () => {
  it("compares past 2^53 without rounding", () => {
    const rep = drift(EXCERPT, rc({ ...allMatch(), "validators.initialMinimumStake": "1200000000000000000000001" }), OPTS);
    expect(site(rep, "validator_min_stake").status).toBe("mismatch");
  });

  it("a JS number past 2^53 is unknown, because its exact value is lost", () => {
    const rep = drift(EXCERPT, rc({ ...allMatch(), "validators.initialMinimumStake": 1.2e24 }), OPTS);
    expect(site(rep, "validator_min_stake").status).toBe("unknown");
    expect(site(rep, "validator_min_stake").note).toContain("2^53");
  });

  it("hex is unknown: SCALE bytes are little endian, so its value is ambiguous", () => {
    const rep = drift(EXCERPT, rc({ ...allMatch(), "blockRewards.halvingIntervalBlocks": "0x03c26700" }), OPTS);
    expect(site(rep, "halving_interval_blocks").status).toBe("unknown");
    expect(site(rep, "halving_interval_blocks").note).toContain("hex");
  });

  it("fractions, booleans, lists and text are unknown", () => {
    for (const v of [120.5, true, [120], "120 blocks", { value: 120 }]) {
      const rep = drift(EXCERPT, rc({ ...allMatch(), "hasStation.finalityFreezeThreshold": v }), OPTS);
      expect(site(rep, "finality_freeze_threshold", "api.consts.hasStation.finalityFreezeThreshold").status).toBe("unknown");
    }
  });

  it("a decimal string and a number read the same", () => {
    const rep = drift(EXCERPT, rc({ ...allMatch(), "blockRewards.halvingIntervalBlocks": "63072000" }), OPTS);
    expect(site(rep, "halving_interval_blocks").status).toBe("match");
  });

  it("the metadata spelling of a key is accepted too", () => {
    const values = allMatch();
    delete values["blockRewards.halvingIntervalBlocks"];
    const rep = drift(EXCERPT, rc({ ...values, "BlockRewards.HalvingIntervalBlocks": 63072000 }), OPTS);
    expect(site(rep, "halving_interval_blocks").status).toBe("match");
  });

  it("two key spellings holding different values are unknown; holding the same value is fine", () => {
    const differ = drift(EXCERPT, rc({ ...allMatch(), "BlockRewards.HalvingIntervalBlocks": 1 }), OPTS);
    expect(site(differ, "halving_interval_blocks").status).toBe("unknown");
    expect(site(differ, "halving_interval_blocks").note).toContain("two key spellings");
    const same = drift(EXCERPT, rc({ ...allMatch(), "BlockRewards.HalvingIntervalBlocks": "63072000" }), OPTS);
    expect(site(same, "halving_interval_blocks").status).toBe("match");
  });
});

describe("reading spec decimals exactly", () => {
  it("keeps every number that is not an integer with its source text, so no spec value is a bare JS number", () => {
    const parsed = parseSpec(EXCERPT);
    const values = parsed.entries.map((e) => (e as { value?: unknown }).value);
    expect(values.filter((v) => typeof v === "number")).toEqual([]);
    const ack = parsed.entries.find((e) => (e as { name?: string }).name === "min_force_open_escrow_for_failed_ack") as { value: unknown };
    expect(ack.value).toBeInstanceOf(SpecDecimal);
    expect((ack.value as SpecDecimal).source).toBe("0.05");
  });

  it("reads underscores, exponents and a leading or trailing point exactly", () => {
    const text = spec(
      entry("u", "{constants: [P.U], multiplier: 2}", "1_000.5") +
        entry("e", "{constants: [P.E]}", "2e-7", "FLOP") +
        entry("l", "{constants: [P.L], multiplier: 4}", ".5") +
        entry("t", "{constants: [P.T]}", "3."),
    );
    const rep = drift(text, rc({ "p.u": 2001, "p.e": "200000000000", "p.l": 2, "p.t": 3 }), OPTS);
    expect(rep.items.map((i) => [i.param, i.status, i.expected])).toEqual([
      ["u", "match", "2001"],
      ["e", "match", "200000000000"],
      ["l", "match", "2"],
      ["t", "match", "3"],
    ]);
  });

  it("a decimal that is whole works as an integer for meta.decimals and multiplier", () => {
    const text = spec(entry("p", "{constants: [P.C], multiplier: 1.0e7}", "5", "percent") + entry("f", "{constants: [P.F]}", "2", "FLOP"), "meta:\n  decimals: 18.0\n");
    const rep = drift(text, rc({ "p.c": 50000000, "p.f": "2000000000000000000" }), OPTS);
    expect(rep.items.map((i) => i.status)).toEqual(["match", "match"]);
  });

  it("infinity, not a number and sexagesimal decimals are unknown, never a number", () => {
    const text = spec(entry("i", "{constants: [P.I]}", ".inf") + entry("n", "{constants: [P.N]}", ".nan") + entry("s", "{constants: [P.S]}", "1:30.5"));
    const rep = drift(text, rc({ "p.i": 1, "p.n": 1, "p.s": 90 }), OPTS);
    expect(rep.items.map((i) => i.status)).toEqual(["unknown", "unknown", "unknown"]);
    expect(rep.items.every((i) => i.note?.includes("is not a number"))).toBe(true);
  });

  it("the spec field is the source text whenever a JS number would round the value", () => {
    const text = spec(entry("short", "{constants: [P.A]}", "0.1") + entry("long", "{constants: [P.B]}", "0.10000000000000000001"));
    const rep = drift(text, null, OPTS);
    expect(rep.items.map((i) => i.spec)).toEqual([0.1, "0.10000000000000000001"]);
    expect(JSON.parse(JSON.stringify(rep))).toEqual(rep);
  });

  it("a long decimal that is a whole number of base units matches exactly, one base unit off does not", () => {
    const text = spec(entry("x", "{constants: [P.X]}", "1.000000000000000001", "FLOP"));
    expect(drift(text, rc({ "p.x": "1000000000000000001" }), OPTS).items[0]!.status).toBe("match");
    expect(drift(text, rc({ "p.x": "1000000000000000000" }), OPTS).items[0]!.status).toBe("mismatch");
  });

  it("a plain JS number in a spec built in code reads from its shortest decimal form", () => {
    const built = { decimals: 18n, entries: [{ name: "x", value: 0.05, unit: "FLOP", on_chain: { constants: ["P.X"] } }] };
    expect(drift(built, rc({ "p.x": "50000000000000000" }), OPTS).items[0]!.status).toBe("match");
  });
});

describe("parsing the spec", () => {
  it("reads YAML 1.1 as upstream does: 63_072_000 is a number", () => {
    const parsed = parseSpec(EXCERPT);
    const halving = parsed.entries.find((e) => (e as { name?: string }).name === "halving_interval_blocks") as { value: unknown };
    expect(halving.value).toBe(63072000n);
    expect(parsed.decimals).toBe(18n);
    expect(drift(parsed, rc(allMatch()), OPTS).items.length).toBe(13);
  });

  it("reads both parameters and reference entries, in file order", () => {
    const rep = drift(EXCERPT, null, OPTS);
    expect(rep.items[0]!.param).toBe("validator_min_stake");
    expect(rep.items[rep.items.length - 1]!.param).toBe("session_key_expiry_days");
  });

  it("refuses a spec it cannot use instead of reporting no drift", () => {
    expect(() => drift("parameters: [", null, OPTS)).toThrow(DriftSpecError);
    expect(() => drift("meta:\n  decimals: 18\n", null, OPTS)).toThrow(DriftSpecError);
    expect(() => drift("parameters: 3\n", null, OPTS)).toThrow(DriftSpecError);
    expect(() => drift("- 1\n- 2\n", null, OPTS)).toThrow(DriftSpecError);
  });

  it("keeps spec values JSON safe", () => {
    const big = drift(spec(entry("big", "{constants: [P.C]}", "12_000_000_000_000_000_000")), rc({ "p.c": "12000000000000000000" }), OPTS);
    expect(big.items[0]).toMatchObject({ spec: "12000000000000000000", status: "match" });
    expect(() => JSON.stringify(big)).not.toThrow();
  });
});
