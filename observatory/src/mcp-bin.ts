#!/usr/bin/env node
// Newline-delimited JSON-RPC over stdio. Usage: flop-observatory-mcp <snapshot.json>
// Reads the snapshot once. Writes nothing but protocol lines on stdout.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { feedText } from "./feed.js";
import { handleLine } from "./mcp.js";
import { hashSnapshot } from "./store.js";
import { MAX_NESTING, duplicateKey, nestingDepth } from "./strict.js";
import type { Snapshot } from "./types.js";

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: flop-observatory-mcp <snapshot.json>\n");
  process.exit(2);
}
let snapshot: Snapshot;
try {
  // Read as the snapshot command wrote it, so the snapshot served is the one that was hashed:
  // strict UTF-8 with a byte order mark kept (so it refuses), nesting checked before parsing, one
  // value per key, and the text byte for byte in the feed format. A key twice, a bad byte read as
  // U+FFFD, an integer past 2^53 - 1 that JSON.parse rounds, or any other spelling of the same
  // values could each be read two ways.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch (e) {
    if (e instanceof TypeError) throw new Error("it is not valid UTF-8");
    throw e;
  }
  if (nestingDepth(text) > MAX_NESTING) throw new Error(`it nests deeper than ${MAX_NESTING} levels`);
  try {
    snapshot = JSON.parse(text) as Snapshot;
  } catch {
    throw new Error("it is not JSON");
  }
  const twice = duplicateKey(text);
  if (twice !== null) throw new Error(`it holds the key ${JSON.stringify(twice)} twice in one object`);
  if (feedText(snapshot) !== text) throw new Error("it is not in the written form (keys sorted, two-space indent, one trailing newline)");
} catch (e) {
  process.stderr.write(`cannot read snapshot ${path}: ${(e as Error).message}; refusing to serve it\n`);
  process.exit(2);
}
// Only an observatory snapshot is served: an object that merely hashes to its own hash field
// would make every tool answer about nothing.
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const part = (v: unknown, schema: string): boolean => isObject(v) && v.schema === schema;
const shaped =
  isObject(snapshot) &&
  snapshot.schema === "flop-observatory/snapshot@0" &&
  typeof snapshot.observed_at === "string" &&
  typeof snapshot.trust === "string" &&
  isObject(snapshot.pin) &&
  part(snapshot.status, "flop-observatory/network-status@0") &&
  Array.isArray(snapshot.escrows) &&
  snapshot.escrows.every((e) => part(e, "flop-observatory/escrow-state@0") && typeof e.escrow_id === "string") &&
  (snapshot.census === null || part(snapshot.census, "flop-observatory/census@0")) &&
  (snapshot.drift === null || part(snapshot.drift, "flop-observatory/drift@0"));
if (!shaped) {
  process.stderr.write(`snapshot ${path} is not an observatory snapshot; refusing to serve it\n`);
  process.exit(2);
}
if (snapshot.hash !== hashSnapshot(snapshot)) {
  process.stderr.write(`snapshot ${path} fails its hash check; refusing to serve it\n`);
  process.exit(2);
}
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const out = handleLine(line, { snapshot });
  if (out !== null) process.stdout.write(out + "\n");
});
