/**
 * The one place that opens a socket to a FLOP node: one JSON-RPC call over Node's built in WebSocket, one socket
 * per call. Moved out of gateway.ts (P2, rule B1), so the gateway's genesis check and the chain reads
 * (chain-read/node.ts) share it. The frame is read by outside-json.ts readOutsideJson, then by answerOf (the P2 fix
 * round, rule X1). It throws on a node error, a frame that is not an answer to the call, a timeout, a socket error
 * and a frame that is not JSON; it never quotes the frame.
 * Each caller hands its own limits (piece A1, audit note 9): a timeout and a frame cap in characters. A frame that is
 * not text, or a text longer than the cap, ends the call before anything is made of it. The cap stops the parse,
 * not the receive: the engine holds the whole frame by the time it is handed over. A socket that closes before an
 * answer ends the call at once.
 */
import { notJsonBecause, readOutsideJson } from "./outside-json.js";
import { plainInput } from "./plain-input.js";
import { serverText } from "./server-text.js";

/** The id of the one request a call sends, and so the id its answer must carry. */
export const CALL_ID = 1;

/** The words of a frame that is not an answer to the call. The frame itself is never quoted. */
export const NOT_AN_ANSWER = "rpc returned a frame that is not an answer to the call";

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * What a frame says of the call (rule X1). rpcCall's own: not exported, and handed only what readOutsideJson
 * returned for a text frame, which is plain data parsed from a JSON text (null, a boolean, a number, a text, a list or
 * an object of those, with no accessor and no prototype of the node's choosing). It never throws for such a value.
 * A frame with an own error key, whatever its value, is a failed call: an error that is an object with a text
 * message is quoted through server-text.ts, any other gives "rpc error". A frame ends the call with its result only
 * when it is an object that is not a list, its jsonrpc is exactly "2.0", its id is exactly CALL_ID and it has an own
 * result key; the result is then msg.result as it is, so null only when the node wrote null. Every other frame is not
 * an answer to the call.
 */
function answerOf(msg: unknown): { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string } {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return { ok: false, error: NOT_AN_ANSWER };
  const m = msg as Record<string, unknown>;
  if (own(m, "error")) {
    const e = m.error;
    const message = e !== null && typeof e === "object" && !Array.isArray(e) && own(e, "message") ? (e as Record<string, unknown>).message : undefined;
    return { ok: false, error: typeof message === "string" ? `rpc error: ${serverText(message)}` : "rpc error" };
  }
  if (m.jsonrpc !== "2.0" || m.id !== CALL_ID || !own(m, "result")) return { ok: false, error: NOT_AN_ANSWER };
  return { ok: true, result: m.result };
}

/**
 * The longest timeout rpcCall takes, in milliseconds. A timer holds at most this many milliseconds: a longer delay
 * fires after 1 ms, which would end the call at once instead of after its time.
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** The limits a caller hands rpcCall. Both are required whole numbers above 0. There is no default. */
export interface RpcLimits {
  /** How long the call waits for an answer, in milliseconds: at most MAX_TIMEOUT_MS (2147483647). */
  readonly timeoutMs: number;
  /** The longest frame text the call parses, in characters. */
  readonly maxFrameChars: number;
}

/** The shared input checks, refusing a caller's limits with an Error of their own words. */
const PLAIN = plainInput((_code, message) => {
  throw new Error(`rpc limits refused: ${message}`);
});

/** A copy of the caller's limits: an object with exactly the two fields, each a whole number above 0. */
function limitsOf(limits: unknown): RpcLimits {
  const f = PLAIN.takeFields(limits, ["timeoutMs", "maxFrameChars"], "the rpc limits");
  const timeoutMs = PLAIN.uintOf("u32", f.timeoutMs, "the rpc limits' timeoutMs");
  const maxFrameChars = PLAIN.uintOf("u32", f.maxFrameChars, "the rpc limits' maxFrameChars");
  if (timeoutMs === 0) throw new Error("rpc limits refused: the rpc limits' timeoutMs must be above 0");
  if (timeoutMs > MAX_TIMEOUT_MS) throw new Error(`rpc limits refused: the rpc limits' timeoutMs must be at most ${MAX_TIMEOUT_MS}`);
  if (maxFrameChars === 0) throw new Error("rpc limits refused: the rpc limits' maxFrameChars must be above 0");
  return { timeoutMs, maxFrameChars };
}

export function rpcCall(url: string, method: string, params: unknown[], limits: RpcLimits): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const { timeoutMs, maxFrameChars } = limitsOf(limits);
    const ws = new WebSocket(url);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(result);
    };
    timer = setTimeout(() => finish(new Error("rpc timeout")), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: CALL_ID, jsonrpc: "2.0", method, params }));
    ws.onmessage = (ev) => {
      // Before anything is made of the frame: it must be text, and no longer than the caller's cap.
      const data: unknown = ev.data;
      if (typeof data !== "string") return finish(new Error("rpc frame is not text"));
      if (data.length > maxFrameChars) return finish(new Error(`rpc frame of ${data.length} characters is over its cap of ${maxFrameChars}`));
      try {
        const a = answerOf(readOutsideJson(data));
        if (a.ok) finish(null, a.result);
        else finish(new Error(a.error));
      } catch (e) {
        // JSON.parse's own message quotes the frame: never repeat it.
        finish(new Error(notJsonBecause("rpc returned malformed JSON", e)));
      }
    };
    ws.onerror = () => {
      finish(new Error("rpc websocket error"));
    };
    // A close before an answer ends the call at once. A close after the call has settled does nothing.
    ws.onclose = () => {
      finish(new Error("rpc socket closed before an answer"));
    };
  });
}
