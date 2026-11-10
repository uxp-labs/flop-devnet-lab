import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FixtureSource } from "../src/source.js";
import { unknownHttp } from "../src/source.js";
import { DEVNET_GENESIS, classifyFaucet, classifyGateway, networkStatus, resetDetected } from "../src/status.js";

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
  ])("%s does not count: faucet genesis null, reset_detected null", async (_name, patch) => {
    const s = await chainWith(patch);
    expect(s.genesis.faucet).toBeNull();
    expect(s.reset_detected).toBeNull();
  });

  it("a reading 120 s old still counts", async () => {
    expect((await chainWith({ fetched_at: "2026-11-09T23:45:53Z" })).reset_detected).toBe(false);
  });

  it("a reading time later than the snapshot time is a conflict and does not count", async () => {
    const s = await chainWith({ fetched_at: "2026-12-01T00:00:00Z" });
    expect(s.conflicts.join(" ")).toMatch(/faucet \/chain reading time .* is later than the snapshot time/);
    expect(s.genesis.faucet).toBeNull();
    expect(s.reset_detected).toBeNull();
  });
});

describe("the classifiers on their own, before freshness is applied", () => {
  it("a faucet or gateway that gave no response is unknown, never ok", () => {
    expect(classifyGateway(unknownHttp("no response")).health).toBe("unknown");
    expect(classifyFaucet(unknownHttp("no response")).health).toBe("unknown");
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
