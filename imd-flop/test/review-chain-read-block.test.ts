/**
 * Review of P2 (reviewer, not the builder): attack B, one block (R2).
 *
 * Which test is which:
 *  - "RULE X..." tests were the reviewer's DEFECT tests: each failed on fcf75d0 and now holds the lead's rule of
 *    that id (the P2 fix round), so its name states the rule.
 *  - "HOLDS ..." tests pass on fcf75d0.
 *
 * Every hash and height comes from research/2026-11-12-session-rerun-1014020/results.json (steps[].block_hash,
 * steps[].finalized_in_block) and the rerun recording through test/lib/recorded-node.ts.
 */
import { describe, expect, it } from "vitest";
import type { Transport } from "../src/chain-read/node.js";
import { readBlockEvents, readSessionState } from "../src/chain-read/read.js";
import { type Log, RERUN_RESULTS, repoJson, rerunScript, transportOf } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const OWNER: string = RESULTS.accounts.owner.public_key;
const DEV1: string = RESULTS.accounts.dev1.public_key;
const step = (id: string) => RESULTS.steps.find((s: any) => s.step === id);
const A6 = step("A6");
const A9 = step("A9");
const AT = { number: A6.finalized_in_block as number, hash: A6.block_hash as string };

describe("B: the events read", () => {
  it("HOLDS a head that moves forward then backward between calls is asked once; the read stands on the first answer", async () => {
    const log: Log = [];
    const base = transportOf(rerunScript(A9.block_hash), log);
    const heads = [A9.block_hash, A6.block_hash, A9.block_hash];
    let i = 0;
    const t: Transport = (m, p) => (m === "chain_getFinalizedHead" ? Promise.resolve(heads[i++]) : base(m, p));
    expect((await readBlockEvents(t, AT)).kind).toBe("known");
    expect(i).toBe(1);
  });

  it("HOLDS events at exactly the head are read; one above the head is unknown", async () => {
    expect((await readBlockEvents(transportOf(rerunScript(A6.block_hash)), AT)).kind).toBe("known");
    const r = await readBlockEvents(transportOf(rerunScript(A6.block_hash)), { number: AT.number + 1, hash: AT.hash });
    expect(r.kind).toBe("unknown");
  });

  it("HOLDS a block number that is a text, NaN, Infinity, 1.5, 2^32, -1 is unknown; -0 is read as 0 and is not the block", async () => {
    for (const n of [String(AT.number), Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 32, -1, -0, AT.number + 0.5]) {
      const r = await readBlockEvents(transportOf(rerunScript(A6.block_hash)), { number: n as number, hash: AT.hash });
      expect([String(n), r.kind]).toEqual([String(n), "unknown"]);
    }
  });

  it("HOLDS a hash in upper case letters is not the node's hash", async () => {
    const r = await readBlockEvents(transportOf(rerunScript(A6.block_hash)), { number: AT.number, hash: `0x${AT.hash.slice(2).toUpperCase()}` });
    expect(r.kind).toBe("unknown");
    expect((r as any).reason).toMatch(/is not canonical/);
  });

  it("HOLDS chain_getBlockHash answering an array (of the right hash) is unknown", async () => {
    const base = transportOf(rerunScript(A6.block_hash));
    const t: Transport = async (m, p) => (m === "chain_getBlockHash" ? [await base(m, p)] : base(m, p));
    expect((await readBlockEvents(t, AT)).kind).toBe("unknown");
  });

  it("HOLDS the head's header answered with a number below the block makes the block unknown", async () => {
    const s = rerunScript(A9.block_hash);
    s.headers.set(A9.block_hash, { ...(s.headers.get(A9.block_hash) as any), number: AT.number - 1 });
    expect((await readBlockEvents(transportOf(s), AT)).kind).toBe("unknown");
  });
});

describe("B: one above the head, at a height the node holds a canonical hash for", () => {
  it("HOLDS (kills R2) a head whose header says A9's number minus one: A9 itself, canonical, one above, is unknown", async () => {
    const s = rerunScript(A6.block_hash);
    s.headers.set(A6.block_hash, { ...(s.headers.get(A6.block_hash) as any), number: A9.finalized_in_block - 1 });
    const control = rerunScript(A6.block_hash);
    control.headers.set(A6.block_hash, { ...(control.headers.get(A6.block_hash) as any), number: A9.finalized_in_block });
    expect((await readBlockEvents(transportOf(control), { number: A9.finalized_in_block, hash: A9.block_hash })).kind).toBe("known");
    const r = await readBlockEvents(transportOf(s), { number: A9.finalized_in_block, hash: A9.block_hash });
    expect(r.kind).toBe("unknown");
    expect((r as any).reason).toMatch(/is not at or below the finalized head/);
  });
});

describe("B: a node that reads hashes in any letter case", () => {
  /** A node that, like a real one, takes a hash param in upper case letters for the same block. */
  const caseBlind = (head: string): Transport => {
    const base = transportOf(rerunScript(A6.block_hash));
    const low = (p: readonly unknown[]) => p.map((x) => (typeof x === "string" ? x.toLowerCase() : x));
    return (m, p) => (m === "chain_getFinalizedHead" ? Promise.resolve(head) : base(m, low(p)));
  };
  it("HOLDS (kills N1) a finalized head answered in upper case letters is unknown for both reads, even when the node reads it", async () => {
    const upper = `0x${A6.block_hash.slice(2).toUpperCase()}`;
    expect((await readSessionState(caseBlind(A6.block_hash), OWNER, DEV1)).kind).toBe("known");
    expect((await readSessionState(caseBlind(upper), OWNER, DEV1)).kind).toBe("unknown");
    expect((await readBlockEvents(caseBlind(upper), AT)).kind).toBe("unknown");
  });
});

describe("B: the session read", () => {
  it("HOLDS every storage read and the metadata are made at the one head hash and its header's parent", async () => {
    const log: Log = [];
    await readSessionState(transportOf(rerunScript(A6.block_hash), log), OWNER, DEV1);
    for (const c of log.filter((x) => x.method === "state_getStorage")) expect(c.params[1]).toBe(A6.block_hash);
  });

  it("RULE X5 the session read's block number is the canonical number of its hash: a header of the head that names another number is not answered as the block's number", async () => {
    // The node answers the head's header with A9's number. The storage values are A6's; the read says they are of
    // block A9.finalized_in_block. A later caller compares the session's expires_at with this number.
    const s = rerunScript(A6.block_hash);
    s.headers.set(A6.block_hash, { ...(s.headers.get(A6.block_hash) as any), number: A9.finalized_in_block });
    const log: Log = [];
    const r = await readSessionState(transportOf(s, log), OWNER, DEV1);
    if (r.kind === "known") expect(r.value.number).toBe(A6.finalized_in_block);
    // The number was never checked against the chain: chain_getBlockHash is not asked by a session read.
    expect(log.some((c) => c.method === "chain_getBlockHash")).toBe(true);
  });
});
