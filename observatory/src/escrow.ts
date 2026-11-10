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

/** True for 0x plus 64 hex characters. */
export function isHash32(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
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

/** Structural problems other than the escrow id. Null when the event is well formed. */
function structureProblem(ev: Record<string, unknown>): string | null {
  if (!isHash32(ev["block_hash"])) return "block_hash is not 0x plus 64 hex";
  const index = ev["index"];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return "index is not a whole number";
  if (typeof ev["finalized"] !== "boolean") return "finalized is not true or false";
  const n = ev["block_number"];
  if (n !== null && n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 0)) {
    return "block_number is not a whole number or null";
  }
  return null;
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
  if (!isHash32(opts.pinnedGenesis)) {
    return unverified(id, ["pinned genesis is not 0x plus 64 hex; no event can count"], opts);
  }
  const pinned = opts.pinnedGenesis.toLowerCase();
  const height = typeof opts.finalizedHeight === "number" ? opts.finalizedHeight : null;

  const notes: string[] = [];
  const clean = new Map<string, { method: string; evidence: EscrowEvidence }>();
  let badPages = 0;
  let otherGenesis = 0;
  let pending = 0;
  let aboveHeight = 0;
  let duplicates = 0;
  let identityConflict = false;
  const malformedNotes: string[] = [];
  // Malformed finalized terminal events on the pinned genesis that could be about this escrow.
  const suspectTerminals = new Set<string>();

  for (const page of Array.isArray(pages) ? pages : []) {
    if (!isRecord(page) || typeof page["genesis"] !== "string" || !Array.isArray(page["events"])) {
      badPages++;
      continue;
    }
    const pageGenesis = page["genesis"].toLowerCase();
    const onPinned = pageGenesis === pinned;
    for (const raw of page["events"] as unknown[]) {
      if (!isRecord(raw)) {
        if (onPinned) malformedNotes.push("an event that is not an object");
        continue;
      }
      const method = raw["method"];
      // Only the three hasStation escrow events are evidence. Everything else is not looked at.
      if (raw["section"] !== SECTION || typeof method !== "string" || !METHODS.includes(method)) continue;
      const name = `${SECTION}.${method}`;
      const idRead = readEscrowId(raw["data"]);
      if (idRead.ok && idRead.id !== id) continue; // about another escrow
      if (!onPinned) {
        if (idRead.ok) otherGenesis++;
        continue;
      }
      const problem = idRead.ok ? structureProblem(raw) : idRead.why;
      if (problem !== null) {
        malformedNotes.push(`${name} (${problem})`);
        if (method !== OPENED && raw["finalized"] === true) suspectTerminals.add(method);
        continue;
      }
      const ev = raw as unknown as RawEvent;
      if (ev.finalized !== true) {
        pending++;
        continue;
      }
      if (height !== null && typeof ev.block_number === "number" && ev.block_number > height) {
        aboveHeight++;
        continue;
      }
      const key = `${pinned}|${ev.block_hash.toLowerCase()}|${ev.index}`;
      const seen = clean.get(key);
      if (seen) {
        if (seen.method === method) duplicates++;
        else identityConflict = true;
        continue;
      }
      clean.set(key, {
        method,
        evidence: {
          event: name,
          block_hash: ev.block_hash.toLowerCase(),
          block_number: typeof ev.block_number === "number" ? ev.block_number : null,
          event_index: ev.index,
          genesis: pinned,
        },
      });
    }
  }

  if (badPages > 0) notes.push(`${plural(badPages, "page")} ignored: not an event page`);
  if (otherGenesis > 0) {
    notes.push(`${plural(otherGenesis, "event")} for this escrow on another genesis excluded`);
  }
  if (pending > 0) notes.push(`${plural(pending, "event")} for this escrow not finalized: pending, not proof`);
  if (aboveHeight > 0) {
    notes.push(`${plural(aboveHeight, "event")} above the finalized height ignored`);
  }
  if (duplicates > 0) notes.push(`${plural(duplicates, "duplicate event")} counted once`);
  for (const m of malformedNotes) notes.push(`malformed event ignored: ${m}`);

  const of = (method: string): EscrowEvidence[] =>
    [...clean.values()].filter((e) => e.method === method).map((e) => e.evidence);
  const opened = of(OPENED);
  const released = of(RELEASED);
  const refunded = of(REFUNDED);

  let state: EscrowStateName = "unverified";
  let evidence: EscrowEvidence[] = [];
  const conflicts: string[] = [];

  if (identityConflict) conflicts.push("two different events share one (genesis, block_hash, index)");
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
  if (conflicts.length > 0) {
    state = "unverified";
    evidence = [];
  }

  return {
    schema: ESCROW_SCHEMA,
    escrow_id: id,
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
