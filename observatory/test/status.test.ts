import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FixtureSource } from "../src/source.js";
import { DEVNET_GENESIS, networkStatus, resetDetected } from "../src/status.js";

const NOW = "2026-11-09T23:47:41Z";
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
