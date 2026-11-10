// The MCP binary's checks (src/snapshot-check.ts) held to RULES.md section 5 as
// test/helpers/snapshot-spec.ts writes it down, apart from the code (eleventh rerun U1). The table
// (test/snapshot-check.test.ts) gives each check cases of its own; this grid asks the same of every
// check at once:
// - every field, wherever it sits, given each value of its type's pool: a value inside breaks no
//   shape check, and a value outside breaks that field's check and no other;
// - every object given a field more, one left out or one renamed: its field set check alone;
// - the settlement agreements over grids of small domains: a snapshot breaks exactly the
//   agreements the reference says it breaks.
// Each value is set on a copy of one honest snapshot, so each verdict is one field's or one grid
// point's. Where a rule reads many escrows or items, the others are left so that they keep it, and
// the last escrow and a second item are read as well as the first. The pools and grids are finite:
// they show the checks and section 5 agree on these values, not on every value.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKS, checkSnapshot } from "../src/snapshot-check.js";
import { buildSnapshot } from "../src/snapshot.js";
import { FixtureSource } from "../src/source.js";
import { DEVNET_GENESIS } from "../src/status.js";
import { hashSnapshot } from "../src/store.js";
import { AGREEMENT_NAMES, expectedAgreements, type Json, OPEN, REFUND, RELEASE, SHAPE_NAMES, TYPES } from "./helpers/snapshot-spec.js";

const fx = (name: string) => FixtureSource.fromDir(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
// The snapshot the table builds on (the healthy status with a claimed, a refunded and an unverified
// escrow), and its claimed escrow given its open as well, so an escrow holds two items.
const escrowFixture = fx("escrows-verification");
const made = await buildSnapshot(
  { status: fx("status-healthy"), escrows: { source: escrowFixture, ids: escrowFixture.data.meta.escrow_ids ?? [] } },
  { pinnedGenesis: DEVNET_GENESIS, now: "2026-11-09T23:47:53Z", sourceSha: "test" },
);
const first = { ...made, seq: 0, prev_hash: null };
const BASE: Json = JSON.parse(JSON.stringify({ ...first, hash: hashSnapshot(first) }));
const FH: number = BASE.status.finalized_height;
{
  const release = BASE.escrows[0].evidence[0];
  BASE.escrows[0].evidence = [{ ...release, event: OPEN, block_number: FH - 5, event_index: release.event_index + 1 }, release];
}
const copy = (): Json => JSON.parse(JSON.stringify(BASE));
const show = (v: unknown): string => JSON.stringify(v) ?? String(v);

const SHAPES = new Set(SHAPE_NAMES);
/**
 * Why the binary's checks misjudge s, or null when they do not: the shape checks it breaks must be
 * `want`, nothing else may be named beside a shape check, and when no shape check breaks, the
 * agreements it breaks must be the reference's. The names come in the binary's order of checks,
 * which picks the five a refusal shows.
 */
function misjudged(s: Json, want: readonly string[]): string | null {
  let got: string[];
  try {
    got = checkSnapshot(s);
  } catch (e) {
    return `throws ${String(e)}`;
  }
  if (show(got) !== show(CHECKS.filter((n) => got.includes(n)))) return `names out of order or twice: ${show(got)}`;
  const shapes = got.filter((n) => SHAPES.has(n));
  if (show(shapes) !== show(want)) return `shape checks ${show(shapes)}, want ${show(want)}`;
  const agreements = got.filter((n) => !SHAPES.has(n)).sort();
  const expected = want.length > 0 ? [] : expectedAgreements(s).sort();
  return show(agreements) === show(expected) ? null : `agreements ${show(agreements)}, want ${show(expected)}`;
}

/** Where each object sits: escrows first and last, items first and second and in another escrow. */
const PLACES: Record<string, readonly (readonly [string, (s: Json) => Json])[]> = {
  snapshot: [["the snapshot", (s) => s]],
  pin: [["the pin", (s) => s.pin]],
  status: [["the status", (s) => s.status]],
  "status.genesis": [["the status genesis", (s) => s.status.genesis]],
  "status.rpc": [["the rpc", (s) => s.status.rpc]],
  "status.gateway": [["the gateway", (s) => s.status.gateway]],
  "status.faucet": [["the faucet", (s) => s.status.faucet]],
  escrow: [
    ["the first escrow", (s) => s.escrows[0]],
    ["the last escrow", (s) => s.escrows[2]],
  ],
  evidence: [
    ["an escrow's first item", (s) => s.escrows[0].evidence[0]],
    ["an escrow's second item", (s) => s.escrows[0].evidence[1]],
    ["another escrow's item", (s) => s.escrows[1].evidence[0]],
  ],
};

describe("every field holds its type, wherever it sits (RULES.md section 5)", () => {
  for (const [object, fields] of TYPES)
    for (const [place, at] of PLACES[object])
      it(`${object} fields, in ${place}`, () => {
        const wrong: string[] = [];
        for (const [key, type] of fields)
          for (const [values, want] of [
            [type.inside, []],
            [type.outside, [`${object}.${key}`]],
          ] as const)
            for (const value of values) {
              const s = copy();
              at(s)[key] = structuredClone(value);
              const why = misjudged(s, want);
              if (why) wrong.push(`${key} = ${show(value)}: ${why}`);
            }
        expect(wrong).toEqual([]);
      });
});

/** The object a field holds, or each item of the list it holds, by the name its checks carry. */
const PARTS: Record<string, string> = {
  "snapshot.pin": "pin",
  "snapshot.status": "status",
  "snapshot.escrows": "escrow",
  "status.genesis": "status.genesis",
  "status.rpc": "status.rpc",
  "status.gateway": "status.gateway",
  "status.faucet": "status.faucet",
  "escrow.evidence": "evidence",
};
const FIELDS = new Map(TYPES);
/** Gives every field of o, and of every part inside it, a value outside its type. */
function spoil(o: Json, object: string): void {
  for (const [key, type] of FIELDS.get(object) ?? []) {
    const inner = PARTS[`${object}.${key}`];
    if (inner === undefined) o[key] = structuredClone(type.outside[0]);
    else for (const x of Array.isArray(o[key]) ? o[key] : [o[key]]) spoil(x, inner);
  }
}

describe("every object holds exactly its fields (RULES.md section 5)", () => {
  for (const [object, fields] of TYPES)
    for (const [place, at] of PLACES[object])
      it(`${object} field set, in ${place}`, () => {
        const edits: [string, (o: Json) => void][] = [["a field more", (o) => (o.more = 1)]];
        for (const [key] of fields) {
          edits.push([`${key} left out`, (o) => delete o[key]]);
          edits.push([`${key} renamed`, (o) => ((o[`${key}_`] = o[key]), delete o[key])]);
        }
        const wrong: string[] = [];
        // An object whose field set is wrong is named once, and its values and parts are not read,
        // so spoiling all of them changes nothing.
        for (const spoiled of [false, true])
          for (const [what, edit] of edits) {
            const s = copy();
            if (spoiled) spoil(at(s), object);
            edit(at(s));
            const why = misjudged(s, [`${object}.fields`]);
            if (why) wrong.push(`${what}${spoiled ? ", every value spoiled" : ""}: ${why}`);
          }
        expect(wrong).toEqual([]);
      });
});

describe("many broken fields are each named once, in the order of checks (RULES.md section 5)", () => {
  it("every value spoiled at once", () => {
    const s = copy();
    spoil(s, "snapshot");
    expect(misjudged(s, SHAPE_NAMES.filter((n) => !n.endsWith(".fields") && PARTS[n] === undefined))).toBeNull();
  });

  it("two broken fields, wherever each sits", () => {
    const places = TYPES.flatMap(([object, fields]) => {
      const [key, type] = fields.find(([k]) => PARTS[`${object}.${k}`] === undefined) as readonly [string, { outside: readonly Json[] }];
      return PLACES[object].map(([place, at]) => ({ name: `${object}.${key}`, place, at, key, value: type.outside[0] }));
    });
    const wrong: string[] = [];
    for (const a of places)
      for (const b of places)
        if (a !== b) {
          const s = copy();
          a.at(s)[a.key] = structuredClone(a.value);
          b.at(s)[b.key] = structuredClone(b.value);
          const why = misjudged(s, SHAPE_NAMES.filter((n) => n === a.name || n === b.name));
          if (why) wrong.push(`${a.name} in ${a.place} and ${b.name} in ${b.place}: ${why}`);
        }
    expect(wrong).toEqual([]);
  });
});

const P: string = BASE.status.genesis.pinned;
const O = "0x" + "ab".repeat(32);
const Q = "0x" + "cd".repeat(32);
const H1: string = BASE.status.finalized_hash;
const H2 = "0x" + "ef".repeat(32);
const A = "0x" + "a1".repeat(32);
const B = "0x" + "b2".repeat(32);
const C = "0x" + "c3".repeat(32);
const census = "flop-observatory/census@0";
const drift = "flop-observatory/drift@0";

/** Every combination of the values given. */
function combos(dims: Record<string, readonly Json[]>): Record<string, Json>[] {
  return Object.entries(dims).reduce<Record<string, Json>[]>((all, [key, values]) => all.flatMap((c) => values.map((v) => ({ ...c, [key]: v }))), [{}]);
}
/** An item of the given event, its own block and index, on the pinned genesis. */
const item = (event: string, n: number, hash = "0x" + "56".repeat(32)): Json => ({ event, block_hash: hash, block_number: null, event_index: n, genesis: P });

/** [name, the values each field takes, how a grid point is set on the honest snapshot]. */
const GRIDS: readonly (readonly [string, Record<string, readonly Json[]>, (s: Json, v: Record<string, Json>) => void])[] = [
  ["seq and prev_hash", { seq: [0, 1, 2], prev: [null, "ab".repeat(32)] }, (s, v) => ((s.seq = v.seq), (s.prev_hash = v.prev))],
  [
    "reset_detected and the genesis readings",
    { reset: [true, false, null], faucet: [P, O, Q, null], rpc: [P, O, Q, null] },
    (s, v) => {
      Object.assign(s.status, { reset_detected: v.reset });
      Object.assign(s.status.genesis, { faucet: v.faucet, rpc: v.rpc });
      s.pin.genesis = v.rpc;
      for (const e of s.escrows) e.finalized_height = null;
    },
  ],
  [
    "reset_detected and the heights",
    { reset: [false, null, true], finalized: [null, 0, 5], best: [null, 0, 4, 5, 7], lag: [null, 0, 1, 2] },
    (s, v) => {
      Object.assign(s.status, { reset_detected: v.reset, finalized_height: v.finalized, best_height: v.best, finality_lag: v.lag });
      s.pin.finalized_height = v.finalized;
      for (const e of s.escrows) e.finalized_height = null;
    },
  ],
  ["the pin genesis", { pin: [P, O, null], rpc: [P, O, null] }, (s, v) => ((s.pin.genesis = v.pin), (s.status.genesis.rpc = v.rpc), (s.status.reset_detected = null))],
  ["the pin height", { pin: [null, 0, FH - 1, FH, FH + 1], status: [null, 0, FH] }, (s, v) => ((s.pin.finalized_height = v.pin), (s.status.finalized_height = v.status))],
  ["the pin hash", { pin: [H1, H2, null], status: [H1, H2, null] }, (s, v) => ((s.pin.finalized_hash = v.pin), (s.status.finalized_hash = v.status))],
  [
    "the last escrow's bound",
    { bound: [null, 0, FH - 1, FH, FH + 1], status: [null, 0, FH], rpc: [P, O, null] },
    (s, v) => {
      for (const e of s.escrows) e.finalized_height = null;
      s.escrows[2].finalized_height = v.bound;
      s.status.finalized_height = v.status;
      s.status.genesis.rpc = v.rpc;
    },
  ],
  [
    "evidence and its escrow's bound",
    { where: [0, 1], bound: [null, FH - 1, FH, FH + 1], block: [null, 0, FH - 1, FH, FH + 1] },
    (s, v) => {
      for (const e of s.escrows) e.finalized_height = null;
      const e = s.escrows[v.where];
      e.finalized_height = v.bound;
      e.evidence[e.evidence.length - 1].block_number = v.block;
      if (v.bound !== null) s.status.finalized_height = v.bound;
    },
  ],
  [
    "the last escrow's state and events",
    { state: ["unverified", "funded", "claimed", "refunded"], opens: [0, 1, 2], releases: [0, 1, 2], refunds: [0, 1, 2] },
    (s, v) => {
      const e = s.escrows[2];
      e.state = v.state;
      e.evidence = [
        ...Array.from({ length: v.opens }, () => OPEN),
        ...Array.from({ length: v.releases }, () => RELEASE),
        ...Array.from({ length: v.refunds }, () => REFUND),
      ].map((event, n) => item(event, n));
    },
  ],
  [
    "an item's genesis",
    { where: [0, 1], genesis: [P, O, Q], faucet: [P, O, null], rpc: [P, O, null] },
    (s, v) => {
      const e = s.escrows[v.where];
      e.evidence[e.evidence.length - 1].genesis = v.genesis;
      Object.assign(s.status.genesis, { faucet: v.faucet, rpc: v.rpc });
      s.pin.genesis = v.rpc;
      s.status.reset_detected = null;
      for (const x of s.escrows) x.finalized_height = null;
    },
  ],
  [
    "one event as evidence twice",
    {
      first: [A + " 0", A + " 1", B + " 0"],
      second: [A + " 0", A + " 1", B + " 0"],
      where: ["one escrow", "two escrows"],
    },
    (s, v) => {
      const set = (x: Json, key: string) => ((x.block_hash = key.split(" ")[0]), (x.event_index = Number(key.split(" ")[1])));
      set(s.escrows[0].evidence[0], v.first);
      set(v.where === "one escrow" ? s.escrows[0].evidence[1] : s.escrows[1].evidence[0], v.second);
    },
  ],
  ["escrow ids", { first: [A, B, C], second: [A, B, C], last: [A, B, C] }, (s, v) => ((s.escrows[0].escrow_id = v.first), (s.escrows[1].escrow_id = v.second), (s.escrows[2].escrow_id = v.last))],
  [
    "the trust labels",
    {
      snapshot: ["fixture", "trusted RPC"],
      status: ["fixture", "trusted RPC"],
      first: ["fixture", "trusted RPC"],
      last: ["fixture", "trusted RPC"],
      census: [null, { schema: census }, { schema: census, trust: "fixture" }, { schema: census, trust: "trusted RPC" }],
      drift: [null, { schema: drift }, { schema: drift, trust: "fixture" }],
    },
    (s, v) => {
      s.trust = v.snapshot;
      s.status.trust = v.status;
      s.escrows[0].trust = v.first;
      s.escrows[1].trust = "trusted RPC";
      s.escrows[2].trust = v.last;
      s.census = v.census;
      s.drift = v.drift;
    },
  ],
];

describe("the agreements are the reference's on every point of each grid (RULES.md section 5)", () => {
  for (const [name, dims, set] of GRIDS)
    it(name, () => {
      const wrong: string[] = [];
      for (const v of combos(dims)) {
        const s = copy();
        set(s, v);
        const why = misjudged(s, []);
        if (why) wrong.push(`${show(v)}: ${why}`);
      }
      expect(wrong).toEqual([]);
    });
});

describe("the grid covers every check", () => {
  it("names every check the binary makes, and no other", () => {
    expect([...SHAPE_NAMES, ...AGREEMENT_NAMES].sort()).toEqual([...CHECKS].sort());
  });

  it("builds on a snapshot the binary and the reference both serve", () => {
    expect(checkSnapshot(copy())).toEqual([]);
    expect(expectedAgreements(copy())).toEqual([]);
  });

  it("holds and breaks every agreement on some point of its grids", () => {
    const broken = new Set<string>();
    const kept = new Set<string>();
    for (const [, dims, set] of GRIDS)
      for (const v of combos(dims)) {
        const s = copy();
        set(s, v);
        const names = expectedAgreements(s);
        for (const n of AGREEMENT_NAMES) (names.includes(n) ? broken : kept).add(n);
      }
    expect(AGREEMENT_NAMES.filter((n) => !broken.has(n) || !kept.has(n))).toEqual([]);
  });

  it("gives every field values inside and outside its type", () => {
    expect(TYPES.flatMap(([object, fields]) => fields.filter(([, t]) => t.outside.length === 0).map(([key]) => `${object}.${key}`))).toEqual([]);
  });
});
