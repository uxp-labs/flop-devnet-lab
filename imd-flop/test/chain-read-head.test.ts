/**
 * The P2 fix round, rule X5: the head's number is the chain's. readSessionState asks chain_getBlockHash for the number
 * the head's header names, once, after the header and before any storage read; unless the answer is the head's hash
 * the read is unknown, and the reason names the number and both hashes.
 *
 * Hashes and numbers come from research/2026-11-12-session-rerun-1014020/results.json: steps A6 and A9 .block_hash and
 * .finalized_in_block, accounts.owner and dev1 .public_key; the node is test/lib/recorded-node.ts over the recording.
 */
import { describe, expect, it } from "vitest";
import { readSessionState } from "../src/chain-read/read.js";
import { type Log, RERUN_RESULTS, repoJson, rerunScript, transportOf } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const OWNER: string = RESULTS.accounts.owner.public_key;
const DEV1: string = RESULTS.accounts.dev1.public_key;
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const A9 = RESULTS.steps.find((s: any) => s.step === "A9");

describe("X5: the session read's number is checked with chain_getBlockHash", () => {
  it("the control: the head is asked once, then its header, then chain_getBlockHash of its number once, then storage", async () => {
    const log: Log = [];
    const r = await readSessionState(transportOf(rerunScript(A6.block_hash), log), OWNER, DEV1);
    expect(r.kind).toBe("known");
    expect((r as any).value.number).toBe(A6.finalized_in_block);
    expect(log.slice(0, 3)).toEqual([
      { method: "chain_getFinalizedHead", params: [] },
      { method: "chain_getHeader", params: [A6.block_hash] },
      { method: "chain_getBlockHash", params: [A6.finalized_in_block] },
    ]);
    expect(log.filter((c) => c.method === "chain_getFinalizedHead").length).toBe(1);
    expect(log.filter((c) => c.method === "chain_getBlockHash").length).toBe(1);
  });

  it("a header of the head that names A9's number is unknown, names the number and both hashes, and no storage is read", async () => {
    const s = rerunScript(A6.block_hash);
    s.headers.set(A6.block_hash, { ...(s.headers.get(A6.block_hash) as any), number: A9.finalized_in_block });
    const log: Log = [];
    const r = await readSessionState(transportOf(s, log), OWNER, DEV1);
    expect(r).toEqual({ kind: "unknown", reason: `the head's header names block ${A9.finalized_in_block}, whose hash at the node is ${A9.block_hash}, not the head ${A6.block_hash}` });
    expect(log.filter((c) => c.method === "state_getStorage" || c.method === "state_getMetadata")).toEqual([]);
    expect(log.filter((c) => c.method === "chain_getFinalizedHead").length).toBe(1);
  });

  it("a number the node holds no hash at is unknown, and no storage is read", async () => {
    const s = rerunScript(A6.block_hash);
    s.hashes.delete(A6.finalized_in_block);
    const log: Log = [];
    const r = await readSessionState(transportOf(s, log), OWNER, DEV1);
    expect(r).toEqual({ kind: "unknown", reason: `the canonical hash of the head's number: chain_getBlockHash: the node holds no block at ${A6.finalized_in_block}` });
    expect(log.filter((c) => c.method === "state_getStorage" || c.method === "state_getMetadata")).toEqual([]);
  });
});
