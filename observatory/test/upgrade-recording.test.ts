// The third real recording as a fixture (fixtures/recording-20261112080132-05842a6db1e9c890): the
// three files as the record workflow published them, the request list and the inputs it was made
// from, its meta.json held to what run.json and the files say, and the recording held to the lab's
// own reads of the upgrade (research/2026-11-12-runtime-upgrade/results.json), the points review
// round 21 left to this phase.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writtenValue } from "../src/feed.js";
import { judgeRecording } from "../src/recording.js";
import { parseMetadata } from "../src/scale/metadata.js";
import { toHex } from "../src/scale/reader.js";
import { REVIEWED } from "../src/scale/shape.js";
import { UPGRADE_INPUTS_TEXT, UPGRADE_RECORDING, UPGRADE_REQUESTS_TEXT, recordedUpgrade, reviewedMetadata, upgradeFixtureText, upgradeRecordingFiles } from "./helpers/recorded-upgrade.js";
import { recorded } from "./helpers/recorded.js";
import { UPGRADE_BLOCKS, deriveRequestsText } from "./helpers/requests/list-3.js";

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const U = recordedUpgrade();
const RESULTS = JSON.parse(readFileSync(new URL("../../research/2026-11-12-runtime-upgrade/results.json", import.meta.url), "utf8"));
/** The lab's reads of the four upgrade blocks, in the list's order: boundary 0 to 2, then the later block. */
const LAB = [...RESULTS.boundary.slice(0, 3), RESULTS.a_later_block_of_the_new_spec] as Record<string, any>[];

describe("the third real recording, as a fixture", () => {
  it("holds exactly the published files, the request list, its inputs and a meta.json, and each published file matches SHA256SUMS", () => {
    expect(readdirSync(new URL(`../fixtures/${UPGRADE_RECORDING}/`, import.meta.url)).sort()).toEqual(["SHA256SUMS", "meta.json", "requests-inputs.json", "requests.json", "run.json", "tape.jsonl"]);
    expect(upgradeFixtureText("SHA256SUMS")).toBe(`${sha256(upgradeFixtureText("run.json"))}  run.json\n${sha256(upgradeFixtureText("tape.jsonl"))}  tape.jsonl\n`);
  });

  it("is usable through judgeRecording with the request list it was made from, whose sha256 run.json names: 63 of 63 answered", () => {
    const run = JSON.parse(upgradeFixtureText("run.json")) as Record<string, unknown>;
    expect(sha256(UPGRADE_REQUESTS_TEXT)).toBe(run.request_list_sha256);
    const j = judgeRecording(upgradeRecordingFiles(), UPGRADE_REQUESTS_TEXT);
    expect(j.usable).toBe(true);
    if (!j.usable) return;
    expect(j.run.calls).toEqual({ asked: 63, answered: 63, failed: 0 });
  });

  it("was made from the list derived from its frozen inputs and the first recording's metadata, byte for byte, and both copies are the files main held at its revision", () => {
    expect(UPGRADE_REQUESTS_TEXT).toBe(deriveRequestsText(U.inputs, parseMetadata(recorded().metadata)));
    const meta = JSON.parse(upgradeFixtureText("meta.json")) as { provenance: Record<string, unknown> };
    expect(meta.provenance).toMatchObject({ request_inputs: "recordings/requests-inputs.json", request_inputs_copy: "requests-inputs.json", request_inputs_sha256: sha256(UPGRADE_INPUTS_TEXT) });
    // READ: run.json names no sha256 of the inputs; meta.json says where its value came from, and the copy is held to it.
    expect(typeof (meta.provenance as Record<string, unknown>).request_inputs_sha256_from).toBe("string");
  });

  it("has a meta.json in the written form that says where the files came from", () => {
    const meta = writtenValue("meta.json", upgradeFixtureText("meta.json"));
    expect(typeof meta).toBe("object");
    const m = (meta as { value: Record<string, unknown> }).value;
    const run = JSON.parse(upgradeFixtureText("run.json")) as Record<string, unknown>;
    expect(m).toMatchObject({
      scenario: UPGRADE_RECORDING,
      synthetic: false,
      provenance: {
        data_branch: "observatory-data",
        data_branch_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        metadata: U.calls.filter((c) => c.call.method === "state_getMetadata").map((c) => ({ seq: c.seq, bytes: U.metadataAt(c.derived.block as never).length, sha256: sha256(U.metadataAt(c.derived.block as never)) })),
        recording_id: UPGRADE_RECORDING.replace("recording-", ""),
        request_list: "recordings/requests.json",
        request_list_copy: "requests.json",
        revision: run.source_sha,
        started_at: run.started_at,
        ended_at: run.ended_at,
        request_list_sha256: run.request_list_sha256,
        tape_sha256: sha256(upgradeFixtureText("tape.jsonl")),
        workflow_run: expect.any(Number),
      },
    });
    const id = `${String(run.started_at).replace(/[^0-9]/g, "").slice(0, 14)}-${String(run.request_list_sha256).slice(0, 16)}`;
    expect(UPGRADE_RECORDING).toBe(`recording-${id}`);
    // READ: the data branch commit and the workflow run are in no file of this repository; meta.json
    // gives each with where it came from, and the commit message the run is read from names the id.
    const p = m.provenance as Record<string, unknown>;
    expect([typeof p.data_branch_commit_from, typeof p.workflow_run_from]).toEqual(["string", "string"]);
    expect(Number.isSafeInteger(p.workflow_run) && (p.workflow_run as number) > 0).toBe(true);
  });
});

describe("the third recording held to the lab's own reads of the upgrade (review round 21, held in this phase)", () => {
  it("names the genesis the lab's reads name, and for each of the four upgrade blocks answers the hash they give", () => {
    expect(U.genesis).toBe(RESULTS.genesis);
    expect(UPGRADE_BLOCKS.map((b) => U.hashOf(b))).toEqual(LAB.map((b) => b.hash));
  });

  it("answers at each block the runtime version the lab read there, by spec name and version, and the same transaction version", () => {
    expect(UPGRADE_BLOCKS.map((b) => [U.versionOf(b).specName, U.versionOf(b).specVersion])).toEqual(LAB.map((b) => [RESULTS.spec_name, b.state_getRuntimeVersion_spec]));
    expect(UPGRADE_BLOCKS.map((b) => U.versionOf(b).transactionVersion)).toEqual([RESULTS.transaction_version.before, RESULTS.transaction_version.after, RESULTS.transaction_version.after, RESULTS.transaction_version.after]);
  });

  it("answers at each block the LastRuntimeUpgrade bytes the lab read there", () => {
    expect(UPGRADE_BLOCKS.map((b) => toHex(U.upgradeOf(b)))).toEqual(LAB.map((b) => b.last_runtime_upgrade.hex));
  });

  it("answers at each block System.Events of the size and sha256 the lab read there, and the sum check of block 3528528", () => {
    expect(UPGRADE_BLOCKS.map((b) => [U.eventsOf(b).length, sha256(U.eventsOf(b))])).toEqual(LAB.map((b) => [b.events.bytes, b.events.sha256]));
    const carries = U.eventsOf(UPGRADE_BLOCKS[1]);
    expect([carries.length, sha256(carries)]).toEqual([RESULTS.sum_check.events_3528528_bytes, RESULTS.sum_check.events_3528528_sha256]);
  });

  it("answers the two metadata the lab read: the old runtime's at 3528527 and the new runtime's at 3528528, which the lab read at 3528529 and 3530299 too", () => {
    const [before, carries] = UPGRADE_BLOCKS;
    expect([U.metadataAt(before).length, sha256(U.metadataAt(before))]).toEqual([LAB[0]?.metadata.bytes, LAB[0]?.metadata.sha256]);
    expect([U.metadataAt(carries).length, sha256(U.metadataAt(carries))]).toEqual([LAB[1]?.metadata.bytes, LAB[1]?.metadata.sha256]);
    for (const b of [LAB[2], LAB[3]]) expect(b?.metadata).toEqual(LAB[1]?.metadata);
    expect(U.metadataAt(before)).toEqual(recorded().metadata);
  });
});

describe("the metadata of a reviewed spec, found on the third recording's tape (reviewedMetadata)", () => {
  it("gives, for each spec on the reviewed list, the metadata of the length and sha256 its line names", () => {
    expect(REVIEWED.length).toBeGreaterThan(1);
    for (const r of REVIEWED) {
      const m = reviewedMetadata(r.specVersion);
      expect([m.length, sha256(m)], String(r.specVersion)).toEqual([r.metadataBytes, r.metadataSha256]);
    }
  });

  it("refuses a spec no reviewed line names", () => {
    expect(() => reviewedMetadata(1014021)).toThrow("no reviewed runtime of spec 1014021");
    expect(() => reviewedMetadata("1014020")).toThrow("no reviewed runtime of spec 1014020");
  });

  it("refuses a reviewed line whose sha256 the tape holds no metadata of", () => {
    const line = REVIEWED[1] as (typeof REVIEWED)[number];
    const planted = [{ ...line, metadataSha256: "00".repeat(32) }];
    expect(() => reviewedMetadata(line.specVersion, planted)).toThrow(`the tape holds no metadata of sha256 ${"00".repeat(32)}`);
    expect(reviewedMetadata(line.specVersion, [line]).length).toBe(line.metadataBytes);
  });
});
