import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { cli, tmpHome } from "./helpers.js";
import { verifyLink, type LinkFile } from "../src/link.js";

async function linked() {
  const h = tmpHome();
  await cli(h, ["init", "--seat", "42"]);
  const r = await cli(h, ["link", "--token", "42", "--agent", "7", "--json"]);
  expect(r.code).toBe(0);
  return { h, file: r.json().file as string, link: r.json().link as LinkFile };
}

describe("seat-to-DID link", () => {
  it("builds the section A statement and the Ed25519 side verifies", async () => {
    const { file, link } = await linked();
    expect(Object.keys(link.statement)).toEqual(["tokenId", "erc8004AgentId", "flopDid", "ss58", "network", "issuedAt"]);
    expect(link.statement).toMatchObject({ tokenId: "42", erc8004AgentId: "7", network: "devnet" });
    expect(link.wallet).toBeNull();
    expect(link.eip712.primaryType).toBe("SeatFlopLink");
    const v = await verifyLink(link);
    expect(v).toMatchObject({ ok: true, flopSig: true, didMatchesSs58: true, ss58PrefixOk: true, eip712MatchesStatement: true });
    expect(v.wallet.checked).toBe(false);
    const h2 = tmpHome();
    expect((await cli(h2, ["link", "verify", file])).code).toBe(0);
  });

  it("fails a tampered statement", async () => {
    const { link } = await linked();
    for (const patch of [{ tokenId: "43" }, { erc8004AgentId: "8" }, { issuedAt: link.statement.issuedAt + 1 }, { network: "mainnet" }]) {
      const t = { ...link, statement: { ...link.statement, ...patch } } as LinkFile;
      const v = await verifyLink(t);
      expect(v.ok).toBe(false);
      expect(v.flopSig).toBe(false);
    }
  });

  it("fails when ss58 and did:key are different keys", async () => {
    const a = await linked();
    const b = await linked();
    const t = { ...a.link, statement: { ...a.link.statement, ss58: b.link.statement.ss58 } } as LinkFile;
    const v = await verifyLink(t);
    expect(v.didMatchesSs58).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("EIP-712: a throwaway in-test wallet signs, verify recovers it, a wrong wallet fails", async () => {
    const { file, link } = await linked();
    const wallet = privateKeyToAccount(generatePrivateKey()); // in-memory only, never written
    const td = link.eip712;
    const sig = await wallet.signTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: { ...td.message, tokenId: BigInt(td.message.tokenId), issuedAt: BigInt(td.message.issuedAt) },
    });
    const ok = await verifyLink(link, { walletSig: sig, wallet: wallet.address });
    expect(ok.ok).toBe(true);
    expect(ok.wallet).toMatchObject({ checked: true, ok: true, recovered: wallet.address });

    const other = privateKeyToAccount(generatePrivateKey());
    const bad = await verifyLink(link, { walletSig: sig, wallet: other.address });
    expect(bad.ok).toBe(false);

    // CLI: verify + save stores only address and signature.
    const r = await cli(tmpHome(), ["link", "verify", file, "--wallet-sig", sig, "--wallet", wallet.address, "--save"]);
    expect(r.code).toBe(0);
    const saved = JSON.parse(readFileSync(file, "utf8")) as LinkFile;
    expect(saved.wallet).toEqual({ address: wallet.address, signature: sig });
    expect((await cli(tmpHome(), ["link", "verify", file])).code).toBe(0);

    // A wallet signature over a different statement does not carry over.
    const t = { ...saved, statement: { ...saved.statement, tokenId: "43" } };
    writeFileSync(file, JSON.stringify(t));
    const rr = await cli(tmpHome(), ["link", "verify", file]);
    expect(rr.code).toBe(8);
  });

  it("never asks for a seed: link output has no private material and tells the holder to sign elsewhere", async () => {
    const h = tmpHome();
    await cli(h, ["init", "--seat", "5"]);
    const r = await cli(h, ["link", "--token", "5"]);
    expect(r.out).toMatch(/on your own machine/);
    expect(r.out).toMatch(/Never paste a seed/);
    const lf = readFileSync(join(h, "seats", "5", "link.json"), "utf8");
    expect(lf).not.toMatch(/seed_b64/);
  });
});
