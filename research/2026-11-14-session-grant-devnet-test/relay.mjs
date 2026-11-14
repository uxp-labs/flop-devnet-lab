#!/usr/bin/env node
// Relays come from files (F14). The lead copies a relay the pane gave into a file of the run folder,
// "<run>/relays/<step>.<name>.txt", by the line plan.mjs next prints: this script's write, fed by a
// here document with a quoted delimiter (<<'RELAY_END'), so the shell changes nothing in it (a quote,
// a dollar sign or a backslash goes through as it is). Every command of this folder that takes a
// relay takes --<name>-file <path> and --<name>-sha256 <hex>, and reads it with readRelay: the file's
// content, with one trailing newline removed if there is one, must have that sha256 (takeRelay of
// the last batch does the check). No network, no key.
//
//   node relay.mjs write <path>     reads the relay from stdin and writes it to <path>
//
// The write refuses, and writes nothing, when stdin holds no relay or more than one line. A relay is
// the JSON text of one value (JSON.stringify writes no line break), so it is one line. A relay line
// equal to the delimiter ends the here document before the relay: stdin is then empty, and the write
// refuses it; the write also refuses a line equal to the delimiter wherever it comes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { takeRelay, RecordStepError } from "../2026-11-12-encoder-devnet-test/record-step.mjs";

export class RelayError extends Error {}
const no = (m) => { throw new RelayError(m); };

/** The delimiter of the here document plan.mjs prints. */
export const DELIMITER = "RELAY_END";

/** The file of a relay in a run folder. */
export const relayFile = (run, step, name) => join(run, "relays", `${step}.${name}.txt`);

/** A file's content as a relay: one trailing newline removed, if there is one. */
export const relayText = (content) => (content.endsWith("\n") ? content.slice(0, -1) : content);

/** The text a write takes from stdin, or a refusal. */
export function writable(input) {
  const text = relayText(String(input));
  if (text.length === 0) no(`no relay was given: stdin is empty (a relay line equal to ${DELIMITER} ends the here document before it). Nothing is written`);
  if (text.split("\n").some((l) => l === DELIMITER)) no(`a line of the relay is ${DELIMITER}, the delimiter. Nothing is written`);
  if (text.includes("\n")) no("the relay is more than one line: a relay of the pane is one line of JSON. Nothing is written");
  return text;
}

/** Writes a relay file from what stdin held; returns the relay text. */
export function writeRelay(path, input) {
  const text = writable(input);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text + "\n");
  return text;
}

/**
 * A relay from its file, checked against its sha256 by takeRelay of the last batch: { value, text }.
 * what names the flag, --<what>-file and --<what>-sha256.
 */
export function readRelay(path, sha256, what) {
  if (typeof path !== "string") no(`--${what}-file <path> is required`);
  if (!existsSync(path)) no(`the relay file ${path} is not there`);
  const text = relayText(readFileSync(path, "utf8"));
  try { return { value: takeRelay(text, sha256, what), text }; } catch (e) { if (e instanceof RecordStepError) no(`${path}: ${e.message}`); throw e; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const [cmd, path] = process.argv.slice(2);
    if (cmd !== "write" || !path) no("usage: node relay.mjs write <path>   (the relay on stdin)");
    const { sha256Text } = await import("./lib.mjs");
    const text = writeRelay(resolve(path), readFileSync(0, "utf8"));
    console.log(JSON.stringify({ wrote: resolve(path), relay_sha256: sha256Text(text) }));
  } catch (e) {
    process.stderr.write(`relay: ${e instanceof RelayError ? e.message : `failed (${e?.constructor?.name ?? typeof e})`}\n`);
    process.exit(2);
  }
}
