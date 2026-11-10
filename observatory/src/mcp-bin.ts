#!/usr/bin/env node
// Newline-delimited JSON-RPC over stdio. Usage: flop-observatory-mcp <snapshot.json>
// Reads the snapshot once. Writes nothing but protocol lines on stdout.
import { createInterface } from "node:readline";
import { feedText } from "./feed.js";
import { NotARegularFile, readRegularFile } from "./files.js";
import { handleLine } from "./mcp.js";
import { checkSnapshot } from "./snapshot-check.js";
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
  // values could each be read two ways. Only a regular file is read: a named pipe would leave the
  // server waiting for ever (src/files.ts).
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readRegularFile(path));
  } catch (e) {
    if (e instanceof TypeError) throw new Error("it is not valid UTF-8");
    if (e instanceof NotARegularFile) throw new Error("it is not a regular file");
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
// would make every tool answer about nothing. src/snapshot-check.ts holds every check and its name
// (RULES.md section 5), and a refusal names the checks the file breaks.
const broken = checkSnapshot(snapshot);
if (broken.length > 0) {
  const named = broken.length > 5 ? `${broken.slice(0, 5).join(", ")} and ${broken.length - 5} more` : broken.join(", ");
  process.stderr.write(`snapshot ${path} is not an observatory snapshot; refusing to serve it (it breaks ${named})\n`);
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
