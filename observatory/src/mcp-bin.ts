#!/usr/bin/env node
// Newline-delimited JSON-RPC over stdio. Usage: flop-observatory-mcp <snapshot.json>
// Reads the snapshot once. Writes nothing but protocol lines on stdout.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { feedText } from "./feed.js";
import { handleLine } from "./mcp.js";
import { hashSnapshot } from "./store.js";
import { MAX_NESTING, duplicateKey, nestingDepth, parseZoned } from "./strict.js";
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
// would make every tool answer about nothing. Every object in the snapshot but the census and the
// drift report holds exactly its schema's fields with its schema's types (round 8 review I1,
// sixth rerun U1), and the values the settlement rules tie together agree: what each check is,
// RULES.md section 5 lists, and it is all the binary checks.
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const part = (v: unknown, schema: string): boolean => isObject(v) && v.schema === schema;
const exactly = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const SNAPSHOT_KEYS = ["schema", "seq", "prev_hash", "hash", "observed_at", "trust", "pin", "status", "escrows", "census", "drift"];
const PIN_KEYS = ["source_sha", "source", "genesis", "finalized_height", "finalized_hash", "node"];
const STATUS_KEYS = ["schema", "observed_at", "trust", "genesis", "reset_detected", "conflicts", "finalized_height", "finalized_hash", "best_height", "finality_lag", "runtime_version", "rpc", "gateway", "faucet"];
const SERVICE_KEYS = ["health", "http", "detail", "observed_at"];
const ESCROW_KEYS = ["schema", "escrow_id", "state", "evidence", "notes", "finalized_height", "observed_at", "trust", "scope"];
const EVIDENCE_KEYS = ["event", "block_hash", "block_number", "event_index", "genesis"];
const STATES = ["unverified", "funded", "claimed", "refunded"];
const TRUSTS = ["trusted RPC", "fixture"];
const HEALTHS = ["ok", "degraded", "down", "unknown"];
const OPENED = "hasStation.EscrowOpened";
const RELEASED = "hasStation.EscrowReleased";
const REFUNDED = "hasStation.EscrowRefunded";
const HASH = /^0x[0-9a-f]{64}$/;
const hash = (v: unknown): boolean => typeof v === "string" && HASH.test(v);
const hashOrNull = (v: unknown): boolean => v === null || hash(v);
const heightOrNull = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
const textOrNull = (v: unknown): boolean => v === null || typeof v === "string";
// An HTTP status as the status keeps it: any safe integer (RULES.md 1.1), not only one from 0 (seventh rerun U1).
const statusCodeOrNull = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isSafeInteger(v));
const flagOrNull = (v: unknown): boolean => v === null || typeof v === "boolean";
const texts = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
const time = (v: unknown): boolean => parseZoned(v) !== null;
// A service holds its health as one of the four words (round 9 review L6) and every field of its
// schema with its type (sixth rerun U1: rpc, gateway and faucet holding only a health word).
const service = (v: unknown, extra: readonly string[]): v is Record<string, unknown> =>
  isObject(v) && exactly(v, [...SERVICE_KEYS, ...extra]) && HEALTHS.includes(v.health as string) && statusCodeOrNull(v.http) && textOrNull(v.detail) && textOrNull(v.observed_at);
const lagOf = (finalized: unknown, best: unknown): number | null =>
  typeof finalized === "number" && typeof best === "number" && best >= finalized ? best - finalized : null;
const limits = (v: unknown): boolean => v === null || (isObject(v) && Object.values(v).every((x) => typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))));
const statusShaped = (st: unknown): boolean =>
  isObject(st) &&
  st.schema === "flop-observatory/network-status@0" &&
  exactly(st, STATUS_KEYS) &&
  time(st.observed_at) &&
  TRUSTS.includes(st.trust as string) &&
  (st.reset_detected === null || typeof st.reset_detected === "boolean") &&
  texts(st.conflicts) &&
  heightOrNull(st.finalized_height) &&
  hashOrNull(st.finalized_hash) &&
  heightOrNull(st.best_height) &&
  heightOrNull(st.finality_lag) &&
  heightOrNull(st.runtime_version) &&
  isObject(st.genesis) &&
  exactly(st.genesis, ["pinned", "faucet", "rpc"]) &&
  hash(st.genesis.pinned) &&
  hashOrNull(st.genesis.faucet) &&
  hashOrNull(st.genesis.rpc) &&
  service(st.rpc, ["stale"]) &&
  flagOrNull(st.rpc.stale) &&
  service(st.gateway, []) &&
  service(st.faucet, ["ready", "limits"]) &&
  flagOrNull(st.faucet.ready) &&
  limits(st.faucet.limits) &&
  // reset_detected says what the genesis values allow (RULES.md 1.1, round 10 review I3): false
  // only with both readings on the pinned genesis, true only with one on another.
  (st.reset_detected !== false || (st.genesis.faucet === st.genesis.pinned && st.genesis.rpc === st.genesis.pinned)) &&
  (st.reset_detected !== true || (st.genesis.faucet !== null && st.genesis.faucet !== st.genesis.pinned) || (st.genesis.rpc !== null && st.genesis.rpc !== st.genesis.pinned)) &&
  // false only from a usable RPC head, which has a finalized height and a best height (sixth rerun U1).
  (st.reset_detected !== false || (st.finalized_height !== null && st.best_height !== null)) &&
  // The lag is the best height less the finalized one, when both are read and in that order.
  st.finality_lag === lagOf(st.finalized_height, st.best_height);
const evidenceShaped = (v: unknown): boolean =>
  isObject(v) &&
  exactly(v, EVIDENCE_KEYS) &&
  [OPENED, RELEASED, REFUNDED].includes(v.event as string) &&
  hash(v.block_hash) &&
  heightOrNull(v.block_number) &&
  typeof v.event_index === "number" &&
  Number.isSafeInteger(v.event_index) &&
  v.event_index >= 0 &&
  hash(v.genesis);
const escrowShaped = (e: unknown): boolean =>
  isObject(e) &&
  e.schema === "flop-observatory/escrow-state@0" &&
  exactly(e, ESCROW_KEYS) &&
  // The one form the snapshot command takes and get_escrow_state answers for (round 9 review L6).
  hash(e.escrow_id) &&
  STATES.includes(e.state as string) &&
  Array.isArray(e.evidence) &&
  e.evidence.every(evidenceShaped) &&
  texts(e.notes) &&
  heightOrNull(e.finalized_height) &&
  time(e.observed_at) &&
  TRUSTS.includes(e.trust as string) &&
  e.scope === "settlement only; says nothing about output quality";
/** The events a state rests on (RULES.md section 2): one open for funded, one release or one refund and at most one open for claimed or refunded, none for unverified. */
const restsOnItsEvents = (e: { state: string; evidence: { event: string }[] }): boolean => {
  const count = (name: string): number => e.evidence.filter((x) => x.event === name).length;
  const [opens, releases, refunds] = [count(OPENED), count(RELEASED), count(REFUNDED)];
  if (e.state === "unverified") return e.evidence.length === 0;
  if (e.state === "funded") return opens === 1 && releases === 0 && refunds === 0;
  if (e.state === "claimed") return releases === 1 && refunds === 0 && opens <= 1;
  if (e.state === "refunded") return refunds === 1 && releases === 0 && opens <= 1;
  // A state off the four words is the state check's to refuse.
  return true;
};
const shaped =
  isObject(snapshot) &&
  snapshot.schema === "flop-observatory/snapshot@0" &&
  exactly(snapshot as unknown as Record<string, unknown>, SNAPSHOT_KEYS) &&
  Number.isSafeInteger(snapshot.seq) &&
  snapshot.seq >= 0 &&
  // The first line of a log has no line before it, and every other line names one.
  (snapshot.seq === 0 ? snapshot.prev_hash === null : typeof snapshot.prev_hash === "string" && /^[0-9a-f]{64}$/.test(snapshot.prev_hash)) &&
  time(snapshot.observed_at) &&
  TRUSTS.includes(snapshot.trust as string) &&
  isObject(snapshot.pin) &&
  exactly(snapshot.pin as unknown as Record<string, unknown>, PIN_KEYS) &&
  // The revision as the snapshot command was given it, which check.sh gives as unknown outside a
  // git checkout: text or none, not only a full sha (seventh rerun U1).
  textOrNull(snapshot.pin.source_sha) &&
  typeof snapshot.pin.source === "string" &&
  hashOrNull(snapshot.pin.genesis) &&
  heightOrNull(snapshot.pin.finalized_height) &&
  hashOrNull(snapshot.pin.finalized_hash) &&
  typeof snapshot.pin.node === "string" &&
  statusShaped(snapshot.status) &&
  Array.isArray(snapshot.escrows) &&
  snapshot.escrows.every(escrowShaped) &&
  // Each escrow once, so get_escrow_state has one answer for each id the list shows.
  new Set(snapshot.escrows.map((e) => e.escrow_id)).size === snapshot.escrows.length &&
  snapshot.escrows.every(
    (e) =>
      // A state rests on its own events, all finalized on the pinned genesis (RULES.md section 2;
      // round 10 review I3, sixth rerun U1).
      restsOnItsEvents(e) &&
      e.evidence.every((x) => x.genesis === snapshot.status?.genesis?.pinned) &&
      // The bound is the status's finalized height or none, and no evidence lies above it.
      (e.finalized_height === null || e.finalized_height === snapshot.status?.finalized_height) &&
      // and it comes only from a head on the pinned genesis (seventh rerun U7).
      (e.finalized_height === null || snapshot.status?.genesis?.rpc === snapshot.status?.genesis?.pinned) &&
      e.evidence.every((x) => e.finalized_height === null || x.block_number === null || x.block_number <= (e.finalized_height as number)),
  ) &&
  // One finalized event is evidence once: it names one escrow, and is one event of it (RULES.md
  // section 2, seventh rerun U7).
  new Set(snapshot.escrows.flatMap((e) => e.evidence.map((x) => `${x.block_hash} ${x.event_index}`))).size ===
    snapshot.escrows.reduce((n, e) => n + e.evidence.length, 0) &&
  (snapshot.census === null || part(snapshot.census, "flop-observatory/census@0")) &&
  (snapshot.drift === null || part(snapshot.drift, "flop-observatory/drift@0")) &&
  // The pin names the chain point the status read (snapshot.ts builds it from the status).
  snapshot.pin.genesis === snapshot.status?.genesis?.rpc &&
  snapshot.pin.finalized_height === snapshot.status?.finalized_height &&
  snapshot.pin.finalized_hash === snapshot.status?.finalized_hash &&
  // One fixture part makes the whole snapshot a fixture (snapshot.ts takes the weakest label).
  (![snapshot.status, ...snapshot.escrows, snapshot.census, snapshot.drift].some((x) => isObject(x) && x.trust === "fixture") || snapshot.trust === "fixture");
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
