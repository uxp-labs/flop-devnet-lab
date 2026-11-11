import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { FixtureSource } from "../src/source.js";
import { unknownHttp } from "../src/source.js";
import { DEVNET_GENESIS, assessNetwork, classifyFaucet, classifyGateway, networkStatus, resetDetected, rpcHeadUsable } from "../src/status.js";

const NOW = "2026-11-09T23:47:53Z";
const OTHER = "0x" + "ab".repeat(32);
const fx = (name: string) => FixtureSource.fromDir(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
const run = (name: string, extra: Record<string, unknown> = {}) =>
  networkStatus(fx(name), { pinnedGenesis: DEVNET_GENESIS, now: NOW, ...extra });

describe("pinned genesis", () => {
  it("is the same hash imd-flop pins", () => {
    const text = readFileSync(new URL("../../imd-flop/src/networks.ts", import.meta.url), "utf8");
    expect(text).toContain(DEVNET_GENESIS);
  });

  it("refuses a malformed pin", async () => {
    await expect(networkStatus(fx("status-healthy"), { pinnedGenesis: "0x1234", now: NOW })).rejects.toThrow(/pinnedGenesis/);
  });
});

describe("real degraded faucet, 2026-11-09 23:47 UTC", () => {
  it("shows the faucet as degraded, never ok", async () => {
    const s = await run("status-degraded-real");
    expect(s.faucet.health).toBe("degraded");
    expect(s.faucet.http).toBe(503);
    expect(s.faucet.ready).toBe(false);
    expect(s.faucet.limits?.addressCooldownMs).toBe(86400000);
    expect(s.faucet.limits?.identityCooldownMs).toBe(86400000);
  });

  it("leaves everything it did not read as unknown or null", async () => {
    const s = await run("status-degraded-real");
    expect(s.gateway.health).toBe("unknown");
    expect(s.rpc.health).toBe("unknown");
    expect(s.rpc.stale).toBeNull();
    expect(s.finalized_height).toBeNull();
    expect(s.finalized_hash).toBeNull();
    expect(s.best_height).toBeNull();
    expect(s.finality_lag).toBeNull();
    expect(s.runtime_version).toBeNull();
    expect(s.genesis).toEqual({ pinned: DEVNET_GENESIS, faucet: DEVNET_GENESIS, rpc: null });
  });

  it("does not call one matching source a clean bill: reset_detected is null", async () => {
    expect((await run("status-degraded-real")).reset_detected).toBeNull();
  });
});

describe("healthy devnet", () => {
  it("is ok everywhere with reset_detected false", async () => {
    const s = await run("status-healthy");
    expect([s.faucet.health, s.gateway.health, s.rpc.health]).toEqual(["ok", "ok", "ok"]);
    expect(s.reset_detected).toBe(false);
    expect(s.conflicts).toEqual([]);
    expect(s.finalized_height).toBe(3341575);
    expect(s.finality_lag).toBe(2);
    expect(s.runtime_version).toBe(1014002);
    expect(s.rpc.stale).toBe(false);
    expect(s.trust).toBe("fixture");
    expect(s.observed_at).toBe(NOW);
  });
});

describe("injected failures", () => {
  it("reset: both sources agree on a new genesis", async () => {
    const s = await run("status-reset");
    expect(s.reset_detected).toBe(true);
    expect(s.genesis.faucet).toBe(OTHER);
    expect(s.genesis.rpc).toBe(OTHER);
  });

  it("conflicting responses: faucet and RPC disagree", async () => {
    const s = await run("status-conflict");
    expect(s.reset_detected).toBe(true);
    expect(s.conflicts.join(" ")).toMatch(/differs from rpc genesis/);
  });

  it("stale RPC: an hour-old head is stale and degraded", async () => {
    const s = await run("status-stale-rpc");
    expect(s.rpc.stale).toBe(true);
    expect(s.rpc.health).toBe("degraded");
    expect(s.rpc.detail).toMatch(/old/);
  });

  it("finality lag: 100 blocks behind is degraded", async () => {
    const s = await run("status-finality-lag");
    expect(s.finality_lag).toBe(100);
    expect(s.rpc.health).toBe("degraded");
    expect(s.rpc.detail).toMatch(/finality lag 100/);
  });

  it("finalized height going backwards is a conflict", async () => {
    const s = await run("status-healthy", {
      previous: { genesis: DEVNET_GENESIS, finalized_height: 3341600, finalized_hash: "0x" + "5e".repeat(32), observed_at: NOW },
    });
    expect(s.conflicts.join(" ")).toMatch(/went backwards/);
    expect(s.rpc.health).toBe("degraded");
  });

  it("a finalized block changing hash is a conflict", async () => {
    const s = await run("status-healthy", {
      previous: { genesis: DEVNET_GENESIS, finalized_height: 3341575, finalized_hash: "0x" + "77".repeat(32), observed_at: NOW },
    });
    expect(s.conflicts.join(" ")).toMatch(/changed hash/);
  });

  it("a finalized height stuck past the stale window is stale", async () => {
    const s = await run("status-healthy", {
      previous: {
        genesis: DEVNET_GENESIS,
        finalized_height: 3341575,
        finalized_hash: "0x" + "5e".repeat(32),
        observed_at: "2026-11-09T23:30:00Z",
      },
    });
    expect(s.rpc.stale).toBe(true);
    expect(s.rpc.detail).toMatch(/stuck/);
  });

  describe("every earlier snapshot on the same genesis counts, not only the last (IMD follow-up audit)", () => {
    const head = (finalized_height: number, observed_at = NOW, finalized_hash = "0x" + "5e".repeat(32), genesis: string = DEVNET_GENESIS) => ({
      genesis,
      finalized_height,
      finalized_hash,
      observed_at,
    });
    it("a later snapshot on another genesis cannot hide a rollback against an earlier one on this genesis", async () => {
      const s = await run("status-healthy", { previous: [head(3341600, "2026-11-09T23:46:00Z"), head(10, "2026-11-09T23:47:00Z", "0x" + "11".repeat(32), OTHER)] });
      expect(s.conflicts.join(" ")).toMatch(/went backwards from 3341600 to 3341575/);
      expect(s.rpc.health).toBe("degraded");
    });
    it("the floor is the highest finalized height ever seen on this genesis, not the latest", async () => {
      const s = await run("status-healthy", { previous: [head(3341600, "2026-11-09T23:46:00Z"), head(3341570, "2026-11-09T23:47:00Z")] });
      expect(s.conflicts.join(" ")).toMatch(/went backwards from 3341600 to 3341575/);
    });
    it("200,000 earlier heads and best heights, ten years and more of readings, give the floors as a short history does", async () => {
      // One call that spread every earlier height into its arguments threw near 120,000 of them.
      const n = 200_000;
      const heads = Array.from({ length: n }, (_, i) => head(3341000 + (i % 500), "2026-11-09T23:46:00Z", "0x" + (i % 500).toString(16).padStart(64, "0")));
      heads[n - 7] = head(3341600, "2026-11-09T23:46:00Z");
      const bests = Array.from({ length: n }, (_, i) => ({ genesis: DEVNET_GENESIS, best_height: 3341000 + (i % 500) }));
      bests[n - 3] = { genesis: DEVNET_GENESIS, best_height: 3341700 };
      const many = await run("status-healthy", { previous: heads, earlierBest: bests });
      const few = await run("status-healthy", { previous: [head(3341000), head(3341600, "2026-11-09T23:46:00Z")], earlierBest: [{ genesis: DEVNET_GENESIS, best_height: 3341700 }] });
      expect(many.conflicts).toEqual(few.conflicts);
      expect(many.conflicts.join(" ")).toMatch(/went backwards from 3341600 to 3341575/);
      expect(many.conflicts.join(" ")).toMatch(/more than 30 blocks below the best block 3341700/);
    });
    it("a changed hash at this height in any earlier snapshot is a conflict", async () => {
      const s = await run("status-healthy", { previous: [head(3341575, "2026-11-09T23:46:00Z", "0x" + "77".repeat(32)), head(3341570, "2026-11-09T23:47:00Z")] });
      expect(s.conflicts.join(" ")).toMatch(/changed hash/);
    });
    it("stuck counts from the oldest of the latest run of snapshots at this height", async () => {
      const run2 = (prev: ReturnType<typeof head>[]) => run("status-healthy", { previous: prev });
      const stuck = await run2([head(3341575, "2026-11-09T23:30:00Z"), head(3341575, "2026-11-09T23:46:53Z")]);
      expect(stuck.rpc.stale).toBe(true);
      expect(stuck.rpc.detail).toMatch(/stuck at 3341575 for 1073s/);
      const recent = await run2([head(3341575, "2026-11-09T23:46:53Z")]);
      expect(recent.rpc.stale).toBe(false);
      const moved = await run2([head(3341575, "2026-11-09T23:30:00Z"), head(3341574, "2026-11-09T23:40:00Z"), head(3341575, "2026-11-09T23:46:53Z")]);
      expect(moved.rpc.stale).toBe(false);
    });
    it("an earlier best height is a floor too, less the lag limit, with or without a finalized head (Fable review r8 L1)", async () => {
      const best = (best_height: number, genesis: string = DEVNET_GENESIS) => ({ genesis, best_height });
      // status-healthy reads best block 3341577 with the default lag limit of 30.
      const within = await run("status-healthy", { earlierBest: [best(3341577 + 30)] });
      expect(within.conflicts).toEqual([]);
      expect(within.reset_detected).toBe(false);
      const fell = await run("status-healthy", { earlierBest: [best(3341000), best(3341577 + 31), best(3341500)] });
      expect(fell.conflicts.join(" ")).toMatch(/best block 3341577 is more than 30 blocks below the best block 3341608 an earlier snapshot saw on this genesis/);
      expect(fell.rpc.health).toBe("degraded");
      expect(fell.reset_detected).toBeNull();
      // A restarted head with no finalized head is caught the same way.
      const src = fx("status-healthy");
      const restarted = new FixtureSource({ ...src.data, rpcHead: { ...(src.data.rpcHead as object), finalized: null, best_number: 8 } as never });
      const s = await networkStatus(restarted, { pinnedGenesis: DEVNET_GENESIS, now: NOW, earlierBest: [best(3341577)] });
      expect(s.conflicts.join(" ")).toMatch(/best block 8 is more than 30 blocks below the best block 3341577/);
      expect(s.reset_detected).toBeNull();
      // Best heights read on another genesis change nothing.
      const other = await run("status-healthy", { earlierBest: [best(9_000_000, OTHER)] });
      expect(other.conflicts).toEqual([]);
      expect(other.reset_detected).toBe(false);
    });
    it("an earlier best height is a floor whether or not that head read a finalized head, so a restart after a finality stall is seen, and a long fork that falls away fails closed (Fable review r10 L4, r9 L5)", async () => {
      // Finality never got past block 0 while the best block reached 3341675; this head reads best
      // 3341577, so 98 blocks fell away. That is a restart or a long fork lost: not usable, either way.
      const fell = await run("status-healthy", {
        earlierBest: [{ genesis: DEVNET_GENESIS, best_height: 3341675 }],
        previous: [{ genesis: DEVNET_GENESIS, finalized_height: 0, finalized_hash: "0x" + "77".repeat(32), observed_at: "2026-11-09T23:47:00Z" }],
      });
      expect(fell.conflicts.join(" ")).toMatch(/best block 3341577 is more than 30 blocks below the best block 3341675/);
      expect(fell.reset_detected).toBeNull();
      // Back within the lag limit of the highest best height seen, the head counts again.
      const healed = await run("status-healthy", {
        earlierBest: [{ genesis: DEVNET_GENESIS, best_height: 3341600 }],
        previous: [{ genesis: DEVNET_GENESIS, finalized_height: 0, finalized_hash: "0x" + "77".repeat(32), observed_at: "2026-11-09T23:47:00Z" }],
      });
      expect(healed.conflicts).toEqual([]);
      expect(healed.reset_detected).toBe(false);
    });
    it("earlier heads on another genesis alone change nothing", async () => {
      const s = await run("status-healthy", { previous: [head(3341600, NOW, "0x" + "11".repeat(32), OTHER)] });
      expect(s.conflicts).toEqual([]);
      expect(s.rpc.health).toBe("ok");
    });
  });

  it("a finalized height or best height past 2^53 - 1 is no valid head: degraded, and the height is null (IMD follow-up audit)", async () => {
    const src = fx("status-healthy");
    const head = { ...(src.data.rpcHead as object), finalized: { number: JSON.parse("9007199254740993"), hash: "0x" + "5e".repeat(32) }, best_number: JSON.parse("9007199254740995") };
    const s = await networkStatus(new FixtureSource({ ...src.data, rpcHead: head as never }), { pinnedGenesis: DEVNET_GENESIS, now: NOW });
    expect(s.rpc.health).toBe("degraded");
    expect(s.finalized_height).toBeNull();
    expect(s.best_height).toBeNull();
    expect(s.rpc.detail).toMatch(/no valid finalized head/);
  });

  it("an earlier snapshot at this height whose head time does not parse leaves stuck unknown, never ok (IMD follow-up audit)", async () => {
    const s = await run("status-healthy", {
      previous: [{ genesis: DEVNET_GENESIS, finalized_height: 3341575, finalized_hash: "0x" + "5e".repeat(32), observed_at: "2026-11-09T23:47:40" }],
    });
    expect(s.rpc.health).toBe("unknown");
    expect(s.rpc.detail).toMatch(/whether the height is stuck is unknown/);
    // Stale is not known to be false either (tenth rerun U2), so a gate on stale false waits.
    expect(s.rpc.stale).toBeNull();
  });

  it("malformed responses become unknown or null, never ok", async () => {
    const src = fx("status-malformed");
    expect(src.data.loadErrors?.join(" ")).toMatch(/faucet-health\.json/);
    const s = await networkStatus(src, { pinnedGenesis: DEVNET_GENESIS, now: NOW });
    expect(s.faucet.health).toBe("unknown");
    expect(s.gateway.health).toBe("degraded");
    expect(s.genesis.rpc).toBeNull();
    expect(s.conflicts.join(" ")).toMatch(/rpc genesis hash is malformed/);
    expect(s.finalized_height).toBeNull();
    expect(s.best_height).toBeNull();
    expect(s.rpc.health).toBe("degraded");
    expect(s.reset_detected).toBeNull();
  });

  it("an RPC read that was tried and failed is down, not unknown", async () => {
    const src = new FixtureSource({
      meta: { scenario: "rpc-error", description: "synthetic", now: NOW, synthetic: true },
      rpcHead: {
        genesis_hash: null,
        finalized: null,
        best_number: null,
        runtime_spec_version: null,
        observed_at: NOW,
        error: "websocket closed: 1006",
      },
    });
    const s = await networkStatus(src, { pinnedGenesis: DEVNET_GENESIS, now: NOW });
    expect(s.rpc.health).toBe("down");
    expect(s.rpc.detail).toBe("websocket closed: 1006");
  });

  it("nothing read: all unknown, reset_detected null", async () => {
    const s = await run("status-unknown");
    expect([s.faucet.health, s.gateway.health, s.rpc.health]).toEqual(["unknown", "unknown", "unknown"]);
    expect(s.reset_detected).toBeNull();
    expect(s.conflicts).toEqual([]);
  });
});

describe("health is ok only when every check ran and passed (RULES 1.1)", () => {
  const healthy = () => fx("status-healthy");
  const withHead = (edit: Record<string, unknown>) => {
    const src = healthy();
    return new FixtureSource({ ...src.data, rpcHead: { ...(src.data.rpcHead as object), ...edit } as never });
  };
  const withFaucet = (edit: Record<string, unknown>) => {
    const src = healthy();
    return new FixtureSource({ ...src.data, faucetHealth: { ...(src.data.faucetHealth as object), ...edit } as never });
  };
  const status = (src: FixtureSource) => networkStatus(src, { pinnedGenesis: DEVNET_GENESIS, now: NOW });

  it("no observed_at on the head: rpc unknown, stale null", async () => {
    const s = await run("status-rpc-no-observed-at");
    expect(s.rpc.health).toBe("unknown");
    expect(s.rpc.stale).toBeNull();
    expect(s.rpc.detail).toMatch(/no observed_at/);
    expect(s.conflicts).toEqual([]);
  });

  it("an unparsable observed_at: rpc unknown, stale null", async () => {
    const s = await status(withHead({ observed_at: "yesterday" }));
    expect(s.rpc.health).toBe("unknown");
    expect(s.rpc.stale).toBeNull();
    expect(s.rpc.detail).toMatch(/does not parse/);
  });

  it("no best height: rpc degraded, finality lag null", async () => {
    const s = await run("status-rpc-no-best");
    expect(s.rpc.health).toBe("degraded");
    expect(s.rpc.detail).toMatch(/no valid best height/);
    expect(s.finality_lag).toBeNull();
  });

  it("a head time later than the snapshot time: a conflict, rpc degraded, stale null", async () => {
    const s = await run("status-rpc-future-head");
    expect(s.rpc.health).toBe("degraded");
    expect(s.rpc.stale).toBeNull();
    expect(s.conflicts.join(" ")).toMatch(/later than the snapshot time/);
  });

  it("a head one second old is fine, and the stale limit is inclusive", async () => {
    expect((await run("status-healthy")).rpc.stale).toBe(false);
    const s = await status(withHead({ observed_at: "2026-11-09T23:45:53Z" }));
    expect(s.rpc.stale).toBe(false);
    expect(s.rpc.health).toBe("ok");
  });

  it("a read error alongside a partial head: rpc degraded", async () => {
    const s = await status(withHead({ error: "chain_getHeader timed out" }));
    expect(s.rpc.health).toBe("degraded");
    expect(s.rpc.detail).toMatch(/read error: chain_getHeader timed out/);
  });

  it("no genesis hash on an otherwise valid head: rpc degraded, reset_detected null", async () => {
    const s = await status(withHead({ genesis_hash: null }));
    expect(s.rpc.health).toBe("degraded");
    expect(s.rpc.detail).toMatch(/no valid genesis hash/);
    expect(s.reset_detected).toBeNull();
  });

  it("a faucet answering 503 with an ok body: degraded, never ok", async () => {
    const s = await run("status-faucet-503-ok-body");
    expect(s.faucet.health).toBe("degraded");
    expect(s.faucet.detail).toMatch(/body says ok but http 503/);
  });

  it("a faucet answering 200 with a degraded body: degraded", async () => {
    const s = await status(withFaucet({ body: { status: "degraded", ready: false } }));
    expect(s.faucet.health).toBe("degraded");
  });

  it("only HTTP 200 is ok: a faucet or gateway 204 is degraded", async () => {
    expect((await status(withFaucet({ http: 204 }))).faucet.health).toBe("degraded");
    const src = healthy();
    const gw = new FixtureSource({ ...src.data, gatewayModels: { ...(src.data.gatewayModels as object), http: 204 } as never });
    expect((await status(gw)).gateway.health).toBe("degraded");
  });

  it("finality lag: 30 blocks is ok, 31 is degraded", async () => {
    const at = (lag: number) => status(withHead({ best_number: 3341575 + lag }));
    expect((await at(30)).rpc.health).toBe("ok");
    const s = await at(31);
    expect(s.rpc.health).toBe("degraded");
    expect(s.rpc.detail).toMatch(/finality lag 31/);
  });

  it("head age: 120 s is fresh, 121 s is stale", async () => {
    expect((await status(withHead({ observed_at: "2026-11-09T23:45:53Z" }))).rpc.stale).toBe(false);
    const s = await status(withHead({ observed_at: "2026-11-09T23:45:52Z" }));
    expect(s.rpc.stale).toBe(true);
    expect(s.rpc.health).toBe("degraded");
  });

  it("a head time even 1 s later than the snapshot time is a conflict", async () => {
    const s = await status(withHead({ observed_at: "2026-11-09T23:47:54Z" }));
    expect(s.rpc.health).toBe("degraded");
    expect(s.rpc.stale).toBeNull();
    expect(s.conflicts.join(" ")).toMatch(/later than the snapshot time/);
  });
});

describe("times must carry a zone (RULES 1.1)", () => {
  const healthy = () => fx("status-healthy");
  const zoneless = () => {
    const src = healthy();
    const strip = (t: unknown) => String(t).replace(/Z$/, "");
    return new FixtureSource({
      ...src.data,
      rpcHead: { ...(src.data.rpcHead as object), observed_at: strip(src.data.rpcHead?.observed_at) } as never,
      faucetHealth: { ...(src.data.faucetHealth as object), fetched_at: strip(src.data.faucetHealth?.fetched_at) } as never,
      gatewayModels: { ...(src.data.gatewayModels as object), fetched_at: strip(src.data.gatewayModels?.fetched_at) } as never,
    });
  };

  it("reading times without a zone are unknown on every machine, whatever its time zone", async () => {
    const before = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/New_York", "Asia/Tokyo"]) {
        process.env.TZ = tz;
        const s = await networkStatus(zoneless(), { pinnedGenesis: DEVNET_GENESIS, now: NOW });
        expect([s.rpc.health, s.faucet.health, s.gateway.health], tz).toEqual(["unknown", "unknown", "unknown"]);
        expect(s.rpc.stale, tz).toBeNull();
        expect(s.conflicts, tz).toEqual([]);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("an offset is accepted and means the same instant", async () => {
    const src = healthy();
    const shifted = new FixtureSource({ ...src.data, rpcHead: { ...(src.data.rpcHead as object), observed_at: "2026-11-09T18:47:40-05:00" } as never });
    const s = await networkStatus(shifted, { pinnedGenesis: DEVNET_GENESIS, now: NOW });
    expect(s.rpc.health).toBe("ok");
    expect(s.rpc.stale).toBe(false);
  });

  it("refuses a snapshot time without a zone", async () => {
    await expect(networkStatus(healthy(), { pinnedGenesis: DEVNET_GENESIS, now: "2026-11-09T23:47:41" })).rejects.toThrow(/with a zone/);
  });

  it("a future reading time is a conflict even on a degraded faucet", async () => {
    const s = await networkStatus(fx("status-degraded-real"), { pinnedGenesis: DEVNET_GENESIS, now: "2026-11-09T22:47:41Z" });
    expect(s.faucet.health).toBe("degraded");
    expect(s.conflicts.join(" ")).toMatch(/faucet reading time .* is later than the snapshot time/);
  });
});

describe("the faucet genesis comes only from a usable /chain reading (RULES 1.1)", () => {
  const chainWith = (patch: Record<string, unknown>) => {
    const src = fx("status-healthy");
    return networkStatus(new FixtureSource({ ...src.data, faucetChain: { ...(src.data.faucetChain as object), ...patch } as never }), { pinnedGenesis: DEVNET_GENESIS, now: NOW });
  };

  it("a fresh HTTP 200 reading counts: the healthy devnet has reset_detected false", async () => {
    const s = await run("status-healthy");
    expect(s.genesis.faucet).toBe(DEVNET_GENESIS);
    expect(s.reset_detected).toBe(false);
    expect(s.conflicts).toEqual([]);
  });

  it.each([
    ["an HTTP 500 reading with a body and no error", { http: 500 }],
    ["an HTTP 503 reading with an error", { http: 503, error: "service unavailable" }],
    ["a reading with an error but a body", { error: "timeout" }],
    ["no response", { http: null, error: "timeout", fetched_at: null }],
    ["a reading 39 days old", { fetched_at: "2026-10-01T00:00:00Z" }],
    ["a reading 121 s old", { fetched_at: "2026-11-09T23:45:52Z" }],
    ["a reading with no time", { fetched_at: null }],
    ["a reading time without a zone", { fetched_at: "2026-11-09T23:47:52" }],
  ])("%s does not count: reset_detected null, and the faucet detail says why", async (_name, patch) => {
    const s = await chainWith(patch);
    // genesis.faucet still shows what the reading said, as genesis.rpc does (RULES.md section 1).
    expect(s.genesis.faucet).toBe(DEVNET_GENESIS);
    expect(s.reset_detected).toBeNull();
    expect(s.faucet.detail).toMatch(/the \/chain reading does not count: /);
  });

  it("a reading 120 s old still counts", async () => {
    expect((await chainWith({ fetched_at: "2026-11-09T23:45:53Z" })).reset_detected).toBe(false);
  });

  it("a reading time later than the snapshot time is a conflict and does not count", async () => {
    const s = await chainWith({ fetched_at: "2026-12-01T00:00:00Z" });
    expect(s.conflicts.join(" ")).toMatch(/faucet \/chain reading time .* is later than the snapshot time/);
    expect(s.genesis.faucet).toBe(DEVNET_GENESIS);
    expect(s.reset_detected).toBeNull();
  });

  it("a reading that does not count but names another genesis is a conflict, and never sets reset_detected (Fable review r7 L3)", async () => {
    for (const patch of [{ fetched_at: "2026-11-09T21:00:00Z" }, { error: "x" }, { http: 500 }]) {
      const s = await chainWith({ ...patch, body: { genesisHash: OTHER } });
      expect(s.genesis.faucet).toBe(OTHER);
      expect(s.reset_detected).toBeNull();
      expect(s.conflicts.join(" ")).toMatch(new RegExp(`faucet /chain reading that does not count \\(.*\\) reports genesis ${OTHER}, not the pinned genesis`));
      expect(s.conflicts.join(" ")).toMatch(/faucet genesis 0xabab.* differs from rpc genesis/);
    }
  });

  it.each([
    ["a body with no genesisHash", { body: {} }, /it names no genesisHash/],
    ["a body that is null", { body: null }, /it names no genesisHash/],
    ["a malformed genesisHash", { body: { genesisHash: "0x12" } }, /its genesisHash is malformed/],
  ])("a usable reading that gives no genesis (%s) leaves reset_detected null, and the faucet detail says why (Fable review r8 L2)", async (_name, patch, why) => {
    const s = await chainWith(patch);
    expect(s.genesis.faucet).toBeNull();
    expect(s.reset_detected).toBeNull();
    expect(s.faucet.detail).toMatch(/the \/chain reading does not count: /);
    expect(s.faucet.detail).toMatch(why);
  });

  it("a usable reading says nothing in the faucet detail", async () => {
    expect((await run("status-healthy")).faucet.detail).toBeNull();
  });
});

describe("the RPC genesis counts toward reset_detected only from a usable head reading (RULES 1.1)", () => {
  const headWith = (patch: Record<string, unknown>) => {
    const src = fx("status-healthy");
    return networkStatus(new FixtureSource({ ...src.data, rpcHead: { ...(src.data.rpcHead as object), ...patch } as never }), { pinnedGenesis: DEVNET_GENESIS, now: NOW });
  };

  it("a fresh head with no error counts: the healthy devnet has reset_detected false", async () => {
    expect((await headWith({})).reset_detected).toBe(false);
  });

  it.each([
    ["a read error", { error: "websocket closed: read timed out" }],
    ["a reading two days old", { observed_at: "2026-11-07T23:47:40Z" }],
    ["a reading 121 s old", { observed_at: "2026-11-09T23:45:52Z" }],
    ["no observed_at", { observed_at: null }],
    ["an observed_at without a zone", { observed_at: "2026-11-09T23:47:40" }],
    ["an observed_at later than the snapshot time", { observed_at: "2026-11-10T00:00:00Z" }],
    ["the IMD audit's failed, two day old reading", { finalized: null, best_number: null, observed_at: "2026-11-07T23:47:40Z", error: "websocket closed: read timed out" }],
  ])("%s does not count: reset_detected null, and genesis.rpc still shows what the head said", async (_name, patch) => {
    const s = await headWith(patch);
    expect(s.reset_detected).toBeNull();
    expect(s.genesis.rpc).toBe(DEVNET_GENESIS);
    expect(s.rpc.health).not.toBe("ok");
  });

  it("a reading 120 s old still counts", async () => {
    expect((await headWith({ observed_at: "2026-11-09T23:45:53Z" })).reset_detected).toBe(false);
  });

  it("an unusable reading of another genesis does not count either way: reset_detected null, never false", async () => {
    const s = await headWith({ genesis_hash: OTHER, observed_at: "2026-11-07T23:47:40Z" });
    expect(s.reset_detected).toBeNull();
    expect(s.genesis.rpc).toBe(OTHER);
    expect(s.conflicts.join(" ")).toMatch(/differs from rpc genesis/);
  });

  it.each(["status-stale-rpc", "status-rpc-no-observed-at", "status-rpc-future-head"])("fixture %s: reset_detected null", async (name) => {
    expect((await run(name)).reset_detected).toBeNull();
  });
});

describe("the classifiers on their own, before freshness is applied", () => {
  it("a faucet or gateway that gave no response is unknown, never ok", () => {
    expect(classifyGateway(unknownHttp("no response")).health).toBe("unknown");
    expect(classifyFaucet(unknownHttp("no response")).health).toBe("unknown");
  });

  it("only a 5xx status is a server's own failure: 600 and up read as any other status (eleventh rerun)", () => {
    const reading = (http: number) => ({ http, body: null, error: null, fetched_at: NOW });
    expect([500, 599, 600, 1000].map((h) => classifyGateway(reading(h)).health)).toEqual(["down", "down", "degraded", "degraded"]);
    // A faucet body that cannot be read is down on a 5xx status and unknown on any other.
    expect([500, 599, 600, 1000].map((h) => classifyFaucet(reading(h)).health)).toEqual(["down", "down", "unknown", "unknown"]);
  });
});

describe("faucet and gateway freshness (RULES 1.1)", () => {
  const healthy = () => fx("status-healthy");
  const status = (src: FixtureSource) => networkStatus(src, { pinnedGenesis: DEVNET_GENESIS, now: NOW });
  const edit = (key: "faucetHealth" | "gatewayModels", patch: Record<string, unknown>) => {
    const src = healthy();
    return new FixtureSource({ ...src.data, [key]: { ...(src.data[key] as object), ...patch } as never });
  };

  it("readings eight days old are degraded, never ok", async () => {
    const s = await run("status-readings-days-old");
    expect(s.faucet.health).toBe("degraded");
    expect(s.gateway.health).toBe("degraded");
    expect(s.faucet.detail).toMatch(/faucet reading is \d+s old/);
    expect(s.rpc.health).toBe("ok");
  });

  it("a reading exactly at the stale limit is fresh, one second more is degraded", async () => {
    expect((await status(edit("faucetHealth", { fetched_at: "2026-11-09T23:45:53Z" }))).faucet.health).toBe("ok");
    expect((await status(edit("faucetHealth", { fetched_at: "2026-11-09T23:45:52Z" }))).faucet.health).toBe("degraded");
    expect((await status(edit("gatewayModels", { fetched_at: "2026-11-09T23:45:52Z" }))).gateway.health).toBe("degraded");
  });

  it("an ok reading with no parsable time is unknown", async () => {
    expect((await status(edit("faucetHealth", { fetched_at: null }))).faucet.health).toBe("unknown");
    expect((await status(edit("gatewayModels", { fetched_at: "soon" }))).gateway.health).toBe("unknown");
  });

  it("a reading time later than the snapshot time is a conflict and degraded", async () => {
    const s = await status(edit("gatewayModels", { fetched_at: "2026-11-09T23:47:54Z" }));
    expect(s.gateway.health).toBe("degraded");
    expect(s.conflicts.join(" ")).toMatch(/gateway reading time .* is later than the snapshot time/);
  });

  it("freshness never improves a reading that is not ok", async () => {
    const s = await run("status-degraded-real");
    expect(s.faucet.health).toBe("degraded");
    expect(s.gateway.health).toBe("unknown");
  });
});

describe("resetDetected", () => {
  const P = DEVNET_GENESIS;
  it.each([
    [P, P, false],
    [P, null, null],
    [null, P, null],
    [null, null, null],
    [OTHER, null, true],
    [null, OTHER, true],
    [P, OTHER, true],
    [OTHER, OTHER, true],
  ])("faucet %s, rpc %s gives %s", (faucet, rpc, expected) => {
    expect(resetDetected(P, faucet, rpc)).toBe(expected);
  });
});

describe("Fable review: status readings", () => {
  const withData = (patch: Record<string, unknown>) => {
    const src = fx("status-healthy");
    return networkStatus(new FixtureSource({ ...src.data, ...patch } as never), { pinnedGenesis: DEVNET_GENESIS, now: NOW });
  };
  const healthy = fx("status-healthy").data;

  it("a faucet or gateway reading that came with an error is never ok, even on HTTP 200", async () => {
    const s = await withData({
      faucetHealth: { ...(healthy.faucetHealth as object), error: "socket hang up after headers" },
      gatewayModels: { ...(healthy.gatewayModels as object), error: "body truncated", body: null },
    });
    expect(s.faucet.health).toBe("degraded");
    expect(s.faucet.detail).toMatch(/read error: socket hang up after headers/);
    expect(s.gateway.health).toBe("degraded");
    expect(s.gateway.detail).toMatch(/read error: body truncated/);
  });

  it("an empty string is an error too: on the RPC head and on the faucet /chain reading", async () => {
    const s = await withData({ rpcHead: { ...(healthy.rpcHead as object), error: "" } });
    expect(s.rpc.health).toBe("degraded");
    expect(s.reset_detected).toBeNull();
    const c = await withData({ faucetChain: { ...(healthy.faucetChain as object), error: "" } });
    expect(c.genesis.faucet).toBe(DEVNET_GENESIS);
    expect(c.reset_detected).toBeNull();
    expect(c.faucet.detail).toBe("the /chain reading does not count: read error: ");
  });

  it("a head that contradicts itself (best below finalized) never counts toward reset_detected", async () => {
    const s = await withData({ rpcHead: { ...(healthy.rpcHead as object), best_number: 3341000 } });
    expect(s.conflicts.join(" ")).toMatch(/best block 3341000 is below finalized block 3341575/);
    expect(s.reset_detected).toBeNull();
  });

  it("a head that went backwards never counts toward reset_detected", async () => {
    const s = await run("status-healthy", { previous: [{ genesis: DEVNET_GENESIS, finalized_height: 3341600, finalized_hash: "0x" + "5e".repeat(32), observed_at: "2026-11-09T23:47:00Z" }] });
    expect(s.reset_detected).toBeNull();
    expect(s.genesis.rpc).toBe(DEVNET_GENESIS);
  });

  it("an earlier snapshot with no head time still raises the floor: a rollback after it is caught", async () => {
    const s = await run("status-healthy", { previous: [{ genesis: DEVNET_GENESIS, finalized_height: 3341600, finalized_hash: "0x" + "5e".repeat(32), observed_at: null }] });
    expect(s.conflicts.join(" ")).toMatch(/went backwards from 3341600 to 3341575/);
    expect(s.rpc.health).toBe("degraded");
  });

  it("an earlier snapshot whose head time is later than this snapshot is a conflict", async () => {
    const s = await run("status-healthy", { previous: [{ genesis: DEVNET_GENESIS, finalized_height: 3341570, finalized_hash: "0x" + "11".repeat(32), observed_at: "2026-11-09T23:48:40Z" }] });
    expect(s.conflicts.join(" ")).toMatch(/an earlier snapshot read the rpc head at 2026-11-09T23:48:40Z, later than this snapshot time/);
    expect(s.rpc.health).toBe("degraded");
    expect(s.reset_detected).toBeNull();
  });

  it("a head that read nothing but carries a future time is still a conflict", async () => {
    const s = await withData({ rpcHead: { genesis_hash: null, finalized: null, best_number: null, runtime_spec_version: null, observed_at: "2030-01-01T00:00:00Z", error: null } });
    expect(s.conflicts.join(" ")).toMatch(/rpc head observed_at 2030-01-01T00:00:00Z is later than the snapshot time/);
  });

  it("a genesis written in upper case is malformed, as in the census: never the pinned one", async () => {
    const upper = "0x" + DEVNET_GENESIS.slice(2).toUpperCase();
    const s = await withData({ rpcHead: { ...(healthy.rpcHead as object), genesis_hash: upper } });
    expect(s.genesis.rpc).toBeNull();
    expect(s.conflicts).toContain("rpc genesis hash is malformed");
    expect(s.reset_detected).toBeNull();
  });

  it("wrong typed fields never reach the interface: a numeric time, a string status, odd limits", async () => {
    const s = await withData({
      rpcHead: { ...(healthy.rpcHead as object), observed_at: 1794268060 },
      gatewayModels: { ...(healthy.gatewayModels as object), http: "200", fetched_at: 17 },
      faucetHealth: { ...(healthy.faucetHealth as object), body: { ...((healthy.faucetHealth as { body: object }).body), limits: { ipCooldownMs: "ten seconds" } } },
    });
    expect(s.rpc.observed_at).toBeNull();
    expect(s.gateway.http).toBeNull();
    expect(s.gateway.health).toBe("unknown");
    expect(s.gateway.observed_at).toBeNull();
    expect(s.faucet.limits).toBeNull();
  });
});

describe("rpcHeadUsable on its own", () => {
  const head = (over: Record<string, unknown>) => ({ genesis_hash: DEVNET_GENESIS, finalized: null, best_number: null, runtime_spec_version: null, observed_at: "2026-11-09T23:47:40Z", error: null, ...over }) as never;
  it.each([
    ["a fresh head with no error", {}, true],
    ["a head 120 s old", { observed_at: "2026-11-09T23:45:53Z" }, true],
    ["a head 121 s old", { observed_at: "2026-11-09T23:45:52Z" }, false],
    ["a head time later than the snapshot", { observed_at: "2026-11-09T23:47:54Z" }, false],
    ["no head time", { observed_at: null }, false],
    ["a read error", { error: "timeout" }, false],
    ["an empty error", { error: "" }, false],
  ])("%s: %s", (_name, over, want) => {
    expect(rpcHeadUsable(head(over as Record<string, unknown>), NOW)).toBe(want);
  });
});

describe("a saved reading that cannot be read (Fable review M5)", () => {
  const healthy = fileURLToPath(new URL("../fixtures/status-healthy", import.meta.url));
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  /** A copy of status-healthy with one file's bytes changed. */
  const withFile = (file: string, edit: (raw: Buffer) => Buffer | string) => {
    const d = mkdtempSync(join(tmpdir(), "obs-status-unreadable-"));
    made.push(d);
    cpSync(healthy, d, { recursive: true });
    const p = join(d, file);
    const before = readFileSync(p);
    const after = edit(before);
    expect(Buffer.from(after).equals(before)).toBe(false);
    writeFileSync(p, after);
    return FixtureSource.fromDir(d);
  };
  /** The first line of "key" said twice, the first copy holding other (JSON.parse keeps the last). */
  const twice = (key: string, other: string) => (raw: Buffer) =>
    raw.toString("utf8").replace(new RegExp(`("${key}": [^\\n]*\\n)`), `"${key}": ${other},\n  $1`);
  const status = (src: FixtureSource) => networkStatus(src, { pinnedGenesis: DEVNET_GENESIS, now: NOW });

  it("control: the unedited copy reads as before", async () => {
    const s = await status(withFile("rpc-head.json", (raw) => raw.toString("utf8") + "\n"));
    expect(s.rpc.health).toBe("ok");
    expect(s.reset_detected).toBe(false);
  });
  it("an RPC head that holds its genesis twice is nothing read, names the file, and leaves reset_detected null", async () => {
    const src = withFile("rpc-head.json", twice("genesis_hash", JSON.stringify("0x" + "11".repeat(32))));
    const s = await status(src);
    const why = 'rpc-head.json: the key "genesis_hash" appears twice in one object';
    expect(s.rpc).toMatchObject({ health: "unknown", detail: why, stale: null });
    expect(s.genesis.rpc).toBeNull();
    expect(s.finalized_height).toBeNull();
    expect(s.reset_detected).toBeNull();
    expect(src.data.loadErrors).toEqual([why]);
  });
  it("a faucet health reading that holds its error twice is unknown and names the file, never ok", async () => {
    const s = await status(withFile("faucet-health.json", twice("error", '"socket hang up after headers"')));
    expect(s.faucet).toMatchObject({ health: "unknown", http: null, detail: 'faucet-health.json: the key "error" appears twice in one object' });
  });
  it("a gateway reading that holds its http status twice is unknown and names the file", async () => {
    const s = await status(withFile("gateway-models.json", twice("http", "503")));
    expect(s.gateway).toMatchObject({ health: "unknown", http: null, detail: 'gateway-models.json: the key "http" appears twice in one object' });
  });
  it("a /chain reading that is not valid UTF-8 gives no faucet genesis, so reset_detected is null", async () => {
    const s = await status(withFile("faucet-chain.json", (raw) => Buffer.from(raw.toString("latin1").replace('"FLOP Devnet"', '"FLOP \xff Devnet"'), "latin1")));
    expect(s.genesis.faucet).toBeNull();
    expect(s.reset_detected).toBeNull();
  });
  it("a meta.json that holds its clock twice refuses the scenario", () => {
    expect(() => withFile("meta.json", twice("now", '"2030-01-01T00:00:00Z"'))).toThrow(/has no readable meta\.json/);
  });
});

describe("Fable review r7: a head that lost its finalized head, a log that runs backwards, a reading with no error key", () => {
  const healthy = fx("status-healthy").data;
  const head = healthy.rpcHead as { finalized: { number: number; hash: string } };
  // One earlier snapshot at the healthy head's own height and hash, read 113 s before NOW.
  const earlier = [{ genesis: DEVNET_GENESIS, finalized_height: head.finalized.number, finalized_hash: head.finalized.hash, observed_at: "2026-11-09T23:46:00Z" }];
  const withHead = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    networkStatus(new FixtureSource({ ...healthy, rpcHead: { ...(healthy.rpcHead as object), ...patch } as never }), { pinnedGenesis: DEVNET_GENESIS, now: NOW, ...extra });

  it("control: the healthy head after that earlier snapshot counts", async () => {
    const s = await withHead({}, { previous: earlier });
    expect(s.reset_detected).toBe(false);
    expect(s.conflicts).toEqual([]);
  });
  it("M1: a best height below an earlier finalized height, with no valid finalized head, is a conflict and the head does not count", async () => {
    for (const finalized of [null, { number: 1e300, hash: "0x" + "11".repeat(32) }]) {
      const s = await withHead({ finalized, best_number: 10 }, { previous: earlier });
      expect(s.conflicts.join(" "), JSON.stringify(finalized)).toMatch(/best block 10 is below the finalized height 3341575 an earlier snapshot saw on this genesis/);
      expect(s.reset_detected).toBeNull();
      expect(s.rpc.health).toBe("degraded");
    }
  });
  it("M1: a head with no valid finalized head or best height never counts, even with no earlier snapshot", async () => {
    for (const patch of [{ finalized: null }, { best_number: null }, { finalized: { number: -1, hash: "0x" + "11".repeat(32) } }, { best_number: 2 ** 53 }]) {
      const s = await withHead(patch);
      expect(s.reset_detected, JSON.stringify(patch)).toBeNull();
      expect(s.genesis.rpc).toBe(DEVNET_GENESIS);
    }
  });
  it("L1: an earlier snapshot taken later than this one is a conflict, whatever it read, and the head does not count", async () => {
    const s = await withHead({}, { earlierTimes: ["2026-11-09T23:47:00Z", "2026-11-09T23:48:41Z"] });
    expect(s.conflicts.join(" ")).toMatch(/an earlier snapshot was taken at 2026-11-09T23:48:41Z, later than this snapshot time/);
    expect(s.reset_detected).toBeNull();
    expect(s.rpc.health).toBe("degraded");
    const fine = await withHead({}, { earlierTimes: ["2026-11-09T23:47:00Z", null, "not a time"] });
    expect(fine.reset_detected).toBe(false);
    expect(fine.conflicts).toEqual([]);
  });
  it("L1: the conflict shows even when this snapshot read no RPC head", async () => {
    const s = await networkStatus(fx("status-unknown"), { pinnedGenesis: DEVNET_GENESIS, now: NOW, earlierTimes: ["2026-11-09T23:48:41Z"] });
    expect(s.conflicts.join(" ")).toMatch(/an earlier snapshot was taken at 2026-11-09T23:48:41Z/);
    expect(s.reset_detected).toBeNull();
  });
  it("L2: a reading with no error key counts as a failed read: never ok, and reset_detected null", async () => {
    const strip = (o: unknown) => {
      const { error: _e, ...rest } = o as Record<string, unknown>;
      return rest as never;
    };
    const s = await networkStatus(
      new FixtureSource({ ...healthy, rpcHead: strip(healthy.rpcHead), faucetHealth: strip(healthy.faucetHealth), faucetChain: strip(healthy.faucetChain), gatewayModels: strip(healthy.gatewayModels) }),
      { pinnedGenesis: DEVNET_GENESIS, now: NOW },
    );
    expect([s.rpc.health, s.faucet.health, s.gateway.health]).toEqual(["degraded", "degraded", "degraded"]);
    expect(s.reset_detected).toBeNull();
    expect(s.rpc.detail).toMatch(/read error: the reading has no error field/);
    expect(s.faucet.detail).toMatch(/the \/chain reading does not count: read error: the reading has no error field/);
  });
});

describe("third IMD audit: a head with keys left out, a /chain status that is no number, and a stuck finalized height", () => {
  const healthy = fx("status-healthy").data;
  const withData = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    networkStatus(new FixtureSource({ ...healthy, ...patch } as never), { pinnedGenesis: DEVNET_GENESIS, now: NOW, ...extra });

  it("J5: a head that left its keys out reads as one that wrote them as null: a failed read is down with its error, and no genesis conflict", async () => {
    const failed = await withData({ rpcHead: { error: "connection refused" } });
    expect(failed.rpc.health).toBe("down");
    expect(failed.rpc.detail).toBe("connection refused");
    expect(failed.conflicts).toEqual([]);
    expect(failed.reset_detected).toBeNull();
    // The same reading with the keys written as null, for comparison.
    const nulls = await withData({ rpcHead: { genesis_hash: null, finalized: null, best_number: null, runtime_spec_version: null, observed_at: null, error: "connection refused" } });
    expect([nulls.rpc.health, nulls.rpc.detail, nulls.conflicts]).toEqual([failed.rpc.health, failed.rpc.detail, failed.conflicts]);
    // No key at all, no error key either: a read that does not say it worked counts as failed.
    const empty = await withData({ rpcHead: {} });
    expect([empty.rpc.health, empty.rpc.detail, empty.conflicts]).toEqual(["down", "the reading has no error field", []]);
  });

  it("J5: a head that is not an object read nothing, and says so", async () => {
    for (const rpcHead of [[], 5, "head"]) {
      const s = await withData({ rpcHead });
      expect([s.rpc.health, s.rpc.detail, s.conflicts, s.reset_detected]).toEqual(["unknown", "the rpc head is not an object", [], null]);
    }
  });

  it("J9: a /chain reading whose http status is no whole number says so, not the value it holds", async () => {
    const s = await withData({ faucetChain: { ...(healthy.faucetChain as object), http: "200" } });
    expect(s.faucet.detail).toBe("the /chain reading does not count: http status is not a whole number");
    expect(s.reset_detected).toBeNull();
  });

  // One earlier snapshot at the healthy head's height and hash, read long enough ago to be stuck.
  const head = healthy.rpcHead as { finalized: { number: number; hash: string } };
  const earlierAt = (observed_at: string, genesis: string = DEVNET_GENESIS) => [{ genesis, finalized_height: head.finalized.number, finalized_hash: head.finalized.hash, observed_at }];
  const assess = (patch: Record<string, unknown>, previous: unknown) =>
    assessNetwork(new FixtureSource({ ...healthy, ...patch } as never), { pinnedGenesis: DEVNET_GENESIS, now: NOW, previous: previous as never });

  it("J11: a stuck finalized height, or one whose stuck check cannot run, leaves reset_detected open, and still bounds escrow evidence", async () => {
    const stuck = await assess({}, earlierAt("2026-11-09T23:30:00Z"));
    expect([stuck.status.rpc.stale, stuck.status.reset_detected]).toEqual([true, null]);
    expect(stuck.status.rpc.detail).toMatch(/finalized height stuck at 3341575/);
    // A finalized height stays final however long it holds: the head still bounds escrows.
    expect(stuck.rpcUsable).toBe(true);
    const unsure = await assess({}, earlierAt("2026-11-09T23:47:40"));
    expect([unsure.status.rpc.health, unsure.status.rpc.stale, unsure.status.reset_detected, unsure.rpcUsable]).toEqual(["unknown", null, null, true]);
    // Not stuck: the earlier snapshot at this height was read less than the stale limit ago.
    const held = await assess({}, earlierAt("2026-11-09T23:46:53Z"));
    expect([held.status.rpc.stale, held.status.reset_detected]).toEqual([false, false]);
  });

  it("eleventh rerun: the stuck check runs after a rollback or a changed hash too, so a fresh head's stale says how long its height has held", async () => {
    const F = head.finalized.number;
    const at = (finalized_height: number, finalized_hash: string, observed_at: string) => ({ genesis: DEVNET_GENESIS, finalized_height, finalized_hash, observed_at });
    const higher = at(F + 5, "0x" + "5f".repeat(32), "2026-11-09T23:40:00Z");
    const changed = "0x" + "77".repeat(32);
    // A rollback (a higher finalized height first) and a changed hash (this height, another hash),
    // each with the run at this height held for a time that does not parse, past the stale limit
    // (273 s) and within it (53 s).
    for (const [what, earlier] of [
      ["rollback", (t: string) => [higher, at(F, head.finalized.hash, t)]],
      ["changed hash", (t: string) => [at(F, changed, t)]],
    ] as const) {
      const stale = [];
      for (const t of ["2026-11-09T23:47:40", "2026-11-09T23:43:20Z", "2026-11-09T23:47:00Z"]) {
        const s = await assess({}, earlier(t));
        expect([what, s.status.rpc.health, s.status.reset_detected, s.rpcUsable]).toEqual([what, "degraded", null, false]);
        stale.push(s.status.rpc.stale);
      }
      expect([what, ...stale]).toEqual([what, null, true, false]);
    }
  });

  it("J11: a stuck head on another genesis still shows the reset", async () => {
    const other = { ...(healthy.rpcHead as object), genesis_hash: OTHER };
    const s = await assess({ rpcHead: other }, earlierAt("2026-11-09T23:30:00Z", OTHER));
    expect(s.status.rpc.stale).toBe(true);
    expect(s.status.genesis.faucet).toBe(DEVNET_GENESIS);
    expect(s.status.reset_detected).toBe(true);
  });
});
