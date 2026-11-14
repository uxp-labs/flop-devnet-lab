/**
 * Piece A1 part 6 (audit finding 1): readBlockEvents reads its block argument once, before the first node call, into
 * a copy: an object with exactly the own fields number and hash, no accessor, a Proxy's get trap not used. A block
 * that is not such an object is unknown with a reason that names what was wrong, makes no node call and never
 * throws. Every later line uses the copy, so an accessor cannot answer the canonical hash once and another after.
 *
 * Every hash and height comes from research/2026-11-12-session-rerun-1014020/results.json (steps[].block_hash,
 * steps[].finalized_in_block) and the rerun recording through test/lib/recorded-node.ts.
 */
import { describe, expect, it } from "vitest";
import { readBlockEvents } from "../src/chain-read/read.js";
import { type Log, RERUN_RESULTS, repoJson, rerunScript, transportOf } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const A9 = RESULTS.steps.find((s: any) => s.step === "A9");
const AT = { number: A6.finalized_in_block as number, hash: A6.block_hash as string };
/** Another block's hash from the same file: a hash the node holds, but not at AT.number. */
const OTHER: string = A9.block_hash;

/** The read through a scripted node at A6, with the log of every node call it made. */
async function readWithLog(block: unknown): Promise<{ r: any; log: Log }> {
  const log: Log = [];
  const r = await readBlockEvents(transportOf(rerunScript(A6.block_hash), log), block as never);
  return { r, log };
}

describe("A-1: the block argument is read once, before any node call", () => {
  it("control: the two hashes differ, and a plain block of the other hash is not canonical", async () => {
    expect(OTHER).not.toBe(AT.hash);
    const { r } = await readWithLog({ number: AT.number, hash: OTHER });
    expect(r.kind).toBe("unknown");
    expect(r.reason).toMatch(/is not canonical/);
  });

  it("a hash accessor that answers the canonical hash once and another hash after: unknown, never read, no node call", async () => {
    let reads = 0;
    const block = {
      number: AT.number,
      get hash() {
        return reads++ === 0 ? AT.hash : OTHER;
      },
    };
    const { r, log } = await readWithLog(block);
    expect(r).toEqual({ kind: "unknown", reason: "the block argument.hash is an accessor, not a value" });
    expect(reads).toBe(0);
    expect(log).toEqual([]);
  });

  it("an accessor on number: unknown, no node call", async () => {
    const block = {
      get number() {
        return AT.number;
      },
      hash: AT.hash,
    };
    const { r, log } = await readWithLog(block);
    expect(r).toEqual({ kind: "unknown", reason: "the block argument.number is an accessor, not a value" });
    expect(log).toEqual([]);
  });

  it("a Proxy block: its get trap is never called; the read stands on the own values, read once", async () => {
    let gets = 0;
    let descriptors = 0;
    const block = new Proxy(
      { number: AT.number, hash: AT.hash },
      {
        get: () => (gets++, OTHER),
        getOwnPropertyDescriptor: (t, k) => (descriptors++, Reflect.getOwnPropertyDescriptor(t, k)),
      },
    );
    const { r } = await readWithLog(block);
    expect(r.kind).toBe("known");
    expect(r.value.hash).toBe(AT.hash);
    expect(gets).toBe(0);
    expect(descriptors).toBe(2);
  });

  it("a Proxy block whose trap throws: unknown with a fixed reason, nothing of what it threw, no node call", async () => {
    const block = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("secret words of the trap");
        },
      },
    );
    const { r, log } = await readWithLog(block);
    expect(r).toEqual({ kind: "unknown", reason: "the block argument threw while it was read" });
    expect(log).toEqual([]);
  });

  it("a block with a third field: unknown, no node call", async () => {
    const { r, log } = await readWithLog({ ...AT, extra: 1 });
    expect(r).toEqual({ kind: "unknown", reason: "the block argument has a field extra that is not one of its fields" });
    expect(log).toEqual([]);
  });

  it("a block missing a field: unknown, no node call", async () => {
    const { r, log } = await readWithLog({ number: AT.number });
    expect(r).toEqual({ kind: "unknown", reason: "the block argument lacks the field hash" });
    expect(log).toEqual([]);
  });

  it("null, undefined, a number, a text and a list: unknown, never a throw, no node call", async () => {
    for (const v of [null, undefined, AT.number, AT.hash, [AT.number, AT.hash]]) {
      const { r, log } = await readWithLog(v);
      expect([String(v), r]).toEqual([String(v), { kind: "unknown", reason: "the block argument must be an object" }]);
      expect(log).toEqual([]);
    }
  });

  it("a plain block reads as before: known, with the same node calls in the same order", async () => {
    const { r, log } = await readWithLog({ ...AT });
    expect(r.kind).toBe("known");
    expect(r.value.number).toBe(AT.number);
    expect(r.value.hash).toBe(AT.hash);
    expect(log.map((c) => c.method)).toEqual(["chain_getFinalizedHead", "chain_getHeader", "chain_getBlockHash", "chain_getHeader", "state_getStorage", "state_getMetadata", "state_getStorage"]);
    expect(log[2]!.params).toEqual([AT.number]);
    expect(log[3]!.params).toEqual([AT.hash]);
  });
});
