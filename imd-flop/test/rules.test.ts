import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cli, tmpHome } from "./helpers.js";
import { assertNoSecrets, clearSecretRegistry, registerSecret, scanForSecrets } from "../src/secrets.js";
import { writeJsonSafe, appendJsonlSafe } from "../src/store.js";

describe("secret scan before any write", () => {
  const hex64 = "ab".repeat(32);
  it("blocks key-shaped strings", () => {
    expect(scanForSecrets({ note: hex64 }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ note: "0x" + hex64 }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ h: "Authorization: Bearer abcdefghijklmnop" }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ t: "flop_ek_" + "A1b2C3d4E5f6G7h8" }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ x: "-----BEGIN OPENSSH PRIVATE KEY-----" }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ private_key: "anything" }).length).toBeGreaterThan(0);
    expect(scanForSecrets({ seed: "x" }).length).toBeGreaterThan(0);
  });
  it("blocks a loaded secret in any encoding", () => {
    clearSecretRegistry();
    const seed = new Uint8Array(32).map((_, i) => i + 1);
    registerSecret(seed);
    expect(scanForSecrets({ a: Buffer.from(seed).toString("base64") }).length).toBeGreaterThan(0);
    clearSecretRegistry();
  });
  it("allows public 32-byte values in allowlisted fields and 64-byte signatures", () => {
    expect(scanForSecrets({ genesisHash: "0x" + hex64, prompt_sha256: hex64, sig: "0x" + "cd".repeat(64) })).toEqual([]);
  });
  it("refuses the write and leaves no file", () => {
    const h = tmpHome();
    const f = join(h, "x.json");
    expect(() => writeJsonSafe(f, { oops: hex64 })).toThrow(/secret scan blocked/);
    expect(existsSync(f)).toBe(false);
    expect(() => appendJsonlSafe(join(h, "l.jsonl"), { oops: hex64 })).toThrow();
    expect(existsSync(join(h, "l.jsonl"))).toBe(false);
    expect(() => assertNoSecrets({ fine: "did:key:z6Mk..." }, "t")).not.toThrow();
  });
  it("the error names the field, not the value", () => {
    try {
      assertNoSecrets({ oops: hex64 }, "t");
    } catch (e) {
      expect((e as Error).message).toMatch(/oops/);
      expect((e as Error).message).not.toContain(hex64);
    }
  });
});

describe("faucet and enrollment", () => {
  it("faucet refuses with its own exit code and explains the rule", async () => {
    const h = tmpHome();
    await cli(h, ["init", "--seat", "42"]);
    const r = await cli(h, ["faucet"]);
    expect(r.code).toBe(9);
    expect(r.err).toMatch(/does not use faucets/);
  });
  it("faucet --dry-run prints the request and sends nothing", async () => {
    const h = tmpHome();
    const id = (await cli(h, ["init", "--seat", "42", "--json"])).json();
    const r = await cli(h, ["faucet", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ sent: false, method: "POST", body: { address: id.ss58 } });
  });
  it("enroll is a dry run by default (fetch is disabled in tests, so a live call would fail)", async () => {
    const h = tmpHome();
    const id = (await cli(h, ["init", "--seat", "42", "--json"])).json();
    const r = await cli(h, ["enroll", "--json"]);
    expect(r.code).toBe(0);
    const plan = r.json();
    expect(plan.sent).toBe(false);
    expect(plan.steps[0].url).toBe(`https://api.flop.network/v1/enroll/wallet/challenge?address=${id.ss58}`);
    expect(existsSync(join(h, "seats", "42", "gateway.key"))).toBe(false);
  });
  it("genesis check only runs behind --check-genesis", async () => {
    const h = tmpHome();
    expect((await cli(h, ["init", "--seat", "1"])).code).toBe(0); // no network touched
    const r = await cli(tmpHome(), ["init", "--seat", "1", "--check-genesis"]);
    expect(r.code).toBe(1); // network disabled in tests -> check fails closed
    expect(r.err).toMatch(/genesis check failed/);
  });
  it("checkGenesis passes only when pinned, faucet and RPC all agree", async () => {
    const { checkGenesis } = await import("../src/gateway.js");
    const { NETWORKS } = await import("../src/networks.js");
    const pinned = NETWORKS.devnet.genesisHash;
    const other = "0x" + "33".repeat(32);
    const faucet = (g: string) => (async () => new Response(JSON.stringify({ genesisHash: g }))) as typeof fetch;
    const realWS = globalThis.WebSocket;
    const fakeWS = (g: string) =>
      class {
        onopen?: () => void;
        onmessage?: (ev: { data: string }) => void;
        onerror?: () => void;
        constructor() { setTimeout(() => this.onopen?.(), 0); }
        send() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ result: g }) }), 0); }
        close() {}
      };
    try {
      (globalThis as any).WebSocket = fakeWS(pinned);
      expect((await checkGenesis(NETWORKS.devnet, faucet(pinned))).ok).toBe(true);
      (globalThis as any).WebSocket = fakeWS(other); // RPC reset, faucet stale
      expect((await checkGenesis(NETWORKS.devnet, faucet(pinned))).ok).toBe(false);
      (globalThis as any).WebSocket = fakeWS(other); // devnet reset: faucet and RPC agree, pin does not
      const reset = await checkGenesis(NETWORKS.devnet, faucet(other));
      expect(reset.ok).toBe(false);
      expect(reset.pinnedGenesis).toBe(pinned);
    } finally {
      (globalThis as any).WebSocket = realWS;
    }
  });
});
