// A tape: the node's raw answers to the tool's own questions at one finalized head, read by
// session-reads.js in the pane and relayed to the PC with its sha256 (H4, H5). This file takes a
// relayed tape and serves it to the tool as its transport: it answers only from the tape, by method
// and params, and throws on any other question (a throw is unknown to the tool, never a default).
// The metadata question is answered with the committed 1014020 metadata bytes, and only when the
// tape's sha256 and length for it are the committed ones. No network, no key.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { REPO, HASH, V } from "./lib.mjs";
import { takeRelay } from "../2026-11-12-encoder-devnet-test/record-step.mjs";

export class TapeError extends Error {}
const no = (m) => { throw new TapeError(m); };

export const KINDS = ["session", "block"];

/** A relayed tape, checked against its sha256 (takeRelay of the last batch) and read in its form. */
export function takeTape(text, sha256) {
  let t;
  try { t = takeRelay(text, sha256, "tape"); } catch (e) { no(e.message); }
  if (!KINDS.includes(t.kind)) no(`the relay is not a tape of session-reads.js: its kind is ${JSON.stringify(t.kind ?? null)}`);
  if (!Array.isArray(t.tape) || !t.tape.every((c) => c && typeof c.method === "string" && Array.isArray(c.params) && ("result" in c || "error" in c))) no("the tape is not a list of { method, params, result or error }");
  if (!t.head || !Number.isSafeInteger(t.head.number) || !HASH.test(t.head.hash ?? "")) no("the tape names no finalized head (number and hash)");
  return t;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The tape's answer to a question, or undefined when it holds none. */
export const answerOf = (t, method, params) => t.tape.find((c) => c.method === method && same(c.params, params));

/** The block 0 hash the tape holds, or null. */
export const genesisOf = (t) => { const a = answerOf(t, "chain_getBlockHash", [0]); return a && typeof a.result === "string" ? a.result : null; };

const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");

let committed = null;
/**
 * The committed 1014020 metadata as 0x hex: the upgrade recording's answer that the facts file names
 * by sha256 and length, read by imd-flop/scripts/chain-table.mjs readSource(SOURCES[0]); held here
 * again to steps.json METADATA_SHA256 and METADATA_BYTES.
 */
export async function committedMetadata(plan) {
  if (committed) return committed;
  const { readSource, SOURCES } = await import(pathToFileURL(join(REPO, "imd-flop", "scripts", "chain-table.mjs")).href);
  const b = Buffer.from(readSource(SOURCES[0]).metadata);
  if (sha256Hex(b) !== V(plan, "METADATA_SHA256") || b.length !== Number(V(plan, "METADATA_BYTES"))) no("the committed metadata is not the one steps.json names");
  committed = { hex: `0x${b.toString("hex")}`, sha256: sha256Hex(b), length: b.length };
  return committed;
}

/** Whether the tape's metadata reading is the committed bytes': its sha256 and its length. */
export const metadataIsCommitted = (t, md) => !!t.metadata && t.metadata.sha256 === md.sha256 && t.metadata.length === md.length && HASH.test(t.metadata.at ?? "");

/**
 * The transport of a tape (H5). It answers a question the tape holds with that answer (a node error
 * the tape holds is thrown with the node's words); state_getMetadata at the tape's metadata block
 * with the committed bytes, only when metadataIsCommitted; anything else throws, and is logged in
 * `missed` so the caller can refuse a tape that does not answer the tool.
 */
export function tapeTransport(t, md, { asked = [], missed = [] } = {}) {
  return async (method, params) => {
    asked.push({ method, params });
    if (method === "state_getMetadata" && params.length === 1 && params[0] === t.metadata?.at) {
      if (!metadataIsCommitted(t, md)) { missed.push({ method, params, why: "the metadata's sha256 is not the committed one" }); throw new Error("the tape's metadata is not the committed bytes"); }
      return md.hex;
    }
    const a = answerOf(t, method, params);
    if (!a) { missed.push({ method, params, why: "not in the tape" }); throw new Error(`the tape holds no answer to ${method}`); }
    if ("error" in a) throw new Error(`the node said: ${a.error?.message ?? "an error"}`);
    return a.result;
  };
}
