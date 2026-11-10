#!/usr/bin/env node
// Newline-delimited JSON-RPC over stdio. Usage: flop-observatory-mcp <snapshot.json>
// Reads the snapshot once. Writes nothing but protocol lines on stdout.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { handleLine } from "./mcp.js";
import { hashSnapshot } from "./store.js";
import { duplicateKey } from "./strict.js";
import type { Snapshot } from "./types.js";

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: flop-observatory-mcp <snapshot.json>\n");
  process.exit(2);
}
let snapshot: Snapshot;
try {
  // Strict UTF-8 and one value per key: a byte read as U+FFFD, or a key whose two copies two
  // readers resolve differently, would serve a snapshot other than the one that was hashed.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (e) {
    if (e instanceof TypeError) throw new Error("it is not valid UTF-8");
    throw e;
  }
  snapshot = JSON.parse(text) as Snapshot;
  const twice = duplicateKey(text);
  if (twice !== null) throw new Error(`it holds the key ${JSON.stringify(twice)} twice in one object`);
} catch (e) {
  process.stderr.write(`cannot read snapshot ${path}: ${(e as Error).message}; refusing to serve it\n`);
  process.exit(2);
}
// Only an observatory snapshot is served: an object that merely hashes to its own hash field
// would make every tool answer about nothing.
const shaped =
  snapshot !== null &&
  typeof snapshot === "object" &&
  snapshot.schema === "flop-observatory/snapshot@0" &&
  snapshot.status !== null &&
  typeof snapshot.status === "object" &&
  Array.isArray(snapshot.escrows) &&
  typeof snapshot.census === "object" &&
  typeof snapshot.drift === "object";
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
