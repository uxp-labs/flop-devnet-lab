// Tapes changed for a test, each change synthetic and said in the test that makes it.
import { canonicalJson } from "../../src/store.js";
import type { TapeAnswer } from "../../src/tape.js";

/**
 * A tape's text with the anchor read back, chain_getBlockHash(height), answered as given, placed
 * where a live run makes that call: after the head calls, before the snapshot clock, the tape's last
 * entry. Every seq after it moves on by one. A tape recorded before runs read an anchor holds no such
 * call, so the answer is made up: synthetic, as the test that uses it says.
 */
export function withAnchorAnswer(text: string, height: number, answer: TapeAnswer): string {
  const lines = text.split("\n");
  if (lines.pop() !== "") throw new Error("a tape ends with a newline");
  const [schema, ...entries] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const clock = entries.pop();
  if (clock === undefined || (clock.request as { kind?: unknown }).kind !== "now") throw new Error("a live tape ends with the snapshot clock");
  const anchor = { answer, request: { kind: "rpc", method: "chain_getBlockHash", params: [height] }, seq: entries.length };
  const out = [schema, ...entries, anchor, { ...clock, seq: entries.length + 1 }];
  return out.map((e) => canonicalJson(e) + "\n").join("");
}
