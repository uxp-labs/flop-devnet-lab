// The second real recording as a fixture (fixtures/recording-20261112004113-0b2b505d2d4b703b): the
// three files as the record workflow published them, the request list it was made from, the
// inputs that list was derived from, and its meta.json held to what run.json and the files say.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writtenValue } from "../src/feed.js";
import { judgeRecording } from "../src/recording.js";
import { toHex } from "../src/scale/reader.js";
import { INPUTS_TEXT, STORAGE_RECORDING, STORAGE_REQUESTS_TEXT, recordedStorage, storageFixtureText, storageRecordingFiles } from "./helpers/recorded-storage.js";
import { deriveRequestsText } from "./helpers/requests-derive.js";

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const R = recordedStorage();

describe("the second real recording, as a fixture", () => {
  it("holds exactly the published files, the request list, its inputs and a meta.json, and each published file matches SHA256SUMS", () => {
    expect(readdirSync(new URL(`../fixtures/${STORAGE_RECORDING}/`, import.meta.url)).sort()).toEqual(["SHA256SUMS", "meta.json", "requests-inputs.json", "requests.json", "run.json", "tape.jsonl"]);
    const sums = storageFixtureText("SHA256SUMS");
    expect(sums).toBe(`${sha256(storageFixtureText("run.json"))}  run.json\n${sha256(storageFixtureText("tape.jsonl"))}  tape.jsonl\n`);
  });

  it("is usable through judgeRecording with the request list it was made from, whose sha256 run.json names", () => {
    const run = JSON.parse(storageFixtureText("run.json")) as Record<string, unknown>;
    expect(sha256(STORAGE_REQUESTS_TEXT)).toBe("0b2b505d2d4b703b84d017f670e2c3bd10938af75ee3373dfae5fea23d6a1f58");
    expect(sha256(STORAGE_REQUESTS_TEXT)).toBe(run.request_list_sha256);
    const j = judgeRecording(storageRecordingFiles(), STORAGE_REQUESTS_TEXT);
    expect(j.usable).toBe(true);
    if (!j.usable) return;
    expect(j.run.calls).toEqual({ asked: 56, answered: 56, failed: 0 });
  });

  it("was made from the list derived from the inputs and the first recording's metadata, byte for byte", () => {
    expect(STORAGE_REQUESTS_TEXT).toBe(deriveRequestsText(R.inputs, R.md));
  });

  it("keeps the inputs that list was derived from, frozen beside it, by the sha256 meta.json names", () => {
    const meta = JSON.parse(storageFixtureText("meta.json")) as { provenance: Record<string, unknown> };
    expect(sha256(INPUTS_TEXT)).toBe("d239542a4f9fab5f6645a01f3f5851b50a177471d2a7999e7bbafc1dad211042");
    expect(meta.provenance).toMatchObject({ request_inputs: "recordings/requests-inputs.json", request_inputs_copy: "requests-inputs.json", request_inputs_sha256: sha256(INPUTS_TEXT) });
    expect(INPUTS_TEXT).toBe(storageFixtureText("requests-inputs.json"));
  });

  it("has a meta.json in the written form that says where the files came from", () => {
    const meta = writtenValue("meta.json", storageFixtureText("meta.json"));
    expect(typeof meta).toBe("object");
    const m = (meta as { value: Record<string, unknown> }).value;
    const run = JSON.parse(storageFixtureText("run.json")) as Record<string, unknown>;
    expect(m).toMatchObject({
      scenario: STORAGE_RECORDING,
      synthetic: false,
      provenance: {
        data_branch: "observatory-data",
        data_branch_commit: "a94073b6cf36e45b15fed216fd64f4bf60cf7cb0",
        metadata_sha256: sha256(R.metadata),
        recording_id: STORAGE_RECORDING.replace("recording-", ""),
        request_list: "recordings/requests.json",
        request_list_copy: "requests.json",
        revision: run.source_sha,
        started_at: run.started_at,
        ended_at: run.ended_at,
        request_list_sha256: run.request_list_sha256,
        tape_sha256: sha256(storageFixtureText("tape.jsonl")),
        workflow_run: 43129072484,
      },
    });
    const id = `${String(run.started_at).replace(/[^0-9]/g, "").slice(0, 14)}-${String(run.request_list_sha256).slice(0, 16)}`;
    expect(STORAGE_RECORDING).toBe(`recording-${id}`);
  });

  it("holds what the lead checked: the genesis, each block's hash as the inputs give it, spec 1014014, the reviewed metadata, and 28 reads of which one is absent", () => {
    expect(R.genesis).toBe("0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631");
    for (const [name, b] of Object.entries(R.inputs.blocks)) {
      const i = R.calls.findIndex((c) => c.method === "chain_getBlockHash" && c.params[0] === b.height.value);
      expect([name, R.calls.at(i)?.answer]).toEqual([name, { result: b.hash.value }]);
      expect(toHex(R.lastRuntimeUpgrade.get(name as never) ?? new Uint8Array()), name).toBe("0xfae33d0030747a6b762d72756e74696d65");
    }
    expect(R.lastRuntimeUpgrade.size).toBe(12);
    expect(R.runtimeVersion).toMatchObject({ specName: "tzkv-runtime", specVersion: 1014014 });
    expect(R.metadata.length).toBe(482132);
    expect(sha256(R.metadata)).toBe("f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444");
    expect(R.reads.length).toBe(28);
    expect(R.reads.filter((r) => r.answer === null).map((r) => [r.height, r.read.entry])).toEqual([[3497567, "Channels"]]);
  });
});
