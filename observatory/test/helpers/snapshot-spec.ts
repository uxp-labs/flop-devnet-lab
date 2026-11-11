// What RULES.md section 5 says a snapshot the MCP binary serves must hold, written from the rules
// apart from src/snapshot-check.ts, so the grid test (test/snapshot-check-grid.test.ts) can hold
// the binary's checks to it. Two halves:
// - TYPES: each object's fields with the type section 5 gives them, and for each type a pool of
//   values inside it and outside it: the edges and near misses a weaker or stricter check would
//   judge otherwise (none, 0, false, empty text, the value as text, more after it, spaces around
//   it, a line break before it, another case, one hex digit short or long, a fraction, 2^53).
// - expectedAgreements: the settlement agreements of section 5, one rule per sentence, judged on a
//   snapshot whose fields all hold their types.
// The check names are the binary's own, so its refusals and this reference can be compared.

// Snapshots here are plain JSON, as the binary reads them.
export type Json = any;

/** A value type: values inside it, which the binary serves, and outside it, which it refuses. */
export interface Kind {
  readonly inside: readonly Json[];
  readonly outside: readonly Json[];
}

const kind = (inside: readonly Json[], outside: readonly Json[]): Kind => ({ inside, outside });
/** The type, or none. */
const orNone = (k: Kind): Kind => kind([...k.inside, null], k.outside.filter((v) => v !== null));

const hex64 = "0123456789abcdef".repeat(4);
/** A value of no type but its own: each of these is outside every type below that is not it. */
const NOT_TEXT = [1, 0, true, false, null, [], {}];

/** Exactly one fixed text (a schema name, the escrow scope). */
const fixed = (value: string): Kind =>
  kind([value], [value.toUpperCase(), value + "x", " " + value, value + " ", "x\n" + value, value + "\n", "", "null", ...NOT_TEXT]);
/** One of a few words (a trust label, a health, an escrow state, an event name). */
const oneOf = (...words: string[]): Kind =>
  kind(words, [...words.flatMap((w) => [w.toUpperCase(), w + "x", " " + w, w + "\n"]), "", "null", ...NOT_TEXT]);

// The binary reads JSON, which holds no NaN or infinity, but its checks take any value, so the
// pools hold them too.
/** A safe integer from 0: a seq, a height, a lag, a runtime version, an index. */
const COUNT = kind([0, 1, 2 ** 32, Number.MAX_SAFE_INTEGER], [-1, 1.5, 2 ** 53, NaN, Infinity, "1", "0", "", "null", true, false, null, [], {}]);
/** An HTTP status as the status keeps it: any safe integer (RULES.md 1.1). */
const HTTP = kind([-1, 0, 200, 599, 600, 1000, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], [1.5, 2 ** 53, -(2 ** 53), NaN, Infinity, -Infinity, "200", "", true, false, null, [], {}]);
const FLAG = kind([true, false], [0, 1, "true", "false", "", "null", null, [], {}]);
const TEXT = kind(["", "x", "null", "a\nb", " x "], NOT_TEXT);
const TEXTS = kind([[], ["a"], ["", "a\nb", "null"]], ["a", "", [1], [null], ["a", 1], [[]], [{}], {}, null, 1, true]);
/** 0x plus 64 lower case hex: a genesis, a block hash, an escrow id. */
const HASH = kind(
  ["0x" + "0".repeat(64), "0x" + "f".repeat(64), "0x" + hex64],
  [
    "0X" + hex64,
    "0x" + hex64.toUpperCase(),
    "0x" + hex64.slice(1),
    "0x" + hex64 + "a",
    "x0x" + hex64,
    "x\n0x" + hex64,
    "0x" + hex64 + "\n",
    " 0x" + hex64,
    "0x" + hex64 + " ",
    hex64,
    "0x" + "g".repeat(64),
    "",
    "null",
    0,
    false,
    null,
    1,
    [],
    {},
  ],
);
/** 64 lower case hex: a snapshot hash. */
const SHA256 = kind(
  ["0".repeat(64), "f".repeat(64), hex64],
  [hex64.toUpperCase(), hex64.slice(1), hex64 + "a", "x" + hex64, "x\n" + hex64, hex64 + "\n", " " + hex64, "0x" + hex64, "g".repeat(64), "", "null", 0, false, null, 1, [], {}],
);
/** ISO 8601 with a zone and a real calendar date and clock time (RULES.md 1.1). */
const TIME = kind(
  [
    "2026-11-09T23:47:53Z",
    "2026-11-10T00:47:53+01:00",
    "2026-11-09T18:47:53-05:00",
    "2026-11-09T23:47:53+23:59",
    "2026-11-09T23:47:53.9999999Z",
    "2026-11-09T23:47Z",
    "2024-02-29T12:00:00Z",
  ],
  [
    "yesterday",
    "2026-11-09T23:47:53",
    "2026-11-31T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-11-09T24:00:00Z",
    "2026-11-09T23:60:00Z",
    "2026-11-09T23:47:60Z",
    "2026-11-09T23:47:53+24:00",
    "2026-11-09T23:47:53+00:60",
    "2026-11-09 23:47:53Z",
    " 2026-11-09T23:47:53Z",
    "2026-11-09T23:47:53Z ",
    "",
    "null",
    5,
    true,
    null,
    [],
    {},
  ],
);
/** The faucet's limits: an object whose values are numbers and flags. */
const LIMITS = kind(
  [{}, { a: 1 }, { a: 0 }, { a: -1 }, { a: 0.5 }, { a: true }, { a: false }, { a: 1, b: true }],
  [[], [1], { a: "x" }, { a: "1" }, { a: null }, { a: [] }, { a: {} }, { a: Infinity }, { a: -Infinity }, { a: NaN }, "x", "", 1, true, null],
);
/** The census or the drift report: an object holding its schema, checked for that alone. */
const part = (schema: string): Kind =>
  kind(
    [{ schema }, { schema, trust: "fixture" }, { schema, trust: "trusted RPC", more: 1 }],
    [{ schema: schema + "x" }, { schema: schema.toUpperCase() }, { schema: null }, { trust: "fixture" }, {}, [], "x", 1, true, null],
  );
/** A nested object whose own fields are checked apart: here only what is no object at all. */
const OBJECT = kind([], [null, [], "x", 1, true]);
/** A list whose items are checked apart: here only an empty list, and what is no list. */
const LIST = kind([[]], [null, {}, "x", "", 1, true]);

const TRUSTS = ["trusted RPC", "fixture"];
const HEALTHS = ["ok", "degraded", "down", "unknown"];
export const OPEN = "hasStation.EscrowOpened";
export const RELEASE = "hasStation.EscrowReleased";
export const REFUND = "hasStation.EscrowRefunded";

const SERVICE: [string, Kind][] = [
  ["health", oneOf(...HEALTHS)],
  ["http", orNone(HTTP)],
  ["detail", orNone(TEXT)],
  ["observed_at", orNone(TEXT)],
];

/**
 * Each object of a served snapshot, by the name its checks carry, with every field section 5 gives
 * it and that field's type. An object holds exactly these fields.
 */
export const TYPES: readonly (readonly [string, readonly (readonly [string, Kind])[]])[] = [
  [
    "snapshot",
    [
      ["schema", fixed("flop-observatory/snapshot@0")],
      ["seq", COUNT],
      ["prev_hash", orNone(SHA256)],
      ["hash", SHA256],
      ["observed_at", TIME],
      ["trust", oneOf(...TRUSTS)],
      ["pin", OBJECT],
      ["status", OBJECT],
      ["escrows", LIST],
      ["census", orNone(part("flop-observatory/census@0"))],
      ["drift", orNone(part("flop-observatory/drift@0"))],
    ],
  ],
  [
    "pin",
    [
      ["source_sha", orNone(TEXT)],
      ["source", TEXT],
      ["genesis", orNone(HASH)],
      ["finalized_height", orNone(COUNT)],
      ["finalized_hash", orNone(HASH)],
      ["node", TEXT],
    ],
  ],
  [
    "status",
    [
      ["schema", fixed("flop-observatory/network-status@0")],
      ["observed_at", TIME],
      ["trust", oneOf(...TRUSTS)],
      ["genesis", OBJECT],
      ["reset_detected", orNone(FLAG)],
      ["conflicts", TEXTS],
      ["finalized_height", orNone(COUNT)],
      ["finalized_hash", orNone(HASH)],
      ["best_height", orNone(COUNT)],
      ["finality_lag", orNone(COUNT)],
      ["runtime_version", orNone(COUNT)],
      ["rpc", OBJECT],
      ["gateway", OBJECT],
      ["faucet", OBJECT],
    ],
  ],
  [
    "status.genesis",
    [
      ["pinned", HASH],
      ["faucet", orNone(HASH)],
      ["rpc", orNone(HASH)],
    ],
  ],
  ["status.rpc", [...SERVICE, ["stale", orNone(FLAG)]]],
  ["status.gateway", SERVICE],
  ["status.faucet", [...SERVICE, ["ready", orNone(FLAG)], ["limits", orNone(LIMITS)]]],
  [
    "escrow",
    [
      ["schema", fixed("flop-observatory/escrow-state@0")],
      ["escrow_id", HASH],
      ["state", oneOf("unverified", "funded", "claimed", "refunded")],
      ["evidence", LIST],
      ["notes", TEXTS],
      ["finalized_height", orNone(COUNT)],
      ["observed_at", TIME],
      ["trust", oneOf(...TRUSTS)],
      ["scope", fixed("settlement only; says nothing about output quality")],
    ],
  ],
  [
    "evidence",
    [
      ["event", oneOf(OPEN, RELEASE, REFUND)],
      ["block_hash", HASH],
      ["block_number", orNone(COUNT)],
      ["event_index", COUNT],
      ["genesis", HASH],
    ],
  ],
];

/** Every shape check's name: each object's field set, and each of its fields. */
export const SHAPE_NAMES: readonly string[] = TYPES.flatMap(([object, fields]) => [`${object}.fields`, ...fields.map(([key]) => `${object}.${key}`)]);

/** Every agreement's name, in the order section 5 states them. */
export const AGREEMENT_NAMES: readonly string[] = [
  "snapshot.prev_hash-follows-seq",
  "status.reset-false-on-the-pinned-genesis",
  "status.reset-false-with-both-heights",
  "status.reset-true-on-another-genesis-or-a-lost-anchor",
  "status.lag-adds-up",
  "escrows.listed-once",
  "escrow.unverified-holds-no-evidence",
  "escrow.funded-on-one-open",
  "escrow.funded-with-no-release",
  "escrow.funded-with-no-refund",
  "escrow.claimed-on-one-release",
  "escrow.claimed-with-no-refund",
  "escrow.refunded-on-one-refund",
  "escrow.refunded-with-no-release",
  "escrow.claimed-on-at-most-one-open",
  "escrow.refunded-on-at-most-one-open",
  "evidence.on-the-pinned-genesis",
  "evidence.used-once",
  "escrow.bound-is-the-status-height",
  "escrow.bound-only-from-the-pinned-genesis",
  "escrow.no-evidence-above-the-bound",
  "pin.genesis-is-the-status-rpc-genesis",
  "pin.height-is-the-status-height",
  "pin.hash-is-the-status-hash",
  "snapshot.fixture-when-a-part-is",
];

/**
 * The agreements a snapshot breaks, by section 5, for a snapshot whose fields all hold their
 * types. Each rule quotes the sentence it comes from.
 */
export function expectedAgreements(s: Json): string[] {
  const broken: string[] = [];
  const rule = (name: string, holds: boolean): void => {
    if (!holds) broken.push(name);
  };
  const st = s.status;
  const g = st.genesis;
  const escrows: Json[] = s.escrows;
  const items: Json[] = escrows.flatMap((e) => e.evidence);
  const events = (e: Json, event: string): number => e.evidence.filter((x: Json) => x.event === event).length;
  const inState = (state: string): Json[] => escrows.filter((e) => e.state === state);
  const unique = (keys: readonly string[]): boolean => keys.every((k, i) => keys.indexOf(k) === i);

  // "prev_hash none on the first line and 64 lower case hex on every other"
  rule("snapshot.prev_hash-follows-seq", s.seq === 0 ? s.prev_hash === null : s.prev_hash !== null);
  // "reset_detected false only with both genesis readings on the pinned genesis and both heights read"
  if (st.reset_detected === false) {
    rule("status.reset-false-on-the-pinned-genesis", g.faucet === g.pinned && g.rpc === g.pinned);
    rule("status.reset-false-with-both-heights", st.finalized_height !== null && st.best_height !== null);
  }
  // "and true only with a reading on another genesis, or with a conflict that ends ": the finalized
  // chain is not the one the log saw", which a lost anchor gives"
  if (st.reset_detected === true)
    rule("status.reset-true-on-another-genesis-or-a-lost-anchor", [g.faucet, g.rpc].some((x) => x !== null && x !== g.pinned) || st.conflicts.some((c: string) => c.endsWith(": the finalized chain is not the one the log saw")));
  // "the finality lag the best height less the finalized one, and none when either is missing or
  // the finalized one is higher"
  const f = st.finalized_height;
  const b = st.best_height;
  rule("status.lag-adds-up", st.finality_lag === (f === null || b === null || f > b ? null : b - f));
  // every escrow "listed once"
  rule("escrows.listed-once", unique(escrows.map((e) => e.escrow_id)));
  // "an escrow unverified with no evidence"
  rule("escrow.unverified-holds-no-evidence", inState("unverified").every((e) => e.evidence.length === 0));
  // "funded on one open and nothing else"
  rule("escrow.funded-on-one-open", inState("funded").every((e) => events(e, OPEN) === 1));
  rule("escrow.funded-with-no-release", inState("funded").every((e) => events(e, RELEASE) === 0));
  rule("escrow.funded-with-no-refund", inState("funded").every((e) => events(e, REFUND) === 0));
  // "claimed on one release and refunded on one refund, each with at most one open and no event
  // of the other kind"
  rule("escrow.claimed-on-one-release", inState("claimed").every((e) => events(e, RELEASE) === 1));
  rule("escrow.claimed-with-no-refund", inState("claimed").every((e) => events(e, REFUND) === 0));
  rule("escrow.refunded-on-one-refund", inState("refunded").every((e) => events(e, REFUND) === 1));
  rule("escrow.refunded-with-no-release", inState("refunded").every((e) => events(e, RELEASE) === 0));
  rule("escrow.claimed-on-at-most-one-open", inState("claimed").every((e) => events(e, OPEN) <= 1));
  rule("escrow.refunded-on-at-most-one-open", inState("refunded").every((e) => events(e, OPEN) <= 1));
  // "every item on the pinned genesis"
  rule("evidence.on-the-pinned-genesis", items.every((x) => x.genesis === g.pinned));
  // "no finalized event evidence twice, for two escrows or for one": an event is its block and its
  // index in that block
  rule("evidence.used-once", unique(items.map((x) => `${x.block_hash} ${x.event_index}`)));
  // "an escrow's finalized height none or the status's, and none unless the status's RPC genesis
  // is the pinned one, with no evidence above it" (a block number of none is above nothing)
  const bound = escrows.filter((e) => e.finalized_height !== null);
  rule("escrow.bound-is-the-status-height", bound.every((e) => e.finalized_height === f));
  rule("escrow.bound-only-from-the-pinned-genesis", bound.length === 0 || g.rpc === g.pinned);
  rule("escrow.no-evidence-above-the-bound", bound.every((e) => e.evidence.every((x: Json) => x.block_number === null || x.block_number <= e.finalized_height)));
  // "the pin's genesis, finalized height and hash the status's RPC genesis, finalized height and hash"
  rule("pin.genesis-is-the-status-rpc-genesis", s.pin.genesis === g.rpc);
  rule("pin.height-is-the-status-height", s.pin.finalized_height === f);
  rule("pin.hash-is-the-status-hash", s.pin.finalized_hash === st.finalized_hash);
  // "the snapshot a fixture when any part is"
  const parts = [st, ...escrows, s.census, s.drift].filter((p) => p !== null && typeof p === "object");
  rule("snapshot.fixture-when-a-part-is", s.trust === "fixture" || parts.every((p) => p.trust !== "fixture"));
  return broken;
}
