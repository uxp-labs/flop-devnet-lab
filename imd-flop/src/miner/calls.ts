/**
 * The calls the miner client makes, each with its fixed method, path and limits (T2, T5, T6, M-12), the shape of a
 * request and of an answer of a transport (T1), and the limits a run is handed. Pure: no I/O, no clock.
 *
 * The paths are FLOP's SDK 0.6.0 as shipped, read and not imported: `dist/miner-admission.js`
 * (`fetchSessionInfoProof`: POST `/session/info-proof`), `dist/compute-channel/peer-info.js` (the anonymous probe
 * and the signed info: GET `/session/info`), `dist/compute-channel/transport-http.js` (POST `/session/open`,
 * `/session/turn`, `/session/ack`, `/session/close`). `/session/checkpoint` and `/session/prepare-retirement` are
 * not here (M-5, M-10): no request can name them.
 */
import { deepFreeze, freezeFunction } from "../freeze.js";
import { plainInput, type PlainInputCode } from "../plain-input.js";
import { refuseMiner } from "./errors.js";

export type CallName = "proof" | "probe" | "info" | "open" | "turn" | "ack" | "close";
export const CALL_NAMES = Object.freeze(["proof", "probe", "info", "open", "turn", "ack", "close"] as const);

export interface CallRule {
  readonly method: "GET" | "POST";
  readonly path: string;
  /** Whether the request carries C's five signed headers. */
  readonly signed: boolean;
  /** Whether the request carries a body (a JSON text). */
  readonly sends: boolean;
  /** Whether the answer's body is decoded and handed back (on a 200 answer). Otherwise it is read to its limit and dropped. */
  readonly reads: boolean;
  /** The default time limit of the whole exchange, body included, in milliseconds. */
  readonly timeMs: number;
  /** The hard maximum of the time limit: 4 times the default. */
  readonly maxTimeMs: number;
  /** The hard maximum, and the default, of the answer's bytes. */
  readonly maxBytes: number;
}

const KiB = 1024;
const MiB = 1024 * KiB;
/** The hard maximum of each time limit, as a multiple of its default (T5). */
export const TIME_MAX_FACTOR = 4;

const rule = (method: "GET" | "POST", path: string, signed: boolean, sends: boolean, reads: boolean, timeMs: number, maxBytes: number): CallRule => ({ method, path, signed, sends, reads, timeMs, maxTimeMs: TIME_MAX_FACTOR * timeMs, maxBytes });

/** The seven calls. The probe and the signed info share a path; they differ in the signature and in what is read. */
export const CALLS: Readonly<Record<CallName, CallRule>> = deepFreeze({
  proof: rule("POST", "/session/info-proof", false, true, true, 10_000, 16 * KiB),
  probe: rule("GET", "/session/info", false, false, false, 10_000, 16 * KiB),
  info: rule("GET", "/session/info", true, false, true, 30_000, 64 * KiB),
  open: rule("POST", "/session/open", true, true, false, 30_000, 16 * KiB),
  turn: rule("POST", "/session/turn", true, true, true, 60_000, 8 * MiB),
  ack: rule("POST", "/session/ack", true, true, false, 30_000, 16 * KiB),
  close: rule("POST", "/session/close", true, true, true, 60_000, 16 * KiB),
});

/** The six fixed paths, and no other. */
export const PATHS = Object.freeze(["/session/info-proof", "/session/info", "/session/open", "/session/turn", "/session/ack", "/session/close"] as const);

/** The names of C's five signed headers, as `src/channel/auth.ts` writes them. */
export const SIGNED_HEADER_NAMES = Object.freeze(["x-flop-channel", "x-flop-timestamp", "x-flop-nonce", "x-flop-challenge", "x-flop-signature"] as const);
export type SignedHeaders = Readonly<Record<(typeof SIGNED_HEADER_NAMES)[number], string>>;

/** The one answer header the client reads: the session challenge of the anonymous probe. */
export const CHALLENGE_HEADER = "x-flop-session-challenge";

/** One call, as the client hands it to a transport. The method and the path are the call's own, from CALLS. */
export interface CallRequest {
  readonly call: CallName;
  /** The body text, or null for a call that sends none. */
  readonly body: string | null;
  /** C's five signed headers, or null for a call that is not signed. */
  readonly signed: SignedHeaders | null;
  /** The most bytes of the answer, at most the call's maxBytes. */
  readonly maxBytes: number;
  /** The time limit of the whole exchange, at most the call's maxTimeMs. */
  readonly timeMs: number;
}

/** What a transport gives back. */
export interface CallAnswer {
  readonly status: number;
  /** The body as text, on a 200 answer to a call that reads one; otherwise null. */
  readonly body: string | null;
  /** The value of the challenge header, or null when there is none. */
  readonly challenge: string | null;
}

/** One function from a request to an answer. It throws when the call gives no answer it reads. */
export type CallTransport = (request: CallRequest) => Promise<CallAnswer>;

export interface CallLimit {
  readonly timeMs: number;
  readonly maxBytes: number;
}
export type CallLimits = Readonly<Record<CallName, CallLimit>>;
/** What a caller may hand in: for any of the calls, a lower time limit, a lower byte limit, or both. */
export type CallLimitsInput = Partial<Record<CallName, Partial<CallLimit>>>;

const PLAIN = plainInput((_code: PlainInputCode, message: string) => refuseMiner("BAD_INPUT", "limits", message));

/** The own fields of a caller's object, each read once, which must be some of `names`. */
function someFieldsOf(value: unknown, names: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value)) return refuseMiner("BAD_INPUT", "limits", `${what} must be an object`);
  if (Object.getOwnPropertySymbols(value).length > 0) refuseMiner("BAD_INPUT", "limits", `${what} has a symbol key`);
  const keys = PLAIN.ownKeys(value);
  if (keys.some((k) => !names.includes(k))) refuseMiner("BAD_INPUT", "limits", `${what} has a field that is not one of ${names.join(", ")}`);
  const out: Record<string, unknown> = Object.create(null);
  for (const k of keys) out[k] = PLAIN.ownValue(value, k, what);
  return out;
}

function limitIn(value: unknown, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) return refuseMiner("BAD_INPUT", "limits", `${what} must be a whole number from 1 to ${max}`);
  return value;
}

/**
 * The limits of each call: the default where none is handed in; a handed in limit from 1 to the call's hard
 * maximum. A limit above the maximum is refused (BAD_INPUT), never cut down: the caller may lower a limit, never
 * raise it (T5).
 */
export function callLimits(input: CallLimitsInput): CallLimits {
  const given = someFieldsOf(input, CALL_NAMES, "limits");
  const out: Record<string, CallLimit> = {};
  for (const name of CALL_NAMES) {
    const r = CALLS[name];
    const g = given[name] === undefined ? {} : someFieldsOf(given[name], ["timeMs", "maxBytes"], `limits.${name}`);
    out[name] = Object.freeze({
      timeMs: g.timeMs === undefined ? r.timeMs : limitIn(g.timeMs, r.maxTimeMs, `limits.${name}.timeMs`),
      maxBytes: g.maxBytes === undefined ? r.maxBytes : limitIn(g.maxBytes, r.maxBytes, `limits.${name}.maxBytes`),
    });
  }
  return Object.freeze(out) as CallLimits;
}
freezeFunction(callLimits);
