// The first real recording as a fixture (fixtures/recording-20261111160917-3c228907aa129a01): the
// three files as the record workflow published them, read through judgeRecording with the request
// list they were made from, and its meta.json held to what run.json and the files say.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { writtenValue } from "../src/feed.js";
import { judgeRecording } from "../src/recording.js";
import { RECORDING, REQUESTS_TEXT, fixtureText, recorded, recordingFiles } from "./helpers/recorded.js";

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const BLOCKS = [3479238, 3479245, 3479277, 3479291, 3479299, 3479303, 3479311, 3479313, 3479317, 3479323, 3479328, 3479329];
const EVENTS_BYTES = [2226, 550, 624, 484, 1119, 538, 535, 579, 535, 749, 784, 1089];

describe("the first real recording, as a fixture", () => {
  it("is usable through judgeRecording with the request list it names", () => {
    expect(sha256(REQUESTS_TEXT)).toBe("3c228907aa129a0190e3df130b7c6bb3efc99783a32be1b16137a86e827d6c20");
    const j = judgeRecording(recordingFiles(), REQUESTS_TEXT);
    expect(j.usable).toBe(true);
    if (!j.usable) return;
    expect(j.run.calls).toEqual({ asked: 52, answered: 52, failed: 0 });
    expect(j.calls.every((c) => "result" in c.answer && typeof c.why === "string")).toBe(true);
  });

  it("holds exactly the published files and a meta.json in the written form that says where they came from", () => {
    const meta = writtenValue("meta.json", fixtureText("meta.json"));
    expect(typeof meta).toBe("object");
    const m = (meta as { value: Record<string, unknown> }).value;
    const run = JSON.parse(fixtureText("run.json")) as Record<string, unknown>;
    expect(m).toMatchObject({
      scenario: RECORDING,
      synthetic: false,
      provenance: {
        data_branch: "observatory-data",
        data_branch_commit: "9d165dd175557f257cf27954571f5c786494bc06",
        recording_id: RECORDING.replace("recording-", ""),
        revision: run.source_sha,
        started_at: run.started_at,
        ended_at: run.ended_at,
        request_list_sha256: run.request_list_sha256,
        tape_sha256: sha256(fixtureText("tape.jsonl")),
      },
    });
    // The id is the start time read digit by digit and the first 16 hex of the list's sha256.
    const id = `${String(run.started_at).replace(/[^0-9]/g, "").slice(0, 14)}-${String(run.request_list_sha256).slice(0, 16)}`;
    expect(RECORDING).toBe(`recording-${id}`);
  });

  it("holds what the lead checked: the head, the genesis, twelve blocks of events at spec 1014014, and the metadata", () => {
    const r = recorded();
    expect(r.genesis).toBe("0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631");
    expect(r.blocks.map((b) => b.number)).toEqual(BLOCKS);
    expect(r.blocks.map((b) => b.events.length)).toEqual(EVENTS_BYTES);
    for (const b of r.blocks) {
      expect(b.header.number, `header of ${b.number}`).toBe(`0x${b.number.toString(16)}`);
      expect(Buffer.from(b.lastRuntimeUpgrade).toString("hex")).toBe("fae33d0030747a6b762d72756e74696d65");
    }
    expect(r.runtimeVersion).toMatchObject({ specName: "tzkv-runtime", specVersion: 1014014 });
    expect(r.metadata.length).toBe(482132);
    expect(sha256(r.metadata)).toBe("f4fd2addba7fff1129483d0e66b8e6bc69141292f56443e201d3f073aab03444");
  });
});
