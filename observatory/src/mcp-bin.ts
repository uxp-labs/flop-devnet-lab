#!/usr/bin/env node
// Newline-delimited JSON-RPC over stdio. Usage: flop-observatory-mcp <snapshot.json>
// Reads the snapshot once. Writes nothing but protocol lines on stdout.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { handleLine } from "./mcp.js";
import { hashSnapshot } from "./store.js";
import type { Snapshot } from "./types.js";

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: flop-observatory-mcp <snapshot.json>\n");
  process.exit(2);
}
let snapshot: Snapshot;
try {
  snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
} catch (e) {
  process.stderr.write(`cannot read snapshot ${path}: ${(e as Error).message}\n`);
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
