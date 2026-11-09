// uxp-labs rehearsal: FLOP leg (tclk frames + MemoryRail, no value) swapped
// against an ETH leg on a local anvil chain, both under one sha256 hash lock.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { makeOffer, makeAccept, openContract, applyFrame, generateHashLock, lockTerms, MemoryRail, encodeFrame } from "../src/index.js";

const PORT = 8547, RPC = `http://127.0.0.1:${PORT}`;
const EVM = "/workspace/flop-agent/tclk-rehearsal/evm";
const ALICE_DID = "did:key:z6Mk" + "a".repeat(44); // pays ETH, receives FLOP, holds the secret
const BOB_DID = "did:key:z6Mk" + "b".repeat(44);   // pays FLOP, receives ETH
let anvil: ChildProcess, ALICE = "", BOB = "", HL = "";
const sh = (c: string) => execSync(c, { encoding: "utf8", cwd: EVM }).trim();
const cast = (a: string) => sh(`cast ${a} --rpc-url ${RPC}`);
const now = () => Number(cast("block latest --field timestamp"));
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
const bal = (a: string) => BigInt(cast(`balance ${a}`));

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(PORT), "--silent"]);
  for (let i = 0; i < 50; i++) { try { cast("chain-id"); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const accts = JSON.parse(cast("rpc eth_accounts")); ALICE = accts[0]; BOB = accts[1];
  const out = sh(`forge create src/HashLock.sol:HashLock --rpc-url ${RPC} --unlocked --from ${ALICE} --broadcast`);
  HL = out.match(/Deployed to: (0x[0-9a-fA-F]{40})/)![1];
}, 60_000);
afterAll(() => anvil?.kill());

function deal(t0: number) {
  const secret = generateHashLock(); // minted by Alice, the FLOP-leg payee
  const offer = makeOffer({ from: BOB_DID, role: "payer", amount: "1000", asset: "FLOP", lock: "hash",
    rails: ["memory"], claimByMs: t0 + 3_000_000, refundAfterMs: t0 + 3_600_000, expiresMs: t0 + 600_000,
    nonce: Math.random().toString(16).slice(2, 18).padEnd(16, "0") } as Parameters<typeof makeOffer>[0]);
  const accept = makeAccept(offer, { from: ALICE_DID, statement: secret.hash });
  const s = applyFrame(openContract(offer), accept, t0); expect(s.ok).toBe(true);
  return { secret, offer, state: s.state };
}

describe("cross-leg hash-lock swap (rehearsal, no value)", () => {
  it("happy path: Alice locks ETH, Bob locks FLOP, Alice reveals, Bob claims ETH with the revealed secret", async () => {
    const t = now(), t0 = t * 1000; let clock = t0;
    const { secret, state } = deal(t0);
    // 1. Alice locks ETH first, longer timeout (2h) than the FLOP leg (1h).
    cast(`send ${HL} "lock(bytes32,address,uint64)" ${secret.hash} ${BOB} ${t + 7200} --value 0.1ether --unlocked --from ${ALICE}`);
    // 2. Bob sees the ETH lock on chain, then locks FLOP on the rail and announces it in-room.
    const onchain = cast(`call ${HL} "locks(bytes32)(address,address,uint256,uint64,bool)" ${secret.hash}`);
    expect(onchain.toLowerCase()).toContain(BOB.toLowerCase());
    const rail = new MemoryRail("memory", () => clock);
    const terms = lockTerms(state); const ref = await rail.lock(terms);
    expect(await rail.verifyLock(terms, ref)).toBe(true);
    const locked = applyFrame(state, { type: "lock", from: BOB_DID, contract: state.contract!, rail: "memory", ref }, clock += 1000);
    expect(locked.ok).toBe(true);
    // 3. Alice claims FLOP; the reveal frame publishes the preimage.
    await rail.claim(ref, secret.preimage);
    const reveal = { type: "reveal" as const, from: ALICE_DID, contract: state.contract!, ref, secret: secret.preimage };
    const claimed = applyFrame(locked.state, reveal, clock += 1000);
    expect(claimed.ok).toBe(true); expect(claimed.state.status).toBe("claimed");
    // 4. Bob reads the secret from the room frame alone and claims ETH.
    const seen = JSON.parse(encodeFrame(reveal).slice(6)).secret as string;
    const before = bal(BOB);
    cast(`send ${HL} "claim(bytes32)" ${seen} --unlocked --from ${ALICE}`); // anyone may submit; funds go to payee
    expect(bal(BOB) - before).toBe(10n ** 17n);
  }, 60_000);

  it("refund path: Alice never reveals; Bob refunds FLOP after 1h, Alice refunds ETH after 2h", async () => {
    const t = now(), t0 = t * 1000; let clock = t0;
    const { secret, state } = deal(t0);
    cast(`send ${HL} "lock(bytes32,address,uint64)" ${secret.hash} ${BOB} ${t + 7200} --value 0.1ether --unlocked --from ${ALICE}`);
    const rail = new MemoryRail("memory", () => clock);
    const ref = await rail.lock(lockTerms(state));
    const locked = applyFrame(state, { type: "lock", from: BOB_DID, contract: state.contract!, rail: "memory", ref }, clock += 1000);
    expect(locked.ok).toBe(true);
    clock = t0 + 3_600_000; await rail.refund(ref);
    const r = applyFrame(locked.state, { type: "refund", from: BOB_DID, contract: state.contract!, ref }, clock);
    expect(r.ok).toBe(true); expect(r.state.status).toBe("refunded");
    expect(() => cast(`send ${HL} "refund(bytes32)" ${secret.hash} --unlocked --from ${ALICE}`)).toThrow(); // too early
    warp(7200);
    const before = bal(ALICE);
    cast(`send ${HL} "refund(bytes32)" ${secret.hash} --unlocked --from ${BOB}`); // Bob pays gas, so Alice gets exactly 0.1
    expect(bal(ALICE) - before).toBe(10n ** 17n);
  }, 60_000);
});
