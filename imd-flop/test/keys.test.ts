import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import { cli, readLines, tmpHome } from "./helpers.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { didKeyFromPub, pubFromDidKey, ss58Decode, ss58Encode } from "../src/ss58.js";

describe("init: one Ed25519 key per seat", () => {
  it("writes the key 0600 in a 0700 dir and never prints it", async () => {
    const h = tmpHome();
    const r = await cli(h, ["init", "--network", "devnet", "--seat", "42"]);
    expect(r.code).toBe(0);
    const kf = join(h, "seats", "42", "flop.key");
    expect(statSync(kf).mode & 0o777).toBe(0o600);
    expect(statSync(join(h, "seats", "42")).mode & 0o777).toBe(0o700);
    const seed = base64.decode(JSON.parse(readFileSync(kf, "utf8")).seed_b64);
    expect(seed.length).toBe(32);
    const all = r.out + r.err;
    for (const enc of [bytesToHex(seed), base64.encode(seed).replace(/=+$/, ""), base58.encode(seed)]) expect(all).not.toContain(enc);
    // Printed address and DID are this key's public key.
    const pub = ed25519.getPublicKey(seed);
    expect(r.out).toContain(didKeyFromPub(pub));
    expect(r.out).toContain(ss58Encode(pub, 42));
    // No other file holds the seed.
    for (const f of ["config.json", join("seats", "42", "identity.json")]) {
      expect(readFileSync(join(h, f), "utf8")).not.toContain(bytesToHex(seed));
    }
  });

  it("refuses a second key for the same seat; --rotate replaces it and writes a revocation", async () => {
    const h = tmpHome();
    const first = await cli(h, ["init", "--seat", "42", "--json"]);
    const did1 = first.json().did;
    await cli(h, ["link", "--token", "42"]);
    const again = await cli(h, ["init", "--seat", "42"]);
    expect(again.code).toBe(5);
    expect(again.err).toMatch(/One DID per seat/);
    const rot = await cli(h, ["init", "--seat", "42", "--rotate", "--json"]);
    expect(rot.code).toBe(0);
    expect(rot.json().did).not.toBe(did1);
    expect(rot.json().rotated.revokedDid).toBe(did1);
    const rev = readLines(join(h, "revocations.jsonl"));
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ seat: "42", revokedDid: did1, replacedByDid: rot.json().did, reason: "rotate" });
    // Revocation is signed by the old key.
    const msg = new TextEncoder().encode("imd-flop/revocation/v0\n" + JSON.stringify((({ signature, ...x }) => x)(rev[0])));
    expect(ed25519.verify(Buffer.from(rev[0].signature.sig.slice(2), "hex"), msg, pubFromDidKey(did1))).toBe(true);
    // The old link is retired; run must re-link.
    expect(existsSync(join(h, "seats", "42", "link.json"))).toBe(false);
    expect(statSync(join(h, "seats", "42", "flop.key")).mode & 0o777).toBe(0o600);
  });

  it("an unassigned key is claimed by the first link and cannot be reused for a second seat", async () => {
    const h = tmpHome();
    const r = await cli(h, ["init", "--json"]);
    expect(r.json().seat).toBe("unassigned");
    const l = await cli(h, ["link", "--token", "9", "--json"]);
    expect(l.code).toBe(0);
    expect(l.json().link.statement.flopDid).toBe(r.json().did);
    const l2 = await cli(h, ["link", "--token", "10"]);
    expect(l2.code).not.toBe(0); // no unassigned key left
  });

  it("refuses networks that are not published", async () => {
    const r = await cli(tmpHome(), ["init", "--network", "testnet", "--seat", "1"]);
    expect(r.code).toBe(2);
  });
});

describe("did:key and SS58", () => {
  it("round-trips the same public key", () => {
    for (let i = 0; i < 20; i++) {
      const pub = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
      const did = didKeyFromPub(pub);
      expect(did.startsWith("did:key:z6Mk")).toBe(true); // ed25519-pub multicodec 0xed01
      expect(Buffer.from(pubFromDidKey(did))).toEqual(Buffer.from(pub));
      const d = ss58Decode(ss58Encode(pub, 42));
      expect(d.prefix).toBe(42);
      expect(Buffer.from(d.pub)).toEqual(Buffer.from(pub));
    }
  });
  it("matches the known SS58 vector for the all-zero account (prefix 42)", () => {
    expect(ss58Encode(new Uint8Array(32), 42)).toBe("5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM");
  });
  it("rejects a bad checksum", () => {
    const a = ss58Encode(new Uint8Array(32).fill(7), 42);
    const bad = a.slice(0, -1) + (a.endsWith("1") ? "2" : "1");
    expect(() => ss58Decode(bad)).toThrow();
  });

  // An address of the given prefix bytes, with a good checksum, built here by the SS58 rule (SS58PRE, blake2b 512, first 2 bytes).
  const addrOf = (prefixBytes: number[], pub: Uint8Array): string => {
    const body = Uint8Array.from([...prefixBytes, ...pub]);
    const sum = blake2b(Uint8Array.from([...new TextEncoder().encode("SS58PRE"), ...body]), { dkLen: 64 }).subarray(0, 2);
    return base58.encode(Uint8Array.from([...body, ...sum]));
  };
  const pub7 = new Uint8Array(32).fill(7);

  it("refuses a reserved first byte (128 or more), with its own error, though the checksum is good (RP5B-2)", () => {
    for (const first of [128, 0x8a, 255]) expect(() => ss58Decode(addrOf([first, 0x00], pub7))).toThrow(/reserved first byte/);
  });
  it("refuses a two byte form that carries a prefix below 64, with its own error (RP5B-2)", () => {
    // 0x40 0x2a: the two byte layout of ss58Encode, applied to a prefix that ss58Encode would write as one byte.
    const twoByte = (prefix: number) => [((prefix & 0xfc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 0x03) << 6)];
    for (const p of [0, 42, 63]) expect(() => ss58Decode(addrOf(twoByte(p), pub7))).toThrow(/two byte form of a prefix below 64, not canonical/);
  });
  it("decodes a canonical address of a one byte prefix and of a two byte prefix as before (RP5B-2)", () => {
    for (const prefix of [0, 42, 63, 64, 252, 16383]) {
      if (prefix === 46 || prefix === 47) continue;
      const d = ss58Decode(ss58Encode(pub7, prefix));
      expect(d.prefix).toBe(prefix);
      expect(Buffer.from(d.pub)).toEqual(Buffer.from(pub7));
    }
  });
});
