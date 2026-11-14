// The sixth real recording (fixtures/recording-20261114071524-9afba293ba8d1b2f), held to itself and
// to the earlier recordings: the two blocks of the first recording where a compute channel settled,
// the gateway's (its settled block and that block's parent) and the other channel's. Every value it
// is compared with comes from a committed file: the first recording's tape, the second recording's
// call 50, the reviewed shape file of the runtime that executed each block, and the frozen list and
// inputs in the fixture's folder. The observatory decodes no extrinsic (piece R, decision R-6): the
// settle call is found here by its pallet and call index followed by the channel id, and its
// arguments are read in imd-flop/test/channel-receipt-vector.test.ts. Offline: nothing here reads
// the network.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writtenValue } from "../src/feed.js";
import { type RecordedCall, judgeRecording } from "../src/recording.js";
import { decodeBlockEvents, decodeStorageValue, runtimeOfBlock } from "../src/scale/block.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { type BatchAnswer, readBatchAnswer } from "./helpers/batch-answer.js";
import { hexBytes, recorded } from "./helpers/recorded.js";
import { recordedStorage } from "./helpers/recorded-storage.js";
import { reviewedMetadata } from "./helpers/recorded-upgrade.js";
import { CHANNELS, type Channel, type DerivedCall, RUNTIME, deriveCalls, deriveRequestsText, parentOf, parentReads, readInputs, settledOf, settledReads } from "./helpers/requests/list-6.js";
import { tapeAnswer } from "./helpers/requests-list.js";

const SETTLE_RECORDING = "recording-20261114071524-9afba293ba8d1b2f";
const FIXTURE = new URL(`../fixtures/${SETTLE_RECORDING}/`, import.meta.url);
const fixtureText = (name: string) => readFileSync(new URL(name, FIXTURE), "utf8");
/** The request list the recording was made from, and the inputs it was derived from: the fixture's own copies. */
const REQUESTS_TEXT = fixtureText("requests.json");
const INPUTS_TEXT = fixtureText("requests-inputs.json");
const recordingFiles = (): Record<string, string> => ({ "run.json": fixtureText("run.json"), "tape.jsonl": fixtureText("tape.jsonl"), SHA256SUMS: fixtureText("SHA256SUMS") });
const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const toHex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
type Rec = Record<string, any>;

/** The runtime the list's keys were built for: the one its plan names (RUNTIME, a read of the first tape), through runtimeOfBlock. */
const NAMED = runtimeOfBlock(hexBytes(String(tapeAnswer(RUNTIME.file, RUNTIME.field))));
if (!NAMED.found) throw new Error(NAMED.refused);
const METADATA = reviewedMetadata(NAMED.reviewed.specVersion);
const INPUTS = readInputs(INPUTS_TEXT);
const DERIVED: DerivedCall[] = deriveCalls(INPUTS, parseMetadata(METADATA));
/** The first recording, judged usable, laid out by block; and the second, by call. */
const FIRST = recorded();
const SECOND = recordedStorage();

/** The recording judged usable, each call held to the derived call it answers. */
function judged() {
  const j = judgeRecording(recordingFiles(), REQUESTS_TEXT);
  if (!j.usable) throw new Error(`the recording is not usable: ${j.refused.join("; ")}`);
  if (j.calls.length !== DERIVED.length) throw new Error("the recording does not hold the derived list's calls");
  DERIVED.forEach((d, seq) => {
    const c = j.calls.at(seq) as RecordedCall;
    if (c.method !== d.call.method || JSON.stringify(c.params) !== JSON.stringify(d.call.params)) throw new Error(`call ${seq} is not the derived call`);
  });
  return j;
}
const J = judged();
const resultAt = (block: string, method: string): unknown => {
  const seqs = DERIVED.flatMap((d, seq) => (d.block === block && d.call.method === method ? [seq] : []));
  if (seqs.length !== 1) throw new Error(`${seqs.length} calls of ${method} at ${block}`);
  const c = J.calls.at(seqs[0] as number) as RecordedCall;
  if (!("result" in c.answer)) throw new Error(`no answer to ${method} at ${block}`);
  return c.answer.result;
};
/** One batch at a block: the keys asked, in the plan's order, and the answer read by readBatchAnswer. */
const batchAt = (block: string) => {
  const d = DERIVED.find((x) => x.block === block && x.call.method === "state_queryStorageAt") as DerivedCall;
  const keys = (d.call.params as [string[], string])[0];
  const answer: BatchAnswer = readBatchAnswer(resultAt(block, "state_queryStorageAt"), keys, INPUTS.blocks[block as keyof typeof INPUTS.blocks].hash.value);
  if (!answer.read) throw new Error(answer.refused);
  return { reads: d.reads ?? [], keys, values: answer.values };
};
/** The bytes a batch answered for the read of an entry. */
const valueOf = (block: string, entry: string): Uint8Array | null => {
  const b = batchAt(block);
  const j = b.reads.findIndex((r) => r.entry === entry);
  if (j < 0) throw new Error(`the batch at ${block} reads no ${entry}`);
  return b.values.get(b.keys[j] as string) ?? null;
};
const bytesOf = (block: string, entry: string): Uint8Array => {
  const v = valueOf(block, entry);
  if (v === null) throw new Error(`${entry} at ${block} holds nothing`);
  return v;
};
const firstBlock = (height: number) => {
  const b = FIRST.blocks.find((x) => x.number === height);
  if (b === undefined) throw new Error(`the first recording holds no block ${height}`);
  return b;
};
const blockBody = (c: Channel) => resultAt(settledOf(c), "chain_getBlock") as { block: { header: Rec; extrinsics: string[] } };

/** The pin input of a block of this recording: the reviewed runtime its own LastRuntimeUpgrade names, the reviewed metadata and the shape file. */
function pinOf(block: string) {
  const lastRuntimeUpgrade = bytesOf(block, "LastRuntimeUpgrade");
  const r = runtimeOfBlock(lastRuntimeUpgrade);
  if (!r.found) throw new Error(r.refused);
  return {
    specName: r.reviewed.specName,
    specVersion: r.reviewed.specVersion,
    metadata: reviewedMetadata(r.reviewed.specVersion),
    lastRuntimeUpgrade,
    shapeText: readFileSync(new URL(`../${r.reviewed.shapeFile}`, import.meta.url), "utf8"),
  };
}
/** The channel's ComputeChannel.Channels record at a block, through the decoder's door. */
function recordAt(c: Channel, block: string): Rec {
  const b = batchAt(block);
  const j = b.reads.findIndex((r) => r.entry === "Channels");
  const v = decodeStorageValue({ ...pinOf(block), pallet: "ComputeChannel", entry: "Channels", keys: [hexBytes(INPUTS.channels[c].value)], key: hexBytes(b.keys[j] as string), answer: valueOf(block, "Channels") });
  if (!v.decoded) throw new Error(v.refused);
  expect(v.stored).toBe(true);
  return v.value as Rec;
}
/** The ComputeChannel events of a settled block, through the decoder's door. */
function channelEventsAt(c: Channel) {
  const d = decodeBlockEvents({ ...pinOf(settledOf(c)), events: bytesOf(settledOf(c), "Events") });
  if (!d.decoded) throw new Error(d.refused);
  return d.events.filter((e) => e.pallet === "ComputeChannel");
}
/** The reviewed shape file of the runtime a block's LastRuntimeUpgrade names. */
const shapeOf = (block: string) => JSON.parse(pinOf(block).shapeText) as Rec;
/** The pallet index and the call index of ComputeChannel.settle, both read from a shape file's types. */
function settleIndexOf(shape: Rec): [number, number] {
  const types = shape.types as Record<string, Rec>;
  const outer = Object.entries(types).filter(([, t]) => t.kind === "variant" && Array.isArray(t.path) && t.path.at(-1) === "RuntimeCall");
  if (outer.length !== 1) throw new Error(`${outer.length} RuntimeCall types in the shape`);
  const pallet = ((outer[0] as [string, Rec])[1].variants as Rec[]).find((v) => v.name === "ComputeChannel") as Rec;
  const call = ((types[pallet.fields[0].type] as Rec).variants as Rec[]).find((v) => v.name === "settle") as Rec;
  return [pallet.index, call.index];
}

describe("the sixth real recording, as a fixture (A1 to A3)", () => {
  it("holds exactly the published files, the request list, its inputs and a meta.json, and each published file matches SHA256SUMS", () => {
    expect(readdirSync(FIXTURE).sort()).toEqual(["SHA256SUMS", "meta.json", "requests-inputs.json", "requests.json", "run.json", "tape.jsonl"]);
    expect(fixtureText("SHA256SUMS")).toBe(`${sha256(fixtureText("run.json"))}  run.json\n${sha256(fixtureText("tape.jsonl"))}  tape.jsonl\n`);
  });

  it("is usable through judgeRecording with the request list it was made from, whose sha256 run.json names: 12 of 12 answered", () => {
    const run = JSON.parse(fixtureText("run.json")) as Rec;
    expect(sha256(REQUESTS_TEXT)).toBe(run.request_list_sha256);
    expect(J.run.calls).toEqual({ asked: 12, answered: 12, failed: 0 });
    expect(J.calls).toHaveLength(12);
    expect(J.calls.every((c) => "result" in c.answer)).toBe(true);
  });

  it("was made from the list derived from its frozen inputs and the metadata of the runtime the plan names, byte for byte", () => {
    expect(REQUESTS_TEXT).toBe(deriveRequestsText(INPUTS, parseMetadata(METADATA)));
    const meta = JSON.parse(fixtureText("meta.json")) as { provenance: Rec };
    expect(meta.provenance).toMatchObject({ request_inputs: "recordings/requests-inputs.json", request_inputs_copy: "requests-inputs.json", request_inputs_sha256: sha256(INPUTS_TEXT) });
  });

  it("has a meta.json in the written form that says where the files came from, and its id is made from started_at and the list's sha256", () => {
    const meta = writtenValue("meta.json", fixtureText("meta.json"));
    const m = (meta as { value: Rec }).value;
    const run = JSON.parse(fixtureText("run.json")) as Rec;
    expect(m).toMatchObject({
      scenario: SETTLE_RECORDING,
      synthetic: false,
      provenance: {
        data_branch: "observatory-data",
        data_branch_commit: expect.stringMatching(/^e18a5e6[0-9a-f]{33}$/),
        metadata: [],
        recording_id: SETTLE_RECORDING.replace("recording-", ""),
        request_list: "recordings/requests.json",
        request_list_copy: "requests.json",
        revision: run.source_sha,
        revision_from: "run.json source_sha",
        started_at: run.started_at,
        ended_at: run.ended_at,
        request_list_sha256: run.request_list_sha256,
        tape_sha256: sha256(fixtureText("tape.jsonl")),
        workflow_run: expect.any(Number),
      },
    });
    const id = `${String(run.started_at).replace(/[^0-9]/g, "").slice(0, 14)}-${String(run.request_list_sha256).slice(0, 16)}`;
    expect(SETTLE_RECORDING).toBe(`recording-${id}`);
    for (const k of ["data_branch_commit_from", "workflow_run_from", "request_inputs_sha256_from"]) expect(typeof m.provenance[k], k).toBe("string");
  });

  it("names the chain of the first recording: the genesis hash it answered is the first recording's", () => {
    expect([J.calls.at(1)?.method, J.calls.at(1)?.params]).toEqual(["chain_getBlockHash", [0]]);
    expect(J.calls.at(1)?.answer).toEqual({ result: FIRST.genesis });
  });
});

describe("the recording held to the earlier recordings and to itself (A4)", () => {
  it("reads both channels of the plan, the gateway's and the other one", () => {
    expect(CHANNELS).toEqual(["gateway", "second"]);
    expect(settledReads("gateway").map((r) => r.entry)).toEqual(["Events", "LastRuntimeUpgrade", "Channels"]);
    expect(parentReads("gateway").map((r) => r.entry)).toEqual(["LastRuntimeUpgrade", "Channels"]);
  });

  for (const c of CHANNELS) {
    const s = INPUTS.blocks[settledOf(c)];
    const p = INPUTS.blocks[parentOf(c)];
    describe(`the ${c} channel's settle`, () => {
      it("the hash the node answered at the settled height is the hash the first recording's tape holds for it", () => {
        expect(resultAt(settledOf(c), "chain_getBlockHash")).toBe(firstBlock(s.height.value).hash);
        expect(firstBlock(s.height.value).hash).toBe(s.hash.value);
      });

      it("System.Events and System.LastRuntimeUpgrade at the block are byte equal to the first recording's reads at that block", () => {
        const first = firstBlock(s.height.value);
        expect(toHex(bytesOf(settledOf(c), "Events"))).toBe(toHex(first.events));
        expect(toHex(bytesOf(settledOf(c), "LastRuntimeUpgrade"))).toBe(toHex(first.lastRuntimeUpgrade));
      });

      if (c === "gateway") {
        it("the channel's ComputeChannel.Channels record at the block is byte equal to the second recording's call 50, under the same key", () => {
          const call = SECOND.calls.at(50) as RecordedCall;
          const b = batchAt(settledOf(c));
          expect(call.method).toBe("state_getStorage");
          expect(call.params).toEqual([b.keys.at(-1), s.hash.value]);
          expect("result" in call.answer && call.answer.result).toBe(toHex(bytesOf(settledOf(c), "Channels")));
        });
      }

      it("System.LastRuntimeUpgrade at the block and at its parent names the reviewed spec of the first recording, through runtimeOfBlock", () => {
        const spec = Number(FIRST.runtimeVersion.specVersion);
        for (const b of [settledOf(c), parentOf(c)]) {
          const r = runtimeOfBlock(bytesOf(b, "LastRuntimeUpgrade"));
          expect(r.found, b).toBe(true);
          if (!r.found) continue;
          expect([r.reviewed.specName, r.reviewed.specVersion, r.reviewed.metadataSha256], b).toEqual([FIRST.runtimeVersion.specName, spec, sha256(FIRST.metadata)]);
        }
      });

      it("R-4: the hash at the parent's height is the parentHash of the first recording's header of the block and of the header this recording holds, whose number is the block's height", () => {
        const answered = resultAt(parentOf(c), "chain_getBlockHash");
        const header = blockBody(c).block.header;
        expect(answered).toBe(firstBlock(s.height.value).header.parentHash);
        expect(answered).toBe(header.parentHash);
        expect(answered).toBe(p.hash.value);
        expect(Number.parseInt(String(header.number), 16)).toBe(s.height.value);
        expect(String(header.number)).toBe(firstBlock(s.height.value).header.number);
      });

      it("the block's events, through the decoder's door, hold exactly one ComputeChannel.Settled, and it names the channel of the inputs", () => {
        const settled = channelEventsAt(c).filter((e) => e.event === "Settled");
        expect(settled).toHaveLength(1);
        expect((settled[0]?.fields as Rec).channel_id).toBe(INPUTS.channels[c].value);
      });

      it("exactly one extrinsic of the block holds the settle call of the channel: the pallet and call index of ComputeChannel.settle from the reviewed shape, then the channel id, found once in the block", () => {
        const shape = shapeOf(settledOf(c));
        const [pallet, call] = settleIndexOf(shape);
        expect(pallet).toBe(shape.compute_channel.index);
        const head = `${toHex(Uint8Array.of(pallet, call)).slice(2)}${INPUTS.channels[c].value.slice(2)}`;
        const exts = blockBody(c).block.extrinsics;
        const count = (x: string) => x.slice(2).split(head).length - 1;
        expect(exts.filter((x) => count(x) > 0)).toHaveLength(1);
        expect(exts.reduce((n, x) => n + count(x), 0)).toBe(1);
        // Found at a byte boundary: the hex search could otherwise match across a nibble.
        const x = exts.find((y) => count(y) > 0) as string;
        expect(x.slice(2).indexOf(head) % 2).toBe(0);
      });

      it("the channel's record at the parent and at the block, through the door: the same record but its state, Open before and Closed at the block; the escrow, the agent key and the enclave key unchanged; the escrow is the event's miner_paid, burned and audit fee together", () => {
        const before = recordAt(c, parentOf(c));
        const after = recordAt(c, settledOf(c));
        const states = (shapeOf(settledOf(c)).compute_channel.channel_states as Rec[]).map((x) => x.name);
        expect([states.includes(before.state.variant), states.includes(after.state.variant)]).toEqual([true, true]);
        expect([before.state.variant, after.state.variant]).toEqual(["Open", "Closed"]);
        const differ = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
        expect(differ).toEqual(["state"]);
        expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
        expect([after.escrow, after.agent_key, after.enclave_key]).toEqual([before.escrow, before.agent_key, before.enclave_key]);
        const events = channelEventsAt(c);
        const settled = events.find((e) => e.event === "Settled")?.fields as Rec;
        const fees = events.filter((e) => e.event === "AuditFeeEarmarked" && (e.fields as Rec).channel_id === INPUTS.channels[c].value);
        expect(fees).toHaveLength(1);
        expect(settled.cooperative).toBe(true);
        expect(BigInt(settled.miner_paid) + BigInt(settled.burned) + BigInt((fees[0]?.fields as Rec).amount)).toBe(BigInt(before.escrow));
        expect(BigInt(settled.miner_paid)).not.toBe(BigInt(before.escrow));
      });
    });
  }
});
