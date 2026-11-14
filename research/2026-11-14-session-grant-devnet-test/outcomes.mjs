// The send outcomes of this batch (H11, F1): the immortal rows of the last batch's send_outcomes,
// imported by steps.json send_outcomes_from, and the one action each row names for an immortal
// step. The action is read from the row's own words and from nothing else: no branch of these tools
// decides what follows an outcome. outcomeRow of the last batch picks the row of a runner reading.
// Pure. No network, no key.
import { join } from "node:path";
import { REPO, atPath, readJson } from "./lib.mjs";
import { outcomeRow, NODE_CODES } from "../2026-11-12-encoder-devnet-test/plan.mjs";

export { outcomeRow, NODE_CODES };

/** The kinds of action a row can name: the lead's stop, the same bytes again, a find first, the first send again, or record the reading. */
export const KINDS = ["stop", "sendSame", "find", "send", "record"];

/** The immortal rows of the last batch's send_outcomes (H11): second_copy keeps its immortal part only. */
export function immortalRows(plan) {
  const rows = atPath(readJson(join(REPO, plan.files[plan.send_outcomes_from.file])), plan.send_outcomes_from.path);
  return rows.map((r) => {
    const m = /Immortal: (.*)$/.exec(r.second_copy);
    return { ...r, second_copy: m ? m[1] : r.second_copy };
  });
}

/**
 * The clause of a row's lead words that applies to an immortal step after a reading sent by
 * `sentBy` (send or sendSame). A row's words may name a condition ("After a first send: ...",
 * "After a sendSame ...: ..."); only the clause of that condition is read then. Inside a clause,
 * "mortal: ... Immortal: ..." keeps the immortal part, and "...; for a mortal step ..." drops the
 * mortal part.
 */
export function immortalClause(row, sentBy) {
  const sentences = String(row.lead).split(/\.\s+/);
  const first = sentences.find((s) => /^After a first send: /.test(s));
  const again = sentences.find((s) => /^After a sendSame\b[^:]*: /.test(s));
  let text;
  if (first && sentBy === "send") text = first.replace(/^After a first send: /, "");
  else if (again && sentBy === "sendSame") text = again.replace(/^After a sendSame\b[^:]*: /, "");
  else text = sentences.filter((s) => s !== first && s !== again).join(". ");
  const imm = /\bImmortal: (.*)$/.exec(text);
  if (imm) text = imm[1];
  return text.split(/;\s*/).filter((p) => !/^for a mortal step\b/.test(p)).join("; ");
}

const ACTIONS = [
  ["stop", /record-step\.mjs stop\b(?! allows)|the lead stops/],
  ["find", /lab\.find\b|\bfind\b/],
  ["sendSame", /lab\.sendSame\b/],
  ["send", /lab\.send\b(?!Same)|relay the send file/],
  ["record", /record-step\.mjs step --sent/],
];

/**
 * The action a row names for an immortal step: the first of the actions named in its immortal
 * clause, by place in the words. A clause that says "as <outcome>" and names no action is that
 * row's. Returns { kind, case, words } (case: the letter of the lead's stop the row names), or
 * throws when the row names none: then these tools cannot say what follows.
 */
export function actionOf(rows, row, sentBy) {
  const text = immortalClause(row, sentBy);
  let best = null;
  for (const [kind, re] of ACTIONS) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.at)) best = { kind, at: m.index };
  }
  if (!best) {
    const as = /\bas ([a-z-]+)\b/.exec(text);
    const ref = as ? rows.find((r) => r.outcome === as[1]) : null;
    if (ref && ref !== row) return { ...actionOf(rows, ref, sentBy), words: text, as: ref.outcome };
    throw new Error(`the row ${row.outcome} names no action for an immortal step: ${text}`);
  }
  const c = /\bcase ([a-d]) of record-step\.mjs stop\b/.exec(text);
  return { kind: best.kind, case: best.kind === "stop" ? (c ? c[1] : null) : null, words: text };
}

/** The row and the action of a runner reading of an immortal step, or { row: null } when no row names it. */
export function sendOutcome(plan, sent) {
  const rows = immortalRows(plan);
  const row = outcomeRow({ send_outcomes: rows }, sent);
  if (!row) return { row: null, action: null };
  return { row, action: actionOf(rows, row, sent?.sent_by ?? null) };
}
