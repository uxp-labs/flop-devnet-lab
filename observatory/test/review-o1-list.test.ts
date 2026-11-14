// Review o1 (round 33), attacks 1, 2 and 4: the sixth list derived a third way. These lines read
// the first recording's tape by its own lines, not through the plan or core.ts, build each storage
// key with the reference hashers (dev only, @polkadot-api/substrate-bindings) from the pallet and
// entry names, and compare with recordings/requests.json call by call. The events are read through
// the decoder's door. Nothing here reads the network.
import { Blake2128Concat, Twox128 } from "@polkadot-api/substrate-bindings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeBlockEvents } from "../src/scale/block.js";
import { REVIEWED } from "../src/scale/shape.js";

const REPO = new URL("../../", import.meta.url);
const text = (p: string) => readFileSync(new URL(p, REPO), "utf8");
const TAPE = "observatory/fixtures/recording-20261111160917-3c228907aa129a01/tape.jsonl";
const LINES = text(TAPE).split("\n");
type Entry = { seq: number; request: { method: string; params: unknown[] }; answer: { result: unknown } };
const at = (seq: number) => JSON.parse(LINES[seq + 1] ?? "null") as Entry;
const ENTRIES = LINES.slice(1).filter((l) => l !== "").map((l) => JSON.parse(l) as Entry);
const LIST_TEXT = text("observatory/recordings/requests.json");
const LIST = JSON.parse(LIST_TEXT) as { calls: { method: string; params: unknown[]; why: string }[] };
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const bytes = (h: string) => new Uint8Array(Buffer.from(h.slice(2), "hex"));
const prefix = (pallet: string, entry: string) => hex(new Uint8Array([...Twox128(new TextEncoder().encode(pallet)), ...Twox128(new TextEncoder().encode(entry))]));
const EVENTS = prefix("System", "Events");
const UPGRADE = prefix("System", "LastRuntimeUpgrade");
const channelKey = (id: string) => prefix("ComputeChannel", "Channels") + hex(Blake2128Concat(bytes(id))).slice(2);

/** The seq of the one chain_getBlockHash call at a height on the tape. */
function hashSeqOf(height: number): number {
  const s = ENTRIES.filter((e) => e.request.method === "chain_getBlockHash" && e.request.params[0] === height);
  expect(s, `hash calls at ${height}`).toHaveLength(1);
  return (s[0] as Entry).seq;
}
const SPEC_1014014 = REVIEWED.find((r) => r.specVersion === 1014014);
const runtimeVersion = ENTRIES.find((e) => e.request.method === "state_getRuntimeVersion")?.answer.result as { specName: string; specVersion: number };
const metadataHex = ENTRIES.find((e) => e.request.method === "state_getMetadata")?.answer.result as string;
function settledOf(height: number) {
  const seq = hashSeqOf(height);
  const hash = at(seq).answer.result as string;
  expect(at(seq + 2).request.params).toEqual([EVENTS, hash]);
  expect(at(seq + 3).request.params).toEqual([UPGRADE, hash]);
  const d = decodeBlockEvents({
    specName: runtimeVersion.specName,
    specVersion: runtimeVersion.specVersion,
    metadata: bytes(metadataHex),
    lastRuntimeUpgrade: bytes(at(seq + 3).answer.result as string),
    shapeText: text(`observatory/${SPEC_1014014?.shapeFile}`),
    events: bytes(at(seq + 2).answer.result as string),
  });
  if (!d.decoded) throw new Error(d.refused);
  return { seq, hash, events: d.events, settled: d.events.filter((e) => e.pallet === "ComputeChannel" && e.event === "Settled") };
}

describe("review o1: the sixth list derived a third way from the first tape (attacks 1, 2, 4)", () => {
  it("HOLDS: the tape runs at spec 1014014, the reviewed spec whose shape the decoder reads", () => {
    expect(runtimeVersion.specVersion).toBe(1014014);
    expect(SPEC_1014014).toBeDefined();
  });

  it("HOLDS: each of 3479299 and 3479277 has exactly one ComputeChannel.Settled event, cooperative, and the two channels differ", () => {
    const g = settledOf(3479299);
    const s = settledOf(3479277);
    for (const b of [g, s]) {
      expect(b.settled).toHaveLength(1);
      expect((b.settled[0]?.fields as Record<string, unknown>).cooperative).toBe(true);
    }
    expect((g.settled[0]?.fields as Record<string, unknown>).channel_id).not.toBe((s.settled[0]?.fields as Record<string, unknown>).channel_id);
    expect([g.seq, s.seq]).toEqual([18, 10]);
  });

  it("HOLDS: no other block of the first tape holds a Settled event, so the two blocks are all the settles it saw", () => {
    const heights = ENTRIES.filter((e) => e.request.method === "chain_getBlockHash" && e.request.params[0] !== 0).map((e) => e.request.params[0] as number);
    const withSettle = heights.filter((h) => settledOf(h).settled.length > 0);
    expect(withSettle.sort()).toEqual([3479277, 3479299]);
  });

  it("HOLDS: recordings/requests.json is, call by call, the twelve calls these lines derive from the tape, in the order of rule L5", () => {
    const expected: { method: string; params: unknown[] }[] = [
      { method: "chain_getFinalizedHead", params: [] },
      { method: "chain_getBlockHash", params: [0] },
    ];
    for (const height of [3479299, 3479277]) {
      const b = settledOf(height);
      const id = (b.settled[0]?.fields as Record<string, unknown>).channel_id as string;
      const header = at(b.seq + 1);
      expect(header.request).toMatchObject({ method: "chain_getHeader", params: [b.hash] });
      const h = header.answer.result as { number: string; parentHash: string };
      expect(Number.parseInt(h.number, 16)).toBe(height);
      expected.push(
        { method: "chain_getBlockHash", params: [height] },
        { method: "chain_getBlock", params: [b.hash] },
        { method: "state_queryStorageAt", params: [[EVENTS, UPGRADE, channelKey(id)], b.hash] },
        { method: "chain_getBlockHash", params: [height - 1] },
        { method: "state_queryStorageAt", params: [[UPGRADE, channelKey(id)], h.parentHash] },
      );
    }
    expect(LIST.calls.map((c) => ({ method: c.method, params: c.params }))).toEqual(expected);
    expect(Object.keys(LIST).sort()).toEqual(["calls", "schema"]);
    for (const c of LIST.calls) expect(Object.keys(c).sort()).toEqual(["method", "params", "why"]);
  });

  it("HOLDS: the gateway's record key is the key the second recording asked at call 50 at the same block", () => {
    const second = JSON.parse(text("observatory/fixtures/recording-20261112004113-0b2b505d2d4b703b/requests.json")) as { calls: { method: string; params: unknown[] }[] };
    const g = settledOf(3479299);
    const id = (g.settled[0]?.fields as Record<string, unknown>).channel_id as string;
    expect(second.calls[50]).toMatchObject({ method: "state_getStorage", params: [channelKey(id), g.hash] });
  });

  it("HOLDS: the committed list's sha256 is the one of the list with the two whys of round 33 mended (the builder's was 51b9075b, before them)", () => {
    expect(createHash("sha256").update(LIST_TEXT).digest("hex")).toBe("9afba293ba8d1b2f4b2f35ee8b8fe54e7f215800b19a07b9a7a2d695b8ac8483");
  });
});
