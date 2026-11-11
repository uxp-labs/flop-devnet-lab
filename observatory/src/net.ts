// The live transport: JSON-RPC over one socket to the devnet RPC, and GET to the faucet and the
// gateway. Its trust is "trusted RPC": it trusts the one endpoint it reads, and proves nothing.
//
// It never names the global socket class or the global HTTP call. Both are handed to it, so a
// test hands it fakes and no test opens a socket. src/live-bin.ts, the composition root, is the
// one module that names the real ones.
//
// Before anything is sent:
// - every RPC method passes guardRpc and every HTTP method passes guardHttp (src/guard.ts), so a
//   write is refused and recorded, and nothing goes out;
// - every URL must be on the allow list below, by scheme and host, with no port, user or password;
//   a URL off the list is refused and recorded as a network attempt, and nothing goes out.
// Every request has a time limit and every answer a size limit. An answer over the limit is
// refused, never cut short. The run uses one socket: once it closes, every later RPC call fails.
import { guardHttp, guardRpc, recordAttempt } from "./guard.js";
import { type Transport, TransportError, strictJson } from "./transport.js";
import type { HttpResult, Trust } from "./types.js";

/** The per request time limit, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** The largest answer read, in bytes. */
export const MAX_ANSWER_BYTES = 1_048_576;

/** The devnet RPC, the one socket the run opens. */
export const DEVNET_RPC_URL = "wss://rpc.devnet.flop.network";

/** Hosts by scheme. Nothing else is ever reached. */
export const ALLOWED_HOSTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["wss:", new Set(["rpc.devnet.flop.network"])],
  ["https:", new Set(["faucet.flop.network", "api.flop.network"])],
]);

/** One event a socket hands its listeners: a message's data, an error's message, a close's code. */
export interface SocketEvent {
  readonly data?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
}

/** What the transport uses of a socket: the standard browser and Node socket interface. */
export interface SocketLike {
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: SocketEvent) => void): void;
  send(data: string): void;
  close(): void;
}

export type SocketClass = new (url: string) => SocketLike;

/** What the transport uses of an HTTP answer. */
export interface ResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: { getReader(): ChunkReader } | null;
}

export interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

export interface RequestSettings {
  method: string;
  redirect: "error";
  signal: AbortSignal;
  headers: Record<string, string>;
}

export type HttpCall = (url: string, settings: RequestSettings) => Promise<ResponseLike>;

export interface NetOptions {
  socketClass: SocketClass;
  httpCall: HttpCall;
  rpcUrl?: string;
  timeoutMs?: number;
  maxAnswerBytes?: number;
  clock?: () => string;
}

/** Why a URL is off the allow list, or null when it is on it. */
export function offList(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "it is not a URL";
  }
  const hosts = ALLOWED_HOSTS.get(u.protocol);
  if (hosts === undefined) return `the scheme ${u.protocol} is not allowed`;
  if (!hosts.has(u.hostname)) return `the host ${u.hostname} is not allowed for ${u.protocol}`;
  if (u.port !== "" || u.username !== "" || u.password !== "") return "a port, user or password is not allowed";
  return null;
}

/** Refuses and records a URL that is off the allow list. */
function allow(url: string): void {
  const why = offList(url);
  if (why !== null) throw new TransportRefused(recordAttempt("network", `refused ${url}: ${why}`).what);
}

/** A request the transport refused to send. Never a failed read: the run stops on it. */
export class TransportRefused extends Error {
  constructor(message: string) {
    super(`live transport refused ${message}`);
    this.name = "TransportRefused";
  }
}

interface Waiting {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NetTransport implements Transport {
  readonly trust: Trust = "trusted RPC";
  readonly label: string;
  private readonly socketClass: SocketClass;
  private readonly httpCall: HttpCall;
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAnswerBytes: number;
  private readonly clock: () => string;
  private socket: SocketLike | null = null;
  private opened = false;
  /** Why the socket can no longer be used, once it cannot. */
  private dead: string | null = null;
  private readonly queue: string[] = [];
  private readonly waiting = new Map<number, Waiting>();
  private nextId = 1;

  constructor(o: NetOptions) {
    this.socketClass = o.socketClass;
    this.httpCall = o.httpCall;
    this.rpcUrl = o.rpcUrl ?? DEVNET_RPC_URL;
    this.timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxAnswerBytes = o.maxAnswerBytes ?? MAX_ANSWER_BYTES;
    this.clock = o.clock ?? (() => new Date().toISOString());
    this.label = `rpc ${this.rpcUrl}`;
  }

  now(): string {
    return this.clock();
  }

  async rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    guardRpc(method);
    allow(this.rpcUrl);
    if (this.dead !== null) throw new TransportError(this.dead);
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new TransportError(`rpc ${method} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.sendRpc(payload);
    });
  }

  /** Sends one payload: at once on an open socket, else when the one socket opens. */
  private sendRpc(payload: string): void {
    if (this.socket === null) this.openSocket();
    if (this.opened && this.socket !== null) this.socket.send(payload);
    else this.queue.push(payload);
  }

  private openSocket(): void {
    let s: SocketLike;
    try {
      s = new this.socketClass(this.rpcUrl);
    } catch (e) {
      return this.fail(`rpc socket could not be made: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.socket = s;
    s.addEventListener("open", () => {
      if (this.dead !== null) return;
      this.opened = true;
      for (const p of this.queue.splice(0)) s.send(p);
    });
    s.addEventListener("message", (e) => this.answer(e.data));
    s.addEventListener("error", (e) => this.fail(typeof e.message === "string" && e.message !== "" ? `rpc socket error: ${e.message}` : "rpc socket error"));
    s.addEventListener("close", (e) => this.fail(typeof e.code === "number" ? `rpc socket closed (code ${e.code})` : "rpc socket closed"));
  }

  /** Every waiting call fails with why, and the socket is never used again. */
  private fail(why: string): void {
    if (this.dead === null) this.dead = why;
    for (const [id, w] of [...this.waiting]) {
      clearTimeout(w.timer);
      this.waiting.delete(id);
      w.reject(new TransportError(why));
    }
  }

  /**
   * One message from the socket. An answer that is too large, not text, not strict JSON or not a
   * JSON-RPC answer cannot be told apart from an answer to any call, so the socket fails, and
   * every waiting call with it.
   */
  private answer(data: unknown): void {
    if (typeof data !== "string") return this.drop("an rpc answer is not text");
    const bytes = new TextEncoder().encode(data);
    if (bytes.length > this.maxAnswerBytes) return this.drop(`an rpc answer is larger than ${this.maxAnswerBytes} bytes`);
    const read = strictJson(bytes);
    if ("problem" in read) return this.drop(`an rpc answer is ${read.problem}`);
    const m = read.value;
    if (m === null || typeof m !== "object" || Array.isArray(m)) return this.drop("an rpc answer is not a JSON object");
    const id = (m as { id?: unknown }).id;
    const w = typeof id === "number" ? this.waiting.get(id) : undefined;
    // An answer to no waiting call (one that timed out, say) changes nothing.
    if (w === undefined) return;
    clearTimeout(w.timer);
    this.waiting.delete(id as number);
    if (Object.hasOwn(m, "error")) {
      const err = (m as { error: unknown }).error;
      const code = err !== null && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      const message = err !== null && typeof err === "object" ? (err as { message?: unknown }).message : undefined;
      w.reject(new TransportError(`rpc error ${String(code)}: ${String(message)}`));
    } else if (Object.hasOwn(m, "result")) {
      w.resolve((m as { result: unknown }).result);
    } else {
      w.reject(new TransportError("an rpc answer has neither result nor error"));
    }
  }

  /** Fails the socket for a message no call can be held to, and closes it. */
  private drop(why: string): void {
    this.fail(why);
    this.socket?.close();
  }

  async httpGet(url: string): Promise<HttpResult<unknown>> {
    return this.http("GET", url);
  }

  /**
   * One HTTP request. Only GET and HEAD pass the guard: any other method is refused and recorded
   * before anything is sent. httpGet is the only caller in src; this takes a method so a test can
   * show the guard stands in front of the send.
   */
  async http(method: string, url: string): Promise<HttpResult<unknown>> {
    guardHttp(method, url);
    allow(url);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), this.timeoutMs);
    let http: number | null = null;
    try {
      const r = await this.httpCall(url, { method, redirect: "error", signal: stop.signal, headers: { accept: "application/json" } });
      http = r.status;
      const fetchedAt = this.clock();
      const bytes = await this.bodyOf(r, stop);
      if (typeof bytes === "string") return { http, body: null, error: bytes, fetched_at: fetchedAt };
      const read = strictJson(bytes);
      if ("problem" in read) return { http, body: null, error: `the body is ${read.problem}`, fetched_at: fetchedAt };
      return { http, body: read.value, error: null, fetched_at: fetchedAt };
    } catch (e) {
      const why = stop.signal.aborted ? `GET timed out after ${this.timeoutMs} ms` : `GET failed: ${e instanceof Error ? e.message : String(e)}`;
      return { http, body: null, error: why, fetched_at: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The whole body, or why it was not read: larger than the limit, by its stated length or as it came. */
  private async bodyOf(r: ResponseLike, stop: AbortController): Promise<Uint8Array | string> {
    const tooLarge = `the body is larger than ${this.maxAnswerBytes} bytes`;
    const stated = r.headers.get("content-length");
    if (stated !== null && /^[0-9]+$/.test(stated) && Number(stated) > this.maxAnswerBytes) {
      stop.abort();
      return tooLarge;
    }
    if (r.body === null) return new Uint8Array(0);
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.length;
      if (size > this.maxAnswerBytes) {
        await reader.cancel();
        stop.abort();
        return tooLarge;
      }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    return all;
  }

  close(): void {
    this.fail("the run closed the rpc socket");
    this.socket?.close();
  }
}
