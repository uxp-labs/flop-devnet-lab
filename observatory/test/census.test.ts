// Census tests. Each rule in RULES.md section 3 and each clause of 3.1 has its own test, and every
// census fixture is checked against expectations worked out by hand from the rules (not taken
// from census.ts), which must also be the totals its meta.description states.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { census, CensusRefused, type CensusOptions } from "../src/census.js";
import { FixtureSource } from "../src/source.js";
import type { BlockRange, CensusCounts, CensusReport } from "../src/types.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
/** The FLOP devnet genesis. Every census fixture pins it, so snapshots can carry the census. */
const DEVNET = "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631";
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
const quiet = { pending_unfinalized: 0, duplicates_dropped: 0, excluded_other_genesis: 0, malformed_dropped: 0 };

/** Worked out by hand from RULES.md 3.1. Each fixture's meta.description gives the reasoning. */
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
    ...quiet,
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
    ...quiet,
    duplicates_dropped: 6,
    reset_detected: false,
  },
  "census-gap": {
    complete: false,
    status: "partial",
    covered: [r(0, 99)],
    gaps: [r(100, 299)],
    totals: counts({ escrows_opened: 2 }),
    by_account: { [alice]: { escrows_opened: 1 }, [bob]: { escrows_opened: 1 } },
    ...quiet,
    reset_detected: false,
  },
  "census-reset": {
    complete: false,
    status: "partial",
    covered: [r(0, 99)],
    gaps: [r(100, 199)],
    totals: counts({ escrows_opened: 1, escrows_released: 1 }),
    by_account: { [alice]: { escrows_opened: 1, escrows_released: 1 } },
    ...quiet,
    excluded_other_genesis: 3,
    reset_detected: true,
  },
  "census-unfinalized": {
    complete: true,
    status: "complete",
    covered: [r(0, 99)],
    gaps: [],
    totals: counts({ escrows_opened: 1, escrows_refunded: 1 }),
    by_account: { [alice]: { escrows_opened: 1 }, [bob]: { escrows_refunded: 1 } },
    ...quiet,
    pending_unfinalized: 4,
    duplicates_dropped: 1,
    reset_detected: false,
  },
  "census-malformed": {
    complete: true,
    status: "complete",
    covered: [r(0, 99)],
    gaps: [],
    totals: counts({ escrows_opened: 2, escrows_released: 1 }),
    by_account: { [alice]: { escrows_opened: 1, escrows_released: 1 } },
    ...quiet,
    duplicates_dropped: 2,
    malformed_dropped: 12,
    reset_detected: false,
  },
  "census-outside-request": {
    complete: true,
    status: "complete",
    covered: [r(0, 99)],
    gaps: [],
    totals: counts({ escrows_opened: 1, escrows_released: 1 }),
    by_account: { [alice]: { escrows_opened: 1, escrows_released: 1 } },
    ...quiet,
    reset_detected: false,
  },
  "census-orphan-disagree": {
    complete: false,
    status: "partial",
    covered: [r(100, 199)],
    gaps: [r(0, 99)],
    totals: counts({ escrows_released: 1 }),
    by_account: { [alice]: { escrows_released: 1 } },
    ...quiet,
    reset_detected: false,
  },
  "census-negative-next-page": {
    complete: false,
    status: "partial",
    covered: [r(100, 199)],
    gaps: [r(0, 99)],
    totals: counts({ escrows_opened: 1 }),
    by_account: { [bob]: { escrows_opened: 1 } },
    ...quiet,
    reset_detected: false,
  },
  "census-block-number-missing": {
    complete: true,
    status: "complete",
    covered: [r(0, 99)],
    gaps: [],
    totals: counts({ escrows_opened: 1, escrows_released: 1 }),
    by_account: { [alice]: { escrows_opened: 1, escrows_released: 1 } },
    ...quiet,
    malformed_dropped: 2,
    reset_detected: false,
  },
  "census-index-written-as-float": {
    complete: true,
    status: "complete",
    covered: [r(0, 99)],
    gaps: [],
    totals: counts({ escrows_opened: 1, escrows_released: 1 }),
    by_account: { [alice]: { escrows_opened: 1, escrows_released: 1 } },
    ...quiet,
    duplicates_dropped: 1,
    malformed_dropped: 1,
    reset_detected: false,
  },
  "census-page-written-as-float": {
    complete: true,
    status: "complete",
    covered: [r(0, 99)],
    gaps: [],
    totals: counts({ escrows_opened: 1, escrows_released: 1 }),
    by_account: { [alice]: { escrows_opened: 1, escrows_released: 1 } },
    ...quiet,
    reset_detected: false,
  },
  "census-block-hash-form": {
    complete: true,
    status: "complete",
    covered: [r(0, 99)],
    gaps: [],
    totals: counts({ escrows_opened: 1, escrows_released: 1 }),
    by_account: { [alice]: { escrows_opened: 1, escrows_released: 1 } },
    ...quiet,
    malformed_dropped: 2,
    reset_detected: false,
  },
};

/** Fixtures the census must refuse, with what the refusal must name. */
const REFUSING: Record<string, RegExp> = {
  "census-invalid-page": /next_page is missing/,
  "census-negative-page": /page -1 is negative/,
  "census-unreadable-page": /unusable event page file\(s\): event-pages\/01-unreadable\.json: /,
  "census-nonstandard-json": /unusable event page file\(s\): event-pages\/01-nan-index\.json: /,
  "census-dotfile-page": /unusable event page file\(s\): event-pages\/\.01\.json: not a page file/,
  "census-symlink-page": /unusable event page file\(s\): event-pages\/01\.json: not a page file/,
  "census-unsafe-integer": /event page 0: to_block is missing or not a safe integer/,
};

/** The raw text of one fixture page file, exactly as written by hand. */
function rawPage(name: string, file: string): string {
  return readFileSync(join(FIXTURES, name, "event-pages", file), "utf8");
}

/** The sentence each fixture's meta.description must contain, in one fixed format. */
function sentence(x: Expected): string {
  const ranges = (rs: BlockRange[]) => (rs.length ? rs.map((b) => `${b.from_block} to ${b.to_block}`).join(", ") : "none");
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

/** Loads a fixture the way the command line does, unreadable page files included. */
async function load(name: string) {
  const src = FixtureSource.fromDir(join(FIXTURES, name));
  const meta = src.data.meta;
  const unreadable = await src.eventPageErrors();
  // Only event page files may fail to load, and those are passed on, never dropped.
  expect(src.data.loadErrors).toEqual(unreadable);
  expect(meta.synthetic).toBe(true);
  expect(meta.census_request).toBeDefined();
  expect(meta.pinned_genesis).toBe(DEVNET);
  const opts: CensusOptions = {
    pinnedGenesis: meta.pinned_genesis!,
    requested: meta.census_request!,
    observedAt: meta.now,
    trust: src.trust,
    unreadablePages: unreadable,
  };
  return { pages: await src.eventPages(), meta, opts };
}

function pick(rep: CensusReport): Expected {
  return Object.fromEntries(COMPARED.map((k) => [k, rep[k]])) as Expected;
}

describe("census fixtures", () => {
  it("every census fixture has an expectation here", () => {
    const dirs = readdirSync(FIXTURES).filter((d) => d.startsWith("census-")).sort();
    expect(dirs).toEqual([...Object.keys(EXPECTED), ...Object.keys(REFUSING)].sort());
  });

  it("all pin the devnet genesis, and only census-reset has pages on another genesis", async () => {
    for (const name of [...Object.keys(EXPECTED), ...Object.keys(REFUSING)]) {
      const { pages } = await load(name);
      const others = pages.filter((p) => p.genesis !== DEVNET);
      expect(others.length > 0, name).toBe(name === "census-reset");
    }
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
      expect(rep.genesis).toBe(DEVNET);
      expect(rep.requested).toEqual(opts.requested);
      expect(JSON.parse(JSON.stringify(rep))).toEqual(rep);
    });
  }

  for (const [name, why] of Object.entries(REFUSING)) {
    it(`${name} refuses the whole census`, async () => {
      const { pages, meta, opts } = await load(name);
      expect(() => census(pages, opts)).toThrow(CensusRefused);
      expect(() => census(pages, opts)).toThrow(why);
      expect(meta.description).toContain("Expected: the census refuses; no totals.");
    });
  }

  it("census-unreadable-page refuses only because of its unreadable file", async () => {
    const { pages, opts } = await load("census-unreadable-page");
    expect(opts.unreadablePages).toHaveLength(1);
    const blind = census(pages, { ...opts, unreadablePages: [] });
    expect(blind.complete).toBe(true);
    expect(blind.totals.escrows_released).toBe(1);
  });

  it("census-dotfile-page refuses only because of its dotfile", async () => {
    const { pages, opts } = await load("census-dotfile-page");
    expect(opts.unreadablePages).toEqual([expect.stringMatching(/^event-pages\/\.01\.json: not a page file/)]);
    const blind = census(pages, { ...opts, unreadablePages: [] });
    expect(blind.complete).toBe(true);
    expect(blind.totals.escrows_opened).toBe(1);
    expect(blind.duplicates_dropped).toBe(0);
  });

  it("census-symlink-page refuses only because of its symbolic link", async () => {
    const { pages, opts } = await load("census-symlink-page");
    expect(opts.unreadablePages).toEqual([expect.stringMatching(/^event-pages\/01\.json: not a page file/)]);
    const blind = census(pages, { ...opts, unreadablePages: [] });
    expect(blind.complete).toBe(true);
    expect(blind.totals.escrows_opened).toBe(1);
    expect(blind.duplicates_dropped).toBe(0);
  });

  it("census-nonstandard-json refuses only because of its file with NaN in it", async () => {
    const { pages, opts } = await load("census-nonstandard-json");
    expect(opts.unreadablePages).toHaveLength(1);
    const blind = census(pages, { ...opts, unreadablePages: [] });
    expect(blind.complete).toBe(true);
    expect(blind.totals.escrows_released).toBe(1);
  });

  it("census-outside-request, census-orphan-disagree and census-negative-next-page say why blocks count nowhere", async () => {
    const notes = async (name: string) => {
      const { pages, opts } = await load(name);
      return census(pages, opts).notes;
    };
    expect(await notes("census-outside-request")).toContain(
      "blocks 200 to 299: the chain is complete but does not intersect the request, so its 5 event(s) count nowhere",
    );
    expect(await notes("census-orphan-disagree")).toContain(
      "blocks 0 to 99: copies of page 7 disagree on next_page, so the chain is broken and its 1 event(s) count nowhere",
    );
    expect(await notes("census-negative-next-page")).toContain(
      "blocks 0 to 99: next_page -1 on page 0 names a page that does not exist, so the chain is broken and its 2 event(s) count nowhere",
    );
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

describe("hand written fixtures keep their literal JSON text", () => {
  it("census-index-written-as-float still holds index 1.0 and index 1.5 as written", () => {
    const text = rawPage("census-index-written-as-float", "00-page-0.json");
    expect(text).toMatch(/"index":\s*1\.0\s*,/);
    expect(text).toMatch(/"index":\s*1\.5\s*,/);
    expect(text).toMatch(/"index":\s*1\s*,/);
  });

  it("census-page-written-as-float still holds every page integer field written with .0", () => {
    const first = rawPage("census-page-written-as-float", "00-page-0.json");
    for (const literal of [/"from_block":\s*0\.0\s*,/, /"to_block":\s*99\.0\s*,/, /"page":\s*0\.0\s*,/, /"next_page":\s*1\.0\s*,/, /"block_number":\s*5\.0\s*,/]) {
      expect(first).toMatch(literal);
    }
    expect(rawPage("census-page-written-as-float", "01-page-1.json")).toMatch(/"page":\s*1\.0\s*,/);
  });

  it("census-nonstandard-json still holds the NaN token, and only that file fails to parse", () => {
    const text = rawPage("census-nonstandard-json", "01-nan-index.json");
    expect(text).toMatch(/"index":\s*NaN\s*,/);
    expect(() => JSON.parse(text)).toThrow(SyntaxError);
    expect(() => JSON.parse(text.replace(/NaN/, "0"))).not.toThrow();
    expect(() => JSON.parse(rawPage("census-nonstandard-json", "00-page-0.json"))).not.toThrow();
  });

  it("census-block-number-missing has two events with no block_number key and one with an explicit null", () => {
    const page = JSON.parse(rawPage("census-block-number-missing", "00-page-0.json")) as { events: Record<string, unknown>[] };
    expect(page.events.filter((e) => !Object.hasOwn(e, "block_number"))).toHaveLength(2);
    expect(page.events.filter((e) => Object.hasOwn(e, "block_number") && e.block_number === null)).toHaveLength(1);
  });

  it("census-unsafe-integer still holds 9007199254740993, which JSON.parse cannot read exactly", () => {
    const text = rawPage("census-unsafe-integer", "00.json");
    expect(text).toMatch(/"to_block":\s*9007199254740993\s*,/);
    expect(text).toMatch(/"block_number":\s*9007199254740993\s*,/);
    const parsed = JSON.parse(text) as { to_block: number };
    expect(parsed.to_block).toBe(2 ** 53);
    expect(Number.isSafeInteger(parsed.to_block)).toBe(false);
  });

  it("census-block-hash-form still holds an upper case hash and a short hash beside valid ones", () => {
    const page = JSON.parse(rawPage("census-block-hash-form", "00-page-0.json")) as { events: { block_hash: string }[] };
    const hashes = page.events.map((e) => e.block_hash);
    expect(hashes.filter((h) => /^0x[0-9a-f]{64}$/.test(h))).toHaveLength(2);
    expect(hashes).toContain("0xabc");
    expect(hashes.filter((h) => /^0x[0-9A-F]{64}$/.test(h) && /[A-F]/.test(h))).toHaveLength(1);
    expect(hashes[1]!.toLowerCase()).toBe(hashes[0]);
  });

  it("census-symlink-page: 01.json really is a symbolic link, and it resolves to a page file", () => {
    // Only facts that also hold in a copied tree: a copy may rewrite where the link points.
    const dir = join(FIXTURES, "census-symlink-page", "event-pages");
    expect(readdirSync(dir).sort()).toEqual(["00.json", "01.json"]);
    expect(lstatSync(join(dir, "01.json")).isSymbolicLink()).toBe(true);
    expect(statSync(join(dir, "01.json")).isFile()).toBe(true);
    expect(lstatSync(join(dir, "00.json")).isFile()).toBe(true);
    const followed = JSON.parse(readFileSync(join(dir, "01.json"), "utf8")) as { page: number; events: unknown[] };
    expect([followed.page, followed.events.length]).toEqual([0, 2]);
  });

  it("census-dotfile-page still holds a page file whose name starts with a dot, beside a normal one", () => {
    expect(readdirSync(join(FIXTURES, "census-dotfile-page", "event-pages")).sort()).toEqual([".01.json", "00.json"]);
    const dot = JSON.parse(rawPage("census-dotfile-page", ".01.json")) as { page: number; events: unknown[] };
    expect([dot.page, dot.events.length]).toEqual([0, 2]);
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

// Inline cases below: one block per clause of RULES.md 3.1.

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

describe("3.1 clause 1: only complete chains that intersect the request count", () => {
  it("events on a broken chain count nowhere: not in totals, pending, duplicates or malformed", () => {
    const broken = pg(0, 9, 0, 1, [ev(1, 0), ev(1, 0), ev(2, 0, "EscrowOpened", { finalized: false }), { index: 0 }]);
    const rep = census([broken], opts(0, 9));
    expect(rep.totals).toEqual(counts({}));
    expect(rep.pending_unfinalized).toBe(0);
    expect(rep.duplicates_dropped).toBe(0);
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.covered).toEqual([]);
    expect(rep.notes[0]).toBe(
      "blocks 0 to 9: next_page 1 on page 0 names a page that does not exist, so the chain is broken and its 4 event(s) count nowhere",
    );
  });

  it("a complete chain that does not intersect the request counts nothing, whatever the block_number", () => {
    const outside = pg(200, 299, 0, null, [
      ev(null, 0),
      ev(null, 0),
      ev(null, 1, "EscrowOpened", { finalized: false }),
      ev(null, 2, "EscrowOpened", { section: "" }),
      ev(250, 3),
    ]);
    const rep = census([pg(0, 99, 0, null, [ev(5, 0)]), outside], opts(0, 99));
    expect(rep.totals.escrows_opened).toBe(1);
    expect([rep.pending_unfinalized, rep.duplicates_dropped, rep.malformed_dropped]).toEqual([0, 0, 0]);
    expect(rep.covered).toEqual([r(0, 99)]);
    expect(rep.notes).toContain(
      "blocks 200 to 299: the chain is complete but does not intersect the request, so its 5 event(s) count nowhere",
    );
    expect(rep.notes.some((n) => n.includes("skipped"))).toBe(false);
  });

  it("a chain that shares one block with the request intersects it, so its null block_number events count", () => {
    const rep = census([pg(99, 199, 0, null, [ev(null, 0), ev(150, 1)])], opts(0, 99));
    expect(rep.covered).toEqual([r(99, 99)]);
    expect(rep.totals.escrows_opened).toBe(1);
    expect(rep.notes).toContain("1 event(s) outside the request or their page's range were skipped");
  });
});

describe("3.1 clause 2: chains", () => {
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
    expect(rep.notes[0]).toContain("there is no page 0");
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

  it("break when a next_page names a page that does not exist", () => {
    const rep = census([pg(0, 9, 0, 3, [ev(1, 0)]), pg(0, 9, 1, null, [])], opts(0, 9));
    expect(rep.covered).toEqual([]);
    expect(rep.notes[0]).toContain("next_page 3 on page 0 names a page that does not exist");
  });

  it("break on a negative next_page, which names a page that does not exist instead of ending the chain", () => {
    const rep = census([pg(0, 9, 0, -1, [ev(1, 0)])], opts(0, 9));
    expect(rep.covered).toEqual([]);
    expect(rep.totals.escrows_opened).toBe(0);
    expect(rep.notes[0]).toContain("next_page -1 on page 0 names a page that does not exist");
  });

  it("break when copies of one page number disagree on next_page", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0)]), pg(0, 9, 0, 1, [ev(1, 0)]), pg(0, 9, 1, null, [])], opts(0, 9));
    expect(rep.covered).toEqual([]);
    expect(rep.notes[0]).toContain("copies of page 0 disagree on next_page");
  });

  it("break when copies of a page the walk never reaches disagree on next_page", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0)]), pg(0, 9, 7, null, []), pg(0, 9, 7, 8, [])], opts(0, 9));
    expect(rep.covered).toEqual([]);
    expect(rep.totals.escrows_opened).toBe(0);
    expect(rep.notes[0]).toContain("copies of page 7 disagree on next_page");
  });

  it("keep identical copies, and their events dedupe", () => {
    const p = pg(0, 9, 0, null, [ev(1, 0), ev(2, 0, "EscrowReleased")]);
    const rep = census([p, structuredClone(p)], opts(0, 9));
    expect(rep.covered).toEqual([r(0, 9)]);
    expect(rep.totals).toEqual(counts({ escrows_opened: 1, escrows_released: 1 }));
    expect(rep.duplicates_dropped).toBe(2);
  });

  it("ignore pages not reachable from page 0, even when their next_page names no page: only next_page on the walk must exist", () => {
    const pages = [pg(0, 9, 0, null, [ev(1, 0)]), pg(0, 9, 3, 4, [ev(2, 0), { not: "checked" }]), pg(0, 9, 3, 4, [])];
    const rep = census(pages, opts(0, 9));
    expect(rep.complete).toBe(true);
    expect(rep.totals.escrows_opened).toBe(1);
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.notes).toContain("blocks 0 to 9: 2 page(s) not reachable from page 0 were ignored");
  });
});

describe("3.1 clause 3: coverage", () => {
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

describe("3.1 clause 4: events outside the request or their page are skipped, not malformed", () => {
  it("skips an integer block_number outside the request", () => {
    const rep = census([pg(0, 99, 0, null, [ev(5, 0), ev(50, 0)])], opts(0, 20));
    expect(rep.totals.escrows_opened).toBe(1);
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.notes).toContain("1 event(s) outside the request or their page's range were skipped");
  });

  it("skips an integer block_number above its page's range, even inside the request", () => {
    const rep = census([pg(0, 9, 0, null, [ev(5, 0), ev(15, 0)]), pg(10, 19, 0, null, [])], opts(0, 19));
    expect(rep.totals.escrows_opened).toBe(1);
  });

  it("skips an integer block_number below its page's range, even inside the request", () => {
    const rep = census([pg(0, 9, 0, null, []), pg(10, 19, 0, null, [ev(5, 0), ev(15, 0)])], opts(0, 19));
    expect(rep.complete).toBe(true);
    expect(rep.totals.escrows_opened).toBe(1);
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.notes).toContain("1 event(s) outside the request or their page's range were skipped");
  });

  it("keeps events on the edges of the page's range", () => {
    const rep = census([pg(10, 19, 0, null, [ev(10, 0), ev(19, 0)])], opts(0, 19));
    expect(rep.totals.escrows_opened).toBe(2);
  });

  it("keeps a null block_number on a chain that intersects the request", () => {
    const rep = census([pg(0, 9, 0, null, [ev(null, 0)])], opts(0, 9));
    expect(rep.totals.escrows_opened).toBe(1);
  });
});

describe("3.1 clause 5: genesis is compared exactly as written", () => {
  it("an upper case spelling of the pinned genesis is another genesis", () => {
    const upper = "0x" + "A1".repeat(32);
    const rep = census([pg(0, 9, 0, null, [ev(1, 0)], upper)], opts(0, 9));
    expect(rep.totals.escrows_opened).toBe(0);
    expect(rep.excluded_other_genesis).toBe(1);
    expect(rep.reset_detected).toBe(true);
  });
});

describe("3.1 clause 6: other geneses", () => {
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

describe("3.1 clause 7: malformed events", () => {
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

  it("a data value that is not an object is not malformed; the event has no account and counts in totals only", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", { data: "x" }), ev(2, 0, "EscrowOpened", { data: [alice] })])], opts(0, 9));
    expect(rep.malformed_dropped).toBe(0);
    expect(rep.totals.escrows_opened).toBe(2);
    expect(rep.by_account).toEqual({});
  });

  it("a block_hash must be 0x and 64 lower case hex digits, as the escrow rules read it", () => {
    const good = hash(1);
    const forms: [string, string][] = [
      ["upper case", good.toUpperCase().replace("0X", "0x")],
      ["0X prefix", good.replace("0x", "0X")],
      ["short", "0xabc"],
      ["no prefix", good.slice(2)],
      ["65 digits", good + "0"],
      ["63 digits", good.slice(0, -1)],
      ["not hex", good.slice(0, -1) + "g"],
    ];
    for (const [what, block_hash] of forms) {
      const rep = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", { block_hash })])], opts(0, 9));
      expect(rep.malformed_dropped, what).toBe(1);
      expect(rep.totals.escrows_opened, what).toBe(0);
    }
    const ok = census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", { block_hash: good })])], opts(0, 9));
    expect([ok.malformed_dropped, ok.totals.escrows_opened]).toEqual([0, 1]);
  });
});

describe("3.1 clause 8: finalized must be exactly true", () => {
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

describe("3.1 clause 9: duplicate groups", () => {
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

describe("3.1 clause 10: order of the filters", () => {
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

describe("3.1 clause 11: by_account", () => {
  it("uses the first of who, owner, agent, payer that is a string and not empty", () => {
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

  it("lists only kinds with a count", () => {
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

describe("3.1 clause 12: a structurally invalid page refuses the whole census", () => {
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
    ["page negative", { ...good(), page: -1 }],
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
    expect(() => census([good(), { ...good(), page: -3 }], opts(0, 9))).toThrow(/page -3 is negative/);
  });
});

describe("3.1 clause 12: an unreadable event page file refuses the whole census", () => {
  const readable = [pg(0, 9, 0, null, [ev(1, 0)])];

  it("names every unreadable file", () => {
    const go = () =>
      census(readable, {
        ...opts(0, 9),
        unreadablePages: ["event-pages/02.json: Unexpected end of JSON input", "event-pages/05.json: Unexpected token"],
      });
    expect(go).toThrow(CensusRefused);
    expect(go).toThrow("unusable event page file(s): event-pages/02.json: Unexpected end of JSON input; event-pages/05.json: Unexpected token");
  });

  it("refuses even when no page could be read at all", () => {
    expect(() => census([], { ...opts(0, 9), unreadablePages: ["event-pages/00.json: bad"] })).toThrow(CensusRefused);
  });

  it("an empty list, or no list, changes nothing", () => {
    const a = census(readable, { ...opts(0, 9), unreadablePages: [] });
    const b = census(readable, opts(0, 9));
    expect(a).toEqual(b);
    expect(a.complete).toBe(true);
  });
});

describe("3.1 clause 13: invalid requests are refused", () => {
  it("a negative from_block", () => {
    expect(() => census([], opts(-1, 9))).toThrow(CensusRefused);
  });
  it("from_block greater than to_block", () => {
    expect(() => census([], opts(10, 9))).toThrow(CensusRefused);
  });
  it("a request that is not integers", () => {
    expect(() => census([], { ...opts(0, 9), requested: { from_block: 0.5, to_block: 9 } })).toThrow(CensusRefused);
  });
  it("a one block request is fine", () => {
    expect(census([pg(5, 5, 0, null, [ev(5, 0)])], opts(5, 5)).totals.escrows_opened).toBe(1);
  });
  it("no pinned genesis is refused", () => {
    expect(() => census([], opts(0, 9, ""))).toThrow(CensusRefused);
  });
});

describe("3.1 clause 14: integers are judged by value", () => {
  // Parsed from JSON text, because a JavaScript literal 1.0 is already just 1.
  const page = (index: string) =>
    JSON.parse(
      `{"genesis":"${G}","from_block":0,"to_block":9,"page":0,"next_page":null,"events":[` +
        `{"block_number":1,"block_hash":"${hash(1)}","finalized":true,"index":${index},"section":"hasStation","method":"EscrowOpened","data":{"who":"${alice}"}}]}`,
    ) as unknown;

  it("index written 1.0 is the integer 1 and counts", () => {
    const rep = census([page("1.0")], opts(0, 9));
    expect(rep.totals.escrows_opened).toBe(1);
    expect(rep.malformed_dropped).toBe(0);
  });

  it("index 1.5 is not an integer, so the event is malformed", () => {
    const rep = census([page("1.5")], opts(0, 9));
    expect(rep.malformed_dropped).toBe(1);
    expect(rep.totals.escrows_opened).toBe(0);
  });

  it("index 1.0 and index 1 are the same key, so the copies dedupe", () => {
    const rep = census([page("1.0"), page("1")], opts(0, 9));
    expect(rep.duplicates_dropped).toBe(1);
    expect(rep.totals.escrows_opened).toBe(1);
  });

  it("page fields written with .0 key the chain and walk it by value", () => {
    const p0 = JSON.parse(`{"genesis":"${G}","from_block":0.0,"to_block":9.0,"page":0.0,"next_page":1.0,"events":[]}`) as unknown;
    const p1 = JSON.parse(`{"genesis":"${G}","from_block":0,"to_block":9,"page":1.0,"next_page":null,"events":[]}`) as unknown;
    const rep = census([p0, p1], opts(0, 9));
    expect(rep.complete).toBe(true);
    expect(rep.covered).toEqual([r(0, 9)]);
  });

  it("a fractional page field refuses the census, and a boolean is never an integer", () => {
    const half = JSON.parse(`{"genesis":"${G}","from_block":0,"to_block":9,"page":0.5,"next_page":null,"events":[]}`) as unknown;
    expect(() => census([half], opts(0, 9))).toThrow(CensusRefused);
    expect(census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", { index: true })])], opts(0, 9)).malformed_dropped).toBe(1);
    expect(census([pg(0, 9, 0, null, [ev(1, 0, "EscrowOpened", { block_number: false })])], opts(0, 9)).malformed_dropped).toBe(1);
  });

  // 2^53 is the smallest positive integer that is not safe; Number.MAX_SAFE_INTEGER is 2^53 less 1.
  const BIG = 2 ** 53;
  const MAX = Number.MAX_SAFE_INTEGER;

  it("a page field past the safe range refuses the census", () => {
    for (const field of ["from_block", "to_block", "page", "next_page"]) {
      const bad = { ...pg(0, 9, 0, null, []), [field]: field === "from_block" ? -BIG : BIG };
      expect(() => census([bad], opts(0, 9)), field).toThrow(new RegExp(`${field} is missing or (not|neither) a safe integer`));
    }
  });

  it("an event field past the safe range makes the event malformed, never skipped", () => {
    const rep = census([pg(0, 9, 0, null, [ev(1, BIG), ev(BIG, 0), ev(1, 1)])], opts(0, 9));
    expect(rep.malformed_dropped).toBe(2);
    expect(rep.totals.escrows_opened).toBe(1);
    expect(rep.notes.some((n) => n.includes("skipped"))).toBe(false);
  });

  it("the largest safe values count, and coverage stays exact", () => {
    const rep = census([pg(0, MAX, 0, null, [ev(MAX, MAX)])], opts(0, MAX));
    expect(rep.complete).toBe(true);
    expect(rep.covered).toEqual([r(0, MAX)]);
    expect(rep.requested_blocks).toBe(BIG);
    expect(rep.covered_blocks).toBe(BIG);
    expect(rep.totals.escrows_opened).toBe(1);
  });

  it("a request past the safe range is refused, as in the verifier's input with to_block 2^53", () => {
    expect(() => census([], opts(0, BIG))).toThrow(/needs safe integer from_block and to_block/);
  });
});
