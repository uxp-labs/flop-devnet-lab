// The sixth request list, recordings/requests.json: the two blocks of the first recording where a
// compute channel settled, the gateway's (3479299) and another (3479277). It is derived
// (test/helpers/requests/list-6.ts) from recordings/requests-inputs.json and the reviewed metadata
// of the runtime the plan names through a recorded System.LastRuntimeUpgrade, and nothing in it is
// typed by hand. These tests hold the list to that function byte for byte, hold its order, derive
// every storage key a second way with the reference decoder, hold the gateway's record key to the key
// the second recording asked, and hold every input to the first recording's tape: the channel ids
// through the decoder's door, the heights and hashes through the calls the fields name. Nothing here
// reads the network.
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { feedText } from "../src/feed.js";
import { READ_ONLY_RPC_METHODS, guardRpc } from "../src/guard.js";
import { MAX_CALLS, readRequests } from "../src/requests.js";
import { decodeBlockEvents, runtimeOfBlock } from "../src/scale/block.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { REVIEWED } from "../src/scale/shape.js";
import { ENCODER_INPUTS_TEXT } from "./helpers/recorded-encoder.js";
import { EVENTS_KEY, LAST_RUNTIME_UPGRADE_KEY, hexBytes, recorded } from "./helpers/recorded.js";
import { STORAGE_REQUESTS_TEXT, STORAGE_RECORDING } from "./helpers/recorded-storage.js";
import { readInputs as readList5Inputs } from "./helpers/requests/list-5.js";
import { BLOCKS, CHANNELS, type Channel, type Inputs, RUNTIME, type Read, TAPE, deriveCalls, deriveRequestsText, parentOf, parentReads, readInputs, settledOf, settledReads } from "./helpers/requests/list-6.js";
import { LIST_RUNTIME, listMetadata, requestsListText, specNamed, tapeAnswer } from "./helpers/requests-list.js";

const REPO = new URL("../../", import.meta.url);
const repoText = (path: string) => readFileSync(new URL(path, REPO), "utf8");
const LIST_TEXT = repoText("observatory/recordings/requests.json");
const INPUTS_TEXT = repoText("observatory/recordings/requests-inputs.json");
const INPUTS: Inputs = readInputs(INPUTS_TEXT);
const META = listMetadata();
const MD = parseMetadata(META);
const DERIVED = deriveCalls(INPUTS, MD);
const BUILDER = getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(META))));
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
/** The first recording, judged usable, and its tape line by line. */
const R = recorded();
const TAPE_LINES = repoText(TAPE).split("\n");
const entryAt = (seq: number) => JSON.parse(TAPE_LINES[seq + 1] ?? "null") as { seq: number; request: { method: string; params: unknown[] }; answer: { result: unknown } };
const SHAPE_FILE = (spec: number) => REVIEWED.find((r) => r.specVersion === spec)?.shapeFile ?? "";
const label = (r: Read) => `${r.pallet}.${r.entry}(${r.keys.map((k) => ("account" in k ? k.account : k.channel)).join(",")})`;
const batches = DERIVED.filter((d) => d.call.method === "state_queryStorageAt");
/** The seq on the first tape of the chain_getBlockHash call at a height. */
const hashSeq = (height: number) => R.calls.findIndex((c) => c.method === "chain_getBlockHash" && c.params[0] === height);
/** The Settled events of a recorded block, read through the decoder's door, pinned by the block's own LastRuntimeUpgrade. */
function settledAt(height: number) {
  const b = R.blocks.find((x) => x.number === height);
  if (b === undefined) throw new Error(`the first recording holds no block ${height}`);
  const d = decodeBlockEvents({
    specName: String(R.runtimeVersion.specName),
    specVersion: Number(R.runtimeVersion.specVersion),
    metadata: R.metadata,
    lastRuntimeUpgrade: b.lastRuntimeUpgrade,
    shapeText: repoText(`observatory/${SHAPE_FILE(Number(R.runtimeVersion.specVersion))}`),
    events: b.events,
  });
  if (!d.decoded) throw new Error(d.refused);
  return d.events.filter((e) => e.pallet === "ComputeChannel" && e.event === "Settled");
}

describe("the sixth request list, recordings/requests.json", () => {
  const read = readRequests(new TextEncoder().encode(LIST_TEXT));
  const calls = typeof read === "string" ? [] : read.calls;

  it("is in the written form, holds 12 calls (at most MAX_CALLS), every method one the guard allows: the head, block hashes, blocks and batches", () => {
    expect(read).not.toBeTypeOf("string");
    expect(calls.length).toBe(12);
    expect(calls.length).toBeLessThanOrEqual(MAX_CALLS);
    for (const c of [...calls, ...DERIVED.map((d) => d.call)]) {
      expect(READ_ONLY_RPC_METHODS.has(c.method), c.method).toBe(true);
      expect(() => guardRpc(c.method), c.method).not.toThrow();
    }
    const by: Record<string, number> = {};
    for (const d of DERIVED) by[d.call.method] = (by[d.call.method] ?? 0) + 1;
    expect(by).toEqual({ chain_getFinalizedHead: 1, chain_getBlockHash: 5, chain_getBlock: 2, state_queryStorageAt: 4 });
  });

  it("is, byte for byte, the list derived from recordings/requests-inputs.json and the metadata of the runtime the plan names", () => {
    expect(LIST_TEXT).toBe(deriveRequestsText(INPUTS, MD));
    expect(calls).toEqual(DERIVED.map((d) => d.call));
  });

  it("is what the committed writer writes: scripts/write-requests.mjs writes requestsListText, the same derive function, and nothing of its own", () => {
    expect(requestsListText()).toBe(LIST_TEXT);
    const script = repoText("observatory/scripts/write-requests.mjs");
    expect(script).toContain('const { requestsListText } = await import("../test/helpers/requests-list.ts");');
    expect(script).toContain("writeFileSync(args[1], requestsListText());");
    for (const name of ["deriveCalls", "deriveRequestsText", "storageKey", "feedText", "PLAN", "plan("]) expect(script, name).not.toContain(name);
    expect(repoText("observatory/test/helpers/requests-list.ts")).toContain('from "./requests/list-6.js";');
  });

  it("asks the head, the genesis, then for the gateway and then the other channel: the hash at the settled height, the block, one batch at it, the hash at the parent's height, one batch at the parent", () => {
    expect(CHANNELS).toEqual(["gateway", "second"]);
    expect(BLOCKS).toEqual(["gateway/settled", "gateway/settled-parent", "second/settled", "second/settled-parent"]);
    const at = (c: Channel) => [INPUTS.blocks[settledOf(c)], INPUTS.blocks[parentOf(c)]] as const;
    expect(DERIVED.map((d) => [d.call.method, d.block, d.call.method === "state_queryStorageAt" ? (d.call.params as unknown[])[1] : d.call.params])).toEqual([
      ["chain_getFinalizedHead", null, []],
      ["chain_getBlockHash", null, [0]],
      ...CHANNELS.flatMap((c) => {
        const [s, p] = at(c);
        return [
          ["chain_getBlockHash", settledOf(c), [s.height.value]],
          ["chain_getBlock", settledOf(c), [s.hash.value]],
          ["state_queryStorageAt", settledOf(c), s.hash.value],
          ["chain_getBlockHash", parentOf(c), [p.height.value]],
          ["state_queryStorageAt", parentOf(c), p.hash.value],
        ];
      }),
    ]);
  });

  it("asks at a settled block System.Events, System.LastRuntimeUpgrade and the channel's record, and at its parent the last two, in that fixed order", () => {
    expect(batches.map((d) => [d.block, d.reads?.map(label)])).toEqual([
      ["gateway/settled", ["System.Events()", "System.LastRuntimeUpgrade()", "ComputeChannel.Channels(gateway)"]],
      ["gateway/settled-parent", ["System.LastRuntimeUpgrade()", "ComputeChannel.Channels(gateway)"]],
      ["second/settled", ["System.Events()", "System.LastRuntimeUpgrade()", "ComputeChannel.Channels(second)"]],
      ["second/settled-parent", ["System.LastRuntimeUpgrade()", "ComputeChannel.Channels(second)"]],
    ]);
    for (const c of CHANNELS) expect([settledReads(c).map(label), parentReads(c).map(label)]).toEqual([batches[CHANNELS.indexOf(c) * 2]?.reads?.map(label), batches[CHANNELS.indexOf(c) * 2 + 1]?.reads?.map(label)]);
    // The System keys are the ones the first recording asked.
    for (const d of batches) {
      const keys = (d.call.params as [string[], string])[0];
      expect(keys.slice(0, -1)).toEqual(d.reads?.length === 3 ? [EVENTS_KEY, LAST_RUNTIME_UPGRADE_KEY] : [LAST_RUNTIME_UPGRADE_KEY]);
    }
  });

  it("builds every key a second way with the reference decoder over the metadata the plan names", () => {
    let n = 0;
    for (const d of batches) {
      const keys = (d.call.params as [string[], string])[0];
      for (const [j, r] of (d.reads ?? []).entries()) {
        const args = r.keys.map((k) => ("channel" in k ? INPUTS.channels[k.channel].value : ""));
        expect(keys[j], `${d.block} ${label(r)}`).toBe(BUILDER.buildStorage(r.pallet, r.entry).keys.enc(...args));
        n++;
      }
    }
    expect(n).toBe(10);
  });

  it("asks the gateway's ComputeChannel.Channels key the second recording asked at call 50, and the other channel's under another key", () => {
    const second = (JSON.parse(STORAGE_REQUESTS_TEXT) as { calls: { method: string; params: unknown[] }[] }).calls[50];
    expect(STORAGE_RECORDING).toBe("recording-20261112004113-0b2b505d2d4b703b");
    expect(second?.method).toBe("state_getStorage");
    expect(second?.params[1]).toBe(INPUTS.blocks["gateway/settled"].hash.value);
    const recordKey = (d: (typeof batches)[number]) => (d.call.params as [string[], string])[0].at(-1);
    expect(recordKey(batches[0] as (typeof batches)[number])).toBe(second?.params[0]);
    expect(recordKey(batches[1] as (typeof batches)[number])).toBe(second?.params[0]);
    expect(recordKey(batches[2] as (typeof batches)[number])).not.toBe(second?.params[0]);
  });

  it("says why for each call in one plain line, naming the height, the hash it compares with, the channel and what the read is for", () => {
    for (const d of DERIVED) {
      expect(d.call.why, d.call.why).toMatch(/^[^\u0000-\u001f\u007f\s](?:[^\u0000-\u001f\u007f]*[^\u0000-\u001f\u007f\s])?$/);
      expect(d.call.why, d.call.why).not.toMatch(/[‒-―]| - /);
      if (d.block === null) continue;
      const c = d.block.split("/")[0] as Channel;
      const b = INPUTS.blocks[d.block];
      const s = INPUTS.blocks[settledOf(c)];
      expect(d.call.why).toContain(`${c === "gateway" ? "the gateway's channel" : "the other channel"} ${INPUTS.channels[c].value.slice(0, 10)}... settled, by the ComputeChannel.Settled event of the first recording`);
      expect(d.call.why).toContain(`${d.call.method === "chain_getBlockHash" ? "height" : "block"} ${b.height.value}`);
      if (d.call.method === "chain_getBlockHash") expect(d.call.why).toContain(`to compare with ${b.hash.value}`);
      if (d.call.method === "chain_getBlock") expect(d.call.why).toContain("so the recording holds the settle call's bytes as the block holds them");
      if (d.block === parentOf(c)) {
        if (d.call.method === "chain_getBlockHash") expect(d.call.why).toContain(`the parentHash of the header the first recording's tape holds for block ${s.height.value}`);
        else expect(d.call.why).toContain("read for the channel's record before the settle");
      }
      if (d.call.method === "state_queryStorageAt") expect(d.call.why).toContain("a key that holds nothing listed with null");
    }
  });
});

describe("the runtime the sixth list's keys are built for", () => {
  it("is named by a file and a field: the System.LastRuntimeUpgrade the first recording read at the gateway's settled block, through runtimeOfBlock", () => {
    expect(LIST_RUNTIME).toBe(RUNTIME);
    expect(RUNTIME).toEqual({ file: TAPE, field: "the answer to the state_getStorage call at seq 21" });
    expect(entryAt(21).request).toEqual({ kind: "rpc", method: "state_getStorage", params: [LAST_RUNTIME_UPGRADE_KEY, INPUTS.blocks["gateway/settled"].hash.value] });
    const named = runtimeOfBlock(hexBytes(String(tapeAnswer(RUNTIME.file, RUNTIME.field))));
    expect(named.found).toBe(true);
    expect(specNamed(RUNTIME)).toBe(named.found ? named.reviewed.specVersion : null);
  });

  it("is the spec the same read at the other settled block names, and that spec is on the reviewed list, its metadata the reviewed bytes", () => {
    const seq = hashSeq(INPUTS.blocks["second/settled"].height.value) + 3;
    expect(entryAt(seq).request).toEqual({ kind: "rpc", method: "state_getStorage", params: [LAST_RUNTIME_UPGRADE_KEY, INPUTS.blocks["second/settled"].hash.value] });
    const spec = specNamed(RUNTIME);
    expect(specNamed({ file: TAPE, field: `the answer to the state_getStorage call at seq ${seq}` })).toBe(spec);
    const line = REVIEWED.find((r) => r.specVersion === spec);
    expect(line).toBeDefined();
    expect([META.length, sha256(META)]).toEqual([line?.metadataBytes, line?.metadataSha256]);
  });

  it("refuses a field not of the one form, a seq whose call is another method, and bytes that name no reviewed runtime", () => {
    expect(() => tapeAnswer(TAPE, "the answer to the state_getStorage call at seq 21 ")).toThrow('a runtime is named by "the answer to the state_getStorage call at seq N"');
    expect(() => tapeAnswer(TAPE, "the answer to the chain_getBlockHash call at seq 18")).toThrow("a runtime is named by");
    expect(() => tapeAnswer(TAPE, "the answer to the state_getStorage call at seq 018")).toThrow("a runtime is named by");
    expect(() => tapeAnswer(TAPE, "the answer to the state_getStorage call at seq 20")).not.toThrow();
    expect(() => tapeAnswer(TAPE, "the answer to the state_getStorage call at seq 19")).toThrow(`${TAPE} holds no state_getStorage call at seq 19`);
    // seq 20 is System.Events: bytes, but no LastRuntimeUpgrade record.
    expect(() => specNamed({ file: TAPE, field: "the answer to the state_getStorage call at seq 20" })).toThrow("no reviewed runtime");
  });
});

describe("the inputs of the sixth list, recordings/requests-inputs.json", () => {
  it("is in the written form, and refuses a file that is not, that lacks a name or holds a wrong one, or a value of the wrong form; the fifth list's inputs are not the sixth's", () => {
    expect(() => readInputs(INPUTS_TEXT)).not.toThrow();
    expect(() => readInputs(JSON.stringify(JSON.parse(INPUTS_TEXT)))).toThrow("the inputs file is not in the written form");
    const edit = (f: (v: { channels: Record<string, unknown>; blocks: Record<string, unknown> }) => void) => {
      const v = JSON.parse(INPUTS_TEXT);
      f(v);
      return feedText(v);
    };
    expect(() => readInputs(edit((v) => delete v.channels.second))).toThrow("channels must hold exactly gateway, second");
    expect(() =>
      readInputs(
        edit((v) => {
          v.channels.other = v.channels.second;
          delete v.channels.second;
        }),
      ),
    ).toThrow("channels must hold exactly gateway, second");
    expect(() => readInputs(edit((v) => delete v.blocks["second/settled-parent"]))).toThrow("blocks must hold exactly gateway/settled, gateway/settled-parent, second/settled, second/settled-parent");
    expect(() => readInputs(edit((v) => ((v.channels.gateway as { value: string }).value = "0x9f81f65b")))).toThrow("channels.gateway has a value of the wrong form");
    expect(() => readInputs(edit((v) => (((v.blocks["gateway/settled-parent"] as { height: { value: unknown } }).height.value = "3479298"))))).toThrow("blocks.gateway/settled-parent.height has a value of the wrong form");
    expect(() => readList5Inputs(INPUTS_TEXT)).toThrow();
    expect(() => readInputs(ENCODER_INPUTS_TEXT)).toThrow();
  });

  it("names only the first recording's tape", () => {
    const files = [...Object.values(INPUTS.channels), ...Object.values(INPUTS.blocks).flatMap((b) => [b.height, b.hash])].map((s) => s.file);
    expect(files).toHaveLength(10);
    expect([...new Set(files)]).toEqual([TAPE]);
    expect(TAPE).toBe(`observatory/fixtures/${"recording-20261111160917-3c228907aa129a01"}/tape.jsonl`);
  });

  it("takes each channel from the one ComputeChannel.Settled event in System.Events of its settled block, read through the decoder's door", () => {
    for (const c of CHANNELS) {
      const s = INPUTS.blocks[settledOf(c)];
      const seq = hashSeq(s.height.value) + 2;
      expect(entryAt(seq).request).toEqual({ kind: "rpc", method: "state_getStorage", params: [EVENTS_KEY, s.hash.value] });
      expect(INPUTS.channels[c].field, c).toBe(`the channel_id of the one ComputeChannel.Settled event in System.Events at seq ${seq}`);
      const settled = settledAt(s.height.value);
      expect(settled.map((e) => (e.fields as Record<string, unknown>).channel_id), c).toEqual([INPUTS.channels[c].value]);
    }
    expect(INPUTS.channels.gateway.value).not.toBe(INPUTS.channels.second.value);
  });

  it("takes each settled block's height and hash from the chain_getBlockHash call its fields name", () => {
    for (const c of CHANNELS) {
      const s = INPUTS.blocks[settledOf(c)];
      const seq = hashSeq(s.height.value);
      expect(seq, c).toBeGreaterThan(1);
      expect([s.height.field, s.hash.field]).toEqual([`the params of the chain_getBlockHash call at seq ${seq}`, `the answer to the chain_getBlockHash call at seq ${seq}`]);
      expect(entryAt(seq)).toMatchObject({ seq, request: { method: "chain_getBlockHash", params: [s.height.value] }, answer: { result: s.hash.value } });
    }
    expect([INPUTS.blocks["gateway/settled"].height.field, INPUTS.blocks["second/settled"].height.field]).toEqual(["the params of the chain_getBlockHash call at seq 18", "the params of the chain_getBlockHash call at seq 10"]);
  });

  it("takes each parent's hash from the parentHash of its child's recorded header, and its height as that header's number less one", () => {
    for (const c of CHANNELS) {
      const s = INPUTS.blocks[settledOf(c)];
      const p = INPUTS.blocks[parentOf(c)];
      const seq = hashSeq(s.height.value) + 1;
      const header = entryAt(seq);
      expect(header.request).toEqual({ kind: "rpc", method: "chain_getHeader", params: [s.hash.value] });
      const h = header.answer.result as { number: string; parentHash: string };
      expect(p.hash.field).toBe(`the parentHash of the answer to the chain_getHeader call at seq ${seq}`);
      expect(p.height.field).toBe(`the number of the answer to the chain_getHeader call at seq ${seq}, less one`);
      expect(p.hash.value).toBe(h.parentHash);
      expect(Number.parseInt(h.number, 16)).toBe(s.height.value);
      expect(p.height.value).toBe(Number.parseInt(h.number, 16) - 1);
    }
  });

  it("changes the list when any one input changes, so the byte comparison bites on each", () => {
    const base = deriveRequestsText(INPUTS, MD);
    const all = [...Object.values(INPUTS.channels), ...Object.values(INPUTS.blocks).flatMap((b) => [b.height, b.hash])] as { value: string | number }[];
    for (const s of all) {
      const original = s.value;
      s.value = typeof original === "number" ? original + 1 : `${original.slice(0, -1)}${original.endsWith("0") ? "1" : "0"}`;
      try {
        expect(deriveRequestsText(INPUTS, MD)).not.toBe(base);
      } finally {
        s.value = original;
      }
    }
    expect(deriveRequestsText(INPUTS, MD)).toBe(base);
  });
});
