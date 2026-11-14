/**
 * Review of P6a, attack 10 (Q10): the edges of three hard maxima that no test of the builder holds (mutants w10, i3
 * and i5 of the review stay alive against the builder's tests). Each test here passes on the reviewed commit and
 * fails with its mutant.
 */
import { describe, expect, it } from "vitest";
import { MinerError } from "../src/miner/errors.js";
import { turnInput } from "../src/miner/input.js";
import { parseTurnReceipt } from "../src/miner/wire.js";
import { expected, turnParts } from "./lib/review-p6a-miner.js";

const refusedCheck = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof MinerError) return e.check;
    throw e;
  }
  return "accepted";
};

describe("Q10: the edges of the hard maxima", () => {
  it("HOLDS: a turn's output of exactly 2 MiB parses, and one byte more is refused", () => {
    const w = turnParts().wire;
    w.output = "0x" + "61".repeat(2 * 1024 * 1024);
    expect(parseTurnReceipt(JSON.stringify(w)).output.length).toBe(2 * 1024 * 1024);
    w.output = "0x" + "61".repeat(2 * 1024 * 1024 + 1);
    expect(refusedCheck(() => parseTurnReceipt(JSON.stringify(w)))).toBe("turn.output");
  });

  it("HOLDS: max_tokens of 131072 is taken, and 131073 is refused", () => {
    const e = expected();
    expect(turnInput({ expected: e, messages: [{ role: "user", content: "x" }], maxTokens: 131072 }).input.length).toBeGreaterThan(0);
    expect(refusedCheck(() => turnInput({ expected: e, messages: [{ role: "user", content: "x" }], maxTokens: 131073 }))).toBe("turn input.maxTokens");
  });

  it("HOLDS: 256 messages are taken, and 257 are refused", () => {
    const e = expected();
    const many = (n: number) => Array.from({ length: n }, () => ({ role: "user" as const, content: "x" }));
    expect(turnInput({ expected: e, messages: many(256), maxTokens: 1 }).input.length).toBeGreaterThan(0);
    expect(refusedCheck(() => turnInput({ expected: e, messages: many(257), maxTokens: 1 }))).toBe("turn input.messages");
  });
});

describe("Q10: own fields only (mutant w20)", () => {
  it("HOLDS: every field but the leaf version is read only as an own field: a gN on Object.prototype does not stand in for a missing one", () => {
    const w = turnParts().wire;
    delete w.gN;
    const proto = Object.prototype as Record<string, unknown>;
    proto.gN = "38";
    let check = "";
    try {
      check = refusedCheck(() => parseTurnReceipt(JSON.stringify(w)));
    } finally {
      delete proto.gN;
    }
    expect(check).toBe("turn.gN");
  });
});
