// The checks a snapshot must pass before the MCP binary serves it (RULES.md section 5).
//
// Every check has a name, and checkSnapshot returns the names of the checks a value breaks, in a
// fixed order. A refusal can then say which rule it broke, and a test can show that a snapshot
// built to break one rule breaks that rule and no other. There are two kinds:
// - shape: every object but the census and the drift report holds exactly its schema's fields,
//   each with its schema's type. An object whose set of fields is wrong is reported once, as
//   `<object>.fields`, and its values are not read.
// - agreement: values the settlement rules tie together agree with each other. They are read only
//   once every shape holds, so each one can read the snapshot as its type says.
// These are all the binary checks. The hash is checked apart, in src/mcp-bin.ts: it shows the file
// is the one that was hashed, not who wrote it.
import { own } from "./own.js";
import { parseZoned } from "./strict.js";
import type { EscrowState, Snapshot } from "./types.js";

type Check = (v: unknown) => boolean;
/** An object's fields in its schema's order, each with the check its value must pass. */
type Fields = readonly (readonly [string, Check])[];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const oneOf =
  (...words: readonly string[]): Check =>
  (v) =>
    typeof v === "string" && words.includes(v);
const exactlyThis =
  (word: string): Check =>
  (v) =>
    v === word;
const orNone =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);

// The value types the schemas use.
const text: Check = (v) => typeof v === "string";
const flag: Check = (v) => typeof v === "boolean";
const texts: Check = (v) => Array.isArray(v) && v.every(text);
const list: Check = (v) => Array.isArray(v);
const object: Check = (v) => isObject(v);
/** 0x plus 64 lower case hex: a genesis, block or escrow id. */
const hash: Check = (v) => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
/** 64 lower case hex: a snapshot hash. */
const sha256: Check = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
/** A height, a lag, a version or an index: a safe integer from 0. */
const count: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** An HTTP status as the status keeps it: any safe integer (RULES.md 1.1). */
const statusCode: Check = (v) => typeof v === "number" && Number.isSafeInteger(v);
/** A time with a zone and a real calendar date. */
const time: Check = (v) => parseZoned(v) !== null;
/** The faucet's limits: numbers and flags. */
const limits: Check = (v) => isObject(v) && Object.values(v).every((x) => typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x)));
const schemaPart =
  (schema: string): Check =>
  (v) =>
    isObject(v) && v.schema === schema;

const TRUSTS = ["trusted RPC", "fixture"] as const;
const HEALTHS = ["ok", "degraded", "down", "unknown"] as const;
const OPENED = "hasStation.EscrowOpened";
const RELEASED = "hasStation.EscrowReleased";
const REFUNDED = "hasStation.EscrowRefunded";

const SNAPSHOT: Fields = [
  ["schema", exactlyThis("flop-observatory/snapshot@0")],
  ["seq", count],
  ["prev_hash", orNone(sha256)],
  ["hash", sha256],
  ["observed_at", time],
  ["trust", oneOf(...TRUSTS)],
  ["pin", object],
  ["status", object],
  ["escrows", list],
  // The census and the drift report are checked for their schema only.
  ["census", orNone(schemaPart("flop-observatory/census@0"))],
  ["drift", orNone(schemaPart("flop-observatory/drift@0"))],
];
const PIN: Fields = [
  // The revision as the snapshot command was given it: check.sh gives unknown outside a checkout.
  ["source_sha", orNone(text)],
  ["source", text],
  ["genesis", orNone(hash)],
  ["finalized_height", orNone(count)],
  ["finalized_hash", orNone(hash)],
  ["node", text],
];
const STATUS: Fields = [
  ["schema", exactlyThis("flop-observatory/network-status@0")],
  ["observed_at", time],
  ["trust", oneOf(...TRUSTS)],
  ["genesis", object],
  ["reset_detected", orNone(flag)],
  ["conflicts", texts],
  ["finalized_height", orNone(count)],
  ["finalized_hash", orNone(hash)],
  ["best_height", orNone(count)],
  ["finality_lag", orNone(count)],
  ["runtime_version", orNone(count)],
  ["rpc", object],
  ["gateway", object],
  ["faucet", object],
];
const GENESIS: Fields = [
  ["pinned", hash],
  ["faucet", orNone(hash)],
  ["rpc", orNone(hash)],
];
const SERVICE: Fields = [
  ["health", oneOf(...HEALTHS)],
  ["http", orNone(statusCode)],
  ["detail", orNone(text)],
  ["observed_at", orNone(text)],
];
const RPC: Fields = [...SERVICE, ["stale", orNone(flag)]];
const FAUCET: Fields = [...SERVICE, ["ready", orNone(flag)], ["limits", orNone(limits)]];
const ESCROW: Fields = [
  ["schema", exactlyThis("flop-observatory/escrow-state@0")],
  ["escrow_id", hash],
  ["state", oneOf("unverified", "funded", "claimed", "refunded")],
  ["evidence", list],
  ["notes", texts],
  ["finalized_height", orNone(count)],
  ["observed_at", time],
  ["trust", oneOf(...TRUSTS)],
  ["scope", exactlyThis("settlement only; says nothing about output quality")],
];
const EVIDENCE: Fields = [
  ["event", oneOf(OPENED, RELEASED, REFUNDED)],
  ["block_hash", hash],
  ["block_number", orNone(count)],
  ["event_index", count],
  ["genesis", hash],
];

/** Every object the shape checks read, by the name its checks carry, with the object it sits in. */
const OBJECTS: readonly (readonly [string, Fields])[] = [
  ["snapshot", SNAPSHOT],
  ["pin", PIN],
  ["status", STATUS],
  ["status.genesis", GENESIS],
  ["status.rpc", RPC],
  ["status.gateway", SERVICE],
  ["status.faucet", FAUCET],
  ["escrow", ESCROW],
  ["evidence", EVIDENCE],
];

/** Records the field checks one object breaks. True when its set of fields is exactly its schema's. */
function shape(name: string, v: unknown, fields: Fields, broken: Set<string>): v is Record<string, unknown> {
  const keys = fields.map(([k]) => k);
  if (!isObject(v) || Object.keys(v).length !== keys.length || !keys.every((k) => Object.hasOwn(v, k))) {
    broken.add(`${name}.fields`);
    return false;
  }
  for (const [key, check] of fields) if (!check(own(v, key))) broken.add(`${name}.${key}`);
  return true;
}

function shapes(s: unknown, broken: Set<string>): void {
  if (!shape("snapshot", s, SNAPSHOT, broken)) return;
  // A part that is not an object is the snapshot's field check to report; its own are not read.
  const part = (key: string): unknown => own(s, key);
  if (isObject(part("pin"))) shape("pin", part("pin"), PIN, broken);
  const status = part("status");
  if (isObject(status) && shape("status", status, STATUS, broken)) {
    if (isObject(own(status, "genesis"))) shape("status.genesis", own(status, "genesis"), GENESIS, broken);
    if (isObject(own(status, "rpc"))) shape("status.rpc", own(status, "rpc"), RPC, broken);
    if (isObject(own(status, "gateway"))) shape("status.gateway", own(status, "gateway"), SERVICE, broken);
    if (isObject(own(status, "faucet"))) shape("status.faucet", own(status, "faucet"), FAUCET, broken);
  }
  const escrows = part("escrows");
  if (!Array.isArray(escrows)) return;
  for (const e of escrows) {
    if (!shape("escrow", e, ESCROW, broken)) continue;
    const evidence = own(e, "evidence");
    if (Array.isArray(evidence)) for (const x of evidence) shape("evidence", x, EVIDENCE, broken);
  }
}

/** The best height less the finalized one, when both are read and in that order; else none. */
const lagOf = (finalized: number | null, best: number | null): number | null => (finalized !== null && best !== null && best >= finalized ? best - finalized : null);
const howMany = (e: EscrowState, event: string): number => e.evidence.filter((x) => x.event === event).length;
const ofState = (s: Snapshot, state: string): EscrowState[] => s.escrows.filter((e) => e.state === state);
const evidenceOf = (s: Snapshot) => s.escrows.flatMap((e) => e.evidence);

/** The values the settlement rules tie together, each a named rule over a snapshot whose shapes hold. */
const AGREEMENTS: readonly (readonly [string, (s: Snapshot) => boolean])[] = [
  // The first line of a log names no line before it, and every other line names one.
  ["snapshot.prev_hash-follows-seq", (s) => (s.seq === 0) === (s.prev_hash === null)],
  // reset_detected says what the readings allow (RULES.md 1.1).
  ["status.reset-false-on-the-pinned-genesis", (s) => s.status.reset_detected !== false || (s.status.genesis.faucet === s.status.genesis.pinned && s.status.genesis.rpc === s.status.genesis.pinned)],
  ["status.reset-false-with-both-heights", (s) => s.status.reset_detected !== false || (s.status.finalized_height !== null && s.status.best_height !== null)],
  [
    "status.reset-true-on-another-genesis",
    (s) => {
      const g = s.status.genesis;
      return s.status.reset_detected !== true || (g.faucet !== null && g.faucet !== g.pinned) || (g.rpc !== null && g.rpc !== g.pinned);
    },
  ],
  ["status.lag-adds-up", (s) => s.status.finality_lag === lagOf(s.status.finalized_height, s.status.best_height)],
  // Each escrow once, so get_escrow_state has one answer for each id the list shows.
  ["escrows.listed-once", (s) => new Set(s.escrows.map((e) => e.escrow_id)).size === s.escrows.length],
  // Each state rests on its own events (RULES.md section 2).
  ["escrow.unverified-holds-no-evidence", (s) => ofState(s, "unverified").every((e) => e.evidence.length === 0)],
  ["escrow.funded-on-one-open", (s) => ofState(s, "funded").every((e) => howMany(e, OPENED) === 1)],
  ["escrow.funded-with-no-release", (s) => ofState(s, "funded").every((e) => howMany(e, RELEASED) === 0)],
  ["escrow.funded-with-no-refund", (s) => ofState(s, "funded").every((e) => howMany(e, REFUNDED) === 0)],
  ["escrow.claimed-on-one-release", (s) => ofState(s, "claimed").every((e) => howMany(e, RELEASED) === 1)],
  ["escrow.claimed-with-no-refund", (s) => ofState(s, "claimed").every((e) => howMany(e, REFUNDED) === 0)],
  ["escrow.refunded-on-one-refund", (s) => ofState(s, "refunded").every((e) => howMany(e, REFUNDED) === 1)],
  ["escrow.refunded-with-no-release", (s) => ofState(s, "refunded").every((e) => howMany(e, RELEASED) === 0)],
  ["escrow.claimed-on-at-most-one-open", (s) => ofState(s, "claimed").every((e) => howMany(e, OPENED) <= 1)],
  ["escrow.refunded-on-at-most-one-open", (s) => ofState(s, "refunded").every((e) => howMany(e, OPENED) <= 1)],
  // Evidence counts only on the pinned genesis, and one finalized event is evidence once.
  ["evidence.on-the-pinned-genesis", (s) => evidenceOf(s).every((x) => x.genesis === s.status.genesis.pinned)],
  ["evidence.used-once", (s) => new Set(evidenceOf(s).map((x) => `${x.block_hash} ${x.event_index}`)).size === evidenceOf(s).length],
  // An escrow's bound is the status's finalized height or none, only from a head on the pinned
  // genesis, and no evidence lies above it.
  ["escrow.bound-is-the-status-height", (s) => s.escrows.every((e) => e.finalized_height === null || e.finalized_height === s.status.finalized_height)],
  ["escrow.bound-only-from-the-pinned-genesis", (s) => s.escrows.every((e) => e.finalized_height === null || s.status.genesis.rpc === s.status.genesis.pinned)],
  [
    "escrow.no-evidence-above-the-bound",
    (s) => s.escrows.every((e) => e.finalized_height === null || e.evidence.every((x) => x.block_number === null || x.block_number <= (e.finalized_height as number))),
  ],
  // The pin names the chain point the status read (snapshot.ts builds it from the status).
  ["pin.genesis-is-the-status-rpc-genesis", (s) => s.pin.genesis === s.status.genesis.rpc],
  ["pin.height-is-the-status-height", (s) => s.pin.finalized_height === s.status.finalized_height],
  ["pin.hash-is-the-status-hash", (s) => s.pin.finalized_hash === s.status.finalized_hash],
  // One fixture part makes the whole snapshot a fixture (snapshot.ts takes the weakest label).
  ["snapshot.fixture-when-a-part-is", (s) => s.trust === "fixture" || ![s.status, ...s.escrows, s.census, s.drift].some((x) => isObject(x) && x.trust === "fixture")],
];

/** Every check's name: each object's field set and fields, then each agreement. */
export const CHECKS: readonly string[] = [...OBJECTS.flatMap(([name, fields]) => [`${name}.fields`, ...fields.map(([k]) => `${name}.${k}`)]), ...AGREEMENTS.map(([name]) => name)];

/** The names of the checks the value breaks, in CHECKS order; empty when it is a snapshot the binary serves. */
export function checkSnapshot(value: unknown): string[] {
  const broken = new Set<string>();
  shapes(value, broken);
  if (broken.size === 0) for (const [name, ok] of AGREEMENTS) if (!ok(value as Snapshot)) broken.add(name);
  return CHECKS.filter((name) => broken.has(name));
}
