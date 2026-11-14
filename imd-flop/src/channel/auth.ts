/**
 * The message a channel key signs for each HTTP request to the miner, and the five headers that carry it (rules C1
 * to C4). No signing here, and nothing made here: the time, the nonce and the challenge are handed in.
 *
 * The layout is FLOP's SDK 0.6.0 as shipped, `dist/compute-channel/session-auth.js`, `sessionRequestMessage` and
 * `signSessionRequest`, read and not imported. Status: as the SDK describes it. Not yet held to a miner. No rule
 * is built on the miner's time window, its nonce rule or the life of a challenge: no source shows them.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesOf, hexOf, takeFields, uintOf, utf8Of } from "./bytes.js";
import { refuse } from "./errors.js";
import { freezeFunction } from "./freeze.js";

/** The first text of the request message. */
export const REQUEST_DOMAIN = "flop-session-request-v1";

/** The fields of sessionRequestMessage, in their order in the message. */
export const REQUEST_FIELDS = Object.freeze(["channelId", "method", "path", "body", "timestampMs", "nonce", "challenge"] as const);
const HEADER_FIELDS = Object.freeze(["channelId", "timestampMs", "nonce", "challenge", "signature"] as const);

/** One or more segments, each a slash and one or more letters, digits, underscores or hyphens. */
const PATH = /^(?:\/[A-Za-z0-9_-]+)+$/;
/** 64 lower case hex digits, with no 0x. */
const CHALLENGE = /^[0-9a-f]{64}$/;

export type RequestMethod = "GET" | "POST";

export interface SessionRequestInput {
  /** The channel id, 32 bytes. */
  readonly channelId: Uint8Array;
  readonly method: RequestMethod;
  /** The request's path, as `^(/[A-Za-z0-9_-]+)+$`: no query, no dot, no empty segment, no trailing slash. */
  readonly path: string;
  /** The exact text sent as the request's body. The empty text for GET. */
  readonly body: string;
  /** Milliseconds, a u64. */
  readonly timestampMs: bigint;
  /** 16 bytes, handed in. */
  readonly nonce: Uint8Array;
  /** The miner's challenge: 64 lower case hex digits, no 0x. */
  readonly challenge: string;
}

export interface RequestHeadersInput {
  readonly channelId: Uint8Array;
  readonly timestampMs: bigint;
  readonly nonce: Uint8Array;
  readonly challenge: string;
  /** The signature, 64 bytes. */
  readonly signature: Uint8Array;
}

export interface RequestHeaders {
  readonly "x-flop-channel": string;
  readonly "x-flop-timestamp": string;
  readonly "x-flop-nonce": string;
  readonly "x-flop-challenge": string;
  readonly "x-flop-signature": string;
}

function methodOf(value: unknown): RequestMethod {
  if (value !== "GET" && value !== "POST") refuse("BAD_INPUT", "request method must be GET or POST");
  return value;
}

function pathOf(value: unknown): string {
  if (typeof value !== "string") refuse("BAD_INPUT", "request path must be a string");
  if (!PATH.test(value)) refuse("BAD_INPUT", `request path of ${value.length} characters is not one or more segments of a slash and letters, digits, _ or -`);
  return value;
}

function challengeOf(value: unknown): string {
  if (typeof value !== "string") refuse("BAD_INPUT", "request challenge must be a string");
  if (!CHALLENGE.test(value)) refuse("BAD_INPUT", `request challenge of ${value.length} characters is not 64 lower case hex digits with no 0x`);
  return value;
}

/**
 * The UTF-8 bytes of the JSON text of eight strings, as JSON.stringify writes it:
 * `["flop-session-request-v1", channel, method, path, bodyHash, timestamp, nonce, challenge]`, where channel is 0x
 * and the hex of the channel id, bodyHash is 0x and the hex of blake2b-256 of the body's UTF-8 bytes, timestamp is
 * the decimal text of the milliseconds, nonce is 0x and the hex of its 16 bytes, and challenge is as handed in.
 */
export function sessionRequestMessage(input: SessionRequestInput): Uint8Array {
  const f = takeFields(input, REQUEST_FIELDS, "request input");
  const channel = hexOf(bytesOf(f.channelId, 32, "request channelId"));
  const method = methodOf(f.method);
  const path = pathOf(f.path);
  const body = utf8Of(f.body, "request body");
  if (method === "GET" && body.length !== 0) refuse("BAD_INPUT", `request body of a GET has ${body.length} bytes, not 0`);
  const timestamp = uintOf("u64", f.timestampMs, "request timestampMs").toString(10);
  const nonce = hexOf(bytesOf(f.nonce, 16, "request nonce"));
  const challenge = challengeOf(f.challenge);
  const bodyHash = hexOf(blake2b(body, { dkLen: 32 }));
  return utf8Of(JSON.stringify([REQUEST_DOMAIN, channel, method, path, bodyHash, timestamp, nonce, challenge]), "the request message");
}
freezeFunction(sessionRequestMessage);

/** The five headers of a signed request, as texts, in a frozen object. */
export function requestHeaders(input: RequestHeadersInput): RequestHeaders {
  const f = takeFields(input, HEADER_FIELDS, "headers input");
  return Object.freeze({
    "x-flop-channel": hexOf(bytesOf(f.channelId, 32, "headers channelId")),
    "x-flop-timestamp": uintOf("u64", f.timestampMs, "headers timestampMs").toString(10),
    "x-flop-nonce": hexOf(bytesOf(f.nonce, 16, "headers nonce")),
    "x-flop-challenge": challengeOf(f.challenge),
    "x-flop-signature": hexOf(bytesOf(f.signature, 64, "headers signature")),
  });
}
freezeFunction(requestHeaders);
