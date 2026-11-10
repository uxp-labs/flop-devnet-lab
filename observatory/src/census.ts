// Census: counts escrow and channel events over one requested block range, from the retained
// raw event pages, so any count can be recomputed. It follows RULES.md section 3 and the binding
// clarifications in 3.1 exactly. The numbers in the comments below are 3.1 clause numbers.
//
// In short:
//   Only pages on the pinned genesis count, compared exactly as written (5). Every event on any
//   other genesis goes to excluded_other_genesis, and those pages never add coverage (6).
//   A chain is keyed by (genesis, from_block, to_block) and walked from page 0 along next_page to
//   null (2). Only complete chains whose range intersects the request count, and only the pages
//   the walk reaches (1, 2).
//   Covered ranges are clipped to the request and merged when they overlap or touch. Gaps are the
//   rest of the request. Any gap makes the census partial, and then every total is partial (3).
//   In this order (10): malformed events drop out, except that a malformed event outside the
//   request or its page's range is skipped; the rest group by key; a group whose copies all lie
//   outside is skipped, and a group partly inside and partly outside is malformed once (4); then
//   dedupe, pending or finalized, and kind.
//   An integer is judged by value and must be safe, at most 2^53 less 1 in size (14). Every integer
//   check uses isSafeInt from strict.ts, the reading escrow and status share.
//   An unreadable page file, an entry in event-pages that is not a page file, a structurally invalid
//   page or an invalid request refuses the whole census. None of them is ever turned into a partial
//   count (12, 13, 15).
// Pure: no clock and no I/O. Everything comes in through the arguments.
import { own } from "./own.js";
import { isSafeInt } from "./strict.js";
import type { BlockRange, CensusCounts, CensusReport, Trust } from "./types.js";

/**
 * Why a census refused (RULES.md 3.1 clause 16): the request, a page file that cannot be used, a
 * page whose structure is invalid, or other input. The Python recount names the same reason.
 */
export type RefusalKind = "request" | "page-file" | "page-structure" | "input";

/** Thrown when the input cannot give a census at all. Never turned into a partial count. */
export class CensusRefused extends Error {
  readonly kind: RefusalKind;
  constructor(kind: RefusalKind, reason: string) {
    super(`census refused (${kind}): ${reason}`);
    this.name = "CensusRefused";
    this.kind = kind;
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
  /**
   * Event page files that could not be read or parsed (clause 12), and entries in event-pages that
   * are not page files (clause 15), as "file: reason", for example from Source.eventPageErrors().
   * Any entry refuses the census, since the lost page could hold any event.
   */
  unreadablePages?: readonly string[];
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

/** The table's row for a kind. */
const eventOf = (k: Kind): (typeof CENSUS_EVENTS)[Kind] => own(CENSUS_EVENTS, k) as (typeof CENSUS_EVENTS)[Kind];

const KIND_OF = new Map<string, Kind>(KINDS.map((k) => [JSON.stringify([eventOf(k).section, eventOf(k).method]), k]));

/** Clause 11: the account is the first of these whose value is a string that is not empty. */
const ACCOUNT_FIELDS = ["who", "owner", "agent", "payer"] as const;

interface Page {
  genesis: string;
  from_block: number;
  to_block: number;
  page: number;
  next_page: number | null;
  events: unknown[];
}

/** A well formed event, reduced to what the census needs. */
interface Event {
  block_hash: string;
  index: number;
  section: string;
  method: string;
  account: string | null;
  finalized: boolean;
}

/** One copy of an event, and whether it lies outside the request or its own page's range. */
interface Copy extends Event {
  outside: boolean;
}

interface Chain {
  range: BlockRange;
  byNumber: Map<number, Page[]>;
}

/** The walk of one chain (clause 2): its pages in walk order, or why it is broken. */
export type ChainWalk<P> = { complete: true; pages: P[] } | { complete: false; reason: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Clause 7: a block hash is 0x followed by 64 lower case hex digits, as the escrow rules read it. */
function isBlockHash(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
}

/** Clause 13: a negative start or an inverted request is refused. */
export function checkRequest(r: unknown): BlockRange {
  if (!isObject(r)) throw new CensusRefused("request", "no requested block range");
  const { from_block, to_block } = r;
  if (!isSafeInt(from_block) || !isSafeInt(to_block)) {
    throw new CensusRefused("request", "the requested range needs safe integer from_block and to_block");
  }
  if (from_block < 0) throw new CensusRefused("request", `the requested range starts below block 0 (${from_block})`);
  if (from_block > to_block) throw new CensusRefused("request", `the requested range is inverted (${from_block} > ${to_block})`);
  return { from_block, to_block };
}

/** Clause 12: any structural fault in any page refuses the whole census. */
function checkPage(raw: unknown, n: number): Page {
  const at = `event page ${n}`;
  if (!isObject(raw)) throw new CensusRefused("page-structure", `${at} is not an object`);
  const { genesis, from_block, to_block, page, next_page, events } = raw;
  if (typeof genesis !== "string") throw new CensusRefused("page-structure", `${at}: genesis is not a string`);
  if (!isSafeInt(from_block)) throw new CensusRefused("page-structure", `${at}: from_block is missing or not a safe integer`);
  if (!isSafeInt(to_block)) throw new CensusRefused("page-structure", `${at}: to_block is missing or not a safe integer`);
  if (!isSafeInt(page)) throw new CensusRefused("page-structure", `${at}: page is missing or not a safe integer`);
  if (page < 0) throw new CensusRefused("page-structure", `${at}: page ${page} is negative`);
  // Block numbers start at 0, so a page whose range starts below 0 describes no real blocks.
  if (from_block < 0) throw new CensusRefused("page-structure", `${at}: from_block ${from_block} is negative`);
  if (next_page !== null && !isSafeInt(next_page)) {
    throw new CensusRefused("page-structure", `${at}: next_page is missing or neither a safe integer nor null`);
  }
  if (!Array.isArray(events)) throw new CensusRefused("page-structure", `${at}: events is not a list`);
  if (from_block > to_block) throw new CensusRefused("page-structure", `${at}: inverted range ${from_block} to ${to_block}`);
  return { genesis, from_block, to_block, page, next_page, events };
}

function noSuchPage(at: number, from: number | null): string {
  return from === null ? "there is no page 0" : `next_page ${at} on page ${from} names a page that does not exist`;
}

/**
 * Clause 2: start at page 0 and follow next_page to null. A next_page naming a page that does not
 * exist, a negative one included, breaks the chain, and so does a cycle. Copies of one page number
 * that disagree on next_page break it too, whether or not the walk reaches that page number.
 * Identical copies are all kept.
 */
export function walkChain<P extends { next_page: number | null }>(byNumber: Map<number, P[]>): ChainWalk<P> {
  const seen = new Set<number>();
  const pages: P[] = [];
  let at = 0;
  let from: number | null = null;
  for (;;) {
    const copies = byNumber.get(at);
    if (copies === undefined) return { complete: false, reason: noSuchPage(at, from) };
    seen.add(at);
    pages.push(...copies);
    const next = copies[0]!.next_page;
    if (next === null) break;
    if (seen.has(next)) return { complete: false, reason: `next_page ${next} on page ${at} makes a cycle` };
    from = at;
    at = next;
  }
  for (const n of [...byNumber.keys()].sort((a, b) => a - b)) {
    const copies = byNumber.get(n)!;
    if (copies.some((c) => c.next_page !== copies[0]!.next_page)) {
      return { complete: false, reason: `copies of page ${n} disagree on next_page` };
    }
  }
  return { complete: true, pages };
}

/** Clause 3: overlapping or adjacent ranges merge (1 to 5 and 6 to 10 become 1 to 10). */
function mergeRanges(ranges: BlockRange[]): BlockRange[] {
  const sorted = [...ranges].sort((a, b) => a.from_block - b.from_block || a.to_block - b.to_block);
  const out: BlockRange[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
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

/** Clause 11. A data value that is not an object has no account (clause 7). */
export function accountOf(data: unknown): string | null {
  if (!isObject(data)) return null;
  for (const field of ACCOUNT_FIELDS) {
    const v = own(data, field);
    if (isText(v)) return v;
  }
  return null;
}

/** Clause 7. Returns null for a malformed event. Clause 8: finalized means exactly true. */
function readEvent(raw: unknown): Event | null {
  if (!isObject(raw)) return null;
  const { section, method, block_hash, index, block_number } = raw;
  if (!isText(section) || !isText(method)) return null;
  if (!isBlockHash(block_hash)) return null;
  if (!isSafeInt(index) || index < 0) return null;
  if (block_number !== null && !isSafeInt(block_number)) return null;
  return { block_hash, index, section, method, account: accountOf(raw.data), finalized: raw.finalized === true };
}

/**
 * Clause 4: whether a copy lies outside, that is, holds an integer block_number outside the
 * request or its own page's range. A null block_number, or one that is not an integer, never does.
 */
function outOfRange(raw: unknown, page: Page, req: BlockRange): boolean {
  if (!isObject(raw) || !isSafeInt(raw.block_number)) return false;
  const b = raw.block_number;
  return b < req.from_block || b > req.to_block || b < page.from_block || b > page.to_block;
}

/** Sorts like Python's str ordering: by code point, not by UTF16 unit. */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) as number);
  const y = Array.from(b, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x.at(i) as number) - (y.at(i) as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Genesis values come from data. Notes echo them only when they look like hex. */
function shown(genesis: string): string {
  return /^0x[0-9a-fA-F]{1,128}$/.test(genesis) ? genesis : "a genesis value that is not hex";
}

function eventNames(): CensusReport["event_names"] {
  return Object.fromEntries(
    KINDS.map((k) => {
      const e = eventOf(k);
      return [k, { event: `${e.section}.${e.method}`, confirmed: e.confirmed }];
    }),
  ) as CensusReport["event_names"];
}

/** Census over the given raw event pages. Throws CensusRefused for input it cannot count (12, 13). */
export function census(pages: readonly unknown[], opts: CensusOptions): CensusReport {
  const req = checkRequest(opts.requested);
  const pinned = opts.pinnedGenesis;
  if (!isText(pinned)) throw new CensusRefused("input", "no pinned genesis");
  // Clauses 12 and 15: a page file that cannot be read or parsed, or an entry in event-pages that
  // is not a page file, refuses the census.
  const unreadable = opts.unreadablePages ?? [];
  if (unreadable.length > 0) {
    throw new CensusRefused("page-file", `unusable event page file(s): ${unreadable.join("; ")}`);
  }
  if (!Array.isArray(pages)) throw new CensusRefused("input", "the event pages are not a list");
  const valid = pages.map((p, n) => checkPage(p, n));
  const notes: string[] = [];

  // Clause 6: every event on another genesis is excluded, and those pages add no coverage.
  let excluded = 0;
  const otherPages = new Map<string, number>();
  for (const p of valid) {
    if (p.genesis === pinned) continue;
    excluded += p.events.length;
    otherPages.set(p.genesis, (otherPages.get(p.genesis) ?? 0) + 1);
  }
  const onPinned = valid.filter((p) => p.genesis === pinned);

  // Clause 2: chains keyed by (genesis, from_block, to_block).
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

  // Clauses 1 to 3: only complete chains that intersect the request count, and they cover their
  // range clipped to the request.
  const counted: Page[] = [];
  const clipped: BlockRange[] = [];
  const ordered = [...chains.values()].sort(
    (a, b) => a.range.from_block - b.range.from_block || a.range.to_block - b.range.to_block,
  );
  for (const chain of ordered) {
    const label = `blocks ${chain.range.from_block} to ${chain.range.to_block}`;
    const all = [...chain.byNumber.values()].flat();
    const events = all.reduce((sum, p) => sum + p.events.length, 0);
    const w = walkChain(chain.byNumber);
    if (!w.complete) {
      notes.push(`${label}: ${w.reason}, so the chain is broken and its ${events} event(s) count nowhere`);
      continue;
    }
    const from = Math.max(chain.range.from_block, req.from_block);
    const to = Math.min(chain.range.to_block, req.to_block);
    const intersects = from <= to;
    if (intersects) clipped.push({ from_block: from, to_block: to });
    // Clause 1: a chain whose range does not intersect the request counts nothing, whatever the block_number.
    if (!intersects) {
      notes.push(`${label}: the chain is complete but does not intersect the request, so its ${events} event(s) count nowhere`);
      continue;
    }
    if (w.pages.length < all.length) {
      notes.push(`${label}: ${all.length - w.pages.length} page(s) not reachable from page 0 were ignored`);
    }
    counted.push(...w.pages);
  }
  const covered = mergeRanges(clipped);
  const gaps = gapsIn(req, covered);
  const complete = gaps.length === 0;
  const status = complete ? "complete" : "partial";

  // Clause 10: malformed first, but a malformed event outside the request or its page's range is
  // skipped instead. Well formed events group by key, each copy marked inside or outside (clause 4).
  let skipped = 0;
  let malformed = 0;
  let mixed = 0;
  const groups = new Map<string, Copy[]>();
  for (const page of counted) {
    for (const raw of page.events) {
      const outside = outOfRange(raw, page, req);
      const ev = readEvent(raw);
      if (ev === null) {
        if (outside) skipped++;
        else malformed++;
        continue;
      }
      const key = JSON.stringify([page.genesis, ev.block_hash, ev.index]);
      const group = groups.get(key) ?? [];
      group.push({ ...ev, outside });
      groups.set(key, group);
    }
  }

  // Clause 4 for each group, then clauses 9 and 10: dedupe, pending or finalized, then kind.
  const totals = new Map<Kind, number>(KINDS.map((k) => [k, 0]));
  const perAccount = new Map<string, Map<Kind, number>>();
  let duplicates = 0;
  let pending = 0;
  for (const group of groups.values()) {
    const outsideCopies = group.filter((e) => e.outside).length;
    // Clause 4: a group whose copies all lie outside is skipped, not even counted in duplicates.
    if (outsideCopies === group.length) {
      skipped += group.length;
      continue;
    }
    duplicates += group.length - 1;
    // Clause 4: copies partly inside and partly outside are inconsistent, so malformed once.
    if (outsideCopies > 0) {
      malformed++;
      mixed++;
      continue;
    }
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
    totals.set(kind, (totals.get(kind) ?? 0) + 1);
    if (first.account !== null) {
      const row = perAccount.get(first.account) ?? new Map<Kind, number>();
      row.set(kind, (row.get(kind) ?? 0) + 1);
      perAccount.set(first.account, row);
    }
  }

  // Clause 11: only kinds with a count, accounts ascending.
  const by_account: Record<string, Partial<CensusCounts>> = Object.fromEntries(
    [...perAccount.keys()].sort(byCodePoint).map((account) => {
      const row = perAccount.get(account) as Map<Kind, number>;
      return [account, Object.fromEntries(KINDS.filter((k) => (row.get(k) ?? 0) > 0).map((k) => [k, row.get(k)]))];
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
  if (mixed > 0) {
    notes.push(`${mixed} event(s) had copies both inside and outside the request or their page's range, so each counts once as malformed`);
  }
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
    totals: Object.fromEntries(KINDS.map((k) => [k, totals.get(k) ?? 0])) as unknown as CensusCounts,
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
