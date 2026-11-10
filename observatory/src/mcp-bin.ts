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
// would make every tool answer about nothing. The status and each escrow, which get_status and
// get_escrow_state answer field by field, hold exactly their schema's fields, and the fields a
// caller branches on have their schema's types (round 8 review I1).
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const part = (v: unknown, schema: string): boolean => isObject(v) && v.schema === schema;
const exactly = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const STATUS_KEYS = ["schema", "observed_at", "trust", "genesis", "reset_detected", "conflicts", "finalized_height", "finalized_hash", "best_height", "finality_lag", "runtime_version", "rpc", "gateway", "faucet"];
const ESCROW_KEYS = ["schema", "escrow_id", "state", "evidence", "notes", "finalized_height", "observed_at", "trust", "scope"];
const STATES = ["unverified", "funded", "claimed", "refunded"];
const TRUSTS = ["trusted RPC", "fixture"];
const heightOrNull = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const statusShaped = (st: unknown): boolean =>
  isObject(st) &&
  st.schema === "flop-observatory/network-status@0" &&
  exactly(st, STATUS_KEYS) &&
  typeof st.observed_at === "string" &&
  TRUSTS.includes(st.trust as string) &&
  (st.reset_detected === null || typeof st.reset_detected === "boolean") &&
  Array.isArray(st.conflicts) &&
  heightOrNull(st.finalized_height) &&
  heightOrNull(st.best_height) &&
  isObject(st.genesis) &&
  isObject(st.rpc) &&
  isObject(st.gateway) &&
  isObject(st.faucet);
const escrowShaped = (e: unknown): boolean =>
  isObject(e) &&
  e.schema === "flop-observatory/escrow-state@0" &&
  exactly(e, ESCROW_KEYS) &&
  typeof e.escrow_id === "string" &&
  STATES.includes(e.state as string) &&
  Array.isArray(e.evidence) &&
  Array.isArray(e.notes) &&
  heightOrNull(e.finalized_height) &&
  typeof e.observed_at === "string" &&
  TRUSTS.includes(e.trust as string) &&
  e.scope === "settlement only; says nothing about output quality";
const shaped =
  isObject(snapshot) &&
  snapshot.schema === "flop-observatory/snapshot@0" &&
  typeof snapshot.observed_at === "string" &&
  typeof snapshot.trust === "string" &&
  isObject(snapshot.pin) &&
  statusShaped(snapshot.status) &&
  Array.isArray(snapshot.escrows) &&
  snapshot.escrows.every(escrowShaped) &&
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
