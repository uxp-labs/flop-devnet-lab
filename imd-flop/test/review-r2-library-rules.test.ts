/**
 * Review of piece R, second branch (reviewer, not the builder): attack 6, the rules of test/lib/settle-recording.ts.
 *
 * The library refuses a tape that holds two answers to a block, two batches at a block, a batch that is not one set
 * for that block, and a batch that does not read one record of the channel. The branch's own tests feed it only the
 * real tape, so none of those refusals is exercised: each rule can be removed and every test of the branch still
 * passes (the mutants of /tmp/rev-r2/tools/lib.json, the review's report). Each test here hands the library a tape
 * changed in the one way its rule refuses and holds the refusal by the library's own words. The changed tape is the
 * fixture's tape with one change, made in memory; no file is written. Nothing here reads the network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { method: string; params: unknown[]; result: unknown };
/** The change the next import of the library sees, applied to the fixture's tape. */
let change: (tape: Call[]) => Call[] = (t) => t;

vi.mock("./lib/recorded-node.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/recorded-node.js")>();
  return {
    ...real,
    tapeOf: (recording: string) => {
      const t = real.tapeOf(recording) as Call[];
      return recording.includes("20261114071524") ? change(structuredClone(t)) : t;
    },
  };
});

const lib = async () => {
  vi.resetModules();
  return import("./lib/settle-recording.js");
};
const settledHash = (t: Call[], ch: string): string => {
  const inputs = JSON.parse(JSON.stringify(t)) as Call[];
  // The settled block of a channel is the block whose chain_getBlock the tape holds and whose batch reads the channel's record.
  const blocks = inputs.filter((c) => c.method === "chain_getBlock").map((c) => c.params[0] as string);
  const batch = (h: string) => inputs.find((c) => c.method === "state_queryStorageAt" && c.params[1] === h) as Call;
  return blocks.find((h) => (batch(h).params[0] as string[]).some((k) => k.endsWith(ch.slice(2)))) as string;
};

beforeEach(() => {
  change = (t) => t;
});

describe("attack 6: each refusal of the settle library, exercised", () => {
  it("HOLDS: the real tape is read (the control for the tests below)", async () => {
    const { SETTLE_CHANNELS, settleOf } = await lib();
    expect(() => SETTLE_CHANNELS.map((c) => settleOf(c))).not.toThrow();
  });

  it("HOLDS: two chain_getBlock answers at the settled block are refused (kills L7-one-answer)", async () => {
    const ch = (await lib()).SETTLE_CHANNELS[0] as string;
    change = (t) => {
      const b = t.find((c) => c.method === "chain_getBlock") as Call;
      return [...t, structuredClone(b)];
    };
    const again = await lib();
    expect(() => again.settleOf(ch)).toThrow("holds 2 answers to chain_getBlock");
  });

  it("HOLDS: two batches at a block are refused (kills L5c-one-batch)", async () => {
    change = (t) => {
      const b = t.find((c) => c.method === "state_queryStorageAt") as Call;
      return [...t, structuredClone(b)];
    };
    const { SETTLE_CHANNELS, settleOf } = await lib();
    expect(() => SETTLE_CHANNELS.map((c) => settleOf(c))).toThrow("2 batches at");
  });

  it("HOLDS: a batch answer of two sets is refused (kills L5a-one-set)", async () => {
    change = (t) => {
      for (const c of t) if (c.method === "state_queryStorageAt") (c.result as unknown[]).push(structuredClone((c.result as unknown[])[0]));
      return t;
    };
    const { SETTLE_CHANNELS, settleOf } = await lib();
    expect(() => settleOf(SETTLE_CHANNELS[0] as string)).toThrow("is not one set for that block");
  });

  it("HOLDS: a batch answer whose one set is for another block is refused (kills L5b-set-block)", async () => {
    change = (t) => {
      const genesis = t.find((x) => x.method === "chain_getBlockHash" && x.params[0] === 0)?.result as string;
      for (const c of t) if (c.method === "state_queryStorageAt") ((c.result as { block: string }[])[0] as { block: string }).block = genesis;
      return t;
    };
    const { SETTLE_CHANNELS, settleOf } = await lib();
    expect(() => settleOf(SETTLE_CHANNELS[0] as string)).toThrow("is not one set for that block");
  });

  it("HOLDS: a batch that reads a second record beside the channel's is refused (kills L4a-one-record-count)", async () => {
    change = (t) => {
      const chKeys = t.filter((c) => c.method === "state_queryStorageAt").map((c) => (c.params[0] as string[]).at(-1) as string);
      const other = chKeys.find((k) => k !== chKeys[0]) as string;
      const first = t.find((c) => c.method === "state_queryStorageAt" && (c.params[0] as string[]).at(-1) === chKeys[0]) as Call;
      (first.params[0] as string[]).push(other);
      return t;
    };
    const { SETTLE_CHANNELS, settleOf } = await lib();
    expect(() => settleOf(SETTLE_CHANNELS[0] as string)).toThrow("does not read one record of");
  });

  it("HOLDS: a batch at the channel's settled block that reads the other channel's record instead is refused by the library's own rule (kills L4b-one-record-channel)", async () => {
    const real = await lib();
    const [a, b] = real.SETTLE_CHANNELS as [string, string];
    const idA = real.settleOf(a).channelId;
    const idB = real.settleOf(b).channelId;
    change = (t) => {
      const h = settledHash(t, idA);
      const c = t.find((x) => x.method === "state_queryStorageAt" && x.params[1] === h) as Call;
      const keys = c.params[0] as string[];
      const kB = (t.find((x) => x.method === "state_queryStorageAt" && (x.params[0] as string[]).at(-1)?.endsWith(idB.slice(2))) as Call).params[0] as string[];
      const old = keys.at(-1) as string;
      keys[keys.length - 1] = kB.at(-1) as string;
      const set = (c.result as { changes: [string, string | null][] }[])[0] as { changes: [string, string | null][] };
      for (const ch of set.changes) if (ch[0] === old) ch[0] = kB.at(-1) as string;
      return t;
    };
    const again = await lib();
    expect(() => again.settleOf(a)).toThrow("does not read one record of");
  });
});
