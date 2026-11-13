/**
 * The one place that opens a socket to a FLOP node: one JSON-RPC call over Node's built in WebSocket, one socket
 * per call. Moved out of gateway.ts unchanged (P2, rule B1), so the gateway's genesis check and the chain reads
 * (chain-read/node.ts) share it. The frame is read by outside-json.ts readOutsideJson. It throws on a node error,
 * a timeout, a socket error and a frame that is not JSON; it never quotes the frame.
 */
import { notJsonBecause, readOutsideJson } from "./outside-json.js";
import { serverText } from "./server-text.js";

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
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }));
    ws.onmessage = (ev) => {
      try {
        const msg = readOutsideJson(String(ev.data)) as { result?: unknown; error?: { message?: string } };
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
          finish(new Error("rpc returned malformed JSON"));
          return;
        }
        // An error field is a failed read even when a result is also present.
        if (msg.error) {
          finish(new Error(`rpc error: ${serverText(msg.error.message ?? "rpc error")}`));
          return;
        }
        finish(null, msg.result ?? null);
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
