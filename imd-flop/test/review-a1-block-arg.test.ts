/**
 * Review of piece A1 (reviewer, not the builder), promise P7: readBlockEvents reads its block argument once, before
 * any node call, and for a bad block answers unknown with a reason, makes no node call and never throws.
 *
 * Every hash and height comes from research/2026-11-12-session-rerun-1014020/results.json (steps[].block_hash,
 * steps[].finalized_in_block), and the node answers from the rerun recording through test/lib/recorded-node.ts.
 */
import { describe, expect, it } from "vitest";
import { readBlockEvents } from "../src/chain-read/read.js";
import { type Log, RERUN_RESULTS, repoJson, rerunScript, transportOf } from "./lib/recorded-node.js";

const RESULTS = repoJson(RERUN_RESULTS);
const A6 = RESULTS.steps.find((s: any) => s.step === "A6");
const AT = { number: A6.finalized_in_block as number, hash: A6.block_hash as string };

/** How a call ended: its answer, or the fact that it threw (a rejected promise). */
async function settle(block: unknown): Promise<{ answer: any; threw: boolean; log: Log }> {
  const log: Log = [];
  try {
    return { answer: await readBlockEvents(transportOf(rerunScript(A6.block_hash), log), block as never), threw: false, log };
  } catch {
    return { answer: undefined, threw: true, log };
  }
}

/** A value whose every Proxy trap counts that it ran, and whose prototype lookup throws. */
function hostileThrown(ran: { n: number }): object {
  return new Proxy(
    {},
    {
      getPrototypeOf() {
        ran.n++;
        throw new Error("the thrown value's own prototype trap");
      },
      get() {
        ran.n++;
        return undefined;
      },
    },
  );
}

describe("review A1, P7: a hostile block argument", () => {
  it("DEFECT RA1-1: a block whose ownKeys trap throws a Proxy with a throwing getPrototypeOf trap makes readBlockEvents throw, and runs the thrown value's code", async () => {
    const ran = { n: 0 };
    const block = new Proxy(
      { number: AT.number, hash: AT.hash },
      {
        ownKeys() {
          throw hostileThrown(ran);
        },
      },
    );
    const s = await settle(block);
    // The promise: never throws; unknown with the fixed reason; no node call; none of the thrown value's code run.
    expect(s.threw).toBe(false);
    expect(s.answer).toEqual({ kind: "unknown", reason: "the block argument threw while it was read" });
    expect(s.log).toEqual([]);
    expect(ran.n).toBe(0);
  });

  it("DEFECT RA1-1 (second form): a getOwnPropertyDescriptor trap that throws such a value also makes the read throw", async () => {
    const ran = { n: 0 };
    const block = new Proxy(
      { number: AT.number, hash: AT.hash },
      {
        getOwnPropertyDescriptor() {
          throw hostileThrown(ran);
        },
      },
    );
    const s = await settle(block);
    expect(s.threw).toBe(false);
    expect(s.answer).toEqual({ kind: "unknown", reason: "the block argument threw while it was read" });
    expect(ran.n).toBe(0);
  });

  it("HOLDS: a trap that throws a plain Error, a text or null gives the fixed reason and no node call", async () => {
    for (const thrown of [new Error("x"), "a text", null, 7]) {
      const block = new Proxy(
        { number: AT.number, hash: AT.hash },
        {
          ownKeys() {
            throw thrown;
          },
        },
      );
      const s = await settle(block);
      expect(s.threw, String(thrown)).toBe(false);
      expect(s.answer, String(thrown)).toEqual({ kind: "unknown", reason: "the block argument threw while it was read" });
      expect(s.log).toEqual([]);
    }
  });

  it("HOLDS: a revoked Proxy, an array, a function, a typed array, a boxed number are unknown with no node call", async () => {
    const r = Proxy.revocable({ number: AT.number, hash: AT.hash }, {});
    r.revoke();
    const fn = Object.assign(() => 0, { number: AT.number, hash: AT.hash });
    for (const block of [r.proxy, [AT.number, AT.hash], fn, new Uint8Array(2), Object(5), true, Symbol("b"), undefined]) {
      const s = await settle(block);
      expect(s.threw).toBe(false);
      expect(s.answer.kind).toBe("unknown");
      expect(s.log).toEqual([]);
    }
  });

  it("HOLDS: a Proxy whose descriptor trap answers the canonical hash once and another after is read once: one descriptor read per field", async () => {
    const reads: string[] = [];
    let n = 0;
    const block = new Proxy(
      { number: AT.number, hash: AT.hash },
      {
        getOwnPropertyDescriptor(t, k) {
          reads.push(String(k));
          if (k === "hash") return { value: n++ === 0 ? AT.hash : `0x${"00".repeat(32)}`, writable: true, enumerable: true, configurable: true };
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
        get() {
          throw new Error("the get trap is never used");
        },
      },
    );
    const s = await settle(block);
    expect(s.threw).toBe(false);
    expect(s.answer.kind).toBe("known");
    expect(s.answer.value.hash).toBe(AT.hash);
    expect(reads.sort()).toEqual(["hash", "number"]);
  });

  it("HOLDS: a symbol key and a non enumerable field are not refused: symbol keys are not fields, a non enumerable own data field is read", async () => {
    const sym = { number: AT.number, hash: AT.hash, [Symbol("x")]: 1 };
    expect((await settle(sym)).answer.kind).toBe("known");
    const hidden = Object.defineProperty({ number: AT.number }, "hash", { value: AT.hash, enumerable: false });
    expect((await settle(hidden)).answer.kind).toBe("known");
  });
});
