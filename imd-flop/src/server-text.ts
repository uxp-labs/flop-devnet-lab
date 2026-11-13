/**
 * Server text for a message, the one rule for it. Moved out of gateway.ts unchanged (P2, rule B1), so the gateway
 * and the node transport (node-rpc.ts) quote server text the same way.
 */
import { outsideText, type Mark } from "./secrets.js";

/** The most characters of one server text a message quotes. */
const SERVER_TEXT_MAX = 200;

/**
 * Server text (an error message a server or the transport wrote) for a message: through secrets.ts
 * outsideText, cut to SERVER_TEXT_MAX, with every form of the given marks replaced. Every message here that
 * quotes server text quotes it through this (swarm audit 33f3b9f, finding 3).
 */
export function serverText(text: unknown, marks: Mark[] = []): string {
  return outsideText(text, { marks, max: SERVER_TEXT_MAX });
}
