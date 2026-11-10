// Census: counts escrow and channel events over one requested block range, from the retained
// raw event pages, so any count can be recomputed. Follows RULES.md section 3 and its binding
// clarifications in 3.1 exactly. Rule numbers below are the 3.1 clause numbers.
//
// In short:
// - Only pages on the pinned genesis count. Genesis is compared exactly as written (5). Events on
//   any other genesis go to excluded_other_genesis, whatever their chain or finality, and those
//   pages never add coverage (6).
// - A chain is keyed by (genesis, from_block, to_block) and walked from page 0 along next_page to
//   null. Only complete chains count, and only their pages reached from page 0 (1, 2).
// - Covered ranges are clipped to the request and merged when they overlap or touch. Gaps are the
//   rest of the request. Any gap makes the census partial, and then every total is partial (3).
// - Per event, in this order: block range filter, malformed, dedupe, pending or finalized, kind (10).
// - A structurally invalid page or request refuses the whole census. It never becomes a partial
//   count (12, 13).
// Pure: no clock and no I/O. Everything comes in through the arguments.
import type { BlockRange, CensusCounts, CensusReport, Trust } from "./types.js";

/** Thrown when the input cannot give a census at all. Never turned into a partial count. */
export class CensusRefused extends Error {
  constructor(reason: string) {
    super(`census refused: ${reason}`);
    this.name = "CensusRefused";
  }
}

export interface CensusOptions {
  /** The only genesis whose pages count. Compared exactly as written. */
  pinnedGenesis: string;
  /** Inclusive block range the census is asked for. */
  requested: BlockRange;
  /** When the pages were read (ISO 8601). */
  observedAt: string;
  trust: Trust;
}

type Kind = keyof CensusCounts;

/** The event counted for each kind (RULES.md section 3 table). */
export const CENSUS_EVENTS: Readonly<Record<Kind, { section: string; method: string; confirmed: boolean }>> = {
  escrows_opened: { section: "hasStation", method: "EscrowOpened", confirmed: true },
  escrows_released: { section: "hasStation", method: "EscrowReleased", confirmed: true },
  escrows_refunded: { section: "hasStation", method: "EscrowRefunded", confirmed: true },
  channels_opened: { section: "computeChannel", method: "ChannelOpened", confirmed: false },
  channels_settled: { section: "computeChannel", method: "ChannelSettled", confirmed: false },
};

const KINDS: readonly Kind[] = [
  "escrows_opened",
  "escrows_released",
  "escrows_refunded",
  "channels_opened",
  "channels_settled",
];

const KIND_OF = new Map<string, Kind>(
  KINDS.map((k) => [JSON.stringify([CENSUS_EVENTS[k].section, CENSUS_EVENTS[k].method]), k]),
);

/** Rule 11: the account is the first of these whose value is a non-empty string. */
const ACCOUNT_FIELDS = ["who", "owner", "agent", "payer"] as const;

interface Page {
  genesis: string;
  from_block: number;
  to_block: number;
  page: number;
  next_page: number | null;
  events: unknown[];
}

/** A well-formed event, reduced to what the census needs. */
interface Event {
  block_hash: string;
  index: number;
  section: string;
  method: string;
  account: string | null;
  finalized: boolean;
}

interface Chain {
  range: BlockRange;
  byNumber: Map<number, Page[]>;
}

type Walk = { complete: true; pages: Page[] } | { complete: false; reason: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Integers only: booleans and fractions are not integers. */
function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Rule 13: a negative start or an inverted request is refused. */
function checkRequest(r: unknown): BlockRange {
  if (!isObject(r)) throw new CensusRefused("no requested block range");
  const { from_block, to_block } = r;
  if (!isInt(from_block) || !isInt(to_block)) {
    throw new CensusRefused("the requested range needs integer from_block and to_block");
  }
  if (from_block < 0) throw new CensusRefused(`the requested range starts below block 0 (${from_block})`);
  if (from_block > to_block) throw new CensusRefused(`the requested range is inverted (${from_block} > ${to_block})`);
  return { from_block, to_block };
}

/** Rule 12: any structural fault in any page refuses the whole census. */
function checkPage(raw: unknown, n: number): Page {
  const at = `event page ${n}`;
  if (!isObject(raw)) throw new CensusRefused(`${at} is not an object`);
  const { genesis, from_block, to_block, page, next_page, events } = raw;
  if (typeof genesis !== "string") throw new CensusRefused(`${at}: genesis is not a string`);
  if (!isInt(from_block)) throw new CensusRefused(`${at}: from_block is missing or not an integer`);
  if (!isInt(to_block)) throw new CensusRefused(`${at}: to_block is missing or not an integer`);
  if (!isInt(page)) throw new CensusRefused(`${at}: page is missing or not an integer`);
  if (next_page !== null && !isInt(next_page)) {
    throw new CensusRefused(`${at}: next_page is missing or neither an integer nor null`);
  }
  if (!Array.isArray(events)) throw new CensusRefused(`${at}: events is not a list`);
  if (from_block > to_block) throw new CensusRefused(`${at}: inverted range ${from_block} to ${to_block}`);
  return { genesis, from_block, to_block, page, next_page, events };
}

/**
 * Rule 2: start at page 0 and follow next_page to null. A missing page, a cycle, or copies of one
 * page number that disagree on next_page break the chain. Identical copies are all kept.
 */
function walk(byNumber: Map<number, Page[]>): Walk {
  const seen = new Set<number>();
  const pages: Page[] = [];
  let at = 0;
  for (;;) {
    const copies = byNumber.get(at);
    if (copies === undefined) return { complete: false, reason: `page ${at} is missing` };
    const next = copies[0]!.next_page;
    if (copies.some((c) => c.next_page !== next)) {
      return { complete: false, reason: `copies of page ${at} disagree on next_page` };
    }
    seen.add(at);
    pages.push(...copies);
    if (next === null) return { complete: true, pages };
    if (seen.has(next)) return { complete: false, reason: `next_page ${next} on page ${at} makes a cycle` };
    at = next;
  }
}

/** Rule 3: overlapping or adjacent ranges merge (1 to 5 and 6 to 10 become 1 to 10). */
function mergeRanges(ranges: BlockRange[]): BlockRange[] {
  const sorted = [...ranges].sort((a, b) => a.from_block - b.from_block || a.to_block - b.to_block);
  const out: BlockRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && r.from_block <= last.to_block + 1) {
      last.to_block = Math.max(last.to_block, r.to_block);
    } else {
      out.push({ from_block: r.from_block, to_block: r.to_block });
    }
  }
  return out;
}

/** The request minus the covered ranges, which are merged and inside the request. */
function gapsIn(req: BlockRange, covered: BlockRange[]): BlockRange[] {
  const gaps: BlockRange[] = [];
  let from = req.from_block;
  for (const r of covered) {
    if (r.from_block > from) gaps.push({ from_block: from, to_block: r.from_block - 1 });
    from = Math.max(from, r.to_block + 1);
  }
  if (from <= req.to_block) gaps.push({ from_block: from, to_block: req.to_block });
  return gaps;
}

function blocks(ranges: BlockRange[]): number {
  return ranges.reduce((n, r) => n + (r.to_block - r.from_block + 1), 0);
}

/** Rule 11. A non-object data has no account (rule 7). */
function accountOf(data: unknown): string | null {
  if (!isObject(data)) return null;
  for (const field of ACCOUNT_FIELDS) {
    const v = Object.hasOwn(data, field) ? data[field] : undefined;
    if (isText(v)) return v;
  }
  return null;
}

/** Rule 7. Returns null for a malformed event. Rule 8: finalized means exactly true. */
function readEvent(raw: unknown): Event | null {
  if (!isObject(raw)) return null;
  const { section, method, block_hash, index, block_number } = raw;
  if (!isText(section) || !isText(method) || !isText(block_hash)) return null;
  if (!isInt(index) || index < 0) return null;
  if (block_number !== null && !isInt(block_number)) return null;
  return { block_hash, index, section, method, account: accountOf(raw.data), finalized: raw.finalized === true };
}

/** Rule 4: an integer block_number outside the request or its page's range is skipped. */
function outOfRange(raw: unknown, page: Page, req: BlockRange): boolean {
  if (!isObject(raw) || !isInt(raw.block_number)) return false;
  const b = raw.block_number;
  return b < req.from_block || b > req.to_block || b < page.from_block || b > page.to_block;
}

/** Sorts like Python's str ordering: by code point, not by UTF-16 unit. */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Genesis values come from data. Notes echo them only when they look like hex. */
function shown(genesis: string): string {
  return /^0x[0-9a-fA-F]{1,128}$/.test(genesis) ? genesis : "a non-hex genesis value";
}

function zeroCounts(): CensusCounts {
  return { escrows_opened: 0, escrows_released: 0, escrows_refunded: 0, channels_opened: 0, channels_settled: 0 };
}

function eventNames(): CensusReport["event_names"] {
  const out = {} as CensusReport["event_names"];
  for (const k of KINDS) {
    const e = CENSUS_EVENTS[k];
    out[k] = { event: `${e.section}.${e.method}`, confirmed: e.confirmed };
  }
  return out;
}

/** Census over the given raw event pages. Throws CensusRefused for input it cannot count (rules 12, 13). */
export function census(pages: readonly unknown[], opts: CensusOptions): CensusReport {
  const req = checkRequest(opts.requested);
  const pinned = opts.pinnedGenesis;
  if (!isText(pinned)) throw new CensusRefused("no pinned genesis");
  if (!Array.isArray(pages)) throw new CensusRefused("the event pages are not a list");
  const valid = pages.map((p, n) => checkPage(p, n));
  const notes: string[] = [];

  // Rule 6: every event on another genesis is excluded, and those pages add no coverage.
  let excluded = 0;
  const otherPages = new Map<string, number>();
  for (const p of valid) {
    if (p.genesis === pinned) continue;
    excluded += p.events.length;
    otherPages.set(p.genesis, (otherPages.get(p.genesis) ?? 0) + 1);
  }
  const onPinned = valid.filter((p) => p.genesis === pinned);

  // Rule 2: chains keyed by (genesis, from_block, to_block).
  const chains = new Map<string, Chain>();
  for (const p of onPinned) {
    const key = JSON.stringify([p.genesis, p.from_block, p.to_block]);
    let chain = chains.get(key);
    if (chain === undefined) {
      chain = { range: { from_block: p.from_block, to_block: p.to_block }, byNumber: new Map() };
      chains.set(key, chain);
    }
    const copies = chain.byNumber.get(p.page) ?? [];
    copies.push(p);
    chain.byNumber.set(p.page, copies);
  }

  // Rules 1 to 3: only complete chains count, and they cover their range clipped to the request.
  const counted: Page[] = [];
  const clipped: BlockRange[] = [];
  const ordered = [...chains.values()].sort(
    (a, b) => a.range.from_block - b.range.from_block || a.range.to_block - b.range.to_block,
  );
  for (const chain of ordered) {
    const label = `range ${chain.range.from_block}-${chain.range.to_block}`;
    const all = [...chain.byNumber.values()].flat();
    const w = walk(chain.byNumber);
    if (!w.complete) {
      const n = all.reduce((sum, p) => sum + p.events.length, 0);
      notes.push(`${label}: ${w.reason}, so the range is not covered and its ${n} event(s) count nowhere`);
      continue;
    }
    if (w.pages.length < all.length) {
      notes.push(`${label}: ${all.length - w.pages.length} page(s) not reachable from page 0 were ignored`);
    }
    counted.push(...w.pages);
    const from = Math.max(chain.range.from_block, req.from_block);
    const to = Math.min(chain.range.to_block, req.to_block);
    if (from <= to) clipped.push({ from_block: from, to_block: to });
  }
  const covered = mergeRanges(clipped);
  const gaps = gapsIn(req, covered);
  const complete = gaps.length === 0;
  const status = complete ? "complete" : "partial";

  // Rule 10: block range filter, then malformed, then dedupe.
  let skipped = 0;
  let malformed = 0;
  const groups = new Map<string, Event[]>();
  for (const page of counted) {
    for (const raw of page.events) {
      if (outOfRange(raw, page, req)) {
        skipped++;
        continue;
      }
      const ev = readEvent(raw);
      if (ev === null) {
        malformed++;
        continue;
      }
      const key = JSON.stringify([page.genesis, ev.block_hash, ev.index]);
      const group = groups.get(key) ?? [];
      group.push(ev);
      groups.set(key, group);
    }
  }

  // Rule 9, then rule 10 again: pending or finalized, then kind.
  const totals = zeroCounts();
  const perAccount = new Map<string, Partial<CensusCounts>>();
  let duplicates = 0;
  let pending = 0;
  for (const group of groups.values()) {
    duplicates += group.length - 1;
    const first = group[0]!;
    const disagree = group.some(
      (e) => e.section !== first.section || e.method !== first.method || e.account !== first.account,
    );
    if (disagree) {
      malformed++;
      continue;
    }
    if (group.some((e) => !e.finalized)) {
      pending++;
      continue;
    }
    const kind = KIND_OF.get(JSON.stringify([first.section, first.method]));
    if (kind === undefined) continue;
    totals[kind] += 1;
    if (first.account !== null) {
      const row = perAccount.get(first.account) ?? {};
      row[kind] = (row[kind] ?? 0) + 1;
      perAccount.set(first.account, row);
    }
  }

  // Rule 11: only non-zero kinds, accounts ascending.
  const by_account: Record<string, Partial<CensusCounts>> = Object.fromEntries(
    [...perAccount.keys()].sort(byCodePoint).map((account) => {
      const row = perAccount.get(account)!;
      const kinds: Partial<CensusCounts> = {};
      for (const k of KINDS) if (row[k]) kinds[k] = row[k];
      return [account, kinds];
    }),
  );

  if (valid.length === 0) notes.push("no event pages, so the whole request is one gap");
  if (otherPages.size > 0) {
    const list = [...otherPages.entries()]
      .sort((a, b) => byCodePoint(a[0], b[0]))
      .map(([g, n]) => `${n} on ${shown(g)}`)
      .join(", ");
    notes.push(
      `reset_detected: pages on another genesis (${list}) were excluded with ${excluded} event(s). ` +
        "The chain may have been reset; check the pinned genesis before relying on these counts",
    );
  }
  if (skipped > 0) notes.push(`${skipped} event(s) outside the request or their page's range were skipped`);
  const requested_blocks = req.to_block - req.from_block + 1;
  const covered_blocks = blocks(covered);
  if (!complete) {
    notes.push(`partial: ${covered_blocks} of ${requested_blocks} requested blocks are covered, so totals and by_account are partial`);
  }

  return {
    schema: "flop-observatory/census@0",
    observed_at: opts.observedAt,
    trust: opts.trust,
    genesis: pinned,
    requested: req,
    covered,
    gaps,
    complete,
    status,
    totals,
    totals_label: status,
    by_account,
    pending_unfinalized: pending,
    duplicates_dropped: duplicates,
    excluded_other_genesis: excluded,
    malformed_dropped: malformed,
    requested_blocks,
    covered_blocks,
    reset_detected: valid.length === 0 ? null : otherPages.size > 0,
    event_names: eventNames(),
    notes,
  };
}
