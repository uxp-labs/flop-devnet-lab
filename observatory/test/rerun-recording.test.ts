// The fourth real recording as a fixture (fixtures/recording-20261112132634-0a472f1b49f7b661): the
// three files as the record workflow published them, the request list and the inputs it was made
// from, its meta.json held to what run.json and the files say, and the recording held to the
// session rerun's own record (research/2026-11-12-session-rerun-1014020/results.json): every hash
// by height, the genesis, and the sha256 of every System.Events value, which the lead computed at
// run time, so two independent reads agree. Then the reader of a batch answer, which refuses and
// never guesses (review round 24, L4).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writtenValue } from "../src/feed.js";
import { judgeRecording } from "../src/recording.js";
import { runtimeOfBlock } from "../src/scale/block.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { readBatchAnswer } from "./helpers/batch-answer.js";
import { RERUN_INPUTS_TEXT, RERUN_RECORDING, RERUN_REQUESTS_TEXT, RERUN_RESULTS, recordedRerun, rerunFixtureText, rerunRecordingFiles } from "./helpers/recorded-rerun.js";
import { deriveRequestsText } from "./helpers/requests/list-4.js";

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const R = recordedRerun();
const RESULTS = JSON.parse(readFileSync(new URL(`../../${RERUN_RESULTS}`, import.meta.url), "utf8")) as {
  spec_version: number;
  chain: { genesis: string };
  steps: { step: string; finalized_in_block: number; block_hash: string; events_value_sha256: string }[];
};
const valueOf = (i: number, key: string | undefined) => {
  const a = R.blocks[i]?.answer;
  if (a === undefined || !a.read || key === undefined) throw new Error(`no read answer at step ${i}`);
  return a.values.get(key);
};

describe("the fourth real recording, as a fixture", () => {
  it("holds exactly the published files, the request list, its inputs and a meta.json, and each published file matches SHA256SUMS", () => {
    expect(readdirSync(new URL(`../fixtures/${RERUN_RECORDING}/`, import.meta.url)).sort()).toEqual(["SHA256SUMS", "meta.json", "requests-inputs.json", "requests.json", "run.json", "tape.jsonl"]);
    expect(rerunFixtureText("SHA256SUMS")).toBe(`${sha256(rerunFixtureText("run.json"))}  run.json\n${sha256(rerunFixtureText("tape.jsonl"))}  tape.jsonl\n`);
  });

  it("is usable through judgeRecording with the request list it was made from, whose sha256 run.json names: 48 of 48 answered", () => {
    const run = JSON.parse(rerunFixtureText("run.json")) as Record<string, unknown>;
    expect(sha256(RERUN_REQUESTS_TEXT)).toBe(run.request_list_sha256);
    const j = judgeRecording(rerunRecordingFiles(), RERUN_REQUESTS_TEXT);
    expect(j.usable).toBe(true);
    if (!j.usable) return;
    expect(j.run.calls).toEqual({ asked: 48, answered: 48, failed: 0 });
  });

  it("was made from the list derived from its frozen inputs and the 1014020 metadata, byte for byte, and both copies are what recordings/ holds", () => {
    expect(RERUN_REQUESTS_TEXT).toBe(deriveRequestsText(R.inputs, parseMetadata(R.metadata)));
    expect(RERUN_REQUESTS_TEXT).toBe(readFileSync(new URL("../recordings/requests.json", import.meta.url), "utf8"));
    expect(RERUN_INPUTS_TEXT).toBe(readFileSync(new URL("../recordings/requests-inputs.json", import.meta.url), "utf8"));
    const meta = JSON.parse(rerunFixtureText("meta.json")) as { provenance: Record<string, unknown> };
    expect(meta.provenance).toMatchObject({ request_inputs: "recordings/requests-inputs.json", request_inputs_copy: "requests-inputs.json", request_inputs_sha256: sha256(RERUN_INPUTS_TEXT) });
    // READ: run.json names no sha256 of the inputs; meta.json says where its value came from, and the copy is held to it.
    expect(typeof meta.provenance.request_inputs_sha256_from).toBe("string");
  });

  it("has a meta.json in the written form that says where the files came from", () => {
    const meta = writtenValue("meta.json", rerunFixtureText("meta.json"));
    expect(typeof meta).toBe("object");
    const m = (meta as { value: Record<string, unknown> }).value;
    const run = JSON.parse(rerunFixtureText("run.json")) as Record<string, unknown>;
    expect(m).toMatchObject({
      scenario: RERUN_RECORDING,
      synthetic: false,
      provenance: {
        data_branch: "observatory-data",
        data_branch_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        metadata: [],
        recording_id: RERUN_RECORDING.replace("recording-", ""),
        request_list: "recordings/requests.json",
        request_list_copy: "requests.json",
        revision: run.source_sha,
        started_at: run.started_at,
        ended_at: run.ended_at,
        request_list_sha256: run.request_list_sha256,
        tape_sha256: sha256(rerunFixtureText("tape.jsonl")),
        workflow_run: expect.any(Number),
      },
    });
    const id = `${String(run.started_at).replace(/[^0-9]/g, "").slice(0, 14)}-${String(run.request_list_sha256).slice(0, 16)}`;
    expect(RERUN_RECORDING).toBe(`recording-${id}`);
    // READ: the data branch commit and the workflow run are in no file of this repository; meta.json
    // gives each with where it came from.
    const p = m.provenance as Record<string, unknown>;
    expect([typeof p.data_branch_commit_from, typeof p.workflow_run_from]).toEqual(["string", "string"]);
    expect(Number.isSafeInteger(p.workflow_run) && (p.workflow_run as number) > 0).toBe(true);
  });
});

describe("the fourth recording held to the session rerun's own record", () => {
  it("names the genesis results.json names, and answers for each step's height the hash results.json gives", () => {
    expect(R.genesis).toBe(RESULTS.chain.genesis);
    expect(R.blocks.map((b) => [b.step.id, b.height, b.answeredHash])).toEqual(RESULTS.steps.map((s) => [s.step, s.finalized_in_block, s.block_hash]));
  });

  it("reads every batch answer: one set at the hash asked, every key asked once", () => {
    for (const b of R.blocks) expect(b.answer, b.step.id).toMatchObject({ read: true });
    expect(R.blocks.reduce((n, b) => n + b.keys.length, 0)).toBe(72);
  });

  it("holds at every block a System.Events value whose sha256 is the events_value_sha256 the lead computed at run time", () => {
    for (const [i, s] of RESULTS.steps.entries()) {
      const events = valueOf(i, R.blocks[i]?.keys[0]);
      expect(events, s.step).toBeInstanceOf(Uint8Array);
      expect(sha256(events as Uint8Array), s.step).toBe(s.events_value_sha256);
    }
  });

  it("holds at every block a System.LastRuntimeUpgrade that names the reviewed runtime of the spec results.json names, through the decoder's door", () => {
    for (const [i, s] of RESULTS.steps.entries()) {
      const lru = valueOf(i, R.blocks[i]?.keys[1]);
      expect(lru, s.step).toBeInstanceOf(Uint8Array);
      const rt = runtimeOfBlock(lru as Uint8Array);
      expect(rt.found && rt.reviewed.specVersion, s.step).toBe(RESULTS.spec_version);
    }
  });
});

describe("the reader of a batch answer refuses, never guesses (review round 24, L4)", () => {
  const H = `0x${"ab".repeat(32)}`;
  const K = ["0x01", "0x02"];
  const good = () => [{ block: H, changes: [["0x01", "0xff"], ["0x02", null]] }];

  it("reads an answer of exactly one set at the block asked, every key once, a null as a key that holds nothing, in any order", () => {
    const a = readBatchAnswer(good(), K, H);
    expect(a.read && [...a.values.entries()]).toEqual([["0x01", new Uint8Array([0xff])], ["0x02", null]]);
    const swapped = readBatchAnswer([{ block: H, changes: [["0x02", null], ["0x01", "0xff"]] }], K, H);
    expect(swapped.read && swapped.values.get("0x01")).toEqual(new Uint8Array([0xff]));
  });

  it.each([
    ["not a list", { block: H, changes: [] }, "the answer is not a list of sets"],
    ["no set", [], "the answer holds 0 sets, not exactly one"],
    ["two sets", [...good(), ...good()], "the answer holds 2 sets, not exactly one"],
    ["a set with another field", [{ ...good()[0], extra: 1 }], "the set must hold exactly block and changes"],
    ["another block", [{ block: `0x${"cd".repeat(32)}`, changes: good()[0]?.changes }], "not the block asked"],
    ["changes not a list", [{ block: H, changes: {} }], "the changes are not a list"],
    ["a change that is not a pair", [{ block: H, changes: [["0x01"], ["0x02", null]] }], "change 0 is not a pair of a key and a value"],
    ["a key not asked", [{ block: H, changes: [["0x01", "0xff"], ["0x02", null], ["0x03", null]] }], "change 2 lists a key not asked"],
    ["a key twice", [{ block: H, changes: [["0x01", "0xff"], ["0x01", "0xff"], ["0x02", null]] }], "change 1 lists the key 0x01 twice"],
    ["a key asked missing", [{ block: H, changes: [["0x01", "0xff"]] }], "the answer lacks the key asked 0x02"],
    ["a value not hex", [{ block: H, changes: [["0x01", "ff"], ["0x02", null]] }], "change 0 has a value that is neither 0x hex nor null"],
    ["a value of half a byte", [{ block: H, changes: [["0x01", "0xf"], ["0x02", null]] }], "change 0 has a value that is neither 0x hex nor null"],
  ])("refuses %s, and gives no value at all", (_, answer, why) => {
    const a = readBatchAnswer(answer, K, H);
    expect(a.read).toBe(false);
    expect(!a.read && a.refused).toContain(why);
    expect("values" in a).toBe(false);
  });

  it("refuses keys asked that hold one twice", () => {
    expect(readBatchAnswer(good(), ["0x01", "0x01"], H)).toEqual({ read: false, refused: `the batch at ${H} is refused: the keys asked hold one twice` });
  });
});
