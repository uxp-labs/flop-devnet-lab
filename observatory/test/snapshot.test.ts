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

  it("refuses a page file that holds one key twice in an object, naming the key", async () => {
    const twice = page.replace('"page":0,', '"page":0,"page":1,');
    expect(twice).not.toBe(page);
    expect(() => JSON.parse(twice)).not.toThrow();
    const dir = scenario((d) => {
      mkdirSync(join(d, "event-pages"));
      writeFileSync(join(d, "event-pages", "00.json"), twice);
    });
    try {
      const src = FixtureSource.fromDir(dir);
      expect(await src.eventPages()).toEqual([]);
      expect(await src.eventPageErrors()).toEqual(['event-pages/00.json: the key "page" appears twice in one object']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a page file nested deeper than 64 levels before parsing it, and reads one at 64", async () => {
    const nested = (n: number) => page.replace('"events":[]', `"events":[],"x":${"[".repeat(n - 1)}${"]".repeat(n - 1)}`);
    for (const [n, ok] of [[64, true], [65, false]] as const) {
      const dir = scenario((d) => {
        mkdirSync(join(d, "event-pages"));
        writeFileSync(join(d, "event-pages", "00.json"), nested(n));
      });
      try {
        const src = FixtureSource.fromDir(dir);
        expect(await src.eventPageErrors()).toEqual(ok ? [] : ["event-pages/00.json: nested deeper than 64 levels"]);
        expect(await src.eventPages()).toHaveLength(ok ? 1 : 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A file name that is not UTF-8 cannot be committed to git safely (macOS refuses such names),
  // so it is made here, where the filesystem allows it.
  const badName = Buffer.from([0x30, 0x31, 0x2d, 0xff, 0x2e, 0x6a, 0x73, 0x6f, 0x6e]); // 01-\xff.json
  const canMakeBadName = (() => {
    const d = mkdtempSync(join(tmpdir(), "obs-name-"));
    try {
      writeFileSync(Buffer.concat([Buffer.from(d + "/"), badName]), "{}");
      return true;
    } catch {
      return false;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  })();
  it.skipIf(!canMakeBadName)("a page file whose name is not valid UTF-8 is a page error, shown byte for byte, never dropped (IMD follow-up audit)", async () => {
    const dir = scenario((d) => {
      mkdirSync(join(d, "event-pages"));
      writeFileSync(join(d, "event-pages", "00.json"), page);
      writeFileSync(Buffer.concat([Buffer.from(join(d, "event-pages") + "/"), badName]), page);
    });
    try {
      const src = FixtureSource.fromDir(dir);
      expect(await src.eventPageErrors()).toEqual(["event-pages/01-%FF.json: not a page file (its name is not valid UTF-8)"]);
      expect(await src.eventPages()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a page file name that is UTF-8 is shown as itself but for %, control characters and line separators, each as %XX of its bytes (Fable review r9 I2, r10 I2, sixth rerun U3)", async () => {
    const names = ["01%FF.json", "02\na.json", "03\u0085b.json", "04\u2028c.json", "05\u00e9d.json", "06\u001fe.json", "07\u007ff.json", "08\u2029g.json", "09\u009fh.json"];
    const dir = scenario((d) => {
      mkdirSync(join(d, "event-pages"));
      for (const n of names) writeFileSync(join(d, "event-pages", n), "{ not json");
    });
    try {
      const src = FixtureSource.fromDir(dir);
      expect(await src.eventPageErrors()).toEqual([
        "event-pages/01%25FF.json: not valid JSON",
        "event-pages/02%0Aa.json: not valid JSON",
        "event-pages/03%C2%85b.json: not valid JSON",
        "event-pages/04%E2%80%A8c.json: not valid JSON",
        "event-pages/05\u00e9d.json: not valid JSON",
        "event-pages/06%1Fe.json: not valid JSON",
        "event-pages/07%7Ff.json: not valid JSON",
        "event-pages/08%E2%80%A9g.json: not valid JSON",
        "event-pages/09%C2%9Fh.json: not valid JSON",
      ]);
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

  it("a stale or failed RPC head on the pinned genesis never bounds the escrows (IMD follow-up audit)", async () => {
    const escrows = fx("escrows-verification");
    const s = await buildSnapshot({ status: fx("status-stale-rpc"), escrows: { source: escrows, ids: escrows.data.meta.escrow_ids ?? [] } }, opts);
    expect(s.status.genesis.rpc).toBe(DEVNET_GENESIS);
    expect(s.status.finalized_height).not.toBeNull();
    expect(s.escrows.every((e) => e.finalized_height === null)).toBe(true);
    expect(s.escrows.filter((e) => e.evidence.length > 0).every((e) => e.notes.join(" ").includes("not bounded by a finalized height"))).toBe(true);
  });

  it("a contradicted RPC head (a rollback) never bounds the escrows either (Fable review)", async () => {
    const escrows = fx("escrows-verification");
    const s = await buildSnapshot(
      { status: fx("status-healthy"), escrows: { source: escrows, ids: escrows.data.meta.escrow_ids ?? [] } },
      { ...opts, previous: [{ genesis: DEVNET_GENESIS, finalized_height: 3341600, finalized_hash: "0x" + "5e".repeat(32), observed_at: "2026-11-09T23:47:00Z" }] },
    );
    expect(s.status.conflicts.join(" ")).toMatch(/went backwards/);
    expect(s.escrows.every((e) => e.finalized_height === null)).toBe(true);
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
