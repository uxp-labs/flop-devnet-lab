// One record run end to end, offline: over the live transport with a fake socket class that
// answers each call as a test says, and over tapes. No test opens a socket.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { feedText } from "../src/feed.js";
import { attemptLog, resetAttempts } from "../src/guard.js";
import { EXIT, sumsText } from "../src/run-command.js";
import { MAX_ANSWER_BYTES, MAX_STATED_ANSWER_BYTES } from "../src/net.js";
import { RECORD_ANSWER_LIMITS, RECORD_SCHEMA, metadataOf, parseRecordArgs, recordNotice, runRecord } from "../src/record-run.js";
import { REQUESTS_SCHEMA, type RequestCall } from "../src/requests.js";
import { TAPE_SCHEMA, TapeTransport, parseTape } from "../src/tape.js";
import type { Transport } from "../src/transport.js";
import { type Reply, network } from "./helpers/answering.js";
import { ENCODER_REQUESTS_TEXT } from "./helpers/recorded-encoder.js";
import { RERUN_REQUESTS_TEXT } from "./helpers/recorded-rerun.js";
import { UPGRADE_REQUESTS_TEXT } from "./helpers/recorded-upgrade.js";

const CLOCK = () => "2026-11-11T12:00:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const H = `0x${"ab".repeat(32)}`;
const META = `0x6d657461${"0e".repeat(10)}`;
const CALLS: RequestCall[] = [
  { method: "chain_getFinalizedHead", params: [], why: "the head" },
  { method: "chain_getBlockHash", params: [7], why: "block 7" },
  { method: "state_getStorage", params: ["0x26aa", H], why: "events at block 7" },
  { method: "state_getMetadata", params: [H], why: "the metadata at block 7" },
];
const listText = (calls: unknown[] = CALLS) => feedText({ schema: REQUESTS_SCHEMA, calls });
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "obs-record-run-"));
});
afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

const answers = (method: string, params: unknown[]): Reply => {
  if (method === "chain_getFinalizedHead") return { result: H };
  if (method === "chain_getBlockHash") return { result: H };
  if (method === "state_getStorage") return { result: `0x${"01".repeat(484)}` };
  if (method === "state_getMetadata") return { result: META };
  // One set for the block asked, every key asked listed in order, each holding nothing.
  if (method === "state_queryStorageAt") return { result: [{ block: params[1], changes: (params[0] as string[]).map((k) => [k, null]) }] };
  return { error: { code: -32601, message: `no ${method} ${JSON.stringify(params)}` } };
};

/** A run of the list text given, written to a file, into a new folder. */
async function record(t: Transport, text: string | Uint8Array = listText(), name = "out") {
  const requests = join(box, `${name}-requests.json`);
  writeFileSync(requests, text);
  const out = join(box, name);
  return { out, requests, r: await runRecord(t, { requests, out, sourceSha: SHA, clock: CLOCK }) };
}
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const runJson = (dir: string) => JSON.parse(read(dir, "run.json")) as Record<string, unknown>;

describe("parseRecordArgs", () => {
  it("reads --requests, --out and --source-sha, the way the live command reads its flags", () => {
    expect(parseRecordArgs(["--requests", "r.json", "--out", "o"])).toEqual({ requests: "r.json", out: "o", sourceSha: null });
    expect(parseRecordArgs(["--source-sha", SHA, "--out", "o", "--requests", "r.json"])).toEqual({ requests: "r.json", out: "o", sourceSha: SHA });
  });

  it.each([
    [["--out", "o"], "missing --requests"],
    [["--requests", "r"], "missing --out"],
    [["--requests", "r", "--out", "o", "--log", "l"], "--log is not a flag the record command reads"],
    [["--requests=r", "--out", "o"], '"--requests=r": give a flag\'s value as the next argument, not after ='],
    [["--requests", "--out", "o"], "--requests needs a value"],
  ])("refuses %j", (argv, why) => {
    expect(parseRecordArgs(argv)).toBe(why);
  });
});

describe("the answer limits a recording states", () => {
  it("are 8 MiB for state_getMetadata and the transport's 1 MiB for every other call", () => {
    expect([...RECORD_ANSWER_LIMITS]).toEqual([["state_getMetadata", MAX_STATED_ANSWER_BYTES]]);
    expect(MAX_ANSWER_BYTES).toBe(1_048_576);
  });
});

describe("runRecord", () => {
  it("makes each call once, in order, on one socket, and writes exactly the tape, run.json and SHA256SUMS", async () => {
    const { t, made } = network(answers);
    const { out, r } = await record(t);
    expect([r.code, r.reason]).toEqual([EXIT.ok, "every call was made and recorded: 4 answered, 0 failed on the way"]);
    expect(readdirSync(out).sort()).toEqual(["SHA256SUMS", "run.json", "tape.jsonl"]);
    expect(made.length).toBe(1);
    expect(made[0]?.map((p) => JSON.parse(p) as { id: number; method: string; params: unknown[] }).map((p) => [p.id, p.method, p.params])).toEqual(CALLS.map((c, i) => [i + 1, c.method, c.params]));
    expect(parseTape(read(out, "tape.jsonl"))).toEqual(CALLS.map((c, seq) => ({ seq, request: { kind: "rpc", method: c.method, params: c.params }, answer: { result: (answers(c.method, c.params) as { result: unknown }).result } })));
    expect(read(out, "tape.jsonl").split("\n")[0]).toBe(JSON.stringify({ schema: TAPE_SCHEMA }));
    expect(read(out, "run.json")).toBe(
      feedText({
        schema: RECORD_SCHEMA,
        started_at: CLOCK(),
        ended_at: CLOCK(),
        source_sha: SHA,
        endpoint: "rpc wss://rpc.devnet.flop.network",
        request_list_sha256: sha(listText()),
        calls: { asked: 4, answered: 4, failed: 0 },
        exit_code: 0,
        exit_reason: "every call was made and recorded: 4 answered, 0 failed on the way",
      }),
    );
    expect(read(out, "SHA256SUMS")).toBe(`${sha(read(out, "run.json"))}  run.json\n${sha(read(out, "tape.jsonl"))}  tape.jsonl\n`);
    expect(sumsText(out)).toBe(read(out, "SHA256SUMS"));
  });

  /** A run of a list over a fake transport that counts the calls in flight. */
  async function oneAtATime(text: string) {
    // Four state_getMetadata calls sent at once over one socket failed with a socket error in the
    // lead's browser pane, one at a time they answered.
    const list = (JSON.parse(text) as { calls: RequestCall[] }).calls;
    let inFlight = 0;
    let most = 0;
    const asked: [string, unknown[]][] = [];
    const t: Transport = {
      trust: "trusted RPC",
      label: "rpc a fake that counts the calls in flight",
      async rpc(method, params) {
        asked.push([method, [...params]]);
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return (answers(method, [...params]) as { result: unknown }).result;
      },
      httpGet: () => Promise.reject(new Error("a record run makes no GET")),
      now: CLOCK,
      close: () => {},
    };
    const { r } = await record(t, text);
    expect([r.code, r.reason]).toEqual([EXIT.ok, `every call was made and recorded: ${list.length} answered, 0 failed on the way`]);
    expect(asked).toEqual(list.map((c) => [c.method, c.params]));
    expect(most).toBe(1);
    expect(inFlight).toBe(0);
    return list;
  }

  it("sends one call at a time: the next is asked only once the one before has its answer, the third list's two state_getMetadata calls among them", async () => {
    const list = await oneAtATime(UPGRADE_REQUESTS_TEXT);
    expect(list.filter((c) => c.method === "state_getMetadata").length).toBe(2);
  });

  it("sends the fourth list one call at a time too, its 23 state_queryStorageAt calls among them", async () => {
    const list = await oneAtATime(RERUN_REQUESTS_TEXT);
    expect(list.filter((c) => c.method === "state_queryStorageAt").length).toBe(23);
  });

  it("sends the fifth list one call at a time too, its 9 state_queryStorageAt calls among them", async () => {
    const list = await oneAtATime(ENCODER_REQUESTS_TEXT);
    expect(list.filter((c) => c.method === "state_queryStorageAt").length).toBe(9);
  });

  it("gives one notice line with the counts, the list's hash, and the byte length and sha256 of each metadata answer's decoded bytes", async () => {
    const { r } = await record(network(answers).t);
    const bytes = Uint8Array.from(Buffer.from(META.slice(2), "hex"));
    expect(bytes.length).toBe(14);
    expect(r.notice).toBe(
      `::notice title=recording::${JSON.stringify({ asked: 4, answered: 4, failed: 0, request_list_sha256: sha(listText()), metadata: [{ seq: 3, bytes: 14, sha256: sha(bytes) }] })}`,
    );
  });

  it("records a call that failed on the way as its error, and goes on: an RPC error, a time limit, and answers over their limits", async () => {
    /** A message of exactly size bytes whose result is 0x and zeros. */
    const big = (id: number, size: number) => {
      const head = `{"jsonrpc":"2.0","id":${id},"result":"0x`;
      return `${head}${"0".repeat(size - head.length - 2)}"}`;
    };
    const resultOf = (message: string) => (JSON.parse(message) as { result: string }).result;
    const calls: RequestCall[] = [
      { method: "chain_getBlockHash", params: [1], why: "an RPC error" },
      { method: "chain_getBlockHash", params: [2], why: "no answer" },
      { method: "state_getMetadata", params: [], why: "an answer of 1.5 MiB, under its stated limit" },
      { method: "chain_getFinalizedHead", params: [], why: "answered" },
      { method: "state_getStorage", params: ["0x01"], why: "an answer over 1 MiB, which no waiting call takes" },
      { method: "chain_getBlockHash", params: [3], why: "after the socket failed" },
    ];
    const { t, made } = network((m, p) => {
      if (m === "chain_getBlockHash" && p[0] === 1) return { error: { code: 4003, message: "Client error: block not found" } };
      if (m === "chain_getBlockHash" && p[0] === 2) return "silent";
      if (m === "state_getMetadata") return { raw: (id) => big(id, MAX_ANSWER_BYTES + MAX_ANSWER_BYTES / 2) };
      if (m === "state_getStorage") return { raw: (id) => big(id, MAX_ANSWER_BYTES + 1) };
      return { result: H };
    });
    const { out, r } = await record(t, listText(calls));
    expect([r.code, r.reason]).toEqual([EXIT.ok, "every call was made and recorded: 2 answered, 4 failed on the way"]);
    expect(made.length).toBe(1);
    const meta = resultOf(big(3, MAX_ANSWER_BYTES + MAX_ANSWER_BYTES / 2));
    expect(parseTape(read(out, "tape.jsonl")).map((e) => e.answer)).toEqual([
      { error: "rpc error 4003: Client error: block not found" },
      { error: "rpc chain_getBlockHash timed out after 50 ms" },
      { result: meta },
      { result: H },
      // An answer no waiting call takes cannot be held to one call: the socket fails, and with it
      // every call after it, each recorded as failed.
      { error: "an rpc answer is larger than 1048576 bytes" },
      { error: "an rpc answer is larger than 1048576 bytes" },
    ]);
    expect(made[0]?.length).toBe(5);
    expect(runJson(out).calls).toEqual({ asked: 6, answered: 2, failed: 4 });
    expect(r.notice).toContain(`"metadata":[{"seq":2,"bytes":${(meta.length - 2) / 2},"sha256":"${sha(Buffer.from(meta.slice(2), "hex"))}"}]`);
  });

  it("records every call as failed when the socket is refused, and still exits 0: every call was made", async () => {
    const { t, made } = network(answers, { failOpen: true });
    const { out, r } = await record(t);
    expect(r.code).toBe(EXIT.ok);
    expect(made.length).toBe(1);
    expect(parseTape(read(out, "tape.jsonl")).map((e) => e.answer)).toEqual(CALLS.map(() => ({ error: "rpc socket error: connection refused" })));
    expect(runJson(out).calls).toEqual({ asked: 4, answered: 0, failed: 4 });
    expect(r.notice).toContain('"metadata":[{"seq":3,"bytes":null,"sha256":null}]');
  });

  it("refuses a list with a method the guard refuses before anything is sent, records the attempt, and exits 4", async () => {
    const { t, made } = network(answers);
    const calls = [...CALLS, { method: "author_submitExtrinsic", params: ["0x00"], why: "a write, never sent" }];
    const { out, r } = await record(t, listText(calls));
    expect(attemptLog().map((a) => [a.kind, a.what])).toEqual([["rpc-write", "rpc author_submitExtrinsic"]]);
    resetAttempts();
    expect([r.code, r.reason]).toEqual([EXIT.refused, "refused before anything was sent: rpc-write rpc author_submitExtrinsic"]);
    expect(made.length).toBe(0);
    expect(read(out, "tape.jsonl")).toBe(`${JSON.stringify({ schema: TAPE_SCHEMA })}\n`);
    expect(runJson(out)).toMatchObject({ request_list_sha256: sha(listText(calls)), calls: { asked: 5, answered: 0, failed: 0 }, exit_code: 4 });
    expect(r.notice).toBe(`::notice title=recording::${JSON.stringify({ asked: 5, answered: 0, failed: 0, request_list_sha256: sha(listText(calls)), metadata: [] })}`);
  });

  it.each([
    ["not in the written form", JSON.stringify({ schema: REQUESTS_SCHEMA, calls: CALLS }), "the request list is not in the written form"],
    ["with an unknown key", feedText({ schema: REQUESTS_SCHEMA, calls: CALLS, extra: 1 }), `the request list is not a ${REQUESTS_SCHEMA}: it must hold exactly calls and schema`],
  ])("refuses a list %s before anything is sent, and exits 1 saying why", async (_what, text, why) => {
    const { t, made } = network(answers);
    const { out, r } = await record(t, text);
    expect([r.code, r.reason]).toEqual([EXIT.crashed, `the request list was refused, so nothing was read: ${why}`]);
    expect(made.length).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["SHA256SUMS", "run.json", "tape.jsonl"]);
    expect(runJson(out)).toMatchObject({ request_list_sha256: sha(text), calls: { asked: 0, answered: 0, failed: 0 }, exit_code: 1 });
  });

  it("exits 1 when the list cannot be read, with no hash", async () => {
    const { t, made } = network(answers);
    const out = join(box, "out");
    mkdirSync(join(box, "a-folder"));
    const r = await runRecord(t, { requests: join(box, "a-folder"), out, sourceSha: null, clock: CLOCK });
    expect([r.code, r.reason]).toEqual([EXIT.crashed, "the request list could not be read: not a regular file"]);
    expect(made.length).toBe(0);
    expect(runJson(out)).toMatchObject({ request_list_sha256: null, source_sha: null, exit_code: 1 });
  });

  it("writes nothing into a folder that is not empty, and exits 2", async () => {
    const { t, made } = network(answers);
    const out = join(box, "out");
    mkdirSync(out);
    writeFileSync(join(out, "keep"), "x");
    const requests = join(box, "requests.json");
    writeFileSync(requests, listText());
    const r = await runRecord(t, { requests, out, sourceSha: SHA, clock: CLOCK });
    expect(r.code).toBe(EXIT.usage);
    expect(readdirSync(out)).toEqual(["keep"]);
    expect(made.length).toBe(0);
    expect(existsSync(join(out, "run.json"))).toBe(false);
  });

  it("stops at a call the transport refuses (not a failed read), records it as refused, and exits 1", async () => {
    // A tape that holds only the first call: the second is not on it.
    const tape = `${JSON.stringify({ schema: TAPE_SCHEMA })}\n${JSON.stringify({ answer: { result: H }, request: { kind: "rpc", method: "chain_getFinalizedHead", params: [] }, seq: 0 })}\n`;
    const { out, r } = await record(TapeTransport.parse(tape), listText());
    expect(r.code).toBe(EXIT.crashed);
    expect(r.reason).toMatch(/^the run broke: request 1 is rpc chain_getBlockHash \[7\], but the tape ends after 1 entries$/);
    expect(parseTape(read(out, "tape.jsonl")).map((e) => e.answer)).toEqual([{ result: H }, { refused: "request 1 is rpc chain_getBlockHash [7], but the tape ends after 1 entries" }]);
    expect(runJson(out).calls).toEqual({ asked: 4, answered: 1, failed: 0 });
  });

  it("writes a tape that replays through TapeTransport, answer for answer, to its end", async () => {
    const { out } = await record(network(answers).t);
    const replay = TapeTransport.fromFile(join(out, "tape.jsonl"));
    for (const c of CALLS) expect(await replay.rpc(c.method, c.params)).toEqual((answers(c.method, c.params) as { result: unknown }).result);
    expect(replay.remaining()).toBe(0);
  });
});

describe("metadataOf and recordNotice", () => {
  it("decodes a metadata answer's hex and says nothing of an answer that is not 0x and an even number of hex digits", () => {
    expect(metadataOf(3, { result: "0x0001ff" })).toEqual({ seq: 3, bytes: 3, sha256: sha(new Uint8Array([0, 1, 255])) });
    for (const answer of [{ result: "0x0" }, { result: "00" }, { result: "0xzz" }, { result: 5 }, { error: "x" }]) expect(metadataOf(3, answer), JSON.stringify(answer)).toEqual({ seq: 3, bytes: null, sha256: null });
  });

  it("escapes the notice for the workflow log", () => {
    expect(recordNotice({ asked: 1, answered: 1, failed: 0 }, "100%\n", [])).toBe('::notice title=recording::{"asked":1,"answered":1,"failed":0,"request_list_sha256":"100%25\\n","metadata":[]}');
  });
});

describe("the two commands, read as text", () => {
  const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

  it("take their one transport each from src/net-root.ts: the recorder with its answer limits, the live command with none", () => {
    expect(source("record-bin.ts").split("realTransport(").length - 1).toBe(1);
    expect(source("record-bin.ts")).toContain("const transport = realTransport(RECORD_ANSWER_LIMITS);\n");
    expect(source("live-bin.ts").split("realTransport(").length - 1).toBe(1);
    expect(source("live-bin.ts")).toContain("const transport = realTransport();\n");
  });

  it("the usage line in src/record-bin.ts names the flags the README gives", () => {
    const usage = /^\/\/\s+node dist\/record-bin\.js (.*)$/m.exec(source("record-bin.ts"))?.[1] ?? "";
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(usage).toBe("--requests <the request list> --out <a new folder> [--source-sha <revision>]");
    expect(/^node dist\/record-bin\.js (.*)$/m.exec(readme)?.[1]).toBe(usage);
  });
});
