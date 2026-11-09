import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { cli, tmpHome } from "./helpers.js";
import { verifyLink, type LinkFile } from "../src/link.js";
import { NETWORKS, SEAT_CHAIN_ID, SEAT_COLLECTION } from "../src/networks.js";
import { readSeatOwner, readVerifiedSeatOwner } from "../src/gateway.js";

async function walletSigned() {
  const l = await linked();
  const wallet = privateKeyToAccount(generatePrivateKey()); // in-memory only, never written
  const td = l.link.eip712;
  const sig = await wallet.signTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: { ...td.message, tokenId: BigInt(td.message.tokenId), issuedAt: BigInt(td.message.issuedAt) },
  });
  return { ...l, wallet, sig };
}

/** Fake Ethereum JSON-RPC. eth_chainId defaults to mainnet (0x1); eth_call answers ownerOf (null = revert). */
function fakeRpc(owner: string | null, calls: unknown[] = [], chainId: string | null = "0x1") {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (body.method === "eth_chainId") {
      const out = chainId === null ? { jsonrpc: "2.0", id: 1, error: { code: -1, message: "no chain" } } : { jsonrpc: "2.0", id: 1, result: chainId };
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }
    const out = owner ? { jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(24) + owner.slice(2).toLowerCase() } : { jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } };
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

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
    expect(Object.keys(link.statement)).toEqual(["tokenId", "erc8004AgentId", "flopDid", "ss58", "network", "genesisHash", "issuedAt"]);
    expect(link.statement).toMatchObject({ tokenId: "42", erc8004AgentId: "7", network: "devnet", genesisHash: NETWORKS.devnet.genesisHash });
    expect(link.v).toBe(1);
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
    for (const patch of [{ tokenId: "43" }, { erc8004AgentId: "8" }, { issuedAt: link.statement.issuedAt + 1 }, { network: "mainnet" }, { genesisHash: "0x" + "11".repeat(32) }]) {
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

  it("a link bound to another chain's genesis fails even with a valid FLOP signature", async () => {
    const { link } = await linked();
    const v = await verifyLink(link);
    expect(v.genesisOk).toBe(true);
    const saved = NETWORKS.devnet.genesisHash;
    try {
      (NETWORKS.devnet as { genesisHash: string }).genesisHash = "0x" + "22".repeat(32); // devnet reset
      const after = await verifyLink(link);
      expect(after.flopSig).toBe(true);
      expect(after.genesisOk).toBe(false);
      expect(after.ok).toBe(false);
    } finally {
      (NETWORKS.devnet as { genesisHash: string }).genesisHash = saved;
    }
  });

  it("ownerOf: the signer still owning the seat passes; a sale or a burn kills the link", async () => {
    const { link, wallet, sig } = await walletSigned();
    const base = { walletSig: sig, wallet: wallet.address };
    expect((await verifyLink(link, { ...base, currentOwner: wallet.address })).ok).toBe(true);
    const buyer = privateKeyToAccount(generatePrivateKey()).address;
    const sold = await verifyLink(link, { ...base, currentOwner: buyer });
    expect(sold.ok).toBe(false);
    expect(sold.errors.join()).toMatch(/link is dead/);
    expect((await verifyLink(link, { ...base, currentOwner: null })).ok).toBe(false);
    // An owner check without a verified wallet signature cannot pass.
    expect((await verifyLink(link, { currentOwner: wallet.address })).ok).toBe(false);
  });

  it("readSeatOwner sends one read-only eth_call ownerOf(tokenId) to the seat collection", async () => {
    const calls: any[] = [];
    const owner = "0x" + "ab".repeat(20);
    expect(await readSeatOwner("https://rpc.example", SEAT_COLLECTION, "42", fakeRpc(owner, calls))).toBe(owner);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("eth_call");
    expect(calls[0].params[0]).toEqual({ to: SEAT_COLLECTION, data: "0x6352211e" + (42).toString(16).padStart(64, "0") });
    expect(await readSeatOwner("https://rpc.example", SEAT_COLLECTION, "42", fakeRpc(null))).toBeNull();
  });

  it("readVerifiedSeatOwner refuses a wrong chain id before ownerOf", async () => {
    const calls: { method?: string }[] = [];
    const owner = "0x" + "ab".repeat(20);
    const wrong = "0xaa36a7";
    await expect(readVerifiedSeatOwner("https://rpc.example", SEAT_COLLECTION, "42", fakeRpc(owner, calls, wrong))).rejects.toThrow(
      new RegExp(`chain id ${BigInt(wrong)} is not ${SEAT_CHAIN_ID}`),
    );
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });

  it("CLI link verify --eth-rpc: exit 0 while the signer owns the seat, 8 after a sale", async () => {
    const { file, wallet, sig } = await walletSigned();
    const args = ["link", "verify", file, "--wallet-sig", sig, "--wallet", wallet.address, "--eth-rpc", "https://rpc.example"];
    const ok = await cli(tmpHome(), args, { fetch: fakeRpc(wallet.address) });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/seat owner \(ownerOf\)\s+true/);
    const sold = await cli(tmpHome(), args, { fetch: fakeRpc("0x" + "cd".repeat(20)) });
    expect(sold.code).toBe(8);
    const calls: { method?: string }[] = [];
    const wrongChain = await cli(tmpHome(), args, { fetch: fakeRpc(wallet.address, calls, "0x5") });
    expect(wrongChain.code).toBe(8);
    expect(wrongChain.err).toMatch(/chain id 5 is not 1/);
    expect(wrongChain.err).toMatch(/not treated as ok/);
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });
});
