// The fifth real recording (fixtures/recording-20261113182100-8769e8d2841bf49a), held to the run it
// recorded: the lab's devnet test of its encoder of 2026-11-13. Every value it is compared with comes
// from a committed file: the run time record (research/2026-11-12-encoder-devnet-test/results.json)
// and the files the lab signed and sent (run-2026-11-13/signed/). Offline: nothing here reads the
// network.
import { blake2b } from "@noble/hashes/blake2.js";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writtenValue } from "../src/feed.js";
import { judgeRecording } from "../src/recording.js";
import { runtimeOfBlock } from "../src/scale/block.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { REVIEWED } from "../src/scale/shape.js";
import { ENCODER_DIR, ENCODER_INPUTS_TEXT, ENCODER_RECORDING, ENCODER_REQUESTS_TEXT, ENCODER_RUN_TIME, encoderFixtureText, encoderRecordingFiles, recordedEncoder } from "./helpers/recorded-encoder.js";
import { MORTAL_IDS, STEP_IDS, deriveRequestsText } from "./helpers/requests/list-5.js";

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const repoText = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const R = recordedEncoder();
type Sent = { status: string; block_number: number; block_hash: string; extrinsic_index: number; events_sha256: string; events_length: number };
type Rec = Record<string, any>;
const RUN_TIME = JSON.parse(repoText(ENCODER_RUN_TIME)) as Rec;
const sentOf = (id: string) => ((RUN_TIME.steps as Rec[]).find((s) => s.step === id)?.run_time?.sent ?? null) as Sent | null;
const signedOf = (id: string) => JSON.parse(repoText(`${ENCODER_DIR}/run-2026-11-13/signed/${id}.json`)) as Rec;
const blockOf = (id: string) => R.blocks.find((b) => b.id === id) as (typeof R.blocks)[number];
const valueAt = (id: string, j: number) => {
  const b = blockOf(id);
  if (!b.answer.read) throw new Error(`the batch at ${id} was refused: ${b.answer.refused}`);
  return b.answer.values.get(b.keys[j] as string);
};

describe("the fifth real recording, as a fixture (B1)", () => {
  it("holds exactly the published files, the request list, its inputs and a meta.json, and each published file matches SHA256SUMS", () => {
    expect(readdirSync(new URL(`../fixtures/${ENCODER_RECORDING}/`, import.meta.url)).sort()).toEqual(["SHA256SUMS", "meta.json", "requests-inputs.json", "requests.json", "run.json", "tape.jsonl"]);
    expect(encoderFixtureText("SHA256SUMS")).toBe(`${sha256(encoderFixtureText("run.json"))}  run.json\n${sha256(encoderFixtureText("tape.jsonl"))}  tape.jsonl\n`);
  });

  it("is usable through judgeRecording with the request list it was made from, whose sha256 run.json names: 32 of 32 answered", () => {
    const run = JSON.parse(encoderFixtureText("run.json")) as Rec;
    expect(sha256(ENCODER_REQUESTS_TEXT)).toBe(run.request_list_sha256);
    const j = judgeRecording(encoderRecordingFiles(), ENCODER_REQUESTS_TEXT);
    expect(j.usable).toBe(true);
    if (!j.usable) return;
    expect(j.run.calls).toEqual({ asked: 32, answered: 32, failed: 0 });
    expect(j.calls.every((c) => "result" in c.answer)).toBe(true);
  });

  it("was made from the list derived from its frozen inputs and the 1014020 metadata, byte for byte (A2)", () => {
    expect(ENCODER_REQUESTS_TEXT).toBe(deriveRequestsText(R.inputs, parseMetadata(R.metadata)));
    const meta = JSON.parse(encoderFixtureText("meta.json")) as { provenance: Rec };
    expect(meta.provenance).toMatchObject({ request_inputs: "recordings/requests-inputs.json", request_inputs_copy: "requests-inputs.json", request_inputs_sha256: sha256(ENCODER_INPUTS_TEXT) });
  });

  it("has a meta.json in the written form that says where the files came from (A1)", () => {
    const meta = writtenValue("meta.json", encoderFixtureText("meta.json"));
    const m = (meta as { value: Rec }).value;
    const run = JSON.parse(encoderFixtureText("run.json")) as Rec;
    expect(m).toMatchObject({
      scenario: ENCODER_RECORDING,
      synthetic: false,
      provenance: {
        data_branch: "observatory-data",
        data_branch_commit: expect.stringMatching(/^210688b[0-9a-f]{33}$/),
        metadata: [],
        recording_id: ENCODER_RECORDING.replace("recording-", ""),
        request_list: "recordings/requests.json",
        request_list_copy: "requests.json",
        revision: run.source_sha,
        started_at: run.started_at,
        ended_at: run.ended_at,
        request_list_sha256: run.request_list_sha256,
        tape_sha256: sha256(encoderFixtureText("tape.jsonl")),
        workflow_run: expect.any(Number),
      },
    });
    const id = `${String(run.started_at).replace(/[^0-9]/g, "").slice(0, 14)}-${String(run.request_list_sha256).slice(0, 16)}`;
    expect(ENCODER_RECORDING).toBe(`recording-${id}`);
    expect(typeof m.provenance.data_branch_commit_from).toBe("string");
    expect(typeof m.provenance.workflow_run_from).toBe("string");
  });

  it("names the chain of the run time record: the genesis hash it answered is results.json chain.genesis", () => {
    expect(R.genesis).toBe(RUN_TIME.chain.genesis);
  });
});

describe("the recording held to the run time record and the signed files", () => {
  it("B2: the hash the tape gives for every block's height is the hash the run time record gives for it", () => {
    const start = blockOf("start");
    expect([start.height, start.answeredHash]).toEqual([RUN_TIME.start.finalized.number, RUN_TIME.start.finalized.hash]);
    for (const id of STEP_IDS) {
      const s = sentOf(id) as Sent;
      const b = blockOf(id);
      expect(s.status, id).toBe("finalized");
      expect([b.height, b.answeredHash], id).toEqual([s.block_number, s.block_hash]);
    }
    expect(R.blocks.map((b) => b.id)).toEqual(["start", ...STEP_IDS]);
  });

  it("B3: each step block holds, at the index the run time record gives, the signed extrinsic byte for byte, and its blake2b 256 is the record's extrinsic_hash", () => {
    for (const id of STEP_IDS) {
      const s = sentOf(id) as Sent;
      const signed = signedOf(id);
      const exts = blockOf(id).extrinsics as string[];
      expect(Array.isArray(exts), id).toBe(true);
      expect(exts[s.extrinsic_index], id).toBe(signed.extrinsic);
      expect(exts.filter((x) => x === signed.extrinsic), id).toHaveLength(1);
      const hash = `0x${Buffer.from(blake2b(Buffer.from(signed.extrinsic.slice(2), "hex"), { dkLen: 32 })).toString("hex")}`;
      const rt = (RUN_TIME.steps as Rec[]).find((x) => x.step === id)?.run_time;
      expect([hash, hash], id).toEqual([rt.extrinsic_hash, signed.extrinsic_hash]);
    }
  });

  it("B4: for T3 to T6 the hash at the era's birth height is the birth hash the signed file was signed with", () => {
    expect([...MORTAL_IDS]).toEqual(["T3", "T4", "T5", "T6"]);
    for (const id of MORTAL_IDS) {
      const era = signedOf(id).era as { birth_number: number; birth_hash: string };
      const birth = blockOf(id).birth;
      expect([birth?.height, birth?.answeredHash], id).toEqual([era.birth_number, era.birth_hash]);
    }
    for (const id of STEP_IDS.filter((x) => !(MORTAL_IDS as readonly string[]).includes(x))) {
      expect(signedOf(id).era, id).toBe("immortal");
      expect(blockOf(id).birth, id).toBeNull();
    }
  });

  it("B5: at each step block the sha256 and length of System.Events on the tape are the events_sha256 and events_length the runner relayed", () => {
    for (const id of STEP_IDS) {
      const s = sentOf(id) as Sent;
      expect(blockOf(id).reads[0], id).toMatchObject({ pallet: "System", entry: "Events" });
      const events = valueAt(id, 0) as Uint8Array;
      expect([sha256(events), events.length], id).toEqual([s.events_sha256, s.events_length]);
    }
  });

  it("B6: every block's System.LastRuntimeUpgrade names spec 1014020, a reviewed runtime", () => {
    expect(RUN_TIME.spec_version).toBe(1014020);
    expect(REVIEWED.some((x) => x.specVersion === RUN_TIME.spec_version)).toBe(true);
    for (const b of R.blocks) {
      expect(b.reads[1], b.id).toMatchObject({ pallet: "System", entry: "LastRuntimeUpgrade" });
      const rt = runtimeOfBlock(valueAt(b.id, 1) as Uint8Array);
      expect(rt.found && rt.reviewed.specVersion, b.id).toBe(RUN_TIME.spec_version);
    }
  });
});
