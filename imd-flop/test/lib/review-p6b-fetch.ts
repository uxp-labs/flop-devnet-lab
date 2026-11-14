/**
 * Review of P6b: the reviewer's own rig. A fake fetch that serves the builder's scripted miner as HTTP answers, so a
 * whole run goes through the one HTTP file (src/miner/http.ts) and every URL, method, header and body text that
 * fetch was asked is recorded. No socket: the fake fetch never reaches the platform's fetch.
 *
 * The reviewer's own writing of the three layouts C signs (from FLOP's SDK 0.6.0 `session-auth.js` and
 * `transcript.js`, read and not imported), checked with the reference library's verify.
 */
import { blake2b } from "@noble/hashes/blake2.js";
import { channelKeyFromSeed, type ChannelKey } from "../../src/channel/key.js";
import { minerRun, type MinerRun } from "../../src/miner/client.js";
import { minerEndpoint } from "../../src/miner/endpoint.js";
import { minerExpected } from "../../src/miner/expected.js";
import { minerHttp } from "../../src/miner/http.js";
import { expectedInputOf } from "./miner-answers.js";
import { scriptedMiner, type ScriptedMiner, type Switches } from "./scripted-miner.js";
import { referenceVerify } from "./sr25519-reference.js";

type Bytes = Uint8Array;
const enc = new TextEncoder();

export const rhex = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const rhex0x = (b: Bytes): string => `0x${rhex(b)}`;
export const rfromHex = (h: string): Bytes => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));
export function rle(n: bigint, width: number): Bytes {
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
}
export function rjoin(...parts: Bytes[]): Bytes {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** session-auth.js `sessionRequestMessage`, as the reviewer reads it. */
export const reqMessage = (channel: string, method: string, path: string, body: string, ts: string, nonce: string, challenge: string): Bytes =>
  enc.encode(JSON.stringify(["flop-session-request-v1", channel, method, path, rhex0x(blake2b(enc.encode(body), { dkLen: 32 })), ts, nonce, challenge]));
/** transcript.js `turnAckMessage`. */
export const ackMessage = (id: Bytes, turn: number, leaf: Bytes, send: bigint, recv: bigint): Bytes => rjoin(id, rle(BigInt(turn), 4), leaf, rle(send, 8), rle(recv, 8));
/** transcript.js `receiptMessage`. */
export const receiptMessage = (id: Bytes, root: Bytes, gn: bigint, payable: bigint): Bytes => rjoin(enc.encode("FLOP/COMPUTE_CHANNEL/RECEIPT"), Uint8Array.of(1), id, root, rle(gn, 16), rle(payable, 16));
export { referenceVerify };

/** What a fetch was asked. */
export interface Asked {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly init: RequestInit;
}

/** C wrapped: every signature recorded with its layout and the fields it was asked to sign. */
export interface Recorded {
  readonly key: ChannelKey;
  readonly signed: { kind: "request" | "ack" | "receipt"; fields: Record<string, unknown>; signature: Bytes }[];
}
export function recordedKey(seedByte = 3): Recorded {
  const inner = channelKeyFromSeed({ seed: new Uint8Array(32).fill(seedByte) });
  const signed: Recorded["signed"] = [];
  const key: ChannelKey = Object.freeze({
    publicKey: () => inner.publicKey(),
    signRequest: (f: Parameters<ChannelKey["signRequest"]>[0]) => {
      const s = inner.signRequest(f);
      signed.push({ kind: "request", fields: { ...f }, signature: Uint8Array.from(s.signature) });
      return s;
    },
    signTurnAck: (f: Parameters<ChannelKey["signTurnAck"]>[0]) => {
      const s = inner.signTurnAck(f);
      signed.push({ kind: "ack", fields: { ...f }, signature: Uint8Array.from(s.signature) });
      return s;
    },
    signReceipt: (f: Parameters<ChannelKey["signReceipt"]>[0]) => {
      const s = inner.signReceipt(f);
      signed.push({ kind: "receipt", fields: { ...f }, signature: Uint8Array.from(s.signature) });
      return s;
    },
  });
  return { key, signed };
}

export type CallName = "proof" | "probe" | "info" | "open" | "turn" | "ack" | "close";
/** The reviewer's own table: the call a (method, path, signed) names. */
export function callOf(method: string, path: string, signed: boolean): CallName | null {
  if (method === "POST" && path === "/session/info-proof") return "proof";
  if (method === "GET" && path === "/session/info") return signed ? "info" : "probe";
  if (method === "POST" && path === "/session/open") return "open";
  if (method === "POST" && path === "/session/turn") return "turn";
  if (method === "POST" && path === "/session/ack") return "ack";
  if (method === "POST" && path === "/session/close") return "close";
  return null;
}

/** An override of one call's HTTP answer: a Response, or a function of the scripted answer. */
export type Override = (scripted: { status: number; body: string | null; challenge: string | null }) => Response | Promise<Response>;

export interface FetchRig {
  readonly run: MinerRun;
  readonly miner: ScriptedMiner;
  readonly asked: Asked[];
  readonly calls: CallName[];
  readonly rec: Recorded;
  readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
}

/** The scripted miner's answer as an HTTP Response, JSON typed where it has a body. */
export function asResponse(a: { status: number; body: string | null; challenge: string | null }): Response {
  const headers: Record<string, string> = {};
  if (a.body !== null) headers["content-type"] = "application/json";
  if (a.challenge !== null) headers["x-flop-session-challenge"] = a.challenge;
  return new Response(a.body, { status: a.status, headers });
}

/** A whole run through minerHttp over a fake fetch that serves the scripted miner. */
export function fetchRig(o: { sw?: Switches; override?: Partial<Record<CallName, Override>>; origin?: string; now?: () => bigint; key?: Recorded } = {}): FetchRig {
  const rec = o.key ?? recordedKey();
  const miner = scriptedMiner(rec.key.publicKey(), o.sw ?? {});
  const asked: Asked[] = [];
  const calls: CallName[] = [];
  const origin = o.origin ?? "https://miner.example:8443";
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = { ...(init.headers as Record<string, string>) };
    const body = typeof init.body === "string" ? init.body : null;
    asked.push({ url, method: String(init.method), headers, body, init });
    const u = new URL(url);
    const signed = "x-flop-signature" in headers;
    const call = callOf(String(init.method), u.pathname, signed);
    if (call === null) throw new Error("the fake fetch was asked a path it does not serve");
    calls.push(call);
    const signedHeaders = signed
      ? { "x-flop-channel": headers["x-flop-channel"], "x-flop-timestamp": headers["x-flop-timestamp"], "x-flop-nonce": headers["x-flop-nonce"], "x-flop-challenge": headers["x-flop-challenge"], "x-flop-signature": headers["x-flop-signature"] }
      : null;
    const limits = { proof: 16384, probe: 16384, info: 65536, open: 16384, turn: 8 * 1024 * 1024, ack: 16384, close: 16384 } as const;
    let scripted: { status: number; body: string | null; challenge: string | null };
    try {
      scripted = await miner.transport({ call, body, signed: signedHeaders, maxBytes: limits[call], timeMs: 1000 });
    } catch {
      throw new TypeError("fetch failed");
    }
    const over = o.override?.[call];
    return over ? over(scripted) : asResponse(scripted);
  };
  let t = 1_763_100_000_000n;
  const run = minerRun({
    expected: minerExpected(expectedInputOf(miner.scenario)),
    endpoint: minerEndpoint(origin),
    transport: minerHttp(minerEndpoint(origin), fetchImpl),
    key: rec.key,
    nowMs:
      o.now ??
      (() => {
        t += 700n;
        return t;
      }),
    random: (n: number) => new Uint8Array(n).fill(0x5a),
    limits: {},
  });
  return { run, miner, asked, calls, rec, fetchImpl };
}
