// The live transport with a fake socket class and a fake HTTP call: no test opens a socket.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadOnlyViolation, attemptLog, resetAttempts } from "../src/guard.js";
import { LIVE_URLS } from "../src/live-source.js";
import {
  ALLOWED_HOSTS,
  type ChunkReader,
  DEVNET_RPC_URL,
  type HttpCall,
  MAX_ANSWER_BYTES,
  NetTransport,
  REQUEST_TIMEOUT_MS,
  type RequestSettings,
  type ResponseLike,
  type SocketEvent,
  type SocketLike,
  TransportRefused,
  offList,
} from "../src/net.js";
import { TransportError } from "../src/transport.js";

const CLOCK = "2026-11-11T06:00:00.500Z";

function takeAttempts() {
  const log = attemptLog();
  resetAttempts();
  return log.map((a) => [a.kind, a.what]);
}

/** A socket class whose every instance is kept, so a test can drive it and count them. */
function fakeSockets() {
  const made: FakeSocket[] = [];
  class FakeSocket implements SocketLike {
    readonly url: string;
    readonly sent: string[] = [];
    closed = false;
    private readonly listeners: [string, (e: SocketEvent) => void][] = [];
    constructor(url: string) {
      this.url = url;
      made.push(this);
    }
    addEventListener(type: string, listener: (e: SocketEvent) => void): void {
      this.listeners.push([type, listener]);
    }
    send(data: string): void {
      if (this.closed) throw new Error("send on a closed fake socket");
      this.sent.push(data);
    }
    close(): void {
      this.closed = true;
    }
    emit(type: string, e: SocketEvent = {}): void {
      for (const [t, l] of this.listeners) if (t === type) l(e);
    }
    /** The id of the n-th payload sent. */
    idOf(n: number): number {
      return (JSON.parse(this.sent.at(n) as string) as { id: number }).id;
    }
    answer(n: number, body: Record<string, unknown>): void {
      this.emit("message", { data: JSON.stringify({ jsonrpc: "2.0", id: this.idOf(n), ...body }) });
    }
  }
  return { made, socketClass: FakeSocket };
}

/** A response whose body comes in the given chunks. */
function response(status: number, chunks: Uint8Array[], headers: Record<string, string> = {}): ResponseLike & { reads: number } {
  const queue = [...chunks];
  const r = {
    status,
    reads: 0,
    headers: { get: (name: string) => headers[name] ?? null },
    body: {
      getReader(): ChunkReader {
        return {
          read: async () => {
            r.reads++;
            const value = queue.shift();
            return value === undefined ? { done: true } : { done: false, value };
          },
          cancel: async () => undefined,
        };
      },
    },
  };
  return r;
}

const bytes = (s: string) => new TextEncoder().encode(s);

/** An HTTP call that hands back the given response, and keeps every call. */
function fakeHttp(answer: (url: string, s: RequestSettings) => Promise<ResponseLike>) {
  const calls: [string, RequestSettings][] = [];
  const httpCall: HttpCall = (url, s) => {
    calls.push([url, s]);
    return answer(url, s);
  };
  return { calls, httpCall };
}

function transport(o: Partial<ConstructorParameters<typeof NetTransport>[0]> = {}) {
  const sockets = fakeSockets();
  const http = fakeHttp(async () => response(200, [bytes('{"status":"ok"}')]));
  const t = new NetTransport({ socketClass: sockets.socketClass, httpCall: http.httpCall, clock: () => CLOCK, ...o });
  return { t, sockets, http };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NetTransport", () => {
  it("is trusted RPC, names its endpoint, and its limits are 15 s and 1 MiB", () => {
    const { t } = transport();
    expect(t.trust).toBe("trusted RPC");
    expect(t.label).toBe("rpc wss://rpc.devnet.flop.network");
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(MAX_ANSWER_BYTES).toBe(1_048_576);
    expect(t.now()).toBe(CLOCK);
  });

  it("opens one socket for the run, waits for it to open, and sends JSON-RPC calls on it", async () => {
    const { t, sockets } = transport();
    const a = t.rpc("system_chain", []);
    const b = t.rpc("chain_getBlockHash", [0]);
    expect(sockets.made.length).toBe(1);
    const s = sockets.made.at(0)!;
    expect(s.url).toBe(DEVNET_RPC_URL);
    // Nothing goes out before the socket opens.
    expect(s.sent).toEqual([]);
    s.emit("open");
    expect(s.sent.map((p) => JSON.parse(p))).toEqual([
      { jsonrpc: "2.0", id: 1, method: "system_chain", params: [] },
      { jsonrpc: "2.0", id: 2, method: "chain_getBlockHash", params: [0] },
    ]);
    // Answers are matched by id, in any order.
    s.answer(1, { result: "0xabc" });
    s.answer(0, { result: "FLOP Devnet" });
    expect(await a).toBe("FLOP Devnet");
    expect(await b).toBe("0xabc");
    const c = t.rpc("chain_getFinalizedHead", []);
    s.answer(2, { result: "0xdef" });
    expect(await c).toBe("0xdef");
    expect(sockets.made.length).toBe(1);
  });

  it("calls the guard before every RPC send: a write method is refused and recorded, and nothing is sent", async () => {
    const { t, sockets } = transport();
    await expect(t.rpc("author_submitExtrinsic", ["0x00"])).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(takeAttempts()).toEqual([["rpc-write", "rpc author_submitExtrinsic"]]);
    // Refused before the socket was even made.
    expect(sockets.made.length).toBe(0);
    const ok = t.rpc("system_chain", []);
    const s = sockets.made.at(0)!;
    s.emit("open");
    await expect(t.rpc("author_insertKey", ["babe", "x", "0x00"])).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(takeAttempts()).toEqual([["rpc-write", "rpc author_insertKey"]]);
    expect(s.sent.map((p) => (JSON.parse(p) as { method: string }).method)).toEqual(["system_chain"]);
    s.answer(0, { result: "FLOP Devnet" });
    await ok;
  });

  it("calls the guard before every HTTP send: a POST is refused and recorded, and nothing is sent", async () => {
    const { t, http } = transport();
    await expect(t.http("POST", "https://faucet.flop.network/fund")).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(t.http("delete", "https://api.flop.network/v1/models")).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(takeAttempts()).toEqual([
      ["http-write", "POST https://faucet.flop.network/fund"],
      ["http-write", "DELETE https://api.flop.network/v1/models"],
    ]);
    expect(http.calls).toEqual([]);
  });

  it("GETs with redirects refused and nothing but an accept header, and reads a JSON body", async () => {
    const { t, http } = transport();
    expect(await t.httpGet("https://faucet.flop.network/health")).toEqual({ http: 200, body: { status: "ok" }, error: null, fetched_at: CLOCK });
    expect(http.calls.length).toBe(1);
    const [url, s] = http.calls.at(0)!;
    expect(url).toBe("https://faucet.flop.network/health");
    expect([s.method, s.redirect, s.headers]).toEqual(["GET", "error", { accept: "application/json" }]);
    expect(s.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["another host", "https://example.com/health", "the host example.com is not allowed for https:"],
    ["a host that only ends like an allowed one", "https://evilfaucet.flop.network/health", "the host evilfaucet.flop.network is not allowed for https:"],
    ["plain http", "http://faucet.flop.network/health", "the scheme http: is not allowed"],
    ["the RPC host over https", "https://rpc.devnet.flop.network/", "the host rpc.devnet.flop.network is not allowed for https:"],
    ["a port", "https://faucet.flop.network:8443/health", "a port, user or password is not allowed"],
    ["a user", "https://me@faucet.flop.network/health", "a port, user or password is not allowed"],
    ["no URL at all", "faucet.flop.network/health", "it is not a URL"],
  ])("refuses a GET to %s, records it, and sends nothing", async (_name, url, why) => {
    const { t, http } = transport();
    const err = await t.httpGet(url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportRefused);
    expect(takeAttempts()).toEqual([["network", `refused ${url}: ${why}`]]);
    expect(http.calls).toEqual([]);
  });

  it("refuses an RPC endpoint off the allow list before any socket is made", async () => {
    const { t, sockets } = transport({ rpcUrl: "wss://rpc.example.com" });
    await expect(t.rpc("system_chain", [])).rejects.toBeInstanceOf(TransportRefused);
    expect(takeAttempts()).toEqual([["network", "refused wss://rpc.example.com: the host rpc.example.com is not allowed for wss:"]]);
    expect(sockets.made.length).toBe(0);
  });

  it("allows exactly the hosts the live reading uses", () => {
    expect([...ALLOWED_HOSTS].map(([k, v]) => [k, [...v]])).toEqual([
      ["wss:", ["rpc.devnet.flop.network"]],
      ["https:", ["faucet.flop.network", "api.flop.network"]],
    ]);
    for (const url of [DEVNET_RPC_URL, ...Object.values(LIVE_URLS)]) expect(offList(url), url).toBeNull();
  });

  it("times out an RPC call after 15 s by default, and the socket stays in use", async () => {
    vi.useFakeTimers();
    const { t, sockets } = transport();
    const a = t.rpc("chain_getFinalizedHead", []);
    const caught = a.catch((e: unknown) => e);
    const s = sockets.made.at(0)!;
    s.emit("open");
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    let settled = false;
    void caught.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await caught).toEqual(new TransportError("rpc chain_getFinalizedHead timed out after 15000 ms"));
    // A late answer to it changes nothing, and the next call works on the same socket.
    s.answer(0, { result: "0xlate" });
    const b = t.rpc("system_chain", []);
    s.answer(1, { result: "FLOP Devnet" });
    expect(await b).toBe("FLOP Devnet");
    expect(sockets.made.length).toBe(1);
  });

  it("times out a GET with no answer, as no response", async () => {
    const http = fakeHttp(
      (_url, s) =>
        new Promise((_res, rej) => {
          s.signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const { t } = transport({ httpCall: http.httpCall, timeoutMs: 20 });
    expect(await t.httpGet("https://api.flop.network/v1/models")).toEqual({ http: null, body: null, error: "GET timed out after 20 ms", fetched_at: null });
  });

  it("times out a GET whose body never ends, keeping its status", async () => {
    const http = fakeHttp(async (_url, s) => ({
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: () => new Promise((_res, rej) => s.signal.addEventListener("abort", () => rej(new Error("aborted")))),
          cancel: async () => undefined,
        }),
      },
    }));
    const { t } = transport({ httpCall: http.httpCall, timeoutMs: 20 });
    expect(await t.httpGet("https://api.flop.network/v1/models")).toEqual({ http: 200, body: null, error: "GET timed out after 20 ms", fetched_at: null });
  });

  it("reads an RPC answer of exactly the size limit, and refuses one byte more: the socket fails and is closed", async () => {
    const { t, sockets } = transport();
    const a = t.rpc("chain_getHeader", []);
    const s = sockets.made.at(0)!;
    s.emit("open");
    const frame = (pad: number) => `{"jsonrpc":"2.0","id":${s.idOf(s.sent.length - 1)},"result":"${"x".repeat(pad)}"}`;
    const base = frame(0).length;
    s.emit("message", { data: frame(MAX_ANSWER_BYTES - base) });
    expect(((await a) as string).length).toBe(MAX_ANSWER_BYTES - base);
    const b = t.rpc("chain_getHeader", []);
    s.emit("message", { data: frame(MAX_ANSWER_BYTES - base + 1) });
    await expect(b).rejects.toEqual(new TransportError("an rpc answer is larger than 1048576 bytes"));
    expect(s.closed).toBe(true);
    // One socket for the run: every later call fails at once, and no second socket is made.
    await expect(t.rpc("system_chain", [])).rejects.toEqual(new TransportError("an rpc answer is larger than 1048576 bytes"));
    expect(sockets.made.length).toBe(1);
  });

  it("counts the size limit in bytes, not characters", async () => {
    const { t, sockets } = transport({ maxAnswerBytes: 40 });
    const a = t.rpc("system_chain", []);
    const s = sockets.made.at(0)!;
    s.emit("open");
    // 37 characters, 43 bytes in UTF-8.
    s.emit("message", { data: `{"id":1,"result":"${"é".repeat(6)}xxxxxxxxxxx"}` });
    await expect(a).rejects.toEqual(new TransportError("an rpc answer is larger than 40 bytes"));
  });

  it("reads a body of exactly the size limit, and refuses one byte more, as it comes or by its stated length", async () => {
    const exact = bytes(JSON.stringify("x".repeat(MAX_ANSWER_BYTES - 2)));
    expect(exact.length).toBe(MAX_ANSWER_BYTES);
    const half = exact.length / 2;
    const ok = transport({ httpCall: fakeHttp(async () => response(200, [exact.subarray(0, half), exact.subarray(half)])).httpCall }).t;
    expect(((await ok.httpGet("https://faucet.flop.network/health")).body as string).length).toBe(MAX_ANSWER_BYTES - 2);
    const over = bytes(JSON.stringify("x".repeat(MAX_ANSWER_BYTES - 1)));
    const big = transport({ httpCall: fakeHttp(async () => response(200, [over.subarray(0, half), over.subarray(half)])).httpCall }).t;
    expect(await big.httpGet("https://faucet.flop.network/health")).toEqual({ http: 200, body: null, error: "the body is larger than 1048576 bytes", fetched_at: CLOCK });
    const stated = response(200, [bytes("{}")], { "content-length": String(MAX_ANSWER_BYTES + 1) });
    const declared = transport({ httpCall: fakeHttp(async () => stated).httpCall }).t;
    expect(await declared.httpGet("https://faucet.flop.network/health")).toEqual({ http: 200, body: null, error: "the body is larger than 1048576 bytes", fetched_at: CLOCK });
    expect(stated.reads).toBe(0);
  });

  it.each([
    ["not JSON", "{", "an rpc answer is not valid JSON"],
    ["a key twice", '{"id":1,"result":1,"result":2}', 'an rpc answer is the key "result" appears twice in one object'],
    ["not an object", "[1]", "an rpc answer is not a JSON object"],
    ["nested too deep", `{"id":1,"result":${"[".repeat(70)}${"]".repeat(70)}}`, "an rpc answer is nested deeper than 64 levels"],
  ])("fails the socket on an answer that is %s", async (_name, data, why) => {
    const { t, sockets } = transport();
    const a = t.rpc("system_chain", []);
    const s = sockets.made.at(0)!;
    s.emit("open");
    s.emit("message", { data });
    await expect(a).rejects.toEqual(new TransportError(why));
    expect(s.closed).toBe(true);
  });

  it("fails the socket on an answer that is not text", async () => {
    const { t, sockets } = transport();
    const a = t.rpc("system_chain", []);
    sockets.made.at(0)!.emit("open");
    sockets.made.at(0)!.emit("message", { data: new Uint8Array([123, 125]) });
    await expect(a).rejects.toEqual(new TransportError("an rpc answer is not text"));
  });

  it("reads an RPC error, and an answer with neither result nor error, as failed calls; an unknown id changes nothing", async () => {
    const { t, sockets } = transport();
    const a = t.rpc("system_chain", []);
    const s = sockets.made.at(0)!;
    s.emit("open");
    s.emit("message", { data: '{"jsonrpc":"2.0","id":99,"result":"stray"}' });
    s.answer(0, { error: { code: -32601, message: "Method not found" } });
    await expect(a).rejects.toEqual(new TransportError("rpc error -32601: Method not found"));
    const b = t.rpc("system_chain", []);
    s.answer(1, {});
    await expect(b).rejects.toEqual(new TransportError("an rpc answer has neither result nor error"));
    expect(s.closed).toBe(false);
  });

  it("fails every waiting call when the socket errors or closes, and never opens another", async () => {
    const { t, sockets } = transport();
    const a = t.rpc("system_chain", []);
    const b = t.rpc("chain_getBlockHash", [0]);
    sockets.made.at(0)!.emit("error");
    sockets.made.at(0)!.emit("close");
    await expect(a).rejects.toEqual(new TransportError("rpc socket error"));
    await expect(b).rejects.toEqual(new TransportError("rpc socket error"));
    await expect(t.rpc("chain_getFinalizedHead", [])).rejects.toEqual(new TransportError("rpc socket error"));
    expect(sockets.made.length).toBe(1);
  });

  it("fails the call when the socket cannot be made", async () => {
    class Refusing implements SocketLike {
      constructor() {
        throw new Error("bad url");
      }
      addEventListener(): void {}
      send(): void {}
      close(): void {}
    }
    const { t } = transport({ socketClass: Refusing });
    await expect(t.rpc("system_chain", [])).rejects.toEqual(new TransportError("rpc socket could not be made: bad url"));
  });

  it("reads a body that is not JSON as an error with its status, and a failed call as no response", async () => {
    const html = transport({ httpCall: fakeHttp(async () => response(503, [bytes("<html>down</html>")])).httpCall }).t;
    expect(await html.httpGet("https://faucet.flop.network/health")).toEqual({ http: 503, body: null, error: "the body is not valid JSON", fetched_at: CLOCK });
    const bad = transport({ httpCall: fakeHttp(async () => response(200, [new Uint8Array([0xff])])).httpCall }).t;
    expect((await bad.httpGet("https://faucet.flop.network/health")).error).toBe("the body is not valid UTF-8");
    const gone = transport({ httpCall: fakeHttp(async () => Promise.reject(new TypeError("fetch failed"))).httpCall }).t;
    expect(await gone.httpGet("https://faucet.flop.network/health")).toEqual({ http: null, body: null, error: "GET failed: fetch failed", fetched_at: null });
  });

  it("closes its socket at the end of the run, failing any call still waiting", async () => {
    const { t, sockets } = transport();
    const a = t.rpc("system_chain", []);
    t.close();
    await expect(a).rejects.toEqual(new TransportError("the run closed the rpc socket"));
    expect(sockets.made.at(0)!.closed).toBe(true);
  });
});
