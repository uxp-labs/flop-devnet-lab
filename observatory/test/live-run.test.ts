// One live run end to end, offline: over tapes, and over the live transport with a fake socket
// class and a fake HTTP call. No test opens a socket.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attemptLog, guardRpc, resetAttempts } from "../src/guard.js";
import { EXIT, RUN_SCHEMA, commandText, noticeLine, parseLiveArgs, runLive, sumsText } from "../src/live-run.js";
import { type HttpCall, NetTransport, type SocketEvent, type SocketLike } from "../src/net.js";
import { checkSnapshot } from "../src/snapshot-check.js";
import { DEVNET_GENESIS } from "../src/status.js";
import { hashSnapshot, verifyChain } from "../src/store.js";
import { type TapeEntry, TapeTransport } from "../src/tape.js";
import type { Transport } from "../src/transport.js";
import type { HttpResult, Snapshot } from "../src/types.js";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const tapeText = (name: string) => readFileSync(new URL(`${name}/tape.jsonl`, FIXTURES), "utf8");
const RUN_CLOCK = () => "2026-11-11T06:10:00.000Z";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const FILES = ["SHA256SUMS", "census.json", "drift.json", "escrows.json", "run.json", "snapshot.json", "snapshots.jsonl", "status.json", "tape.jsonl"];

let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "obs-live-run-"));
});
afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const json = (dir: string, name: string) => JSON.parse(read(dir, name)) as Record<string, unknown>;

/** A transport that answers from a tape but says it is the network, as the live one does. */
function asLive(inner: Transport): Transport {
  return { trust: "trusted RPC", label: "rpc wss://rpc.devnet.flop.network", rpc: (m, p) => inner.rpc(m, p), httpGet: (u) => inner.httpGet(u), now: () => inner.now(), close: () => inner.close() };
}

/** A run into a new folder under box, on the published log in log (by default one that does not exist: a first run). */
async function run(t: Transport, name = "out", log = join(box, "no-log")) {
  const out = join(box, name);
  return { out, r: await runLive(t, { out, log, sourceSha: SHA, clock: RUN_CLOCK }) };
}

describe("parseLiveArgs", () => {
  it("reads --out, --log and --source-sha", () => {
    expect(parseLiveArgs(["--out", "o", "--log", "l"])).toEqual({ out: "o", log: "l", sourceSha: null });
    expect(parseLiveArgs(["--source-sha", SHA, "--log", "l", "--out", "o"])).toEqual({ out: "o", log: "l", sourceSha: SHA });
  });

  it.each([
    [[], "missing --out"],
    [["--out", "o"], "missing --log"],
    [["--out", "o", "--log"], "--log needs a value"],
    [["--out"], "--out needs a value"],
    [["--out", ""], "--out needs a value"],
    [["--out", "--source-sha"], "--out needs a value"],
    [["--out=o"], '"--out=o": give a flag\'s value as the next argument, not after ='],
    [["--out", "a", "--out", "b"], "--out is given twice"],
    [["--logs", "x", "--out", "o"], "--logs is not a flag the live command reads"],
    [["o"], '"o" is no flag\'s value; every argument is --name followed by its value'],
  ])("refuses %j", (argv, why) => {
    expect(parseLiveArgs(argv)).toBe(why);
  });
});

describe("runLive over a tape", () => {
  it("writes a truthful snapshot and exits 0, with exactly its files, each one hashed in SHA256SUMS", async () => {
    const { out, r } = await run(TapeTransport.parse(tapeText("live-healthy"), "tape:live-healthy"));
    expect([r.code, r.reason]).toEqual([EXIT.ok, "a truthful snapshot was written"]);
    expect(readdirSync(out).sort()).toEqual(FILES);
    // SHA256SUMS in sha256sum's own form, for every other file, sorted.
    const sums = read(out, "SHA256SUMS");
    expect(sums).toBe(
      FILES.filter((f) => f !== "SHA256SUMS")
        .map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}\n`)
        .join(""),
    );
    expect(sumsText(out)).toBe(sums);
    // The tape it wrote is the tape it read, byte for byte.
    expect(read(out, "tape.jsonl")).toBe(tapeText("live-healthy"));
    const snap = json(out, "snapshot.json") as unknown as Snapshot;
    expect(checkSnapshot(snap)).toEqual([]);
    expect(snap.hash).toBe(hashSnapshot(snap));
    expect(verifyChain(join(out, "snapshots.jsonl"))).toBeNull();
    expect([snap.seq, snap.prev_hash, snap.trust, snap.status.trust, snap.escrows, snap.census, snap.drift]).toEqual([0, null, "fixture", "fixture", [], null, null]);
    expect(snap.pin).toEqual({ source_sha: SHA, source: "live:tape:live-healthy", genesis: DEVNET_GENESIS, finalized_height: 3430000, finalized_hash: snap.status.finalized_hash, node: process.version });
    expect(snap.observed_at).toBe("2026-11-11T06:00:01.000Z");
    expect(r.snapshot).toEqual(snap);
    expect(json(out, "run.json")).toEqual({
      schema: RUN_SCHEMA,
      started_at: RUN_CLOCK(),
      ended_at: RUN_CLOCK(),
      source_sha: SHA,
      exit_code: 0,
      exit_reason: "a truthful snapshot was written",
      history: { state: "absent", detail: "the log folder does not exist, so this is a first run", files: 0, snapshots: 0, last_hash: null },
      snapshot_hash: snap.hash,
    });
  });

  it("prints one notice line with what the snapshot says", async () => {
    const { r } = await run(TapeTransport.parse(tapeText("live-healthy")));
    const s = r.snapshot as Snapshot;
    expect(r.notice).toBe(
      `::notice title=networkStatus::{"trust":"fixture","genesis_pinned":"${DEVNET_GENESIS}","genesis_rpc":"${DEVNET_GENESIS}","genesis_faucet":"${DEVNET_GENESIS}",` +
        `"reset_detected":false,"finalized_height":3430000,"best_height":3430002,"runtime_version":1014014,"rpc":"ok","faucet":"ok","gateway":"ok","seq":0,"prev_hash":null,"snapshot_hash":"${s.hash}"}`,
    );
    expect(noticeLine(s)).toBe(r.notice);
    expect(r.notice).not.toMatch(/\n/);
  });

  it("escapes what a workflow command would read as its end", () => {
    expect(commandText("50% a\r\nb")).toBe("50%25 a%0D%0Ab");
  });

  it.each([
    ["live-other-genesis", "reset signal: reset_detected is true"],
    ["live-faucet-disagrees", "reset signal: reset_detected is true"],
  ])("%s: writes the snapshot and exits 3 for the reset signal", async (name, why) => {
    const { out, r } = await run(TapeTransport.parse(tapeText(name)));
    expect([r.code, r.reason]).toEqual([EXIT.reset, why]);
    expect(readdirSync(out).sort()).toEqual(FILES);
    expect(json(out, "run.json").exit_code).toBe(3);
    expect(r.notice).toContain('"reset_detected":true');
  });

  it("exits 3 for a conflict the rules raise even when reset_detected is not true", async () => {
    const other = "0x2222222222222222222222222222222222222222222222222222222222222222";
    // The faucet /chain answers 503, so its reading does not count, but it names another genesis.
    const text = tapeText("live-healthy").replace('"genesisHash":"' + DEVNET_GENESIS + '"', `"genesisHash":"${other}"`).replace(/("fetched_at":"2026-11-11T06:00:00.240Z","http":)200/, "$1503");
    const { r } = await run(TapeTransport.parse(text));
    const s = r.snapshot as Snapshot;
    expect(s.status.reset_detected).toBeNull();
    expect(s.status.conflicts).toEqual([
      `faucet /chain reading that does not count (http 503) reports genesis ${other}, not the pinned genesis`,
      `faucet genesis ${other} differs from rpc genesis ${DEVNET_GENESIS}`,
    ]);
    expect(r.code).toBe(EXIT.reset);
    expect(r.reason).toBe(`reset signal: the status holds 2 conflicts: ${s.status.conflicts.join("; ")}`);
  });

  it.each(["live-rpc-down", "live-faucet-down", "live-gateway-down", "live-malformed-header", "live-runtime-not-number", "live-oversize", "live-timeout"])(
    "%s: a service down or unknown is still a truthful snapshot, exit 0",
    async (name) => {
      const { out, r } = await run(TapeTransport.parse(tapeText(name)));
      expect([r.code, r.reason]).toEqual([EXIT.ok, "a truthful snapshot was written"]);
      expect(checkSnapshot(json(out, "snapshot.json"))).toEqual([]);
      expect(read(out, "tape.jsonl")).toBe(tapeText(name));
    },
  );

  it("exits 1 when the run breaks, and still writes the tape so far, run.json and SHA256SUMS", async () => {
    const t = TapeTransport.parse(tapeText("live-healthy").replace('"params":[0]', '"params":[1]'));
    const { out, r } = await run(t);
    expect(r.code).toBe(EXIT.crashed);
    expect(r.reason).toBe(
      "the run broke before a snapshot was written: request 5 is rpc chain_getBlockHash [0], but the next one on the tape is rpc chain_getBlockHash [1]",
    );
    expect([r.snapshot, r.notice]).toEqual([null, null]);
    expect(readdirSync(out).sort()).toEqual(["SHA256SUMS", "run.json", "tape.jsonl"]);
    expect(sumsText(out)).toBe(read(out, "SHA256SUMS"));
    const lines = read(out, "tape.jsonl").trimEnd().split("\n");
    expect(lines.length).toBe(7);
    expect(lines.at(-1)).toContain('"refused":"request 5 is rpc chain_getBlockHash [0]');
    expect(json(out, "run.json")).toMatchObject({ exit_code: 1, snapshot_hash: null });
  });

  it("exits 4 when the guard refuses a request, and says what it refused", async () => {
    const inner = TapeTransport.parse(tapeText("live-healthy"));
    const writing: Transport = { ...asLive(inner), rpc: async () => guardRpc("author_submitExtrinsic") };
    const { out, r } = await run(writing);
    expect(attemptLog().map((a) => a.what)).toEqual(["rpc author_submitExtrinsic"]);
    resetAttempts();
    expect([r.code, r.reason]).toEqual([EXIT.refused, "refused: rpc-write rpc author_submitExtrinsic"]);
    expect(json(out, "run.json")).toMatchObject({ exit_code: 4, exit_reason: "refused: rpc-write rpc author_submitExtrinsic" });
  });

  it("refuses an output folder that is not empty, writes nothing there, and closes the transport", async () => {
    const out = join(box, "used");
    mkdirSync(out);
    writeFileSync(join(out, "old.txt"), "x");
    let closed = false;
    const t: Transport = { ...asLive(TapeTransport.parse(tapeText("live-healthy"))), close: () => (closed = true) };
    const r = await runLive(t, { out, log: join(box, "no-log"), sourceSha: null, clock: RUN_CLOCK });
    expect([r.code, r.snapshot, closed]).toEqual([EXIT.usage, null, true]);
    expect(readdirSync(out)).toEqual(["old.txt"]);
  });

  it("makes the output folder when it does not exist", async () => {
    const { out } = await run(TapeTransport.parse(tapeText("live-healthy")), "deeper/new");
    expect(existsSync(join(out, "snapshot.json"))).toBe(true);
  });
});

/** The answers of a tape, by request, for a fake network that gives them back. */
function answersOf(text: string) {
  const entries = (TapeTransport.parse(text) as unknown as { entries: TapeEntry[] }).entries;
  const rpc = new Map<string, unknown>();
  const http = new Map<string, HttpResult<unknown>>();
  const clock: string[] = [];
  for (const e of entries) {
    if (e.request.kind === "rpc" && "result" in e.answer) rpc.set(`${e.request.method} ${JSON.stringify(e.request.params)}`, e.answer.result);
    if (e.request.kind === "http" && "result" in e.answer) http.set(e.request.url, e.answer.result as HttpResult<unknown>);
    if (e.request.kind === "now" && "result" in e.answer) clock.push(e.answer.result as string);
  }
  return { rpc, http, clock };
}

describe("runLive over the live transport, with a fake network", () => {
  it("is trusted RPC, uses one socket, and its tape replays to the same snapshot (round trip)", async () => {
    const a = answersOf(tapeText("live-healthy"));
    let sockets = 0;
    class AnsweringSocket implements SocketLike {
      private readonly listeners: [string, (e: SocketEvent) => void][] = [];
      constructor() {
        sockets++;
        setTimeout(() => this.emit("open"), 0);
      }
      addEventListener(type: string, l: (e: SocketEvent) => void): void {
        this.listeners.push([type, l]);
      }
      send(data: string): void {
        const m = JSON.parse(data) as { id: number; method: string; params: unknown[] };
        const result = a.rpc.get(`${m.method} ${JSON.stringify(m.params)}`);
        setTimeout(() => this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) }), 0);
      }
      close(): void {}
      private emit(type: string, e: SocketEvent = {}): void {
        for (const [t, l] of this.listeners) if (t === type) l(e);
      }
    }
    const httpCall: HttpCall = async (url) => {
      const h = a.http.get(url) as HttpResult<unknown>;
      const body = new TextEncoder().encode(JSON.stringify(h.body));
      let done = false;
      return {
        status: h.http as number,
        headers: { get: () => null },
        body: { getReader: () => ({ read: async () => (done ? { done: true } : ((done = true), { done: false, value: body })), cancel: async () => undefined }) },
      };
    };
    // The clock the tape's answers were taken at: each GET's time, then the head's, then the snapshot's.
    const times = [...[...a.http.values()].map((h) => h.fetched_at as string)];
    times.splice(3, 0, ...a.clock);
    const clock = () => times.shift() as string;
    const live = new NetTransport({ socketClass: AnsweringSocket, httpCall, clock });
    const first = await run(live, "live");
    expect([first.r.code, sockets]).toEqual([EXIT.ok, 1]);
    const recorded = first.r.snapshot as Snapshot;
    expect([recorded.trust, recorded.status.trust, recorded.pin.source]).toEqual(["trusted RPC", "trusted RPC", "live:rpc wss://rpc.devnet.flop.network"]);
    // The MCP binary's checks pass for it: a live snapshot can be served as any other.
    expect(checkSnapshot(json(first.out, "snapshot.json"))).toEqual([]);
    expect(first.r.notice).toContain('"trust":"trusted RPC"');
    // What it recorded is what the fixture tape holds, request for request.
    expect(read(first.out, "tape.jsonl")).toBe(tapeText("live-healthy"));

    const replay = await run(TapeTransport.fromFile(join(first.out, "tape.jsonl"), "tape:live"), "replay");
    const again = replay.r.snapshot as Snapshot;
    // Only where it came from differs: the trust, the source label, and so the hash.
    const asRecorded = { ...again, trust: recorded.trust, status: { ...again.status, trust: recorded.status.trust }, pin: { ...again.pin, source: recorded.pin.source } };
    expect({ ...asRecorded, hash: hashSnapshot(asRecorded) }).toEqual(recorded);
    expect([again.trust, again.status.trust]).toEqual(["fixture", "fixture"]);
    expect(read(replay.out, "tape.jsonl")).toBe(read(first.out, "tape.jsonl"));
    expect(sumsText(replay.out)).toBe(read(replay.out, "SHA256SUMS"));
  });

  it("exits 4 when the transport refuses a host, records it, and opens no socket", async () => {
    let sockets = 0;
    class Counting implements SocketLike {
      constructor() {
        sockets++;
      }
      addEventListener(): void {}
      send(): void {}
      close(): void {}
    }
    const ok: HttpCall = async () => ({ status: 200, headers: { get: () => null }, body: null });
    const t = new NetTransport({ socketClass: Counting, httpCall: ok, rpcUrl: "wss://rpc.example.com", clock: RUN_CLOCK });
    const { out, r } = await run(t);
    expect(attemptLog().map((x) => [x.kind, x.what])).toEqual([["network", "refused wss://rpc.example.com: the host rpc.example.com is not allowed for wss:"]]);
    resetAttempts();
    expect([r.code, r.reason, sockets]).toEqual([EXIT.refused, "refused: network refused wss://rpc.example.com: the host rpc.example.com is not allowed for wss:", 0]);
    expect(readdirSync(out).sort()).toEqual(["SHA256SUMS", "run.json", "tape.jsonl"]);
  });
});
