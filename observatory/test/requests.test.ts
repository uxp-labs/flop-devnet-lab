// The request list: its one written form, and the first list, as it was reviewed.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { feedText } from "../src/feed.js";
import { READ_ONLY_RPC_METHODS } from "../src/guard.js";
import { MAX_CALLS, REQUESTS_SCHEMA, type RequestCall, readRequests } from "../src/requests.js";
import { REQUESTS_TEXT } from "./helpers/recorded.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const CALL: RequestCall = { method: "chain_getFinalizedHead", params: [], why: "the finalized head when the run read it" };
const list = (calls: unknown[]) => feedText({ schema: REQUESTS_SCHEMA, calls });

describe("readRequests", () => {
  it("reads a list in the written form, with the sha256 of its bytes as read", () => {
    const text = list([CALL, { method: "chain_getBlockHash", params: [0], why: "the genesis" }]);
    expect(readRequests(bytes(text))).toEqual({
      sha256: createHash("sha256").update(text).digest("hex"),
      calls: [CALL, { method: "chain_getBlockHash", params: [0], why: "the genesis" }],
    });
  });

  it.each([
    ["not UTF-8", new Uint8Array([0xff]), "the request list is not valid UTF-8"],
    ["a byte order mark", bytes(`﻿${list([CALL])}`), "the request list is not valid JSON"],
    ["not JSON", bytes("{"), "the request list is not valid JSON"],
    ["a key twice", bytes('{"calls":[],"calls":[],"schema":"x"}'), 'the request list is the key "calls" appears twice in one object'],
    ["not in the written form", bytes(JSON.stringify({ calls: [CALL], schema: REQUESTS_SCHEMA })), "the request list is not in the written form"],
    ["keys out of order", bytes(`{\n  "schema": "${REQUESTS_SCHEMA}",\n  "calls": []\n}\n`), "the request list is not in the written form"],
    ["another schema", bytes(feedText({ schema: "flop-observatory/requests@1", calls: [CALL] })), `the request list is not a ${REQUESTS_SCHEMA}: it must hold exactly calls and schema`],
    ["an unknown key", bytes(feedText({ schema: REQUESTS_SCHEMA, calls: [CALL], note: "x" })), `the request list is not a ${REQUESTS_SCHEMA}: it must hold exactly calls and schema`],
    ["no calls", bytes(list([])), `the request list must hold 1 to ${MAX_CALLS} calls`],
    ["too many calls", bytes(list(Array.from({ length: MAX_CALLS + 1 }, () => CALL))), `the request list must hold 1 to ${MAX_CALLS} calls`],
    ["a call with an unknown key", bytes(list([{ ...CALL, id: 1 }])), "call 0 must hold exactly method, params and why"],
    ["a call with no why", bytes(list([{ method: CALL.method, params: [] }])), "call 0 must hold exactly method, params and why"],
    ["a method that is no RPC method name", bytes(list([CALL, { ...CALL, method: "chain getHeader" }])), 'call 1 has the method "chain getHeader", which is no RPC method name'],
    ["params that are no list", bytes(list([{ ...CALL, params: { at: 1 } }])), "call 0 has params that are not a list"],
    ["an empty why", bytes(list([{ ...CALL, why: "" }])), "call 0 has a why that is not one plain line of words"],
    ["a why over two lines", bytes(list([{ ...CALL, why: "a\nb" }])), "call 0 has a why that is not one plain line of words"],
    ["a why with padding", bytes(list([{ ...CALL, why: " a" }])), "call 0 has a why that is not one plain line of words"],
  ])("refuses a list with %s", (_what, b, why) => {
    expect(readRequests(b)).toBe(why);
  });

  it("does not judge a method by the guard: the run does, before anything is sent", () => {
    const write = { method: "author_submitExtrinsic", params: ["0x00"], why: "never" };
    expect(READ_ONLY_RPC_METHODS.has(write.method)).toBe(false);
    expect(readRequests(bytes(list([write])))).toMatchObject({ calls: [write] });
  });
});

// The first list, as the brief gave it: blocks checked by hand on 2026-11-11 against the RPC (each
// hash the canonical block at its height, finalized), holding compute channel events according to
// the explorer. Runtime spec 1014014 at every one.
const SYSTEM_EVENTS = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
const LAST_RUNTIME_UPGRADE = "0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8";
const BLOCKS: [number, string, string][] = [
  [3479238, "0x9c0ac85d24b12803e66d3def5a03cd43a2a03e55a48f8ddda166a85fac123062", "SessionEvidenceRegistered"],
  [3479245, "0x920dc42cb5fb0f1d5d203a58a486dfe9178b2c4e7889669c6200b873cfcec7f7", "EscrowToppedUp"],
  [3479277, "0xb85b24f4b0609839aea37d97ad1aa9f7ec7aba20348bca090ab31df471764aba", "AuditFeeEarmarked, Settled"],
  [3479291, "0x37b23091195e6ce7c2a74ac6a3e56b2209fa2846cb4a0a46d80792338ba5fe2d", "ToplocEvidenceSubmitted"],
  [3479299, "0xeba1182c9f2bbf5a8fd012afddc201c2ebed11b64f59b10c1d3c4fcc4b2ee18e", "AuditFeeEarmarked, Settled"],
  [3479303, "0xd7d1972cfa69f3810ee70ddfefd2f7f096b3a961e23f6c81d34ac2f4267e02e0", "EscrowToppedUp"],
  [3479311, "0xa918b5dcc7bc6335914cd2a13e1442dfd7fcc1c091b47d0c86e9d868870a84cb", "TimedOutRefunded"],
  [3479313, "0x5f557ec62d3ec449e52a8e80b0cf81b02be586fc519d3b2c7052f49b25753918", "SessionEvidenceRegistered"],
  [3479317, "0x7519278459add0a60cb6a42e72e3b9d56a72d662161ef5f3b51f61aea706e85e", "TimedOutRefunded"],
  [3479323, "0xf67f31c9721ec2966f8561a13723e3b678ee24d49cc899945c8af10f33ee42f9", "AssuranceClassPinned, CalibrationSnapshotted, ChannelOpened"],
  [3479328, "0x63fb8c0e85f8f75f8fbc588ccbbd258255ac53e0a42f05cacf799b156f812e19", "ToplocEvidenceSubmitted"],
  [3479329, "0xef5960e6418bbe91c09e368b2a2a817f5a12dcf6cc75d05b6435673af18255ed", "AssuranceClassPinned, CalibrationSnapshotted, ChannelOpened"],
];

// The first list is kept in its recording's fixture folder, byte for byte as it was recorded:
// recordings/requests.json has moved on to the current list (test/rerun-requests.test.ts).
describe("the first request list, as its recording's fixture keeps it", () => {
  const text = REQUESTS_TEXT;
  const read = readRequests(bytes(text));
  const calls = typeof read === "string" ? [] : read.calls;

  it("is in the written form, and every method in it is one the guard allows", () => {
    expect(typeof read).not.toBe("string");
    for (const c of calls) expect(READ_ONLY_RPC_METHODS.has(c.method), c.method).toBe(true);
  });

  it("asks the heads, then each block in height order, then the runtime at the last block, and nothing else", () => {
    const [last] = BLOCKS.slice(-1) as [[number, string, string]];
    expect(BLOCKS.map(([h]) => h)).toEqual([...BLOCKS.map(([h]) => h)].sort((a, b) => a - b));
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["chain_getFinalizedHead", []],
      ["chain_getBlockHash", [0]],
      ...BLOCKS.flatMap(([height, hash]) => [
        ["chain_getBlockHash", [height]],
        ["chain_getHeader", [hash]],
        ["state_getStorage", [SYSTEM_EVENTS, hash]],
        ["state_getStorage", [LAST_RUNTIME_UPGRADE, hash]],
      ]),
      ["state_getRuntimeVersion", [last[1]]],
      ["state_getMetadata", [last[1]]],
    ]);
  });

  it("says why for each call, naming the height and what the explorer shows in each block", () => {
    for (const [height, , shows] of BLOCKS) {
      const at = calls.findIndex((c) => c.method === "chain_getBlockHash" && c.params[0] === height);
      for (const c of calls.slice(at, at + 4)) expect(c.why, `${height} ${c.method}`).toContain(String(height));
      expect(calls.at(at + 2)?.why).toContain(shows);
    }
  });
});
