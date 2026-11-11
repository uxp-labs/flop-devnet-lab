import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReadOnlyViolation, attemptLog, guardRpc, resetAttempts } from "../src/guard.js";
import { canonicalJson } from "../src/store.js";
import { Recorder, TAPE_SCHEMA, TapeError, TapeTransport } from "../src/tape.js";
import { type Transport, TransportError } from "../src/transport.js";
import type { HttpResult } from "../src/types.js";

const HEAD = `{"schema":"${TAPE_SCHEMA}"}\n`;
const line = (o: unknown) => canonicalJson(o) + "\n";
const GENESIS = "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631";
const ok: HttpResult<unknown> = { http: 200, body: { status: "ok" }, error: null, fetched_at: "2026-11-11T06:00:00.000Z" };

// Canonical lines (src/store.ts): sorted keys, as the recorder writes them.
const tape =
  HEAD +
  line({ answer: { result: ok }, request: { kind: "http", method: "GET", url: "https://faucet.flop.network/health" }, seq: 0 }) +
  line({ answer: { result: "2026-11-11T06:00:01.000Z" }, request: { kind: "now" }, seq: 1 }) +
  line({ answer: { result: GENESIS }, request: { kind: "rpc", method: "chain_getBlockHash", params: [0] }, seq: 2 }) +
  line({ answer: { error: "rpc chain_getFinalizedHead timed out after 15000 ms" }, request: { kind: "rpc", method: "chain_getFinalizedHead", params: [] }, seq: 3 });

describe("TapeTransport", () => {
  it("answers each request with the next entry, and its trust is fixture", async () => {
    const t = TapeTransport.parse(tape);
    expect(t.trust).toBe("fixture");
    expect(await t.httpGet("https://faucet.flop.network/health")).toEqual(ok);
    expect(t.now()).toBe("2026-11-11T06:00:01.000Z");
    expect(await t.rpc("chain_getBlockHash", [0])).toBe(GENESIS);
    await expect(t.rpc("chain_getFinalizedHead", [])).rejects.toThrow(new TransportError("rpc chain_getFinalizedHead timed out after 15000 ms"));
    expect(t.remaining()).toBe(0);
  });

  it("replays a recorded failure as a TransportError, so a source reads it as a failed read", async () => {
    const t = TapeTransport.parse(tape);
    await t.httpGet("https://faucet.flop.network/health");
    t.now();
    await t.rpc("chain_getBlockHash", [0]);
    await expect(t.rpc("chain_getFinalizedHead", [])).rejects.toBeInstanceOf(TransportError);
  });

  it.each([
    ["another method", () => (t: TapeTransport) => t.rpc("chain_getFinalizedHead", []), "request 2 is rpc chain_getFinalizedHead [], but the next one on the tape is rpc chain_getBlockHash [0]"],
    ["other params", () => (t: TapeTransport) => t.rpc("chain_getBlockHash", [1]), "request 2 is rpc chain_getBlockHash [1], but the next one on the tape is rpc chain_getBlockHash [0]"],
    ["a GET where the tape holds an rpc call", () => (t: TapeTransport) => t.httpGet("https://faucet.flop.network/chain"), "request 2 is GET https://faucet.flop.network/chain, but the next one on the tape is rpc chain_getBlockHash [0]"],
    ["the clock where the tape holds an rpc call", () => (t: TapeTransport) => Promise.resolve().then(() => t.now()), "request 2 is the clock, but the next one on the tape is rpc chain_getBlockHash [0]"],
  ])("refuses a request that is not the next one on the tape (%s), and names both", async (_name, make, words) => {
    const t = TapeTransport.parse(tape);
    await t.httpGet("https://faucet.flop.network/health");
    t.now();
    const err = await make()(t).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TapeError);
    expect((err as Error).message).toBe(words);
    // A refused request is not taken: the entry it did not match is still next.
    expect(t.remaining()).toBe(2);
  });

  it("refuses a request past the end of the tape, and the same GET to another URL", async () => {
    const t = TapeTransport.parse(HEAD);
    await expect(t.rpc("system_chain", [])).rejects.toThrow("request 0 is rpc system_chain [], but the tape ends after 0 entries");
    const u = TapeTransport.parse(tape);
    await expect(u.httpGet("https://faucet.flop.network/health?x=1")).rejects.toThrow(
      "request 0 is GET https://faucet.flop.network/health?x=1, but the next one on the tape is GET https://faucet.flop.network/health",
    );
  });

  it("replays a recorded refusal as a refusal, never as an answer", async () => {
    const t = TapeTransport.parse(HEAD + line({ answer: { refused: "read-only observatory refused rpc-write: rpc author_submitExtrinsic" }, request: { kind: "rpc", method: "author_submitExtrinsic", params: [] }, seq: 0 }));
    const err = await t.rpc("author_submitExtrinsic", []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TapeError);
    expect(err).not.toBeInstanceOf(TransportError);
  });

  it.each([
    ["no newline at the end", HEAD.trimEnd(), "the tape does not end with a newline (a tape cut short)"],
    ["a blank line", HEAD + "\n", "tape line 1 is blank"],
    ["no header", line({ answer: { result: "x" }, request: { kind: "now" }, seq: 0 }), `tape line 0 must be {"schema":"${TAPE_SCHEMA}"}`],
    ["another schema", line({ schema: "flop-observatory/tape@1" }), `tape line 0 must be {"schema":"${TAPE_SCHEMA}"}`],
    ["a key twice", HEAD + '{"seq":0,"seq":0,"request":{"kind":"now"},"answer":{"result":"x"}}\n', 'tape line 1 is the key "seq" appears twice in one object'],
    ["a line that is not JSON", HEAD + "{\n", "tape line 1 is not valid JSON"],
    ["a seq out of order", HEAD + line({ answer: { result: "x" }, request: { kind: "now" }, seq: 1 }), "tape line 1 has seq 1, not 0"],
    ["an extra key", HEAD + line({ answer: { result: "x" }, request: { kind: "now" }, seq: 0, note: 1 }), "tape line 1 is not an object holding exactly answer, request and seq"],
    ["a POST", HEAD + line({ answer: { result: ok }, request: { kind: "http", method: "POST", url: "https://faucet.flop.network/fund" }, seq: 0 }), "tape line 1 has a request that is not an rpc call, a GET or the clock"],
    ["two answers", HEAD + line({ answer: { result: "x", error: "y" }, request: { kind: "now" }, seq: 0 }), "tape line 1 has an answer that is not an object with one key"],
    ["an error on a GET", HEAD + line({ answer: { error: "y" }, request: { kind: "http", method: "GET", url: "https://faucet.flop.network/health" }, seq: 0 }), "tape line 1 has an error answer, which only an rpc call can have"],
    ["a clock that is no string", HEAD + line({ answer: { result: 5 }, request: { kind: "now" }, seq: 0 }), "tape line 1 has a clock answer that is not a string"],
    ["a GET answer that is no object", HEAD + line({ answer: { result: null }, request: { kind: "http", method: "GET", url: "https://faucet.flop.network/health" }, seq: 0 }), "tape line 1 has a GET answer that is not an object"],
  ])("refuses a tape with %s", (_name, text, words) => {
    expect(() => TapeTransport.parse(text)).toThrow(new TapeError(words));
  });

  it("reads a tape from a regular file only, and refuses one that is not UTF-8", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-tape-"));
    try {
      writeFileSync(join(dir, "t.jsonl"), tape);
      expect(TapeTransport.fromFile(join(dir, "t.jsonl")).remaining()).toBe(4);
      writeFileSync(join(dir, "bad.jsonl"), Buffer.from([0xff, 0x0a]));
      expect(() => TapeTransport.fromFile(join(dir, "bad.jsonl"))).toThrow("the tape is not valid UTF-8");
      expect(() => TapeTransport.fromFile(dir)).toThrow("not a regular file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Recorder", () => {
  it("keeps the wrapped transport's trust and label, whichever they are", () => {
    const inner = TapeTransport.parse(tape, "tape:x");
    const r = new Recorder(inner);
    expect([r.trust, r.label]).toEqual(["fixture", "tape:x"]);
    const live = new Recorder({ ...stub(), trust: "trusted RPC", label: "rpc wss://rpc.devnet.flop.network" });
    expect([live.trust, live.label]).toEqual(["trusted RPC", "rpc wss://rpc.devnet.flop.network"]);
  });

  it("writes back exactly the tape it replays (round trip)", async () => {
    const r = new Recorder(TapeTransport.parse(tape));
    await r.httpGet("https://faucet.flop.network/health");
    r.now();
    await r.rpc("chain_getBlockHash", [0]);
    await r.rpc("chain_getFinalizedHead", []).catch(() => undefined);
    expect(r.text()).toBe(tape);
  });

  it("writes a refusal as refused and passes it on; a request still waiting is written as unanswered", async () => {
    let release: (v: unknown) => void = () => undefined;
    const inner: Transport = {
      ...stub(),
      rpc: (method) => {
        guardRpc(method);
        return new Promise((res) => {
          release = res;
        });
      },
    };
    const r = new Recorder(inner);
    await expect(r.rpc("author_submitExtrinsic", [])).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(attemptLog().map((a) => a.what)).toEqual(["rpc author_submitExtrinsic"]);
    resetAttempts();
    const waiting = r.rpc("system_chain", []);
    expect(r.text()).toBe(
      HEAD +
        line({ answer: { refused: "read-only observatory refused rpc-write: rpc author_submitExtrinsic" }, request: { kind: "rpc", method: "author_submitExtrinsic", params: [] }, seq: 0 }) +
        line({ answer: { refused: "no answer was recorded" }, request: { kind: "rpc", method: "system_chain", params: [] }, seq: 1 }),
    );
    release("FLOP Devnet");
    await waiting;
    expect(r.text().split("\n").at(2)).toBe(canonicalJson({ answer: { result: "FLOP Devnet" }, request: { kind: "rpc", method: "system_chain", params: [] }, seq: 1 }));
  });

  it("holds each request at the place it was made, whatever order the answers come in", async () => {
    const pending: ((v: unknown) => void)[] = [];
    const r = new Recorder({ ...stub(), rpc: () => new Promise((res) => pending.push(res)) });
    const a = r.rpc("system_chain", []);
    const b = r.rpc("chain_getFinalizedHead", []);
    pending.at(1)?.("0xb");
    pending.at(0)?.("a");
    await Promise.all([a, b]);
    const lines = r.text().split("\n");
    expect(lines.at(1)).toContain('"method":"system_chain"');
    expect(lines.at(2)).toContain('"method":"chain_getFinalizedHead"');
  });
});

function stub(): Transport {
  return {
    trust: "fixture",
    label: "stub",
    rpc: async () => null,
    httpGet: async () => ok,
    now: () => "2026-11-11T06:00:00.000Z",
    close: () => undefined,
  };
}
