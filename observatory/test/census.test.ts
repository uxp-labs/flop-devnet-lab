// Census tests. Each rule in RULES.md section 3 and each clause of 3.1 has its own test, and every
// census-* fixture is checked against expectations worked out by hand from the rules (not taken
// from census.ts), which must also be the totals its meta.description states.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { census, CensusRefused, type CensusOptions } from "../src/census.js";
import { FixtureSource } from "../src/source.js";
import type { BlockRange, CensusCounts, CensusReport } from "../src/types.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const KINDS = ["escrows_opened", "escrows_released", "escrows_refunded", "channels_opened", "channels_settled"] as const;
/** The fields compare-recount.mjs checks against the Python recount. */
const COMPARED = [
  "complete",
  "status",
  "covered",
  "gaps",
  "totals",
  "by_account",
  "pending_unfinalized",
  "duplicates_dropped",
  "excluded_other_genesis",
  "malformed_dropped",
] as const;

type Expected = Pick<CensusReport, (typeof COMPARED)[number]>;

const alice = "synthetic-alice";
const bob = "synthetic-bob";
const carol = "synthetic-carol";
const dave = "synthetic-dave";
const counts = (o: Partial<CensusCounts>): CensusCounts => ({
  escrows_opened: 0,
  escrows_released: 0,
  escrows_refunded: 0,
  channels_opened: 0,
  channels_settled: 0,
  ...o,
});
const r = (from_block: number, to_block: number): BlockRange => ({ from_block, to_block });

/** Worked out by hand from RULES.md 3.1. See each fixture's meta.description for the reasoning. */
const EXPECTED: Record<string, Expected & { reset_detected: boolean }> = {
  "census-complete": {
    complete: true,
    status: "complete",
    covered: [r(0, 199)],
    gaps: [],
    totals: counts({ escrows_opened: 4, escrows_released: 1, escrows_refunded: 1, channels_opened: 1, channels_settled: 1 }),
    by_account: {
      [alice]: { escrows_opened: 1, escrows_released: 1 },
      [bob]: { escrows_opened: 2 },
      [carol]: { channels_opened: 1, channels_settled: 1 },
      [dave]: { escrows_refunded: 1 },
    },
    pending_unfinalized: 0,
    duplicates_dropped: 0,
    excluded_other_genesis: 0,
    malformed_dropped: 0,
    reset_detected: false,
  },
  "census-paginated": {
    complete: true,
    status: "complete",
    covered: [r(0, 99)],
    gaps: [],
    totals: counts({ escrows_opened: 3, escrows_released: 2, escrows_refunded: 1, channels_opened: 1 }),
    by_account: {
      [alice]: { escrows_opened: 1, escrows_released: 1 },
      [bob]: { escrows_opened: 1, escrows_released: 1 },
      [carol]: { escrows_opened: 1, escrows_refunded: 1 },
      [dave]: { channels_opened: 1 },
    },
    pending_unfinalized: 0,
    duplicates_dropped: 6,
    excluded_other_genesis: 0,
    malformed_dropped: 0,
    reset_detected: false,
  },
  "census-gap": {
    complete: false,
    status: "partial",
    covered: [r(0, 99)],
    gaps: [r(100, 299)],
    totals: counts({ escrows_opened: 2 }),
    by_account: { [alice]: { escrows_opened: 1 }, [bob]: { escrows_opened: 1 } },
    pending_unfinalized: 0,
    duplicates_dropped: 0,
    excluded_other_genesis: 0,
    malformed_dropped: 0,
    reset_detected: false,
  },
  "census-reset": {
    complete: false,
    status: "partial",
    covered: [r(0, 99)],
    gaps: [r(100, 199)],
    totals: counts({ escrows_opened: 1, escrows_released: 1 }),
    by_account: { [alice]: { escrows_opened: 1, escrows_released: 1 } },
    pending_unfinalized: 0,
    duplicates_dropped: 0,
    excluded_other_genesis: 3,
    malformed_dropped: 0,
    reset_detected: true,
  },
  "census-unfinalized": {
    complete: true,
    status: "complete",
    covered: [r(0, 99)],
    gaps: [],
    totals: counts({ escrows_opened: 1, escrows_refunded: 1 }),
    by_account: { [alice]: { escrows_opened: 1 }, [bob]: { escrows_refunded: 1 } },
    pending_unfinalized: 4,
    duplicates_dropped: 1,
    excluded_other_genesis: 0,
    malformed_dropped: 0,
    reset_detected: false,
  },
  "census-malformed": {
    complete: true,
    status: "complete",
    covered: [r(0, 99)],
    gaps: [],
    totals: counts({ escrows_opened: 2, escrows_released: 1 }),
    by_account: { [alice]: { escrows_opened: 1, escrows_released: 1 } },
    pending_unfinalized: 0,
    duplicates_dropped: 2,
    excluded_other_genesis: 0,
    malformed_dropped: 12,
    reset_detected: false,
  },
};
const REFUSING = ["census-invalid-page"];

/** The sentence each fixture's meta.description must contain, in one fixed format. */
function sentence(x: Expected): string {
  const ranges = (rs: BlockRange[]) => (rs.length ? rs.map((b) => `${b.from_block}-${b.to_block}`).join(", ") : "none");
  const totals = KINDS.map((k) => `${k} ${x.totals[k]}`).join(", ");
  const acc = Object.entries(x.by_account);
  const accounts = acc.length
    ? acc.map(([a, row]) => `${a} (${Object.entries(row).map(([k, n]) => `${k} ${n}`).join(", ")})`).join(", ")
    : "none";
  return (
    `Expected: complete ${x.complete}, status ${x.status}; covered ${ranges(x.covered)}; gaps ${ranges(x.gaps)}; ` +
    `totals ${totals}; pending_unfinalized ${x.pending_unfinalized}; duplicates_dropped ${x.duplicates_dropped}; ` +
    `excluded_other_genesis ${x.excluded_other_genesis}; malformed_dropped ${x.malformed_dropped}; by_account ${accounts}.`
  );
}

async function load(name: string) {
  const src = FixtureSource.fromDir(join(FIXTURES, name));
  const meta = src.data.meta;
  expect(src.data.loadErrors).toEqual([]);
  expect(meta.synthetic).toBe(true);
  expect(meta.census_request).toBeDefined();
  expect(meta.pinned_genesis).toBeDefined();
  const opts: CensusOptions = {
    pinnedGenesis: meta.pinned_genesis!,
    requested: meta.census_request!,
    observedAt: meta.now,
    trust: src.trust,
  };
  return { pages: await src.eventPages(), meta, opts };
}

function pick(rep: CensusReport): Expected {
  return Object.fromEntries(COMPARED.map((k) => [k, rep[k]])) as Expected;
}

describe("census fixtures", () => {
  it("every census-* fixture has an expectation here", () => {
    const dirs = readdirSync(FIXTURES).filter((d) => d.startsWith("census-")).sort();
    expect(dirs).toEqual([...Object.keys(EXPECTED), ...REFUSING].sort());
  });

  for (const [name, want] of Object.entries(EXPECTED)) {
    it(`${name} gives the totals its description states`, async () => {
      const { pages, meta, opts } = await load(name);
      const rep = census(pages, opts);
      const { reset_detected, ...compared } = want;
      expect(pick(rep)).toEqual(compared);
      expect(Object.keys(rep.by_account)).toEqual(Object.keys(compared.by_account));
      expect(rep.reset_detected).toBe(reset_detected);
      expect(meta.description).toContain(sentence(compared));
      expect(rep.totals_label).toBe(rep.status);
      expect(rep.observed_at).toBe(meta.now);
      expect(rep.trust).toBe("fixture");
      expect(rep.genesis).toBe(opts.pinnedGenesis);
      expect(rep.requested).toEqual(opts.requested);
      expect(JSON.parse(JSON.stringify(rep))).toEqual(rep);
    });
  }

  it("census-invalid-page refuses the whole census", async () => {
    const { pages, meta, opts } = await load("census-invalid-page");
    expect(() => census(pages, opts)).toThrow(CensusRefused);
    expect(() => census(pages, opts)).toThrow(/next_page is missing/);
    expect(meta.description).toContain("Expected: the census refuses");
  });

  it("page order does not change any count", async () => {
    for (const name of Object.keys(EXPECTED)) {
      const { pages, opts } = await load(name);
      const forward = pick(census(pages, opts));
      const backward = pick(census([...pages].reverse(), opts));
      expect(backward).toEqual(forward);
    }
  });
});

describe("a partial census is never presented as complete", () => {
  it("census-gap: status partial, complete false, and its totals are labeled partial", async () => {
    const { pages, opts } = await load("census-gap");
    const rep = census(pages, opts);
    expect(rep.status).toBe("partial");
    expect(rep.complete).toBe(false);
    expect(rep.totals_label).toBe("partial");
    expect(rep.covered_blocks).toBe(100);
    expect(rep.requested_blocks).toBe(300);
    expect(rep.notes).toContain("partial: 100 of 300 requested blocks are covered, so totals and by_account are partial");
    expect(rep.totals.escrows_opened).toBe(2);
  });

  it("census-reset: the other genesis adds no coverage, so the totals are labeled partial", async () => {
    const { pages, opts } = await load("census-reset");
    const rep = census(pages, opts);
    expect(rep.status).toBe("partial");
    expect(rep.totals_label).toBe("partial");
    expect(rep.notes.some((n) => n.startsWith("reset_detected:"))).toBe(true);
  });

  it("with no pages the whole request is one gap, and zero totals are labeled partial", () => {
    const rep = census([], opts(0, 49));
    expect(rep.covered).toEqual([]);
    expect(rep.gaps).toEqual([r(0, 49)]);
    expect(rep.status).toBe("partial");
    expect(rep.complete).toBe(false);
    expect(rep.totals_label).toBe("partial");
    expect(rep.reset_detected).toBeNull();
  });

  it("every fixture: complete exactly when there are no gaps, and status and label agree", async () => {
    for (const name of Object.keys(EXPECTED)) {
      const { pages, opts: o } = await load(name);
      const rep = census(pages, o);
      expect(rep.complete).toBe(rep.gaps.length === 0);
      expect(rep.status).toBe(rep.complete ? "complete" : "partial");
      expect(rep.totals_label).toBe(rep.status);
    }
  });
});

// ---- Inline cases, one block per clause of RULES.md 3.1 ----

const G = "0x" + "a1".repeat(32);
const OTHER = "0x" + "b2".repeat(32);
const hash = (n: number) => "0x" + "a1" + n.toString(16).padStart(62, "0");

function opts(from_block: number, to_block: number, pinnedGenesis = G): CensusOptions {
  return { pinnedGenesis, requested: { from_block, to_block }, observedAt: "2026-11-10T00:00:00.000Z", trust: "fixture" };
}

type Ev = Record<string, unknown>;
function ev(n: number | null, index: number, method = "EscrowOpened", more: Ev = {}): Ev {
  return {
    block_number: n,
    block_hash: hash(n ?? 9999),
    finalized: true,
    index,
    section: "hasStation",
    method,
    data: { who: alice },
    ...more,
  };
}
function pg(from: number, to: number, page: number, next: number | null, events: unknown[], genesis = G): Record<string, unknown> {
  return { genesis, from_block: from, to_block: to, page, next_page: next, events };
}

describe("3.1 rule 1: only complete chains inside the request count anywhere", () => {
  it("events on a broken chain count nowhere: not in totals, pending, duplicates or malformed", () => {
    const broken = pg(0, 9, 0, 1, [ev(1, 0), ev(1, 0), ev(2, 0, "EscrowOpened", { finalized: false }), { index: 0 }]);
    const rep = census([broken], opts(0, 9));
    expect(rep.totals).toEqual(counts({}));
    expect(rep.pending_unfinalized).toBe(0);
    expect(rep.duplicates_dropped).toBe(0);
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.covered).toEqual([]);
    expect(rep.notes[0]).toBe("range 0-9: page 1 is missing, so the range is not covered and its 4 event(s) count nowhere");
  });
});

describe("3.1 rule 2: chains", () => {
  it("are keyed by genesis too: another genesis cannot complete a pinned chain", () => {
    const rep = census([pg(0, 9, 0, 1, [ev(1, 0)]), pg(0, 9, 1, null, [ev(2, 0)], OTHER)], opts(0, 9));
    expect(rep.covered).toEqual([]);
    expect(rep.totals.escrows_opened).toBe(0);
    expect(rep.excluded_other_genesis).toBe(1);
  });

  it("are keyed by range: page 1 of another range does not continue this one", () => {
    const rep = census([pg(0, 9, 0, 1, [ev(1, 0)]), pg(0, 19, 1, null, [ev(2, 0)])], opts(0, 9));
    expect(rep.covered).toEqual([]);
  });

  it("must start at page 0", () => {
    const rep = census([pg(0, 9, 1, null, [ev(1, 0)])], opts(0, 9));
    expect(rep.covered).toEqual([]);
    expect(rep.notes[0]).toContain("page 0 is missing");
  });

  it("break on a cycle", () => {
    const rep = census([pg(0, 9, 0, 1, [ev(1, 0)]), pg(0, 9, 1, 0, [ev(2, 0)])], opts(0, 9));
    expect(rep.covered).toEqual([]);
    expect(rep.notes[0]).toContain("makes a cycle");
    expect(rep.totals.escrows_opened).toBe(0);
  });

  it("break on a next_page pointing at itself", () => {
    const rep = census([pg(0, 9, 0, 0, [ev(1, 0)])], opts(0, 9));
    expect(rep.covered).toEqual([]);
  });

  it("break when copies of one page number disagree on next_page", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0)]), pg(0, 9, 0, 1, [ev(1, 0)]), pg(0, 9, 1, null, [])], opts(0, 9));
    expect(rep.covered).toEqual([]);
    expect(rep.notes[0]).toContain("copies of page 0 disagree on next_page");
  });

  it("keep identical copies, and their events dedupe", () => {
    const p = pg(0, 9, 0, null, [ev(1, 0), ev(2, 0, "EscrowReleased")]);
    const rep = census([p, structuredClone(p)], opts(0, 9));
    expect(rep.covered).toEqual([r(0, 9)]);
    expect(rep.totals).toEqual(counts({ escrows_opened: 1, escrows_released: 1 }));
    expect(rep.duplicates_dropped).toBe(2);
  });

  it("ignore pages not reachable from page 0", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0)]), pg(0, 9, 3, null, [ev(2, 0), { not: "checked" }])], opts(0, 9));
    expect(rep.complete).toBe(true);
    expect(rep.totals.escrows_opened).toBe(1);
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.notes).toContain("range 0-9: 1 page(s) not reachable from page 0 were ignored");
  });
});

describe("3.1 rule 3: coverage", () => {
  it("clips each complete chain to the request", () => {
    const rep = census([pg(0, 99, 0, null, [])], opts(10, 20));
    expect(rep.covered).toEqual([r(10, 20)]);
    expect(rep.complete).toBe(true);
  });

  it("merges adjacent ranges: 1 to 5 and 6 to 10 become 1 to 10", () => {
    const rep = census([pg(1, 5, 0, null, []), pg(6, 10, 0, null, [])], opts(1, 10));
    expect(rep.covered).toEqual([r(1, 10)]);
    expect(rep.gaps).toEqual([]);
  });

  it("merges overlapping ranges and leaves the rest of the request as gaps", () => {
    const rep = census([pg(5, 30, 0, null, []), pg(20, 40, 0, null, []), pg(60, 70, 0, null, [])], opts(0, 99));
    expect(rep.covered).toEqual([r(5, 40), r(60, 70)]);
    expect(rep.gaps).toEqual([r(0, 4), r(41, 59), r(71, 99)]);
    expect(rep.covered_blocks).toBe(36 + 11);
  });

  it("a complete chain wholly outside the request adds no coverage", () => {
    const rep = census([pg(200, 299, 0, null, [])], opts(0, 99));
    expect(rep.covered).toEqual([]);
    expect(rep.gaps).toEqual([r(0, 99)]);
  });
});

describe("3.1 rule 4: events outside the request or their page are skipped, not malformed", () => {
  it("skips an integer block_number outside the request", () => {
    const rep = census([pg(0, 99, 0, null, [ev(5, 0), ev(50, 0)])], opts(0, 20));
    expect(rep.totals.escrows_opened).toBe(1);
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.notes).toContain("1 event(s) outside the request or their page's range were skipped");
  });

  it("skips an integer block_number outside its page's range, even inside the request", () => {
    const rep = census([pg(0, 9, 0, null, [ev(5, 0), ev(15, 0)]), pg(10, 19, 0, null, [])], opts(0, 19));
    expect(rep.totals.escrows_opened).toBe(1);
  });

  it("keeps a null block_number", () => {
    const rep = census([pg(0, 9, 0, null, [ev(null, 0)])], opts(0, 9));
    expect(rep.totals.escrows_opened).toBe(1);
  });
});

describe("3.1 rule 5: genesis is compared exactly as written", () => {
  it("an upper-case spelling of the pinned genesis is another genesis", () => {
    const upper = "0x" + "A1".repeat(32);
    const rep = census([pg(0, 9, 0, null, [ev(1, 0)], upper)], opts(0, 9));
    expect(rep.totals.escrows_opened).toBe(0);
    expect(rep.excluded_other_genesis).toBe(1);
    expect(rep.reset_detected).toBe(true);
  });
});

describe("3.1 rule 6: other geneses", () => {
  it("count every event on every page of another genesis, whatever chain, finality or shape", () => {
    const pages = [
      pg(0, 9, 0, null, [ev(1, 0)]),
      pg(0, 9, 0, 5, [ev(1, 0), ev(1, 0), ev(2, 0, "EscrowOpened", { finalized: false })], OTHER),
      pg(10, 19, 3, null, ["junk", ev(500, 0)], OTHER),
    ];
    const rep = census(pages, opts(0, 9));
    expect(rep.excluded_other_genesis).toBe(5);
    expect(rep.totals.escrows_opened).toBe(1);
    expect(rep.duplicates_dropped).toBe(0);
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.reset_detected).toBe(true);
  });

  it("reset_detected is false when every page is on the pinned genesis", () => {
    expect(census([pg(0, 9, 0, null, [])], opts(0, 9)).reset_detected).toBe(false);
  });
});

describe("3.1 rule 7: malformed events", () => {
  const cases: [string, unknown][] = [
    ["not an object (string)", "x"],
    ["not an object (null)", null],
    ["not an object (list)", [1, 2]],
    ["section missing", (() => { const e = ev(1, 0); delete e.section; return e; })()],
    ["section not a string", ev(1, 0, "EscrowOpened", { section: 7 })],
    ["section empty", ev(1, 0, "EscrowOpened", { section: "" })],
    ["method missing", (() => { const e = ev(1, 0); delete e.method; return e; })()],
    ["method empty", ev(1, 0, "")],
    ["block_hash missing", (() => { const e = ev(1, 0); delete e.block_hash; return e; })()],
    ["block_hash not a string", ev(1, 0, "EscrowOpened", { block_hash: 12 })],
    ["block_hash empty", ev(1, 0, "EscrowOpened", { block_hash: "" })],
    ["index missing", (() => { const e = ev(1, 0); delete e.index; return e; })()],
    ["index a boolean", ev(1, 0, "EscrowOpened", { index: true })],
    ["index a string", ev(1, 0, "EscrowOpened", { index: "0" })],
    ["index a fraction", ev(1, 0, "EscrowOpened", { index: 0.5 })],
    ["index negative", ev(1, -1)],
    ["block_number missing", (() => { const e = ev(1, 0); delete e.block_number; return e; })()],
    ["block_number a string", ev(1, 0, "EscrowOpened", { block_number: "1" })],
    ["block_number a boolean", ev(1, 0, "EscrowOpened", { block_number: true })],
  ];
  for (const [what, raw] of cases) {
    it(`${what} is malformed`, () => {
      const rep = census([pg(0, 9, 0, null, [raw])], opts(0, 9));
      expect(rep.malformed_dropped).toBe(1);
      expect(rep.totals.escrows_opened).toBe(0);
      expect(rep.pending_unfinalized).toBe(0);
    });
  }

  it("a non-object data is not malformed; the event has no account and counts in totals only", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", { data: "x" }), ev(2, 0, "EscrowOpened", { data: [alice] })])], opts(0, 9));
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.totals.escrows_opened).toBe(2);
    expect(rep.by_account).toEqual({});
  });

  it("a short block_hash is not malformed: the rule asks only for a non-empty string", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", { block_hash: "0xabc" })])], opts(0, 9));
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.totals.escrows_opened).toBe(1);
  });
});

describe("3.1 rule 8: finalized must be exactly true", () => {
  for (const [what, more] of [
    ["false", { finalized: false }],
    ["the string true", { finalized: "true" }],
    ["1", { finalized: 1 }],
    ["null", { finalized: null }],
  ] as [string, Ev][]) {
    it(`finalized ${what} is pending`, () => {
      const rep = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", more)])], opts(0, 9));
      expect(rep.pending_unfinalized).toBe(1);
      expect(rep.totals.escrows_opened).toBe(0);
    });
  }

  it("a missing finalized is pending", () => {
    const e = ev(1, 0);
    delete e.finalized;
    const rep = census([pg(0, 9, 0, null, [e])], opts(0, 9));
    expect(rep.pending_unfinalized).toBe(1);
    expect(rep.totals.escrows_opened).toBe(0);
  });
});

describe("3.1 rule 9: duplicate groups", () => {
  it("duplicates_dropped adds copies minus one per group, across and within pages", () => {
    const rep = census([pg(0, 9, 0, 1, [ev(1, 0), ev(1, 0), ev(2, 0)]), pg(0, 9, 1, null, [ev(1, 0), ev(2, 0)])], opts(0, 9));
    expect(rep.duplicates_dropped).toBe(3);
    expect(rep.totals.escrows_opened).toBe(2);
  });

  it("one unfinalized copy makes the whole group one pending event, in any order", () => {
    for (const order of [[true, false], [false, true]]) {
      const evs = order.map((f) => ev(1, 0, "EscrowOpened", { finalized: f }));
      const rep = census([pg(0, 9, 0, null, evs)], opts(0, 9));
      expect(rep.pending_unfinalized).toBe(1);
      expect(rep.totals.escrows_opened).toBe(0);
      expect(rep.duplicates_dropped).toBe(1);
    }
  });

  it("copies that disagree on method count once as malformed and nowhere else", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened"), ev(1, 0, "EscrowReleased"), ev(1, 0, "EscrowOpened")])], opts(0, 9));
    expect(rep.malformed_dropped).toBe(1);
    expect(rep.duplicates_dropped).toBe(2);
    expect(rep.totals).toEqual(counts({}));
  });

  it("copies that disagree on section count once as malformed", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0), ev(1, 0, "EscrowOpened", { section: "computeChannel" })])], opts(0, 9));
    expect(rep.malformed_dropped).toBe(1);
    expect(rep.totals.escrows_opened).toBe(0);
  });

  it("copies that disagree on account count once as malformed, also when one copy has no account", () => {
    const a = census([pg(0, 9, 0, null, [ev(1, 0), ev(1, 0, "EscrowOpened", { data: { who: bob } })])], opts(0, 9));
    const b = census([pg(0, 9, 0, null, [ev(1, 0), ev(1, 0, "EscrowOpened", { data: {} })])], opts(0, 9));
    for (const rep of [a, b]) {
      expect(rep.malformed_dropped).toBe(1);
      expect(rep.by_account).toEqual({});
    }
  });

  it("copies that differ only outside section, method and account still dedupe", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", { data: { who: alice, n: 1 } }), ev(1, 0, "EscrowOpened", { data: { who: alice, n: 2 } })])], opts(0, 9));
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.totals.escrows_opened).toBe(1);
  });

  it("disagreement wins over pending: the group is malformed, not pending", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", { finalized: false }), ev(1, 0, "EscrowReleased")])], opts(0, 9));
    expect(rep.malformed_dropped).toBe(1);
    expect(rep.pending_unfinalized).toBe(0);
  });

  it("malformed events have no key and are never deduplicated", () => {
    const bad = ev(1, 0, "EscrowOpened", { section: "" });
    const rep = census([pg(0, 9, 0, null, [bad, structuredClone(bad), structuredClone(bad)])], opts(0, 9));
    expect(rep.malformed_dropped).toBe(3);
    expect(rep.duplicates_dropped).toBe(0);
  });

  it("the same block_hash and index on different geneses are different events", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0)]), pg(0, 9, 0, null, [ev(1, 0)], OTHER)], opts(0, 9));
    expect(rep.duplicates_dropped).toBe(0);
    expect(rep.excluded_other_genesis).toBe(1);
  });
});

describe("3.1 rule 10: order of the filters", () => {
  it("the block range filter runs before the malformed check", () => {
    const noSection = ev(50, 0);
    delete noSection.section;
    const rep = census([pg(0, 9, 0, null, [noSection])], opts(0, 9));
    expect(rep.malformed_dropped).toBe(0);
  });

  it("pending is decided before kind: an unfinalized event of any kind is pending", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0, "Transfer", { section: "balances", finalized: false })])], opts(0, 9));
    expect(rep.pending_unfinalized).toBe(1);
  });

  it("finalized events of kinds not in the table count nowhere", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0, "Transfer", { section: "balances" }), ev(2, 0, "escrowopened")])], opts(0, 9));
    expect(rep.totals).toEqual(counts({}));
    expect(rep.pending_unfinalized + rep.duplicates_dropped + rep.malformed_dropped).toBe(0);
    expect(rep.by_account).toEqual({});
  });

  it("counts each kind under its RULES.md event name", () => {
    const evs = [
      ev(1, 0, "EscrowOpened"),
      ev(2, 0, "EscrowReleased"),
      ev(3, 0, "EscrowRefunded"),
      ev(4, 0, "ChannelOpened", { section: "computeChannel" }),
      ev(5, 0, "ChannelSettled", { section: "computeChannel" }),
      ev(6, 0, "ChannelOpened"),
    ];
    const rep = census([pg(0, 9, 0, null, evs)], opts(0, 9));
    expect(rep.totals).toEqual(counts({ escrows_opened: 1, escrows_released: 1, escrows_refunded: 1, channels_opened: 1, channels_settled: 1 }));
    expect(rep.event_names).toEqual({
      escrows_opened: { event: "hasStation.EscrowOpened", confirmed: true },
      escrows_released: { event: "hasStation.EscrowReleased", confirmed: true },
      escrows_refunded: { event: "hasStation.EscrowRefunded", confirmed: true },
      channels_opened: { event: "computeChannel.ChannelOpened", confirmed: false },
      channels_settled: { event: "computeChannel.ChannelSettled", confirmed: false },
    });
  });
});

describe("3.1 rule 11: by_account", () => {
  it("uses the first of who, owner, agent, payer that is a non-empty string", () => {
    const evs = [
      ev(1, 0, "EscrowOpened", { data: { payer: dave, agent: carol, owner: bob, who: alice } }),
      ev(2, 0, "EscrowOpened", { data: { payer: dave, agent: carol, owner: bob } }),
      ev(3, 0, "EscrowOpened", { data: { payer: dave, agent: carol } }),
      ev(4, 0, "EscrowOpened", { data: { payer: dave } }),
      ev(5, 0, "EscrowOpened", { data: { who: "", owner: null, agent: 5, payer: dave } }),
      ev(6, 0, "EscrowOpened", { data: { from: alice } }),
    ];
    const rep = census([pg(0, 9, 0, null, evs)], opts(0, 9));
    expect(rep.by_account).toEqual({
      [alice]: { escrows_opened: 1 },
      [bob]: { escrows_opened: 1 },
      [carol]: { escrows_opened: 1 },
      [dave]: { escrows_opened: 2 },
    });
    expect(rep.totals.escrows_opened).toBe(6);
  });

  it("lists only non-zero kinds", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowReleased")])], opts(0, 9));
    expect(rep.by_account).toEqual({ [alice]: { escrows_released: 1 } });
  });

  it("sorts accounts ascending by code point, as Python does", () => {
    const names = ["zeta", "Alpha", "beta", "\u{1F600}smile", "～wide"];
    const evs = names.map((who, i) => ev(i, 0, "EscrowOpened", { data: { who } }));
    const rep = census([pg(0, 9, 0, null, evs)], opts(0, 9));
    expect(Object.keys(rep.by_account)).toEqual(["Alpha", "beta", "zeta", "～wide", "\u{1F600}smile"]);
  });

  it("an account named __proto__ is kept as data", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", { data: { who: "__proto__" } })])], opts(0, 9));
    expect(Object.keys(rep.by_account)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(rep.by_account)).toBe(Object.prototype);
  });
});

describe("3.1 rule 12: a structurally invalid page refuses the whole census", () => {
  const good = () => pg(0, 9, 0, null, [ev(1, 0)]);
  const without = (key: string) => {
    const p = good();
    delete p[key];
    return p;
  };
  const cases: [string, unknown][] = [
    ["not an object", "page"],
    ["a list", [good()]],
    ["genesis not a string", { ...good(), genesis: 1 }],
    ["genesis missing", without("genesis")],
    ["from_block missing", without("from_block")],
    ["from_block a string", { ...good(), from_block: "0" }],
    ["to_block missing", without("to_block")],
    ["to_block a fraction", { ...good(), to_block: 9.5 }],
    ["page missing", without("page")],
    ["page a boolean", { ...good(), page: false }],
    ["next_page missing", without("next_page")],
    ["next_page a string", { ...good(), next_page: "1" }],
    ["events not a list", { ...good(), events: { 0: ev(1, 0) } }],
    ["events missing", without("events")],
    ["an inverted range", { ...good(), from_block: 10, to_block: 9 }],
  ];
  for (const [what, bad] of cases) {
    it(`${what}`, () => {
      expect(() => census([good(), bad], opts(0, 9))).toThrow(CensusRefused);
    });
  }

  it("refuses even when the invalid page is on another genesis or unreachable", () => {
    expect(() => census([good(), { ...without("next_page"), genesis: OTHER }], opts(0, 9))).toThrow(CensusRefused);
    expect(() => census([good(), { ...good(), page: 4, events: null }], opts(0, 9))).toThrow(CensusRefused);
  });
});

describe("3.1 rule 13: invalid requests are refused", () => {
  it("a negative from_block", () => {
    expect(() => census([], opts(-1, 9))).toThrow(CensusRefused);
  });
  it("from_block greater than to_block", () => {
    expect(() => census([], opts(10, 9))).toThrow(CensusRefused);
  });
  it("a request that is not integers", () => {
    expect(() => census([], { ...opts(0, 9), requested: { from_block: 0.5, to_block: 9 } })).toThrow(CensusRefused);
  });
  it("a one-block request is fine", () => {
    expect(census([pg(5, 5, 0, null, [ev(5, 0)])], opts(5, 5)).totals.escrows_opened).toBe(1);
  });
  it("no pinned genesis is refused", () => {
    expect(() => census([], opts(0, 9, ""))).toThrow(CensusRefused);
  });
});
