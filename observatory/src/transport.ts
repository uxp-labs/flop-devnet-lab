// How a live read reaches the network: one small interface, so the source that reads the chain
// never knows whether its answers come from the network (src/net.ts) or from a tape (src/tape.ts).
//
// Every request goes through one of three calls. A tape records exactly these, in the order they
// were made, so a run can be replayed and checked.
import { MAX_NESTING, duplicateKey, nestingDepth } from "./strict.js";
import type { HttpResult, Trust } from "./types.js";

export interface Transport {
  /** How far the answers can be trusted: "trusted RPC" for the network, "fixture" for a tape. */
  readonly trust: Trust;
  /** Short description of where the answers come from, for the run pin. */
  readonly label: string;
  /**
   * One JSON-RPC call. Resolves with the answer's result. Rejects with a TransportError when the
   * call failed on the way (no socket, a timeout, an answer too large or not JSON, an RPC error).
   * Any other rejection (a refused method, a tape that does not match) is not a failed read.
   */
  rpc(method: string, params: readonly unknown[]): Promise<unknown>;
  /** One GET. A failure on the way is in the result (http null, error set), never a rejection. */
  httpGet(url: string): Promise<HttpResult<unknown>>;
  /** The time now, ISO 8601 with a zone. */
  now(): string;
  /** Ends the run: closes the socket, if any. */
  close(): void;
}

/** A request that failed on the way. Its message is what the reading reports as its error. */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * A JSON text read the way a saved reading is read (RULES.md 1.1, census clause 12): strict UTF-8
 * with a byte order mark kept, so a mark refuses, nested at most 64 levels, checked before the
 * parser runs, and no key twice in one object. Gives the value, or the reason it is not one.
 */
export function strictJson(bytes: Uint8Array): { value: unknown } | { problem: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { problem: "not valid UTF-8" };
  }
  if (nestingDepth(text) > MAX_NESTING) return { problem: `nested deeper than ${MAX_NESTING} levels` };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: "not valid JSON" };
  }
  const twice = duplicateKey(text);
  if (twice !== null) return { problem: `the key ${JSON.stringify(twice)} appears twice in one object` };
  return { value };
}
