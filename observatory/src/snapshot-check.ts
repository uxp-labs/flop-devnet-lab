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
import { createHash } from "node:crypto";
import { own } from "./own.js";
import { ANCHOR_LOST } from "./status.js";
import { parseZoned } from "./strict.js";
import type { EscrowState, Snapshot, UpgradeWatch } from "./types.js";

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
/** 0x and lower case hex of whole bytes: storage bytes as answered. */
const hexBytes: Check = (v) => typeof v === "string" && /^0x(?:[0-9a-f]{2})*$/.test(v);
/** The most bytes a node's storage answer can hold: the transport's 1 MiB answer limit. */
const MAX_ANSWER_BYTES = 1048576;
/** The bytes of an authorisation the watch keeps at most (src/upgrade-watch.ts AUTHORIZED_KEPT, RULES.md 7.2). */
const KEPT_BYTES = 256;
/** A count of bytes a storage answer can hold. */
const byteCount: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_ANSWER_BYTES;
/** The sha256 of the bytes a 0x hex string holds, lower case hex. */
const sha256Of = (hex: string): string => createHash("sha256").update(Uint8Array.from(hex.slice(2).match(/[0-9a-f]{2}/g) ?? [], (b) => Number.parseInt(b, 16))).digest("hex");
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

/** A snapshot written before the upgrade watch: it has no upgrade part, and still reads. */
const SNAPSHOT_V0: Fields = [
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
/** Every snapshot written now: the @0 fields and the upgrade watch, null when none was read. */
const SNAPSHOT: Fields = [["schema", exactlyThis("flop-observatory/snapshot@1")], ...SNAPSHOT_V0.slice(1), ["upgrade", orNone(object)]];
/** The snapshot's fields by its schema: @0 its own, any other the current one, whose schema check refuses what is not @1. */
const snapshotFields = (v: unknown): Fields => (isObject(v) && v.schema === "flop-observatory/snapshot@0" ? SNAPSHOT_V0 : SNAPSHOT);
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

const UPGRADE: Fields = [
  ["schema", exactlyThis("flop-observatory/upgrade-watch@0")],
  ["observed_at", time],
  ["trust", oneOf(...TRUSTS)],
  ["at", object],
  ["executing", object],
  ["authorized", object],
  ["compared_with", orNone(count)],
  ["executing_changed", orNone(flag)],
  ["authorization_appeared", orNone(flag)],
];
const UPGRADE_AT: Fields = [
  ["hash", hash],
  ["number", orNone(count)],
];
const UPGRADE_EXECUTING: Fields = [
  ["state", oneOf("reviewed", "not reviewed", "absent", "unknown")],
  ["spec_name", orNone(text)],
  ["spec_version", orNone(count)],
  ["detail", orNone(text)],
];
const UPGRADE_AUTHORIZED: Fields = [
  ["state", oneOf("absent", "present", "unknown")],
  ["bytes", orNone(hexBytes)],
  ["length", orNone(byteCount)],
  ["sha256", orNone(sha256)],
  ["detail", orNone(text)],
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
  ["upgrade", UPGRADE],
  ["upgrade.at", UPGRADE_AT],
  ["upgrade.executing", UPGRADE_EXECUTING],
  ["upgrade.authorized", UPGRADE_AUTHORIZED],
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
  if (!shape("snapshot", s, snapshotFields(s), broken)) return;
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
  const upgrade = part("upgrade");
  if (isObject(upgrade) && shape("upgrade", upgrade, UPGRADE, broken)) {
    if (isObject(own(upgrade, "at"))) shape("upgrade.at", own(upgrade, "at"), UPGRADE_AT, broken);
    if (isObject(own(upgrade, "executing"))) shape("upgrade.executing", own(upgrade, "executing"), UPGRADE_EXECUTING, broken);
    if (isObject(own(upgrade, "authorized"))) shape("upgrade.authorized", own(upgrade, "authorized"), UPGRADE_AUTHORIZED, broken);
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
/** A rule of the upgrade watch: it holds when the snapshot has none (null, or an @0 line). */
const watch =
  (rule: (u: UpgradeWatch, s: Snapshot) => boolean) =>
  (s: Snapshot): boolean =>
    s.upgrade === undefined || s.upgrade === null || rule(s.upgrade, s);
const NAMED = ["reviewed", "not reviewed"];

/** The values the settlement rules tie together, each a named rule over a snapshot whose shapes hold. */
const AGREEMENTS: readonly (readonly [string, (s: Snapshot) => boolean])[] = [
  // The first line of a log names no line before it, and every other line names one.
  ["snapshot.prev_hash-follows-seq", (s) => (s.seq === 0) === (s.prev_hash === null)],
  // reset_detected says what the readings allow (RULES.md 1.1).
  ["status.reset-false-on-the-pinned-genesis", (s) => s.status.reset_detected !== false || (s.status.genesis.faucet === s.status.genesis.pinned && s.status.genesis.rpc === s.status.genesis.pinned)],
  ["status.reset-false-with-both-heights", (s) => s.status.reset_detected !== false || (s.status.finalized_height !== null && s.status.best_height !== null)],
  // True only from another genesis, or from a lost anchor, a reset that kept the genesis: its
  // conflict ends with ANCHOR_LOST (RULES.md 1.1).
  [
    "status.reset-true-on-another-genesis-or-a-lost-anchor",
    (s) => {
      const g = s.status.genesis;
      const lost = s.status.conflicts.some((c) => c.endsWith(`: ${ANCHOR_LOST}`));
      return s.status.reset_detected !== true || (g.faucet !== null && g.faucet !== g.pinned) || (g.rpc !== null && g.rpc !== g.pinned) || lost;
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
  ["snapshot.fixture-when-a-part-is", (s) => s.trust === "fixture" || ![s.status, ...s.escrows, s.census, s.drift, s.upgrade].some((x) => isObject(x) && x.trust === "fixture")],
  // The upgrade watch (RULES.md 7.2): read at the finalized head the status names.
  ["upgrade.at-is-the-status-finalized-head", watch((u, s) => s.status.finalized_hash === null || (u.at.hash === s.status.finalized_hash && u.at.number === s.status.finalized_height))],
  // A runtime is named exactly when the record named one, and every state but reviewed says why.
  ["upgrade.executing-names-a-spec-only-when-read", watch((u) => (u.executing.spec_name !== null) === NAMED.includes(u.executing.state) && (u.executing.spec_version !== null) === NAMED.includes(u.executing.state))],
  ["upgrade.executing-says-why-unless-reviewed", watch((u) => (u.executing.detail !== null) === (u.executing.state !== "reviewed"))],
  // A present authorisation is measured, its length and sha256, and its bytes kept up to 256 of them
  // and held to both; unknown says why, and so does present when its bytes are not kept.
  ["upgrade.authorized-measured-exactly-when-present", watch((u) => (u.authorized.length !== null) === (u.authorized.state === "present") && (u.authorized.sha256 !== null) === (u.authorized.state === "present"))],
  ["upgrade.authorized-bytes-only-when-present", watch((u) => u.authorized.bytes === null || u.authorized.state === "present")],
  ["upgrade.authorized-bytes-kept-up-to-256", watch((u) => u.authorized.state !== "present" || u.authorized.length === null || (u.authorized.bytes !== null) === (u.authorized.length <= KEPT_BYTES))],
  ["upgrade.authorized-length-counts-the-bytes", watch((u) => u.authorized.bytes === null || u.authorized.length === (u.authorized.bytes.length - 2) / 2)],
  ["upgrade.authorized-sha256-of-the-bytes", watch((u) => u.authorized.bytes === null || u.authorized.sha256 === sha256Of(u.authorized.bytes))],
  ["upgrade.authorized-says-why-when-unknown-or-not-kept", watch((u) => (u.authorized.detail !== null) === (u.authorized.state === "unknown" || (u.authorized.state === "present" && u.authorized.bytes === null)))],
  // A change is said only against an earlier watch at a lower block, and only of what both sides know.
  ["upgrade.changes-only-when-compared", watch((u) => u.compared_with !== null || (u.executing_changed === null && u.authorization_appeared === null))],
  ["upgrade.compared-with-a-lower-block", watch((u) => u.compared_with === null || (u.at.number !== null && u.compared_with < u.at.number))],
  ["upgrade.executing-changed-only-when-named", watch((u) => u.executing_changed === null || NAMED.includes(u.executing.state))],
  ["upgrade.appeared-only-when-known", watch((u) => u.authorization_appeared === null || u.authorized.state !== "unknown")],
  ["upgrade.appeared-only-when-present", watch((u) => u.authorization_appeared !== true || u.authorized.state === "present")],
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
