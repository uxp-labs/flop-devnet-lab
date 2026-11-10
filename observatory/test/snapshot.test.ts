// The snapshot builder and the fixture source: the plumbing between the modules.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/snapshot.js";
import { FixtureSource } from "../src/source.js";
import { DEVNET_GENESIS } from "../src/status.js";

const fx = (name: string) => FixtureSource.fromDir(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
const NOW = "2026-11-09T23:47:53Z";
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

  it("reports every entry in event-pages that is not a page file (clause 15), and still reads the real pages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-source-"));
    try {
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ scenario: "names", description: "synthetic", now: NOW, synthetic: true }));
      mkdirSync(join(dir, "event-pages"));
      mkdirSync(join(dir, "event-pages", "sub.json"));
      const page = { genesis: DEVNET_GENESIS, from_block: 0, to_block: 9, page: 0, next_page: null, events: [] };
      for (const name of ["00.json", ".01.json", "02.txt", "03.json.bak"]) writeFileSync(join(dir, "event-pages", name), JSON.stringify(page));
      const src = FixtureSource.fromDir(dir);
      expect(await src.eventPages()).toHaveLength(1);
      const errors = await src.eventPageErrors();
      expect(errors.map((e) => e.split(":")[0])).toEqual([
        "event-pages/.01.json",
        "event-pages/02.txt",
        "event-pages/03.json.bak",
        "event-pages/sub.json",
      ]);
      expect(errors.every((e) => /not a page file/.test(e))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const scenario = (setup: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "obs-source-"));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ scenario: "x", description: "synthetic", now: NOW, synthetic: true }));
    setup(dir);
    return dir;
  };
  const page = JSON.stringify({ genesis: DEVNET_GENESIS, from_block: 0, to_block: 9, page: 0, next_page: null, events: [] });

  // The bad byte sits inside a string, where a lossy decoder would turn it into U+FFFD and the
  // page would still parse: only a strict decoder refuses it.
  const withName = JSON.stringify({
    genesis: DEVNET_GENESIS, from_block: 0, to_block: 9, page: 0, next_page: null,
    events: [{ block_number: 5, block_hash: "0x" + "09".repeat(32), finalized: true, index: 0, section: "hasStation", method: "EscrowReleased", data: { who: "alXXice" } }],
  });
  const [before, after] = withName.split("XX") as [string, string];

  it("the invalid byte page would parse if decoded lossily, so the test below means something", () => {
    const lossy = Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]).toString("utf8");
    expect(() => JSON.parse(lossy)).not.toThrow();
  });

  it.each([
    ["an invalid UTF-8 byte inside a string", Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)])],
    ["a byte order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(page)])],
  ])("refuses a page file with %s instead of decoding around it", async (_name, bytes) => {
    const dir = scenario((d) => {
      mkdirSync(join(d, "event-pages"));
      writeFileSync(join(d, "event-pages", "00.json"), bytes);
    });
    try {
      const src = FixtureSource.fromDir(dir);
      expect(await src.eventPages()).toEqual([]);
      expect(await src.eventPageErrors()).toEqual(["event-pages/00.json: not valid JSON"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["a regular file", (d: string) => writeFileSync(join(d, "event-pages"), page)],
    ["a link to a folder", (d: string) => {
      mkdirSync(join(d, "real-pages"));
      writeFileSync(join(d, "real-pages", "00.json"), page);
      symlinkSync("real-pages", join(d, "event-pages"));
    }],
  ])("refuses event-pages that is %s (clause 15)", async (_name, make) => {
    const dir = scenario(make);
    try {
      const src = FixtureSource.fromDir(dir);
      expect(await src.eventPages()).toEqual([]);
      expect((await src.eventPageErrors())[0]).toMatch(/^event-pages: not a folder/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("never bounds escrows with another chain's finalized height", async () => {
    const escrows = fx("escrows-verification");
    const parts = (status: string) => ({ status: fx(status), escrows: { source: escrows, ids: escrows.data.meta.escrow_ids ?? [] } });
    const other = await buildSnapshot(parts("status-conflict"), opts);
    expect(other.status.genesis.rpc).not.toBe(other.status.genesis.pinned);
    expect(other.status.finalized_height).not.toBeNull();
    expect(other.escrows.every((e) => e.finalized_height === null)).toBe(true);
    const reset = await buildSnapshot(parts("status-reset"), opts);
    expect(reset.escrows.every((e) => e.finalized_height === null)).toBe(true);
    const same = await buildSnapshot(parts("status-healthy"), opts);
    expect(same.escrows.every((e) => e.finalized_height === 3341575)).toBe(true);
  });

  it("passes the previous snapshot to the status checks: a rollback on the same genesis is a conflict", async () => {
    const s = await buildSnapshot(
      { status: fx("status-healthy") },
      { ...opts, previous: { genesis: DEVNET_GENESIS, finalized_height: 3341600, finalized_hash: "0x" + "5e".repeat(32), observed_at: NOW } },
    );
    expect(s.status.rpc.health).toBe("degraded");
    expect(s.status.conflicts.join(" ")).toMatch(/went backwards from 3341600 to 3341575/);
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
