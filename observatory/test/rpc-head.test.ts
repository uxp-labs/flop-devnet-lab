// The head reading's raw answers, turned into RpcHead. Pure: no transport at all.
import { describe, expect, it } from "vitest";
import { type HeadAnswers, finalizedHashOf, headFrom, headerNumber, specVersionOf } from "../src/rpc-head.js";
import { DEVNET_GENESIS } from "../src/status.js";

const F = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a";
const AT = "2026-11-11T06:00:00.400Z";

function answers(over: Partial<HeadAnswers> = {}): HeadAnswers {
  return {
    observedAt: AT,
    genesis: { result: DEVNET_GENESIS },
    finalizedHead: { result: F },
    finalizedHeader: { result: { number: "0x345670" } },
    bestHeader: { result: { number: "0x345672" } },
    runtimeVersion: { result: { specName: "tzkv-runtime", specVersion: 1014014 } },
    ...over,
  };
}

describe("headFrom", () => {
  it("reads every field from its answer", () => {
    expect(headFrom(answers())).toEqual({
      genesis_hash: DEVNET_GENESIS,
      finalized: { number: 3430000, hash: F },
      best_number: 3430002,
      runtime_spec_version: 1014014,
      observed_at: AT,
      error: null,
    });
  });

  it("names each call that failed on the way in the error, in reading order, and leaves its field null", () => {
    const h = headFrom(answers({ genesis: { error: "rpc socket error" }, bestHeader: { error: "rpc chain_getHeader timed out after 15000 ms" } }));
    expect([h.genesis_hash, h.best_number, h.finalized?.number]).toEqual([null, null, 3430000]);
    expect(h.error).toBe("chain_getBlockHash(0): rpc socket error; chain_getHeader(): rpc chain_getHeader timed out after 15000 ms");
  });

  it("leaves the finalized head null when either its hash or its header number is not valid", () => {
    expect(headFrom(answers({ finalizedHead: { result: F.toUpperCase().replace("0X", "0x") }, finalizedHeader: null, runtimeVersion: null })).finalized).toBeNull();
    expect(headFrom(answers({ finalizedHeader: { result: { number: 3430000 } } })).finalized).toBeNull();
    expect(headFrom(answers({ finalizedHeader: { result: null } })).finalized).toBeNull();
  });

  it("passes a genesis string on as given, so the status judges its spelling, and nulls any other value", () => {
    expect(headFrom(answers({ genesis: { result: "0xABC" } })).genesis_hash).toBe("0xABC");
    expect(headFrom(answers({ genesis: { result: 7 } })).genesis_hash).toBeNull();
    expect(headFrom(answers({ genesis: { result: null } })).error).toBeNull();
  });

  it("reads a runtime version that is not a whole number from 0 as unknown, with no error of its own", () => {
    for (const v of ["1014014", 1014014.5, -1, null, true, 2 ** 53]) {
      const h = headFrom(answers({ runtimeVersion: { result: { specVersion: v } } }));
      expect([h.runtime_spec_version, h.error], String(v)).toEqual([null, null]);
    }
    expect(headFrom(answers({ runtimeVersion: null })).runtime_spec_version).toBeNull();
  });
});

describe("the readers", () => {
  it.each([
    ["0x0", 0],
    ["0x345670", 3430000],
    ["0x00345670", 3430000],
    ["0xABCDEF", 0xabcdef],
    ["0x1fffffffffffff", Number.MAX_SAFE_INTEGER],
  ])("reads the header number %s", (n, v) => {
    expect(headerNumber({ number: n })).toBe(v);
  });

  it.each([["0x20000000000000"], ["0x"], ["345670"], ["0x-1"], ["0x34 5670"], [3430000], [null]])("reads no header number from %j", (n) => {
    expect(headerNumber({ number: n })).toBeNull();
  });

  it("reads nothing from a header or version that is not an object", () => {
    for (const v of [null, "0x1", [], 5]) {
      expect(headerNumber(v)).toBeNull();
      expect(specVersionOf(v)).toBeNull();
    }
    expect(headerNumber({})).toBeNull();
    expect(specVersionOf({ specVersion: 0 })).toBe(0);
  });

  it("reads a finalized hash to read by only when it is 0x and 64 lower case hex, from a result", () => {
    expect(finalizedHashOf({ result: F })).toBe(F);
    expect(finalizedHashOf({ result: F.slice(0, 65) })).toBeNull();
    expect(finalizedHashOf({ error: "x" })).toBeNull();
  });
});
