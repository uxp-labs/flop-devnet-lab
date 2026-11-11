// The recording of a live run: every request, in the order it was made, and the answer it got.
//
// A tape is JSON lines. The first line names the format, {"schema":"flop-observatory/tape@0"}.
// Every other line is one request and its answer, in canonical form (src/store.ts):
//   {"answer":{...},"request":{...},"seq":n}
// with seq counting from 0 and the request one of
//   {"kind":"rpc","method":"chain_getHeader","params":["0x..."]}
//   {"kind":"http","method":"GET","url":"https://faucet.flop.network/health"}
//   {"kind":"now"}
// and the answer one of
//   {"result": <the value the call gave back>}
//   {"error": "<why the request failed on the way>"}   (rpc only: a TransportError)
//   {"refused": "<why the request was refused or broke>"}
// The tape holds the answers as the observatory read them, after the transport parsed them: a body
// that was not JSON is an HttpResult with its error set, not the bytes that came back.
//
// Recorder wraps any transport and writes the tape. TapeTransport replays one: it answers each
// request with the next entry, and refuses any request that is not the next one on the tape.
import { readRegularFile } from "./files.js";
import { canonicalJson } from "./store.js";
import { type Transport, TransportError, strictJson } from "./transport.js";
import type { HttpResult, Trust } from "./types.js";

export const TAPE_SCHEMA = "flop-observatory/tape@0";

export type TapeRequest =
  | { kind: "rpc"; method: string; params: unknown[] }
  | { kind: "http"; method: "GET"; url: string }
  | { kind: "now" };

export type TapeAnswer = { result: unknown } | { error: string } | { refused: string };

export interface TapeEntry {
  seq: number;
  request: TapeRequest;
  answer: TapeAnswer;
}

/** A tape that cannot be read, or a request that is not the next one on it. */
export class TapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TapeError";
  }
}

/** A request in a few words, for a refusal. */
function describe(r: TapeRequest): string {
  if (r.kind === "rpc") return `rpc ${r.method} ${canonicalJson(r.params)}`;
  if (r.kind === "http") return `${r.method} ${r.url}`;
  return "the clock";
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keysAre = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** One entry as written on the tape, or the reason it is not one. */
function entryOf(v: unknown, seq: number): TapeEntry | string {
  if (!isRecord(v) || !keysAre(v, ["answer", "request", "seq"])) return "is not an object holding exactly answer, request and seq";
  if (v.seq !== seq) return `has seq ${canonicalJson(v.seq)}, not ${seq}`;
  const r = v.request;
  let request: TapeRequest;
  if (isRecord(r) && r.kind === "rpc" && keysAre(r, ["kind", "method", "params"]) && typeof r.method === "string" && Array.isArray(r.params)) {
    request = { kind: "rpc", method: r.method, params: r.params };
  } else if (isRecord(r) && r.kind === "http" && keysAre(r, ["kind", "method", "url"]) && r.method === "GET" && typeof r.url === "string") {
    request = { kind: "http", method: "GET", url: r.url };
  } else if (isRecord(r) && r.kind === "now" && keysAre(r, ["kind"])) {
    request = { kind: "now" };
  } else {
    return "has a request that is not an rpc call, a GET or the clock";
  }
  const a = v.answer;
  if (!isRecord(a) || Object.keys(a).length !== 1) return "has an answer that is not an object with one key";
  if (Object.hasOwn(a, "refused")) return typeof a.refused === "string" ? { seq, request, answer: { refused: a.refused } } : "has a refusal that is not a string";
  if (Object.hasOwn(a, "error")) {
    if (request.kind !== "rpc") return "has an error answer, which only an rpc call can have";
    return typeof a.error === "string" ? { seq, request, answer: { error: a.error } } : "has an error that is not a string";
  }
  if (!Object.hasOwn(a, "result")) return "has an answer with no result, error or refusal";
  if (request.kind === "now" && typeof a.result !== "string") return "has a clock answer that is not a string";
  if (request.kind === "http" && !isRecord(a.result)) return "has a GET answer that is not an object";
  return { seq, request, answer: { result: a.result } };
}

/** A tape's entries, in order. Throws TapeError, naming the line, when any line is not as written above. */
export function parseTape(text: string): TapeEntry[] {
  const lines = text.split("\n");
  if (lines.at(-1) !== "") throw new TapeError("the tape does not end with a newline (a tape cut short)");
  lines.pop();
  const values = lines.map((line, i) => {
    if (line === "") throw new TapeError(`tape line ${i} is blank`);
    const read = strictJson(new TextEncoder().encode(line));
    if ("problem" in read) throw new TapeError(`tape line ${i} is ${read.problem}`);
    return read.value;
  });
  const head = values.at(0);
  if (!isRecord(head) || !keysAre(head, ["schema"]) || head.schema !== TAPE_SCHEMA) throw new TapeError(`tape line 0 must be {"schema":"${TAPE_SCHEMA}"}`);
  return values.slice(1).map((v, i) => {
    const e = entryOf(v, i);
    if (typeof e === "string") throw new TapeError(`tape line ${i + 1} ${e}`);
    return e;
  });
}

/** Replays a tape. Trust "fixture": a tape is saved data, whatever transport recorded it. */
export class TapeTransport implements Transport {
  readonly trust: Trust = "fixture";
  readonly label: string;
  private readonly entries: readonly TapeEntry[];
  private next = 0;

  constructor(entries: readonly TapeEntry[], label = "tape") {
    this.entries = entries;
    this.label = label;
  }

  /** Reads a tape's text. Throws TapeError, naming the line, when any line is not as written above. */
  static parse(text: string, label?: string): TapeTransport {
    return new TapeTransport(parseTape(text), label);
  }

  /** Reads the tape at path, a regular file only (src/files.ts). */
  static fromFile(path: string, label = `tape:${path}`): TapeTransport {
    const bytes = readRegularFile(path);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new TapeError("the tape is not valid UTF-8");
    }
    return TapeTransport.parse(text, label);
  }

  /** How many entries are left unanswered. A replay that matches its tape ends at 0. */
  remaining(): number {
    return this.entries.length - this.next;
  }

  /** The next entry when it holds this request; otherwise a TapeError naming both. */
  private take(request: TapeRequest): TapeAnswer {
    const entry = this.entries.at(this.next);
    if (entry === undefined) throw new TapeError(`request ${this.next} is ${describe(request)}, but the tape ends after ${this.entries.length} entries`);
    if (canonicalJson(entry.request) !== canonicalJson(request)) {
      throw new TapeError(`request ${this.next} is ${describe(request)}, but the next one on the tape is ${describe(entry.request)}`);
    }
    this.next++;
    return entry.answer;
  }

  async rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    const a = this.take({ kind: "rpc", method, params: [...params] });
    if ("error" in a) throw new TransportError(a.error);
    if ("refused" in a) throw new TapeError(`the recorded rpc ${method} was refused: ${a.refused}`);
    return a.result;
  }

  async httpGet(url: string): Promise<HttpResult<unknown>> {
    const a = this.take({ kind: "http", method: "GET", url });
    if (!("result" in a)) throw new TapeError(`the recorded GET ${url} was refused: ${"refused" in a ? a.refused : a.error}`);
    return a.result as HttpResult<unknown>;
  }

  now(): string {
    const a = this.take({ kind: "now" });
    if (!("result" in a)) throw new TapeError("the recorded clock read was refused");
    return a.result as string;
  }

  close(): void {}
}

/**
 * Wraps a transport and writes down every request and its answer, in the order the requests were
 * made. Its trust and label are the wrapped transport's: it changes nothing it passes on.
 */
export class Recorder implements Transport {
  readonly trust: Trust;
  readonly label: string;
  private readonly inner: Transport;
  /** One canonical line per request, written when its answer came; null while it is waiting. */
  private readonly lines: (string | null)[] = [];
  private readonly waiting: TapeRequest[] = [];

  constructor(inner: Transport) {
    this.inner = inner;
    this.trust = inner.trust;
    this.label = inner.label;
  }

  /** Reserves the request's place on the tape when it is made. Returns the writer of its answer. */
  private open(request: TapeRequest): (answer: TapeAnswer) => void {
    const seq = this.lines.length;
    this.lines.push(null);
    this.waiting.push(request);
    return (answer) => {
      this.lines.splice(seq, 1, canonicalJson({ seq, request, answer }));
    };
  }

  async rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    const done = this.open({ kind: "rpc", method, params: [...params] });
    try {
      const result = await this.inner.rpc(method, params);
      done({ result });
      return result;
    } catch (e) {
      done(e instanceof TransportError ? { error: e.message } : { refused: messageOf(e) });
      throw e;
    }
  }

  async httpGet(url: string): Promise<HttpResult<unknown>> {
    const done = this.open({ kind: "http", method: "GET", url });
    try {
      const result = await this.inner.httpGet(url);
      done({ result });
      return result;
    } catch (e) {
      done({ refused: messageOf(e) });
      throw e;
    }
  }

  now(): string {
    const done = this.open({ kind: "now" });
    const t = this.inner.now();
    done({ result: t });
    return t;
  }

  close(): void {
    this.inner.close();
  }

  /**
   * The tape so far. A request still waiting for its answer (the run broke off) is written with
   * the refusal "no answer was recorded", so the tape says it was made.
   */
  text(): string {
    const body = this.lines.map((line, seq) => line ?? canonicalJson({ seq, request: this.waiting.at(seq), answer: { refused: "no answer was recorded" } }));
    return [canonicalJson({ schema: TAPE_SCHEMA }), ...body].map((l) => l + "\n").join("");
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
