/**
 * Every call a chain read makes to a FLOP node, and only these (P2, rule B2): chain_getFinalizedHead,
 * chain_getHeader, chain_getBlockHash, state_getStorage and state_getMetadata. Nothing here can send.
 *
 * The transport is a parameter, so tests give a scripted one. The real one is nodeTransport, which goes through
 * node-rpc.ts rpcCall, the one place imd-flop opens a socket to a node; rpcCall reads the frame with outside-json.ts
 * readOutsideJson. Every answer is then checked here before it is used: its shape, 0x and an even number of lower
 * case hex digits for bytes, exactly 32 bytes for a hash, and a cap for each kind of answer (CAPS). A node error, a
 * timeout, a socket error, a wrong shape and an answer over its cap are each unknown, with the reason. Nothing
 * here throws for what a node said.
 */
import { rpcCall } from "../node-rpc.js";
import { serverText } from "../server-text.js";
import { bytesOf, hexOf, isHex } from "./bytes.js";
import { type Got, known, unknown } from "./result.js";
import { freezeFunction } from "../freeze.js";

/** The five methods a chain read calls, frozen at their definition (the P2 fix round, rule X6). */
export const READ_METHODS = Object.freeze(["chain_getFinalizedHead", "chain_getHeader", "chain_getBlockHash", "state_getStorage", "state_getMetadata"] as const);
export type ReadMethod = (typeof READ_METHODS)[number];

/** Whether a text is one of the five, read from the frozen list at run time. */
const isReadMethod = (m: unknown): m is ReadMethod => typeof m === "string" && (READ_METHODS as readonly string[]).includes(m);

/** One JSON-RPC call: the result, or a throw for a node error, a timeout or a broken socket. */
export type Transport = (method: ReadMethod, params: readonly unknown[]) => Promise<unknown>;

/**
 * The transport to a node at a WebSocket URL, through node-rpc.ts rpcCall. timeoutMs is rpcCall's own. It refuses,
 * at run time and before rpcCall is called, any method that is not one of the five (rule X2), so a cast cannot put
 * another method on the wire; call turns the refusal into unknown.
 */
export function nodeTransport(url: string, timeoutMs?: number): Transport {
  return async (method, params) => {
    if (!isReadMethod(method)) throw new Error("the method is not one of the five a chain read calls; nothing was sent");
    return rpcCall(url, method, [...params], timeoutMs);
  };
}
freezeFunction(nodeTransport);

const MiB = 1024 * 1024;

/**
 * The largest answer of each kind, in bytes (for a header, in characters of its JSON text), with its reason.
 * An answer over its cap is unknown and is never decoded.
 */
export const CAPS = Object.freeze({
  /** The decoder refuses metadata past its MAX_INPUT_BYTES, 16 MiB (observatory RULES.md section 9). */
  metadata: 16 * MiB,
  /** The decoder refuses System.Events past its MAX_INPUT_BYTES, 16 MiB. */
  events: 16 * MiB,
  /** A Compact<u32> spec version and a spec name the door reads only to 256 characters, 4 bytes of UTF-8 each at most. */
  lastRuntimeUpgrade: 5 + 5 + 4 * 256,
  /** A SessionToken: two accounts, five u128, two u32, a bool and its allow list. The recorded ones are 169 and 248 bytes; 64 KiB leaves room for a long allow list. */
  session: 64 * 1024,
  /** A u64. */
  sessionNonce: 8,
  /** A CircuitBreakerState: two u32, a u128 and a bool, 25 bytes. */
  circuitBreaker: 25,
  /** A header's JSON text: a number, three hashes and the digest logs. The recorded ones are under 700 characters; 64 KiB leaves room for many logs. */
  header: 64 * 1024,
});
export type StorageKind = Exclude<keyof typeof CAPS, "metadata" | "header">;

/** A block hash: 0x and 64 lower case hex digits. */
const HASH = /^0x[0-9a-f]{64}$/;
/** A block number as a node writes it in a header: a hex quantity of a u32, no leading zeros. */
const NUMBER = /^0x(?:0|[1-9a-f][0-9a-f]{0,7})$/;
/** The largest block number a chain read takes: a u32. */
const U32_MAX = 0xffffffff;

/** The words of what a transport threw: an Error's text message, read inside its own guard (rule X4), or "the transport failed". */
function thrownWords(e: unknown): string {
  try {
    const m = e instanceof Error ? e.message : undefined;
    return typeof m === "string" ? serverText(m) : "the transport failed";
  } catch {
    return "the transport failed";
  }
}

/** One call, its throw turned into unknown with the method's name and the node's words, through server-text.ts. */
async function call(t: Transport, method: ReadMethod, params: readonly unknown[]): Promise<Got<unknown>> {
  try {
    return known(await t(method, params));
  } catch (e) {
    return unknown(`${method}: ${thrownWords(e)}`);
  }
}

/** The length of a header's JSON text, or null when it cannot be measured (rule X4). */
function measured(h: object): number | null {
  try {
    const text = JSON.stringify(h);
    return typeof text === "string" ? text.length : null;
  } catch {
    return null;
  }
}

/** A hash answer, or unknown. */
function hashOf(method: ReadMethod, a: unknown): Got<string> {
  return typeof a === "string" && HASH.test(a) ? known(a) : unknown(`${method}: the answer is not a 32 byte hash`);
}

/** Bytes, or unknown: a hex text of at most cap bytes. */
function bytesWithin(method: ReadMethod, what: string, a: unknown, cap: number): Got<Uint8Array> {
  if (typeof a !== "string") return unknown(`${method}: the answer for ${what} is not text`);
  if (a.length > 2 + 2 * cap) return unknown(`${method}: the answer for ${what} is more than its cap of ${cap} bytes`);
  if (!isHex(a)) return unknown(`${method}: the answer for ${what} is not 0x and an even number of lower case hex digits`);
  return known(bytesOf(a));
}

/** A block number, checked to be a safe integer of a u32. */
const blockNumber = (n: number): boolean => Number.isSafeInteger(n) && n >= 0 && n <= U32_MAX;

/** The finalized head's hash. */
export async function finalizedHead(t: Transport): Promise<Got<string>> {
  const a = await call(t, "chain_getFinalizedHead", []);
  return a.kind === "unknown" ? a : hashOf("chain_getFinalizedHead", a.value);
}
freezeFunction(finalizedHead);

/** What a read takes from a header: its number and its parent's hash. */
export interface Header {
  readonly number: number;
  readonly parentHash: string;
}

/** The header of the block of a hash. A node that holds no such block answers null: unknown. */
export async function header(t: Transport, hash: string): Promise<Got<Header>> {
  const a = await call(t, "chain_getHeader", [hash]);
  if (a.kind === "unknown") return a;
  const h = a.value;
  if (h === null) return unknown(`chain_getHeader: the node holds no block ${hash}`);
  if (typeof h !== "object" || Array.isArray(h)) return unknown("chain_getHeader: the answer is not a header");
  const size = measured(h);
  if (size === null) return unknown("chain_getHeader: the answer cannot be measured");
  if (size > CAPS.header) return unknown(`chain_getHeader: the answer is more than its cap of ${CAPS.header} characters`);
  const { number, parentHash } = h as { number?: unknown; parentHash?: unknown };
  if (typeof number !== "string" || !NUMBER.test(number)) return unknown("chain_getHeader: the header's number is not a hex quantity of a u32");
  if (typeof parentHash !== "string" || !HASH.test(parentHash)) return unknown("chain_getHeader: the header's parentHash is not a 32 byte hash");
  return known({ number: Number.parseInt(number.slice(2), 16), parentHash });
}
freezeFunction(header);

/** The canonical hash at a height. A node that holds no block there answers null: unknown. */
export async function blockHash(t: Transport, number: number): Promise<Got<string>> {
  if (!blockNumber(number)) return unknown("chain_getBlockHash: the block number is not a u32");
  const a = await call(t, "chain_getBlockHash", [number]);
  if (a.kind === "unknown") return a;
  if (a.value === null) return unknown(`chain_getBlockHash: the node holds no block at ${number}`);
  return hashOf("chain_getBlockHash", a.value);
}
freezeFunction(blockHash);

/** The value under a storage key at a block: its bytes, or null when the node holds none there. */
export async function storage(t: Transport, kind: StorageKind, key: Uint8Array, at: string): Promise<Got<Uint8Array | null>> {
  const a = await call(t, "state_getStorage", [hexOf(key), at]);
  if (a.kind === "unknown") return a;
  if (a.value === null) return known(null);
  return bytesWithin("state_getStorage", kind, a.value, CAPS[kind]);
}
freezeFunction(storage);

/** The metadata at a block. */
export async function metadata(t: Transport, at: string): Promise<Got<Uint8Array>> {
  const a = await call(t, "state_getMetadata", [at]);
  return a.kind === "unknown" ? a : bytesWithin("state_getMetadata", "the metadata", a.value, CAPS.metadata);
}
freezeFunction(metadata);
