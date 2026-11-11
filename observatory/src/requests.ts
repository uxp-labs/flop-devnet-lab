// The request list: the read calls a recording makes, each with the reason it is asked, reviewed
// like code (RULES.md section 8). observatory/recordings/requests.json is the list the record
// workflow runs.
//
// The list is JSON in the written form (src/feed.ts: sorted keys, two space indent, a newline at
// the end), so it has one spelling and a review sees every change:
//   { "calls": [ { "method": "...", "params": [...], "why": "..." }, ... ],
//     "schema": "flop-observatory/requests@0" }
// No other key, no key twice, 1 to MAX_CALLS calls, each one JSON-RPC call: a method name, its
// params as a list, and why it is asked, one plain line. Whether a method may be called is the read
// only guard's rule (src/guard.ts), not this file's: the run puts every method through it before it
// sends anything.
import { createHash } from "node:crypto";
import { feedText } from "./feed.js";
import { strictJson } from "./transport.js";

export const REQUESTS_SCHEMA = "flop-observatory/requests@0";

/** The most calls one list may ask: a run makes them one at a time, each with its 15 s limit. */
export const MAX_CALLS = 256;

export interface RequestCall {
  method: string;
  params: unknown[];
  why: string;
}

export interface RequestList {
  /** The sha256 of the list's bytes as they were read, in lower case hex. */
  sha256: string;
  calls: RequestCall[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keysAre = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const METHOD = /^[a-z]+_[A-Za-z]+$/;
/** One line of words: no control character, and nothing to trim at either end. */
const PLAIN_LINE = /^[^\u0000-\u001f\u007f\s](?:[^\u0000-\u001f\u007f]*[^\u0000-\u001f\u007f\s])?$/;

/** The list these bytes hold, or the reason they hold none. Pure: it reads no file. */
export function readRequests(bytes: Uint8Array): RequestList | string {
  const read = strictJson(bytes);
  if ("problem" in read) return `the request list is ${read.problem}`;
  if (feedText(read.value) !== new TextDecoder().decode(bytes)) return "the request list is not in the written form";
  const v = read.value;
  if (!isRecord(v) || !keysAre(v, ["calls", "schema"]) || v.schema !== REQUESTS_SCHEMA) return `the request list is not a ${REQUESTS_SCHEMA}: it must hold exactly calls and schema`;
  if (!Array.isArray(v.calls) || v.calls.length < 1 || v.calls.length > MAX_CALLS) return `the request list must hold 1 to ${MAX_CALLS} calls`;
  const calls: RequestCall[] = [];
  for (const [i, c] of v.calls.entries()) {
    if (!isRecord(c) || !keysAre(c, ["method", "params", "why"])) return `call ${i} must hold exactly method, params and why`;
    if (typeof c.method !== "string" || !METHOD.test(c.method)) return `call ${i} has the method ${JSON.stringify(c.method)}, which is no RPC method name`;
    if (!Array.isArray(c.params)) return `call ${i} has params that are not a list`;
    if (typeof c.why !== "string" || !PLAIN_LINE.test(c.why)) return `call ${i} has a why that is not one plain line of words`;
    calls.push({ method: c.method, params: c.params, why: c.why });
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex"), calls };
}
