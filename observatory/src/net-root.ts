// The composition root of every network read: the one module in src that names the global socket
// class and the global HTTP call, each once, as the options of the one NetTransport it makes
// (RULES.md section 4 and scripts/source-scan.mjs hold it to that form). The live command
// (src/live-bin.ts) and the recorder (src/record-bin.ts) each take their one transport from here,
// so both reach the network by the same code: the guard, the allow list, the limits, one socket.
import { NetTransport } from "./net.js";

/**
 * The real transport. answerLimits states a larger answer limit for named RPC methods (src/net.ts
 * caps each at MAX_STATED_ANSWER_BYTES); the live command states none.
 */
export function realTransport(answerLimits?: ReadonlyMap<string, number>): NetTransport {
  return new NetTransport({ socketClass: WebSocket, httpCall: fetch, answerLimits });
}
