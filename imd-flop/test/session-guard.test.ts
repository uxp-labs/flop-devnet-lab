/**
 * P5b, the guards of the three session commands: the genesis (C6, test T4), the owner (C3, T7), no key (C4, T8), the
 * transport (C5), and the one importer of the encoder (C2). The owner and the delegates are read from
 * research/2026-11-12-session-rerun-1014020/results.json `accounts`; the pinned genesis from src/networks.ts.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { clearSecretRegistry, registerSecret, scanForSecrets } from "../src/secrets.js";
import { writeSecretFile } from "../src/store.js";
import { NETWORKS } from "../src/networks.js";
import { ss58Decode, ss58Encode } from "../src/ss58.js";
import { cli } from "./helpers.js";
import { PKG } from "./lib/chain-fixtures.js";
import type { Log } from "./lib/recorded-node.js";
import { copyScript, DEV1, OWNER, scriptAt, seatHome, SEAT, session, transportOf, unhex } from "./lib/session-fixtures.js";

const SUBS: [string, string[]][] = [
  ["grant", ["--days", "1"]],
  ["revoke", []],
  ["show", []],
];
const SESSION = join(PKG, "src", "session");
const files = readdirSync(SESSION).filter((f) => f.endsWith(".ts"));
const argsOf = (sub: string, extra: string[], owner = OWNER.ss58) => [sub, "--owner", owner, ...extra];

describe("T4: the node is held to the network's genesis first", () => {
  for (const [sub, extra] of SUBS) {
    it(`${sub}: another hash at height 0 refuses with exit 5, before any other read`, async () => {
      const s = copyScript(scriptAt("A10"));
      s.hashes.set(0, s.head);
      const log: Log = [];
      const r = await session(seatHome(), argsOf(sub, extra), transportOf(s, log));
      expect([r.code, r.out]).toEqual([5, ""]);
      expect(r.err).toContain(`not devnet's pinned genesis ${NETWORKS.devnet.genesisHash}`);
      expect(log.map((c) => c.method)).toEqual(["chain_getBlockHash"]);
      expect(log[0].params).toEqual([0]);
    });

    it(`${sub}: a block 0 that cannot be read exits 1 and prints nothing but the reason`, async () => {
      const s = copyScript(scriptAt("A10"));
      s.hashes.delete(0);
      const r = await session(seatHome(), argsOf(sub, extra), transportOf(s));
      expect([r.code, r.out]).toEqual([1, ""]);
      expect(r.err).toMatch(/the node's block 0 cannot be read, so the node is not known to be devnet: chain_getBlockHash: the node holds no block at 0/);
    });
  }

  it("the recording's block 0 is the pinned genesis (control)", () => {
    expect(scriptAt("A10").hashes.get(0)).toBe(NETWORKS.devnet.genesisHash);
  });
});

describe("T7: the owner", () => {
  const otherPrefix = ss58Encode(unhex(OWNER.public_key), 0);
  const bad = OWNER.ss58.slice(0, -1) + (OWNER.ss58.endsWith("z") ? "y" : "z");
  const cases: [string, string, RegExp][] = [
    ["a bad checksum", bad, /--owner is not an SS58 account address/],
    ["another prefix", otherPrefix, /--owner has the SS58 prefix 0, not 42 of devnet/],
    ["the device itself", DEV1.ss58, /--owner is the seat's own device key/],
    ["not base58", "0OIl", /--owner is not an SS58 account address \(not base58\)/],
    ["empty", "", /--owner <ss58> is required/],
  ];
  it("the cases are what they say (control)", () => {
    expect(() => ss58Decode(bad)).toThrow();
    expect(ss58Decode(otherPrefix).prefix).toBe(0);
  });
  for (const [sub, extra] of SUBS) {
    for (const [name, owner, words] of cases) {
      it(`${sub}: ${name}: exit 2, nothing printed, no node call`, async () => {
        const log: Log = [];
        const r = await session(seatHome(), argsOf(sub, extra, owner), transportOf(scriptAt("A10"), log));
        expect([r.code, r.out]).toEqual([2, ""]);
        expect(r.err).toMatch(words);
        expect(log).toEqual([]);
      });
    }
    it(`${sub}: no --owner at all: exit 2`, async () => {
      const r = await session(seatHome(), [sub, ...extra], transportOf(scriptAt("A10")));
      expect([r.code, r.out]).toEqual([2, ""]);
      expect(r.err).toMatch(/--owner <ss58> is required/);
    });
  }

  it("the owner is not written: the home holds the same files after each command", async () => {
    const home = seatHome();
    const list = () => readdirSync(home, { recursive: true }).map(String).sort();
    const before = list();
    const cfg = readFileSync(join(home, "config.json"), "utf8");
    for (const [sub, extra] of SUBS) await session(home, argsOf(sub, extra), transportOf(scriptAt("A10")));
    expect(list()).toEqual(before);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(cfg);
  });
});

describe("T8: no key is read", () => {
  it("with a key file and without it, each command gives the same output; the secret registry holds nothing of it after", async () => {
    // A key file made here, in memory, for this test: it is not the delegate's key, so a command that loaded it
    // would fail; and readSeed would register it with the secret guard.
    const seed = ed25519.utils.randomSecretKey();
    for (const [sub, extra] of SUBS) {
      const home = seatHome();
      writeSecretFile(join(home, "seats", SEAT, "flop.key"), JSON.stringify({ v: 0, alg: "ed25519", seed_b64: Buffer.from(seed).toString("base64") }) + "\n");
      clearSecretRegistry();
      const withKey = await session(home, argsOf(sub, extra), transportOf(scriptAt("A10")));
      expect(scanForSecrets({ note: base58.encode(seed) })).toEqual([]);
      rmSync(join(home, "seats", SEAT, "flop.key"));
      const without = await session(home, argsOf(sub, extra), transportOf(scriptAt("A10")));
      expect([sub, without.code, without.out, without.err]).toEqual([sub, withKey.code, withKey.out, withKey.err]);
      expect(withKey.out.length).toBeGreaterThan(0);
    }
    registerSecret(seed);
    expect(scanForSecrets({ note: base58.encode(seed) }).length).toBeGreaterThan(0);
    clearSecretRegistry();
  });

  it("a seat with no identity file is a usage error; one whose did is not a did:key exits 1", async () => {
    const home = seatHome();
    rmSync(join(home, "seats", SEAT, "identity.json"));
    const r = await session(home, argsOf("show", []), transportOf(scriptAt("A10")));
    expect([r.code, r.out]).toEqual([2, ""]);
    expect(r.err).toMatch(/no FLOP identity for seat 42/);
    const home2 = seatHome();
    const p = join(home2, "seats", SEAT, "identity.json");
    const id = JSON.parse(readFileSync(p, "utf8"));
    writeFileSync(p, JSON.stringify({ ...id, did: "did:key:znot" }));
    const r2 = await session(home2, argsOf("show", []), transportOf(scriptAt("A10")));
    expect([r2.code, r2.out]).toEqual([1, ""]);
    expect(r2.err).toMatch(/holds no ed25519 did:key/);
  });

  it("the scan of src/session: no file names the signer, the seed or the key file, and keys.ts gives readIdentity alone", () => {
    const banned = /\b(loadSigner|readSeed|Signer|keyFile|flop\.key|readSecretJson|readSecretFile|registerSecret)\b/;
    expect(banned.test("const s = loadSigner(h, seat);")).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(SESSION, f), "utf8");
      expect(`${f}: ${banned.test(text)}`).toBe(`${f}: false`);
      for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\.\/keys\.js"/g)) expect(m[1].split(",").map((s) => s.trim()).filter(Boolean)).toEqual(["readIdentity"]);
    }
  });
});

describe("C5: one transport", () => {
  it("the transport the caller hands in is the only one used: every read of a command goes through it", async () => {
    const log: Log = [];
    const r = await session(seatHome(), ["show", "--owner", OWNER.ss58], transportOf(scriptAt("A6"), log));
    expect(r.code).toBe(0);
    expect(log.length).toBeGreaterThan(1);
    expect(log[0]).toEqual({ method: "chain_getBlockHash", params: [0] });
  });

  it("without one, the network's node is used, and in tests its socket is the one test/setup.ts blocks", async () => {
    const r = await cli(seatHome(), ["session", "show", "--owner", OWNER.ss58]);
    expect([r.code, r.out]).toEqual([1, ""]);
    expect(r.err).toMatch(/the node's block 0 cannot be read/);
  });
});

describe("C2 and C1: the command's shape", () => {
  it("an unknown or missing sub command, or a positional, is a usage error", async () => {
    for (const args of [["session"], ["session", "list"], ["session", "show", "extra", "--owner", OWNER.ss58], ["session", "toString", "--owner", OWNER.ss58]]) {
      const r = await cli(seatHome(), args, { transport: transportOf(scriptAt("A10")) });
      expect([args.join(" "), r.code, r.out]).toEqual([args.join(" "), 2, ""]);
    }
  });

  it("the help names the three commands, and that a day of --days is one epoch of the chain's daily cap", async () => {
    const r = await cli(seatHome(), ["help"]);
    expect(r.out).toContain("session grant --owner <ss58> --days <1..10>");
    expect(r.out).toContain("a day is one epoch of the chain's daily cap");
    expect(r.out).toContain("session revoke --owner <ss58>");
    expect(r.out).toContain("session show --owner <ss58>");
  });

  it("the code is in src/session, in a file for each part", () => {
    expect([...files].sort()).toEqual(["accounts.ts", "caps.ts", "chain.ts", "command.ts", "context.ts", "grant.ts", "revoke.ts", "room.ts", "show.ts", "stored.ts", "words.ts"]);
  });
});
