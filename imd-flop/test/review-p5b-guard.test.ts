/**
 * Review of P5b, attacks 3, 4 and 7 (promises P4, P5, P6, P10). The owner and the delegates come from
 * research/2026-11-12-session-rerun-1014020/results.json `accounts`, the pinned genesis from src/networks.ts, the node
 * is the rerun's recording at step A10 (test/lib/session-fixtures.ts). Each bad input is made here from those values
 * and said in the test's name. No socket is opened; no key file is read: the key files made here are a folder, an
 * empty file the test cannot read, and a dangling link, none of them a key.
 */
import { mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blake2b } from "@noble/hashes/blake2.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "../src/networks.js";
import { clearSecretRegistry, scanForSecrets } from "../src/secrets.js";
import { ss58Decode, ss58Encode } from "../src/ss58.js";
import type { Log } from "./lib/recorded-node.js";
import { copyScript, DEV1, DEV2, OWNER, scriptAt, SEAT, seatHome, session, transportOf, unhex } from "./lib/session-fixtures.js";

const SUBS: [string, string[]][] = [
  ["grant", ["--days", "1"]],
  ["revoke", []],
  ["show", []],
];
const argsOf = (sub: string, extra: string[], owner = OWNER.ss58) => [sub, "--owner", owner, ...extra];
const SS58PRE = new TextEncoder().encode("SS58PRE");

/** An SS58 text of the given raw body (prefix bytes and payload) with its good checksum. */
function withChecksum(body: Uint8Array): string {
  const pre = new Uint8Array(SS58PRE.length + body.length);
  pre.set(SS58PRE);
  pre.set(body, SS58PRE.length);
  const sum = blake2b(pre, { dkLen: 64 }).subarray(0, 2);
  const all = new Uint8Array(body.length + 2);
  all.set(body);
  all.set(sum, body.length);
  return base58.encode(all);
}
const cat = (...xs: Uint8Array[]) => Uint8Array.from(xs.flatMap((x) => Array.from(x)));
const OPUB = unhex(OWNER.public_key);
const P42 = Uint8Array.of(NETWORKS.devnet.ss58Prefix);

describe("review P5b, attack 4: every bad owner exits 2, prints nothing and asks the node nothing", () => {
  const bad: [string, string][] = [
    ["a bad checksum (the last byte of the checksum flipped)", base58.encode(cat(base58.decode(OWNER.ss58).slice(0, -1), Uint8Array.of(base58.decode(OWNER.ss58).at(-1)! ^ 1)))],
    ["prefix 0 (Polkadot), a good checksum", ss58Encode(OPUB, 0)],
    ["prefix 2 (Kusama), a good checksum", ss58Encode(OPUB, 2)],
    ["a two byte prefix 4242, a good checksum", ss58Encode(OPUB, 4242)],
    ["a 33 byte payload of prefix 42 with a good checksum", withChecksum(cat(P42, OPUB, Uint8Array.of(0)))],
    ["a 31 byte payload of prefix 42 with a good checksum", withChecksum(cat(P42, OPUB.slice(0, 31)))],
    ["a leading space", ` ${OWNER.ss58}`],
    ["a trailing space", `${OWNER.ss58} `],
    ["a trailing newline", `${OWNER.ss58}\n`],
    ["a space inside", `${OWNER.ss58.slice(0, 10)} ${OWNER.ss58.slice(10)}`],
    ["the device's own address (dev1)", DEV1.ss58],
    ["the device's own public key as hex", DEV1.public_key],
    ["the owner's public key as hex", OWNER.public_key],
    ["empty", ""],
  ];
  for (const [sub, extra] of SUBS) {
    for (const [name, owner] of bad) {
      it(`HOLDS: ${sub}: ${name}: exit 2, stdout empty, no node call`, async () => {
        const log: Log = [];
        const r = await session(seatHome(), argsOf(sub, extra, owner), transportOf(scriptAt("A10"), log));
        expect({ code: r.code, out: r.out, calls: log.length }).toEqual({ code: 2, out: "", calls: 0 });
      });
    }
  }

  it("the cases are what they say (control): the checksummed 33 and 31 byte texts, and the two non canonical forms below, decode as named", () => {
    expect(base58.decode(bad[4][1]).length).toBe(1 + 33 + 2);
    expect(base58.decode(bad[5][1]).length).toBe(1 + 31 + 2);
    expect(ss58Decode(ss58Encode(OPUB, 4242)).prefix).toBe(4242);
    // The two non canonical forms, read without ss58Decode: the first bytes, the owner's 32 key bytes, and a good checksum by this test's own blake2b.
    for (const [t, first] of [[twoByte42, [0x4a, 0x80]], [reserved42, [0x8a, 0x80]]] as const) {
      const raw = base58.decode(t);
      expect(Array.from(raw.subarray(0, 2))).toEqual(first);
      expect(Buffer.from(raw.subarray(2, 34)).toString("hex")).toBe(OWNER.public_key.slice(2));
      expect(raw.length).toBe(2 + 32 + 2);
      const sum = blake2b(cat(SS58PRE, raw.subarray(0, 34)), { dkLen: 64 }).subarray(0, 2);
      expect(Array.from(raw.subarray(34))).toEqual(Array.from(sum));
    }
  });

  // The two byte form of prefix 42: bytes 0x4a 0x80 read as ((0x4a & 0x3f) << 2) | (0x80 >> 6) | ((0x80 & 0x3f) << 8) = 42.
  // SS58 writes a prefix below 64 in one byte, so this text is no address a wallet makes. A first byte of 0x80 or
  // more (0x8a here) is reserved by SS58 and is no address at all.
  const twoByte42 = withChecksum(cat(Uint8Array.of(0x4a, 0x80), OPUB));
  const reserved42 = withChecksum(cat(Uint8Array.of(0x8a, 0x80), OPUB));
  it("HOLDS: ss58Decode refuses both non canonical texts, each with its own error, and neither is the canonical text (before the fix both decoded to prefix 42 and the owner's key)", () => {
    expect(() => ss58Decode(twoByte42)).toThrow(/two byte form of a prefix below 64, not canonical/);
    expect(() => ss58Decode(reserved42)).toThrow(/reserved first byte/);
    for (const t of [twoByte42, reserved42]) expect(t).not.toBe(OWNER.ss58);
  });
  for (const [sub, extra] of SUBS) {
    for (const [name, owner] of [["a two byte encoding of prefix 42", twoByte42], ["a reserved first byte 0x8a that reads as prefix 42", reserved42]]) {
      it(`HOLDS: RP5B-2: ${sub}: --owner as ${name}, not a canonical SS58 address of prefix 42, is refused with exit 2 before any node call (before the fix it was taken as the owner)`, async () => {
        const log: Log = [];
        const r = await session(seatHome(), argsOf(sub, extra, owner), transportOf(scriptAt("A10"), log));
        expect({ code: r.code, out: r.out, calls: log.length }).toEqual({ code: 2, out: "", calls: 0 });
      });
    }
  }

  for (const [sub, extra] of SUBS) {
    it(`HOLDS: RP5B-3: ${sub}: --owner given twice (a bad one, then the owner) is refused with exit 2 before any node call (before the fix the last one was taken)`, async () => {
      const log: Log = [];
      const r = await session(seatHome(), [sub, "--owner", DEV2.ss58.slice(0, -2), "--owner", OWNER.ss58, ...extra], transportOf(scriptAt("A10"), log));
      expect({ code: r.code, out: r.out, calls: log.length }).toEqual({ code: 2, out: "", calls: 0 });
    });
    it(`HOLDS: RP5B-3: ${sub}: --owner given twice (dev2, then the owner) is refused with exit 2 before any node call (before the fix the call was for the last flag's owner)`, async () => {
      const log: Log = [];
      const r = await session(seatHome(), [sub, "--owner", DEV2.ss58, "--owner", OWNER.ss58, ...extra], transportOf(scriptAt("A10"), log));
      expect({ code: r.code, out: r.out, calls: log.length }).toEqual({ code: 2, out: "", calls: 0 });
    });
  }
});

describe("review P5b, attack 4: the genesis", () => {
  const cases: [string, string | null | number, number][] = [
    ["another hash (the head's)", "HEAD", 5],
    ["no block 0 (null)", null, 1],
    ["a text that is not a hash", "genesis", 1],
    ["the pinned genesis in upper case hex", NETWORKS.devnet.genesisHash.replace(/^0x/, "0x").toUpperCase().replace(/^0X/, "0x"), 1],
    ["the pinned genesis with one byte short", NETWORKS.devnet.genesisHash.slice(0, -2), 1],
    ["a number", 0, 1],
  ];
  for (const [sub, extra] of SUBS) {
    for (const [name, value, code] of cases) {
      it(`HOLDS: ${sub}: block 0 is ${name}: exit ${code === 5 ? "5" : "1 or 5"}, stdout empty, no read past block 0`, async () => {
        const s = copyScript(scriptAt("A10"));
        if (value === null) s.hashes.delete(0);
        else (s.hashes as Map<number, unknown>).set(0, value === "HEAD" ? s.head : value);
        const log: Log = [];
        const r = await session(seatHome(), argsOf(sub, extra), transportOf(s, log));
        expect(r.out).toBe("");
        if (code === 5) expect(r.code).toBe(5);
        else expect([1, 5]).toContain(r.code);
        expect(log.map((c) => [c.method, c.params])).toEqual([["chain_getBlockHash", [0]]]);
      });
    }
  }
});

describe("review P5b, attack 7: --days", () => {
  for (const days of ["0", "11", "01", "1.0", "1e1", "+1", " 1", "1 ", "", "１", "10\n", "0x1", "-0", "100", "1_0"]) {
    it(`HOLDS: grant --days ${JSON.stringify(days)}: exit 2, stdout empty, no node call`, async () => {
      const log: Log = [];
      const r = await session(seatHome(), ["grant", "--owner", OWNER.ss58, "--days", days], transportOf(scriptAt("A10"), log));
      expect({ code: r.code, out: r.out, calls: log.length }).toEqual({ code: 2, out: "", calls: 0 });
    });
  }
  it("HOLDS: RP5B-3: grant --days given twice (1, then 10) is refused with exit 2 and prints no call (before the fix the grant printed a call of the last value)", async () => {
    const log: Log = [];
    const r = await session(seatHome(), ["grant", "--owner", OWNER.ss58, "--days", "1", "--days", "10", "--json"], transportOf(scriptAt("A10"), log));
    expect({ code: r.code, out: r.out, calls: log.length }).toEqual({ code: 2, out: "", calls: 0 });
  });
  for (const sub of ["revoke", "show"]) {
    for (const days of ["", "0", "1"]) {
      it(`HOLDS: ${sub} --days ${JSON.stringify(days)}: exit 2, stdout empty, no node call`, async () => {
        const log: Log = [];
        const r = await session(seatHome(), [sub, "--owner", OWNER.ss58, "--days", days], transportOf(scriptAt("A10"), log));
        expect({ code: r.code, out: r.out, calls: log.length }).toEqual({ code: 2, out: "", calls: 0 });
      });
    }
  }
});

/** Every path under a home with its kind, size, mode and modification time. */
function snapshot(home: string): string[] {
  return readdirSync(home, { recursive: true })
    .map(String)
    .sort()
    .map((p) => {
      const st = statSync(join(home, p), { throwIfNoEntry: false });
      return st === undefined ? `${p} dangling` : `${p} ${st.isDirectory() ? "d" : "f"} ${st.size} ${st.mode.toString(8)} ${st.mtimeMs}`;
    });
}

describe("review P5b, attack 3: the owner's key and the seat's key file", () => {
  const keyFiles: [string, (f: string) => void][] = [
    ["no key file", () => {}],
    ["a key file that is a folder", (f) => mkdirSync(f)],
    ["a key file the process cannot read (mode 000 at creation)", (f) => writeFileSync(f, "", { mode: 0o000 })],
    ["a key file that is a dangling link", (f) => symlinkSync(join(f, "..", "nowhere"), f)],
  ];
  for (const [sub, extra] of SUBS) {
    it(`HOLDS: ${sub}: the same output with each kind of broken key file; no file of the home changes; nothing printed is a secret`, async () => {
      const outs: string[] = [];
      for (const [, make] of keyFiles) {
        const home = seatHome();
        make(join(home, "seats", SEAT, "flop.key"));
        const before = snapshot(home);
        clearSecretRegistry();
        const r = await session(home, [...argsOf(sub, extra), "--json"], transportOf(scriptAt("A10")));
        expect(snapshot(home)).toEqual(before);
        // The 64 hex rule flags the public hashes printed (head, call hash, accounts) by their shape alone; what is
        // held here is that no loaded secret is in the registry after the command and none is printed.
        expect(scanForSecrets({ out: r.out, err: r.err }).filter((f) => f.reason === "contains a loaded secret")).toEqual([]);
        outs.push(JSON.stringify([r.code, r.out, r.err]));
      }
      expect(new Set(outs).size).toBe(1);
    });
    it(`HOLDS: ${sub}: a refused command (a bad owner, a wrong genesis, an unknown read) changes no file of the home`, async () => {
      const home = seatHome();
      const before = snapshot(home);
      const s = copyScript(scriptAt("A10"));
      s.hashes.set(0, s.head);
      await session(home, argsOf(sub, extra, DEV1.ss58), transportOf(scriptAt("A10")));
      await session(home, argsOf(sub, extra), transportOf(s));
      await session(home, argsOf(sub, extra), async () => {
        throw new Error("down");
      });
      expect(snapshot(home)).toEqual(before);
    });
  }
});
