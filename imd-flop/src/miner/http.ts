/**
 * The one HTTP file of the miner client (T1 to T8, M-12). It is the only file under src/miner that names the
 * platform's fetch, Request, Response, AbortSignal or AbortController, and the fetch it uses is handed in: this
 * file reads no global, no environment and no clock.
 *
 * It gives a transport: one function from a request (the call's name, the body text or none, C's signed headers or
 * none, the answer's byte limit, the time limit) to an answer (the status, the body text or null, and the one
 * answer header the client reads, the session challenge). The method, the path and whether a body is wanted are the
 * call's own, from CALLS: no request can name another path. The URL is the endpoint's origin and that path.
 *
 * Sent: `Accept: application/json`, `Content-Type: application/json` with a body, and C's five signed headers, and
 * nothing else; there is no headers option. A redirect is refused, credentials are never sent, no cache, no
 * referrer. One time limit covers the whole exchange, body included. The answer's bytes are counted while they
 * stream, and the read stops and refuses past the limit; a Content-Length above the limit refuses before the body
 * is read. Where a body is wanted (a 200 answer to the proof, the info, the turn or the close) the content type must
 * be `application/json`, with an optional `charset=utf-8`, and the bytes are decoded as UTF-8 fatally. Otherwise
 * the body is read to its limit and dropped, never decoded. One call is one attempt: nothing here retries.
 *
 * A refusal names the call and what failed, the status as a number where there is one. It never carries the
 * body, a header value or the URL's text. Its exit code is 11 for the proof, 1 for every other call (httpExit).
 */
import { EXIT } from "../errors.js";
import { freezeFunction } from "../freeze.js";
import { CALL_NAMES, CALLS, CHALLENGE_HEADER, SIGNED_HEADER_NAMES, type CallAnswer, type CallName, type CallRequest, type CallTransport, type SignedHeaders } from "./calls.js";
import { httpExit, MinerClientError, refuseClient } from "./client-errors.js";
import { originOf, type MinerEndpoint } from "./endpoint.js";

/** The fetch this file takes: the platform's, or a test's fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The content type wanted where a body is read: `application/json`, then nothing or `; charset=utf-8`, in any letter case. */
const JSON_TYPE = /^application\/json[ \t]*(?:;[ \t]*charset[ \t]*=[ \t]*"?utf-8"?[ \t]*)?$/i;
/** A Content-Length: digits only. */
const LENGTH = /^[0-9]{1,16}$/;
/** A signed header's value as src/channel writes it: 0x and hex, hex, or decimal digits. */
const HEADER_VALUE = /^(?:0x)?[0-9a-f]{1,128}$/;
/** The most characters of the challenge header handed back. A longer one is null: no challenge is that long. */
const CHALLENGE_MAX = 128;

const REQUEST_FIELDS = Object.freeze(["call", "body", "signed", "maxBytes", "timeMs"] as const);

/** The caller's request, checked: its own fields, read once each, each of its form for its call. */
function requestOf(value: unknown): CallRequest & { readonly name: CallName } {
  const bad = (check: string, msg: string): never => refuseClient("REQUEST", `request.${check}`, `${msg}; nothing was sent`, EXIT.ERROR);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad("form", "the request must be an object");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== REQUEST_FIELDS.length || !REQUEST_FIELDS.every((k) => keys.includes(k))) bad("form", `the request must hold exactly the fields ${REQUEST_FIELDS.join(", ")}`);
  const read = (k: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (d === undefined || !("value" in d)) return bad("form", `the request field ${k} must be a plain field`);
    return d.value;
  };
  const call = read("call");
  if (typeof call !== "string" || !(CALL_NAMES as readonly string[]).includes(call)) return bad("call", `the request's call must be one of ${CALL_NAMES.join(", ")}`);
  const name = call as CallName;
  const rule = CALLS[name];
  const body = read("body");
  if (rule.sends ? typeof body !== "string" : body !== null) bad("body", `the ${name} call ${rule.sends ? "sends a body text" : "sends no body"}`);
  const signed = read("signed");
  let headers: Record<string, string> | null = null;
  if (rule.signed) {
    if (typeof signed !== "object" || signed === null) return bad("signed", `the ${name} call carries C's five signed headers`);
    const have = Reflect.ownKeys(signed);
    if (have.length !== SIGNED_HEADER_NAMES.length || !SIGNED_HEADER_NAMES.every((k) => have.includes(k))) bad("signed", `the ${name} call carries exactly the headers ${SIGNED_HEADER_NAMES.join(", ")}`);
    headers = {};
    for (const k of SIGNED_HEADER_NAMES) {
      const d = Object.getOwnPropertyDescriptor(signed, k);
      const v = d !== undefined && "value" in d ? d.value : undefined;
      if (typeof v !== "string" || !HEADER_VALUE.test(v)) bad("signed", `the header ${k} must be a value src/channel writes`);
      headers[k] = v as string;
    }
  } else if (signed !== null) {
    bad("signed", `the ${name} call is not signed`);
  }
  const maxBytes = read("maxBytes");
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > rule.maxBytes) bad("maxBytes", `the ${name} call's byte limit must be from 1 to ${rule.maxBytes}`);
  const timeMs = read("timeMs");
  if (typeof timeMs !== "number" || !Number.isSafeInteger(timeMs) || timeMs < 1 || timeMs > rule.maxTimeMs) bad("timeMs", `the ${name} call's time limit must be from 1 to ${rule.maxTimeMs} ms`);
  return Object.freeze({ name, call: name, body: body as string | null, signed: headers as SignedHeaders | null, maxBytes: maxBytes as number, timeMs: timeMs as number });
}

/** The answer's bytes, counted while they stream; past `max` the read is cancelled and the call refused. */
async function bodyBytes(res: Response, max: number, fail: (check: string, msg: string) => never, inTime: <T>(p: Promise<T>) => Promise<T>): Promise<Uint8Array> {
  const stream = res.body;
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    for (;;) {
      const step = await inTime(reader.read());
      if (step.done) break;
      const chunk: unknown = step.value;
      if (!(chunk instanceof Uint8Array)) fail("body", "the body is not a stream of bytes");
      size += (chunk as Uint8Array).length;
      if (size > max) fail("size", `the body passed its limit of ${max} bytes`);
      chunks.push(chunk as Uint8Array);
    }
    done = true;
  } finally {
    if (!done) void reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * The transport to the miner at `endpoint`, through `fetchImpl`. The endpoint must be a value minerEndpoint made
 * (refused with exit 5 otherwise); the fetch must be a function.
 */
export function minerHttp(endpoint: MinerEndpoint, fetchImpl: FetchLike): CallTransport {
  const origin = originOf(endpoint);
  if (typeof fetchImpl !== "function") refuseClient("REQUEST", "http.fetch", "the fetch handed in must be a function", EXIT.ERROR);
  const transport = async (value: CallRequest): Promise<CallAnswer> => {
    const req = requestOf(value);
    const rule = CALLS[req.name];
    const fail = (check: string, msg: string): never => refuseClient("HTTP", `http.${req.name}.${check}`, `the ${req.name} call: ${msg}`, httpExit(req.name));
    const headers: Record<string, string> = { Accept: "application/json" };
    if (req.body !== null) headers["Content-Type"] = "application/json";
    if (req.signed !== null) Object.assign(headers, req.signed);
    const controller = new AbortController();
    let timedOut = false;
    let expire: () => void = () => undefined;
    /** Settles when the time limit passes, so a fetch or a read that ignores the signal still ends. */
    const expired = new Promise<never>((_resolve, reject) => {
      expire = () => reject(new Error("time limit"));
    });
    expired.catch(() => undefined);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      expire();
    }, req.timeMs);
    const inTime = <T>(p: Promise<T>): Promise<T> => Promise.race([p, expired]);
    try {
      let res: Response;
      try {
        res = await inTime(fetchImpl(`${origin}${rule.path}`, {
          method: rule.method,
          headers,
          ...(req.body === null ? {} : { body: req.body }),
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          referrer: "",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        }));
      } catch {
        return timedOut ? fail("time", `no answer inside its time limit of ${req.timeMs} ms`) : fail("transport", "the transport failed, with no answer");
      }
      if (typeof res !== "object" || res === null || typeof res.status !== "number" || !Number.isInteger(res.status) || res.status < 100 || res.status > 599) return fail("status", "the answer has no status this client reads");
      const status = res.status;
      const answer = res;
      /** Refuses, and cancels a body that will not be read. */
      const drop = (check: string, msg: string): never => {
        try {
          void answer.body?.cancel().catch(() => undefined);
        } catch {
          // A body that cannot be cancelled is left: the call is refused either way.
        }
        return fail(check, msg);
      };
      if (status >= 300 && status < 400) drop("redirect", `a redirect (status ${status}) is refused`);
      const wanted = rule.reads && status === 200;
      const type = res.headers.get("content-type");
      if (wanted && (type === null || !JSON_TYPE.test(type))) drop("type", "the answer's content type is not application/json");
      const length = res.headers.get("content-length");
      if (length !== null && LENGTH.test(length.trim()) && Number(length.trim()) > req.maxBytes) drop("size", `the answer's Content-Length is above its limit of ${req.maxBytes} bytes`);
      const raw = res.headers.get(CHALLENGE_HEADER);
      const challenge = raw !== null && raw.length <= CHALLENGE_MAX ? raw : null;
      let bytes: Uint8Array;
      try {
        bytes = await bodyBytes(res, req.maxBytes, fail, inTime);
      } catch (e) {
        if (e instanceof MinerClientError) throw e;
        return timedOut ? fail("time", `the body did not end inside its time limit of ${req.timeMs} ms`) : fail("transport", "the body's read failed");
      }
      if (timedOut) fail("time", `the body did not end inside its time limit of ${req.timeMs} ms`);
      let body: string | null = null;
      if (wanted) {
        try {
          body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          fail("utf8", "the body is not UTF-8");
        }
      }
      return Object.freeze({ status, body, challenge });
    } finally {
      clearTimeout(timer);
    }
  };
  return freezeFunction(transport);
}
freezeFunction(minerHttp);
