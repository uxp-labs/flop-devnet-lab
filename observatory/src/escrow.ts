// Escrow state from finalized chain events. Implements RULES.md section 2.
//
// Inputs are the escrow id, raw event pages and options. Nothing else is read. There is
// no parameter for gateway receipts or other reports, and extra properties on the inputs
// are never looked at, so a gateway "settled" report cannot move a state.
//
// How RawEvent.data is keyed
// - Chain events carry positional data. tclk/flop/src/chain.ts reads the escrow id of
//   hasStation.EscrowOpened as event.data[0]. We keep positions as decimal string keys,
//   so the escrow id is data["0"].
// - A source that decodes names may use data["escrow_id"] instead. If both keys are
//   present they must agree, otherwise the event is malformed.
// - Assumption until M1 reads metadata: EscrowReleased and EscrowRefunded also carry the
//   escrow id first. chain.ts confirms this only for EscrowOpened.
//
// Order of checks
// 1. An unreadable or structurally invalid page (census clause 12) makes every escrow
//    unverified. The missing page could hold a conflicting event.
// 2. All well formed events on the pinned genesis are grouped by (genesis, block_hash, index),
//    whatever escrow they name. Copies that disagree on section, method, escrow id or block_number make
//    every escrow any copy names unverified. One chain event is never evidence for two escrows.
// 3. If any copy in a group is not finalized, the event is pending, never proof (census
//    clause 9). A missing or non boolean finalized flag means not finalized (census clause 8).
//
// 4. Genesis and block hashes are compared exactly as written and must be lower case hex.
//    A page genesis in another spelling is another genesis. A block hash in another spelling
//    is a malformed event. Escrow ids are matched without regard to case.
// 5. An event whose block_number is outside its page's block range is never evidence, and it
//    is suspect. It is grouped like any other copy, so rules 2 and the unparsable id rule
//    still see it. A finalized release or refund out of range that names this escrow leaves
//    it unverified.
// 6. A null finalizedHeight means the evidence is not bounded by a finalized height, and
//    a result with evidence says so in its notes.
//
// How the two "malformed" rules are read together
// - A malformed event is never evidence. It cannot make an escrow funded, claimed or refunded.
// - A malformed finalized terminal event on the pinned genesis that could be about this
//   escrow (its id does not parse, or it names this escrow) is conflicting evidence when it
//   contradicts the state the clean events give. Then the state is unverified with a note.
// - A malformed event that names a different, valid escrow id is not about this escrow
//   and is skipped.
import type {
  EscrowEvidence,
  EscrowState,
  EscrowStateName,
  EscrowStateOptions,
  EventPage,
  RawEvent,
} from "./types.js";

export const ESCROW_SCOPE = "settlement only; says nothing about output quality" as const;
export const ESCROW_SCHEMA = "flop-observatory/escrow-state@0" as const;

const SECTION = "hasStation";
const OPENED = "EscrowOpened";
const RELEASED = "EscrowReleased";
const REFUNDED = "EscrowRefunded";
const METHODS: readonly string[] = [OPENED, RELEASED, REFUNDED];

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
// Genesis and block hashes are compared exactly as written (census clause 5), so they have
// one accepted spelling: lower case. Escrow ids are still matched without regard to case.
const LOWER_HASH_RE = /^0x[0-9a-f]{64}$/;

/** True for 0x plus 64 hex characters. */
export function isHash32(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

function isLowerHash32(value: unknown): value is string {
  return typeof value === "string" && LOWER_HASH_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type IdRead = { ok: true; id: string } | { ok: false; why: string };

/** Reads the escrow id from event data. See the header for the keying rule. */
function readEscrowId(data: unknown): IdRead {
  if (!isRecord(data)) return { ok: false, why: "data is not an object" };
  const positional = data["0"];
  const named = data["escrow_id"];
  if (positional === undefined && named === undefined) return { ok: false, why: "no escrow id field" };
  for (const v of [positional, named]) {
    if (v !== undefined && !isHash32(v)) return { ok: false, why: "escrow id is not 0x plus 64 hex" };
  }
  const a = positional === undefined ? null : (positional as string).toLowerCase();
  const b = named === undefined ? null : (named as string).toLowerCase();
  if (a !== null && b !== null && a !== b) return { ok: false, why: "escrow id fields disagree" };
  return { ok: true, id: (a ?? b) as string };
}

/** Structural problems that leave an event without an identity. Null when it has one. */
function structureProblem(ev: Record<string, unknown>): string | null {
  if (!isLowerHash32(ev["block_hash"])) return "block_hash is not 0x plus 64 lower case hex";
  const index = ev["index"];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return "index is not a whole number";
  const n = ev["block_number"];
  if (n !== null && n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 0)) {
    return "block_number is not a whole number or null";
  }
  return null;
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** Census clause 12: why a page is structurally invalid, or null when it is valid. */
export function pageProblem(page: unknown): string | null {
  if (!isRecord(page)) return "not an object";
  if (typeof page["genesis"] !== "string") return "genesis is not a string";
  for (const k of ["from_block", "to_block", "page"]) {
    if (!isInt(page[k])) return `${k} is missing or not a whole number`;
  }
  if (!("next_page" in page) || (page["next_page"] !== null && !isInt(page["next_page"]))) {
    return "next_page is missing or not a whole number or null";
  }
  if ((page["page"] as number) < 0) return "page is negative";
  if (!Array.isArray(page["events"])) return "events is not a list";
  if ((page["from_block"] as number) > (page["to_block"] as number)) return "block range is inverted";
  return null;
}

function describePage(page: unknown, position: number): string {
  const where = `page at position ${position}`;
  if (!isRecord(page)) return where;
  const show = (v: unknown) => (isInt(v) ? String(v) : "?");
  return `${where} (blocks ${show(page["from_block"])} to ${show(page["to_block"])}, page ${show(page["page"])})`;
}

function unverified(
  escrowId: string,
  notes: string[],
  opts: EscrowStateOptions,
): EscrowState {
  return {
    schema: ESCROW_SCHEMA,
    escrow_id: escrowId,
    state: "unverified",
    evidence: [],
    notes,
    finalized_height: typeof opts.finalizedHeight === "number" ? opts.finalizedHeight : null,
    observed_at: opts.observedAt,
    trust: opts.trust,
    scope: ESCROW_SCOPE,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

interface Copy {
  section: unknown;
  method: unknown;
  /** True when this copy is one of the three hasStation escrow events. */
  escrowEvent: boolean;
  id: IdRead;
  finalized: boolean;
  block_hash: string;
  block_number: number | null;
  index: number;
  /** False when an integer block_number is outside the block range of the page it came from. */
  inRange: boolean;
}

/**
 * State of one escrow from raw event pages.
 * Only finalized hasStation events on the pinned genesis count. Anything missing,
 * conflicting or malformed leaves the escrow unverified, with notes saying why.
 */
export function escrowState(
  escrowId: string,
  pages: readonly EventPage[],
  opts: EscrowStateOptions,
): EscrowState {
  const shownId = typeof escrowId === "string" ? escrowId : String(escrowId);
  if (!isHash32(escrowId)) {
    return unverified(shownId, ["escrow id is not 0x plus 64 hex; nothing was looked up"], opts);
  }
  const id = escrowId.toLowerCase();
  if (!isLowerHash32(opts.pinnedGenesis)) {
    return unverified(id, ["pinned genesis is not 0x plus 64 lower case hex; no event can count"], opts);
  }
  const pinned = opts.pinnedGenesis;
  const height = typeof opts.finalizedHeight === "number" ? opts.finalizedHeight : null;
  const pageList: readonly unknown[] = Array.isArray(pages) ? pages : [];

  // Unreadable or invalid input: nothing can be verified from the rest.
  const unreadable = Array.isArray(opts.unreadablePages) ? opts.unreadablePages.map((u) => String(u)) : [];
  if (unreadable.length > 0) {
    return unverified(
      id,
      unreadable.map((u) => `event page could not be read, so nothing is verified: ${u}`),
      opts,
    );
  }
  const invalid: string[] = [];
  pageList.forEach((page, i) => {
    const problem = pageProblem(page);
    if (problem !== null) invalid.push(`${describePage(page, i)}: ${problem}`);
  });
  if (!Array.isArray(pages)) invalid.push("pages is not a list");
  if (invalid.length > 0) {
    return unverified(
      id,
      invalid.map((u) => `event page is invalid, so nothing is verified: ${u}`),
      opts,
    );
  }

  const notes: string[] = [];
  const groups = new Map<string, Copy[]>();
  let otherGenesis = 0;
  let outsideRange = 0;
  const malformedNotes: string[] = [];
  // Malformed finalized terminal events on the pinned genesis that could be about this escrow.
  const suspectTerminals = new Set<string>();

  for (const page of pageList) {
    if (pageProblem(page) !== null) continue;
    const p = page as Record<string, unknown>;
    // Exact comparison, as written. A genesis in another spelling is another genesis.
    const onPinned = p["genesis"] === pinned;
    const fromBlock = p["from_block"] as number;
    const toBlock = p["to_block"] as number;
    for (const raw of p["events"] as unknown[]) {
      if (!isRecord(raw)) {
        if (onPinned) malformedNotes.push("an event that is not an object");
        continue;
      }
      const method = raw["method"];
      const escrowEvent = raw["section"] === SECTION && typeof method === "string" && METHODS.includes(method);
      const idRead = escrowEvent ? readEscrowId(raw["data"]) : ({ ok: false, why: "not an escrow event" } as IdRead);
      if (!onPinned) {
        if (escrowEvent && idRead.ok && idRead.id === id) otherGenesis++;
        continue;
      }
      const problem = structureProblem(raw);
      if (problem !== null) {
        // No identity, so it cannot be grouped. Only escrow events that could be about
        // this escrow are noted.
        if (escrowEvent && !(idRead.ok && idRead.id !== id)) {
          malformedNotes.push(`${SECTION}.${method as string} (${idRead.ok ? problem : idRead.why})`);
          if (method !== OPENED && raw["finalized"] === true) suspectTerminals.add(method as string);
        }
        continue;
      }
      const ev = raw as unknown as RawEvent;
      // An event outside its page's block range is never evidence, and it is suspect. It is
      // still grouped, so the copy agreement and unparsable id rules see it.
      const inRange = !(typeof ev.block_number === "number" && (ev.block_number < fromBlock || ev.block_number > toBlock));
      const key = `${pinned}|${ev.block_hash}|${ev.index}`;
      const copy: Copy = {
        section: raw["section"],
        method,
        escrowEvent,
        id: idRead,
        finalized: raw["finalized"] === true,
        block_hash: ev.block_hash,
        block_number: typeof ev.block_number === "number" ? ev.block_number : null,
        index: ev.index,
        inRange,
      };
      const list = groups.get(key);
      if (list) list.push(copy);
      else groups.set(key, [copy]);
    }
  }

  const clean: { method: string; evidence: EscrowEvidence }[] = [];
  const conflicts: string[] = [];
  let pending = 0;
  let aboveHeight = 0;
  let duplicates = 0;

  for (const copies of groups.values()) {
    const first = copies[0] as Copy;
    const where = `block ${first.block_hash}, index ${first.index}`;
    const named = new Set<string>();
    const signatures = new Set<string>();
    for (const c of copies) {
      if (c.escrowEvent && c.id.ok) named.add(c.id.id);
      const idPart = c.escrowEvent && c.id.ok ? c.id.id : "?";
      // A block hash fixes the block number, so copies must agree on it. Null against a number disagrees.
      signatures.add(`${String(c.section)}|${String(c.method)}|${idPart}|${String(c.block_number)}`);
    }
    // A finalized terminal copy whose escrow id does not parse could contradict any escrow.
    // This holds for every such copy, whatever the other copies of the event say.
    const unparsable = new Set<string>();
    for (const c of copies) {
      if (!c.escrowEvent || c.id.ok) continue;
      const m = c.method as string;
      unparsable.add(`${SECTION}.${m} (${c.id.why})`);
      if (m !== OPENED && copies.some((x) => x.finalized)) suspectTerminals.add(m);
    }
    for (const u of unparsable) malformedNotes.push(u);
    if (signatures.size > 1) {
      // Copies of one event disagree. Every escrow any copy names is unverified.
      if (named.has(id)) {
        conflicts.push(`copies of one event disagree on section, method, escrow id or block number (${where})`);
      }
      continue;
    }
    if (!first.escrowEvent) continue;
    const method = first.method as string;
    const name = `${SECTION}.${method}`;
    if (!first.id.ok) continue; // noted above, never evidence
    if (first.id.id !== id) continue; // about another escrow
    if (copies.some((c) => !c.inRange)) {
      // Never evidence. A finalized release or refund out of range still names this escrow,
      // so it leaves the escrow unverified.
      outsideRange++;
      if (method !== OPENED && copies.some((c) => c.finalized)) {
        const what = method === RELEASED ? "release" : "refund";
        conflicts.push(`a finalized ${what} outside its page's block range names this escrow (${where})`);
      }
      continue;
    }
    duplicates += copies.length - 1;
    if (copies.some((c) => c.finalized !== true)) {
      pending++;
      continue;
    }
    if (height !== null && copies.some((c) => c.block_number !== null && c.block_number > height)) {
      aboveHeight++;
      continue;
    }
    clean.push({
      method,
      evidence: {
        event: name,
        block_hash: first.block_hash,
        block_number: first.block_number,
        event_index: first.index,
        genesis: pinned,
      },
    });
  }

  if (otherGenesis > 0) {
    notes.push(`${plural(otherGenesis, "event")} for this escrow on another genesis excluded`);
  }
  if (pending > 0) notes.push(`${plural(pending, "event")} for this escrow not finalized: pending, not proof`);
  if (aboveHeight > 0) {
    notes.push(`${plural(aboveHeight, "event")} above the finalized height ignored`);
  }
  if (outsideRange > 0) {
    notes.push(`${plural(outsideRange, "event")} outside its page's block range: never evidence`);
  }
  if (duplicates > 0) notes.push(`${plural(duplicates, "duplicate event")} counted once`);
  for (const m of malformedNotes) notes.push(`malformed event ignored: ${m}`);

  const of = (method: string): EscrowEvidence[] => clean.filter((e) => e.method === method).map((e) => e.evidence);
  const opened = of(OPENED);
  const released = of(RELEASED);
  const refunded = of(REFUNDED);

  let state: EscrowStateName = "unverified";
  let evidence: EscrowEvidence[] = [];

  if (released.length > 0 && refunded.length > 0) {
    conflicts.push("both a finalized release and a finalized refund exist for this escrow");
  }
  if (released.length > 1) conflicts.push("more than one distinct finalized release for this escrow");
  if (refunded.length > 1) conflicts.push("more than one distinct finalized refund for this escrow");

  if (conflicts.length === 0) {
    if (released.length === 1) {
      if (suspectTerminals.has(REFUNDED)) {
        conflicts.push("a malformed finalized refund could be about this escrow");
      } else {
        state = "claimed";
        evidence = [...(opened.length === 1 ? opened : []), ...released];
      }
    } else if (refunded.length === 1) {
      if (suspectTerminals.has(RELEASED)) {
        conflicts.push("a malformed finalized release could be about this escrow");
      } else {
        state = "refunded";
        evidence = [...(opened.length === 1 ? opened : []), ...refunded];
      }
    } else if (opened.length > 1) {
      conflicts.push("more than one distinct finalized open for this escrow");
    } else if (opened.length === 1) {
      if (suspectTerminals.size > 0) {
        conflicts.push("a malformed finalized terminal event could be about this escrow");
      } else {
        state = "funded";
        evidence = opened;
      }
    } else {
      notes.push("no finalized hasStation event for this escrow on the pinned genesis");
    }
  }

  for (const c of conflicts) notes.push(`conflicting evidence: ${c}`);
  if (height === null && evidence.length > 0) {
    notes.push("evidence is not bounded by a finalized height: no finalized height from an RPC head on the pinned genesis");
  }

  return {
    schema: ESCROW_SCHEMA,
    escrow_id: id,
    // state and evidence are only ever set on a path with no conflict.
    state,
    evidence,
    notes,
    finalized_height: height,
    observed_at: opts.observedAt,
    trust: opts.trust,
    scope: ESCROW_SCOPE,
  };
}

/** escrowState() for several ids, in the order given. */
export function escrowStates(
  escrowIds: readonly string[],
  pages: readonly EventPage[],
  opts: EscrowStateOptions,
): EscrowState[] {
  return escrowIds.map((id) => escrowState(id, pages, opts));
}
