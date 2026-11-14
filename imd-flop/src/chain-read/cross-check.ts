/**
 * The cross check of S4 (P2, rule C5). Given a session's state at a finalized block and the events of that same
 * block, it says whether the totals of the session's FlopSessionKeys.SessionCallExecuted event agree with the stored
 * session. Which stored field each total belongs to comes from the frozen table (key-table.ts): the script pairs each
 * total of the event with the session record's field of the same name and type in the reviewed shape, and the
 * rerun's record shows them equal at its successful session calls (test/chain-read-replay.test.ts). A disagreement
 * is unknown and names both values. So is a check that cannot be made: another block, another runtime, a session
 * that is not known, a session record of another owner or delegate than the state's own (rule X3), no such event
 * of the session at the block, or more than one. Pure.
 * It takes the values the two reads returned (the known value of readSessionState and of readBlockEvents), plain
 * data the reads made, and reads their fields as they are: it takes no copy of them.
 */
import type { DoorValue } from "./door.js";
import { lineOf } from "./keys.js";
import type { BlockEventsAt, SessionState } from "./read.js";
import { type Got, known, unknown, within } from "./result.js";
import { ofThePair } from "./session-state.js";
import { freezeFunction } from "../freeze.js";

/** The totals that agree, by the stored field's name. */
export interface Agreement {
  readonly number: number;
  readonly hash: string;
  readonly totals: Readonly<Record<string, bigint>>;
}

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const isRecord = (v: unknown): v is Record<string, DoorValue> => v !== null && typeof v === "object" && !Array.isArray(v);

export function crossCheck(state: SessionState, events: BlockEventsAt): Got<Agreement> {
  if (state.number !== events.number || state.hash !== events.hash) return unknown(`the session was read at block ${state.number} ${state.hash} and the events at block ${events.number} ${events.hash}`);
  const r = state.runtime;
  const e = events.runtime;
  if (r.specName !== e.specName || r.specVersion !== e.specVersion || r.shapeFile !== e.shapeFile) return unknown("the session and the events were pinned to other runtimes");
  if (state.session.kind === "absent") return unknown("the session is absent");
  if (state.session.kind === "unknown") return unknown(`the session is unknown (${state.session.reason})`);
  // Rule X3: the known record must name the state's own owner and delegate, before any event is looked at.
  const pair = ofThePair(state.session.value, state.owner, state.delegate);
  if (pair.kind === "unknown") return within("the session", pair);
  const line = lineOf(r);
  if (line.kind === "unknown") return line;
  const cc = line.value.crossCheck;
  const session = state.session.value as unknown as Readonly<Record<string, unknown>>;
  const name = `${cc.pallet}.${cc.event}`;
  const mine = events.events.filter((x) => x.pallet === cc.pallet && x.event === cc.event && isRecord(x.fields) && cc.keys.every((k) => (x.fields as Record<string, DoorValue>)[k] === session[k]));
  if (mine.length === 0) return unknown(`no ${name} of this session at block ${events.number}`);
  if (mine.length > 1) return unknown(`${mine.length} events ${name} of this session at block ${events.number}: the cross check takes exactly one`);
  const fields = (mine[0] as { fields: Record<string, DoorValue> }).fields;
  const totals: Record<string, bigint> = {};
  for (const t of cc.totals) {
    const said = fields[t];
    const stored = session[t];
    if (typeof said !== "string" || !DECIMAL.test(said)) return unknown(`${name}.${t} is not a total in decimal`);
    if (typeof stored !== "bigint") return unknown(`the stored session has no total ${t}`);
    if (BigInt(said) !== stored) return unknown(`${t} disagrees: the event ${name} says ${said}, the stored session says ${stored}`);
    totals[t] = stored;
  }
  return known({ number: state.number, hash: state.hash, totals });
}
freezeFunction(crossCheck);
