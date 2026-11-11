// The reader of a recording: judgeRecording, pure, over the text of each file.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { feedText } from "../src/feed.js";
import { RECORD_SCHEMA, runRecord } from "../src/record-run.js";
import { RECORDING_FILES, judgeRecording } from "../src/recording.js";
import { REQUESTS_SCHEMA, type RequestCall } from "../src/requests.js";
import { sumsOf } from "../src/sums.js";
import { TAPE_SCHEMA, TapeTransport } from "../src/tape.js";
import { network } from "./helpers/answering.js";

const CLOCK = () => "2026-11-11T12:00:00.000Z";
const H = `0x${"cd".repeat(32)}`;
const CALLS: RequestCall[] = [
  { method: "chain_getBlockHash", params: [7], why: "block 7" },
  { method: "state_getStorage", params: ["0x26aa", H], why: "events at block 7" },
  { method: "state_getMetadata", params: [H], why: "the metadata at block 7" },
];
const LIST = feedText({ schema: REQUESTS_SCHEMA, calls: CALLS });
const OTHER_LIST = feedText({ schema: REQUESTS_SCHEMA, calls: [CALLS[1], CALLS[0], CALLS[2]] });

let box: string;
let files: Record<string, string>;
/** A record run over the fake network, where state_getStorage fails with an RPC error. */
async function recorded(list: string, name: string, failOpen = false): Promise<Record<string, string>> {
  const requests = join(box, `${name}.json`);
  writeFileSync(requests, list);
  const out = join(box, name);
  const { t } = network((m) => (m === "state_getStorage" ? { error: { code: -32000, message: "no storage" } } : { result: m === "state_getMetadata" ? "0x6d657461" : H }), { failOpen });
  await runRecord(t, { requests, out, sourceSha: "a".repeat(40), clock: CLOCK });
  return Object.fromEntries(readdirSync(out).map((f) => [f, readFileSync(join(out, f), "utf8")]));
}
beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), "obs-recording-"));
  files = await recorded(LIST, "one");
});
afterAll(() => {
  rmSync(box, { recursive: true, force: true });
});

/** The files with one changed and SHA256SUMS written again around it. */
function resummed(name: string, text: string): Record<string, string> {
  const next = { ...files, [name]: text };
  return { ...next, SHA256SUMS: sumsOf(RECORDING_FILES.map((n) => [n, next[n] as string] as const)) };
}
const run = () => JSON.parse(files["run.json"] as string) as Record<string, unknown>;
const runAs = (edit: Record<string, unknown>) => resummed("run.json", feedText({ ...run(), ...edit }));

describe("judgeRecording", () => {
  it("gives the calls with their answers, with each why when the request list is given, and its tape replays", () => {
    expect(RECORDING_FILES).toEqual(["run.json", "tape.jsonl"]);
    const j = judgeRecording(files, LIST);
    expect(j).toEqual({
      usable: true,
      run: run(),
      calls: [
        { method: "chain_getBlockHash", params: [7], why: "block 7", answer: { result: H } },
        { method: "state_getStorage", params: ["0x26aa", H], why: "events at block 7", answer: { error: "rpc error -32000: no storage" } },
        { method: "state_getMetadata", params: [H], why: "the metadata at block 7", answer: { result: "0x6d657461" } },
      ],
    });
    expect(judgeRecording(files)).toMatchObject({ usable: true, calls: CALLS.map((c) => ({ method: c.method, params: c.params, why: null })) });
    const replay = TapeTransport.parse(files["tape.jsonl"] as string);
    return (async () => {
      expect(await replay.rpc("chain_getBlockHash", [7])).toBe(H);
      await expect(replay.rpc("state_getStorage", ["0x26aa", H])).rejects.toThrow("rpc error -32000: no storage");
      expect(await replay.rpc("state_getMetadata", [H])).toBe("0x6d657461");
      expect(replay.remaining()).toBe(0);
    })();
  });

  it("reads a recording whose every call failed: what the endpoint answered was nothing", async () => {
    const down = await recorded(LIST, "down", true);
    expect(judgeRecording(down, LIST)).toMatchObject({ usable: true, run: { calls: { asked: 3, answered: 0, failed: 3 } } });
  });

  it.each([
    ["a missing file", () => ({ "run.json": files["run.json"], SHA256SUMS: files.SHA256SUMS }), ["missing tape.jsonl"]],
    ["an extra file", () => ({ ...files, "notes.txt": "x" }), ["unexpected notes.txt"]],
    ["a changed byte", () => ({ ...files, "tape.jsonl": (files["tape.jsonl"] as string).replace("block", "Block").replace(H, H.toUpperCase()) }), ["tape.jsonl differs from SHA256SUMS"]],
    ["SHA256SUMS out of its form", () => ({ ...files, SHA256SUMS: `${files.SHA256SUMS}\n` }), ["SHA256SUMS is not in the written form"]],
    ["a run.json out of the written form", () => resummed("run.json", JSON.stringify(run())), ["run.json is not in the written form"]],
    ["another schema", () => runAs({ schema: "flop-observatory/live-run@1" }), [`run.json is not a ${RECORD_SCHEMA}`]],
    ["an unknown key", () => runAs({ note: "x" }), [`run.json is not a ${RECORD_SCHEMA}`]],
    ["a run that did not exit 0", () => runAs({ exit_code: 4 }), ["run.json says exit 4: only a run that exited 0 is a recording"]],
    ["no request list hash", () => runAs({ request_list_sha256: null }), ["run.json names no request list hash"]],
    ["a start time not in the recorder's form", () => runAs({ started_at: "2026-11-11T12:00:00Z" }), ["run.json has a start or end time not in the form the recorder writes, or an end before its start"]],
    ["an end before its start", () => runAs({ ended_at: "2026-11-11T11:59:59.999Z" }), ["run.json has a start or end time not in the form the recorder writes, or an end before its start"]],
    ["another endpoint", () => runAs({ endpoint: "tape" }), ['run.json has the endpoint "tape", not "rpc wss://rpc.devnet.flop.network"']],
    ["counts that do not add up", () => runAs({ calls: { asked: 3, answered: 3, failed: 1 } }), ["run.json has calls that are not whole counts where answered and failed add up to asked"]],
    ["counts the tape does not hold", () => runAs({ calls: { asked: 3, answered: 1, failed: 2 } }), ["run.json says 1 answered and 2 failed of 3, the tape holds 2 and 1 of 3"]],
    ["a tape that does not parse", () => resummed("tape.jsonl", (files["tape.jsonl"] as string).slice(0, -1)), ["tape.jsonl: the tape does not end with a newline (a tape cut short)"]],
    ["a tape with a clock read", () => resummed("tape.jsonl", `${files["tape.jsonl"]}${JSON.stringify({ answer: { result: CLOCK() }, request: { kind: "now" }, seq: 3 })}\n`), ["tape.jsonl entry 3 is not an rpc call answered or failed on the way"]],
    ["a tape with a refusal", () => resummed("tape.jsonl", (files["tape.jsonl"] as string).replace(`{"error":"rpc error -32000: no storage"}`, `{"refused":"no answer was recorded"}`)), ["tape.jsonl entry 1 is not an rpc call answered or failed on the way"]],
  ])("refuses %s", (_what, make, refused) => {
    expect(judgeRecording(make() as Record<string, string>, LIST)).toEqual({ usable: false, refused });
  });

  it("refuses a recording of another request list, and a tape whose calls are not the list's in order", async () => {
    expect(judgeRecording(files, OTHER_LIST)).toEqual({ usable: false, refused: ["run.json names another request list"] });
    const other = await recorded(OTHER_LIST, "other");
    // run.json names the list given, but the tape holds the calls of another, in another order.
    const swapped = { ...other, "tape.jsonl": files["tape.jsonl"] as string };
    const doctored = { ...swapped, SHA256SUMS: sumsOf(RECORDING_FILES.map((n) => [n, swapped[n] as string] as const)) };
    expect(judgeRecording(doctored, OTHER_LIST)).toEqual({ usable: false, refused: ["tape.jsonl call 0 is not call 0 of the request list", "tape.jsonl call 1 is not call 1 of the request list"] });
    expect(judgeRecording(files, `${LIST} `)).toEqual({ usable: false, refused: ["the request list given is not in the written form"] });
  });

  it("is pure: it reads only what it is handed", () => {
    expect(judgeRecording({}, LIST)).toEqual({ usable: false, refused: ["missing run.json", "missing tape.jsonl", "missing SHA256SUMS"] });
    expect(files["tape.jsonl"]?.split("\n")[0]).toBe(JSON.stringify({ schema: TAPE_SCHEMA }));
  });
});
