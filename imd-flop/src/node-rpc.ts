/**
 * The one place that opens a socket to a FLOP node: one JSON-RPC call over Node's built in WebSocket, one socket
 * per call. Moved out of gateway.ts (P2, rule B1), so the gateway's genesis check and the chain reads
 * (chain-read/node.ts) share it. The frame is read by outside-json.ts readOutsideJson, then by answerOf (the P2 fix
 * round, rule X1). It throws on a node error, a frame that is not an answer to the call, a timeout, a socket error
 * and a frame that is not JSON; it never quotes the frame.
 */
import { notJsonBecause, readOutsideJson } from "./outside-json.js";
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

export function rpcCall(url: string, method: string, params: unknown[], timeoutMs = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
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
      try {
        const a = answerOf(readOutsideJson(String(ev.data)));
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
  });
}
