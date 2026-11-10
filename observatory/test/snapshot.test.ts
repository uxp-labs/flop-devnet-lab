// The snapshot builder and the fixture source: the plumbing between the modules.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/snapshot.js";
import { FixtureSource } from "../src/source.js";
import { DEVNET_GENESIS } from "../src/status.js";

const fx = (name: string) => FixtureSource.fromDir(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
const NOW = "2026-11-09T23:47:41Z";
const opts = { pinnedGenesis: DEVNET_GENESIS, now: NOW, sourceSha: "test" };

describe("fixture source: unreadable event pages are reported, never dropped", () => {
  it("lists an unreadable page file in pageErrors and eventPageErrors, in words that do not depend on the Node version", async () => {
    const src = fx("escrows-unreadable-page");
    const errors = await src.eventPageErrors();
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/^event-pages\/.+\.json: not valid JSON$/);
    expect(src.data.loadErrors).toEqual(expect.arrayContaining(errors));
  });

  it("reports no page errors when every page reads", async () => {
    expect(await fx("escrows-verification").eventPageErrors()).toEqual([]);
  });

  it("does not count other unreadable files as page errors", async () => {
    const src = fx("status-malformed");
    expect(src.data.loadErrors?.join(" ")).toMatch(/faucet-health\.json/);
    expect(await src.eventPageErrors()).toEqual([]);
  });
});

describe("buildSnapshot", () => {
  it("passes unreadable escrow pages through: every escrow is unverified and the note names the file", async () => {
    const escrows = fx("escrows-unreadable-page");
    const s = await buildSnapshot({ status: fx("status-healthy"), escrows: { source: escrows, ids: escrows.data.meta.escrow_ids ?? [] } }, opts);
    expect(s.escrows.length).toBeGreaterThan(0);
    for (const e of s.escrows) {
      expect(e.state).toBe("unverified");
      expect(e.notes.join(" ")).toMatch(/event-pages\/.+\.json/);
    }
  });

  it("reads the real claim and refund as claimed and refunded, bounded by the status finalized height", async () => {
    const escrows = fx("escrows-verification");
    const s = await buildSnapshot({ status: fx("status-healthy"), escrows: { source: escrows, ids: escrows.data.meta.escrow_ids ?? [] } }, opts);
    expect(s.escrows.map((e) => e.state)).toEqual(["claimed", "refunded", "unverified"]);
    expect(s.escrows.every((e) => e.finalized_height === s.status.finalized_height)).toBe(true);
  });

  it("labels the snapshot with the weakest trust of its parts, and a missing part is null", async () => {
    const s = await buildSnapshot({ status: fx("status-healthy") }, opts);
    expect(s.trust).toBe("fixture");
    expect(s.census).toBeNull();
    expect(s.drift).toBeNull();
    expect(s.escrows).toEqual([]);
  });

  it("pins the run to the chain point it describes", async () => {
    const s = await buildSnapshot({ status: fx("status-healthy") }, opts);
    expect(s.pin).toMatchObject({ source_sha: "test", genesis: DEVNET_GENESIS, finalized_height: 3341575, finalized_hash: "0x" + "5e".repeat(32) });
    expect(s.pin.node).toBe(process.version);
  });

  it("takes the pin's genesis from the RPC that gave the finalized head, never from the faucet", async () => {
    const conflict = await buildSnapshot({ status: fx("status-conflict") }, opts);
    expect(conflict.pin.genesis).toBe(conflict.status.genesis.rpc);
    expect(conflict.pin.genesis).not.toBe(conflict.status.genesis.faucet);
    const faucetOnly = await buildSnapshot({ status: fx("status-degraded-real") }, opts);
    expect(faucetOnly.status.genesis.faucet).not.toBeNull();
    expect(faucetOnly.pin).toMatchObject({ genesis: null, finalized_height: null, finalized_hash: null });
  });
});
