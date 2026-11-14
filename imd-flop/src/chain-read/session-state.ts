/**
 * The door's decoded values turned into imd-flop's own types (P2, rule C4): the session record with exactly the
 * fields the reviewed shape states for it, the session nonce, and the circuit breaker's state. A field the shape
 * does not state, a field it states that is missing, a value of another kind and a number out of its range are
 * unknown. Amounts are bigint. The fields come from the frozen table (key-table.ts, from the shape file); the types
 * below are what this reader turns them into, and a runtime whose shape states them otherwise is unknown. Pure.
 */
import { isHex } from "./bytes.js";
import { deepFreeze, freezeFunction } from "../freeze.js";
import type { DoorValue } from "./door.js";
import type { FieldType, RecordField, RuntimeLine } from "./key-table-types.js";
import { type Got, known, unknown } from "./result.js";

/** FlopSessionKeys.Sessions(owner, delegate), by the shape's field names. Accounts and allowed pallets are 0x hex. */
export interface SessionRecord {
  readonly owner: string;
  readonly delegate: string;
  readonly spending_cap: bigint;
  readonly per_tx_limit: bigint;
  readonly daily_cap: bigint;
  readonly epoch_spent: bigint;
  readonly epoch_start: number;
  readonly spent: bigint;
  readonly expires_at: number;
  readonly allowed_pallets: readonly string[];
  readonly active: boolean;
}

/** FlopSessionKeys.CircuitBreakers(delegate), by the shape's field names. */
export interface CircuitBreakerRecord {
  readonly period_start: number;
  readonly tx_count: number;
  readonly total_spend: bigint;
  readonly tripped: boolean;
}

const account: FieldType = { kind: "bytes", length: 32 };
const u128: FieldType = { kind: "u128" };
const u32: FieldType = { kind: "u32" };
const bool: FieldType = { kind: "bool" };

/** The session record as this reader reads it: the shape's fields, in its order, with their types. */
export const SESSION_FIELDS: readonly RecordField[] = deepFreeze([
  { name: "owner", type: account },
  { name: "delegate", type: account },
  { name: "spending_cap", type: u128 },
  { name: "per_tx_limit", type: u128 },
  { name: "daily_cap", type: u128 },
  { name: "epoch_spent", type: u128 },
  { name: "epoch_start", type: u32 },
  { name: "spent", type: u128 },
  { name: "expires_at", type: u32 },
  { name: "allowed_pallets", type: { kind: "list", of: { kind: "bytes" } } },
  { name: "active", type: bool },
]);

/** The circuit breaker's state as this reader reads it. */
export const CIRCUIT_BREAKER_FIELDS: readonly RecordField[] = deepFreeze([
  { name: "period_start", type: u32 },
  { name: "tx_count", type: u32 },
  { name: "total_spend", type: u128 },
  { name: "tripped", type: bool },
]);

/** The session nonce as this reader reads it. */
export const SESSION_NONCE_TYPE: FieldType = deepFreeze({ kind: "u64" });

const BITS: Readonly<Record<string, number>> = Object.freeze({ u8: 8, u16: 16, u32: 32, u64: 64, u128: 128 });
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** One value of a type: a number for u8 to u32, a bigint for u64 and u128, as the door writes them. */
function valueOf(t: FieldType, v: DoorValue, at: string): Got<unknown> {
  switch (t.kind) {
    case "u8":
    case "u16":
    case "u32": {
      const max = 2 ** (BITS[t.kind] as number) - 1;
      return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? known(v) : unknown(`${at} is not a ${t.kind}`);
    }
    case "u64":
    case "u128": {
      if (typeof v !== "string" || !DECIMAL.test(v)) return unknown(`${at} is not a ${t.kind} in decimal`);
      const n = BigInt(v);
      return n < 1n << BigInt(BITS[t.kind] as number) ? known(n) : unknown(`${at} is out of the range of a ${t.kind}`);
    }
    case "bool":
      return typeof v === "boolean" ? known(v) : unknown(`${at} is not a bool`);
    case "bytes":
      if (!isHex(v)) return unknown(`${at} is not bytes`);
      return t.length === undefined || v.length === 2 + 2 * t.length ? known(v) : unknown(`${at} is not ${t.length} bytes`);
    case "list": {
      if (!Array.isArray(v)) return unknown(`${at} is not a list`);
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const x = valueOf(t.of, v[i] as DoorValue, `${at}[${i}]`);
        if (x.kind === "unknown") return x;
        out.push(x.value);
      }
      return known(out);
    }
    case "record":
      return recordOf(t.fields, v, at);
  }
}

/** A record with exactly these fields: one the shape does not state, or one it states that is missing, is unknown. */
function recordOf(fields: readonly RecordField[], v: DoorValue, at: string): Got<Record<string, unknown>> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return unknown(`${at} is not a record`);
  const names = fields.map((f) => f.name);
  const extra = Object.keys(v).filter((k) => !names.includes(k));
  if (extra.length > 0) return unknown(`${at} has the field ${extra[0]}, which the shape does not state`);
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!Object.hasOwn(v, f.name)) return unknown(`${at} lacks the field ${f.name}, which the shape states`);
    const x = valueOf(f.type, (v as Record<string, DoorValue>)[f.name] as DoorValue, `${at}.${f.name}`);
    if (x.kind === "unknown") return x;
    out[f.name] = x.value;
  }
  return known(out);
}

/** The runtime's shape must state a record as this reader reads it, field for field. */
function stated(line: RuntimeLine, what: string, theirs: unknown, ours: unknown): Got<true> {
  return same(theirs, ours) ? known(true) : unknown(`spec ${line.specVersion} states ${what} otherwise than chain-read reads it`);
}

/** The session record from the door's value of FlopSessionKeys.Sessions. */
export function sessionOf(line: RuntimeLine, v: DoorValue): Got<SessionRecord> {
  const s = stated(line, "the session record", line.records.session, SESSION_FIELDS);
  if (s.kind === "unknown") return s;
  return recordOf(SESSION_FIELDS, v, "the session") as Got<SessionRecord>;
}
freezeFunction(sessionOf);

/**
 * The session record, only when it names this owner and this delegate (the P2 fix round, rule X3): a stored record
 * of another pair is unknown, whatever key it was answered under.
 */
export function ofThePair(record: SessionRecord, owner: string, delegate: string): Got<SessionRecord> {
  if (record.owner !== owner) return unknown(`the stored record names another owner, ${record.owner}, than ${owner}`);
  if (record.delegate !== delegate) return unknown(`the stored record names another delegate, ${record.delegate}, than ${delegate}`);
  return known(record);
}
freezeFunction(ofThePair);

/** The session nonce from the door's value of FlopSessionKeys.SessionNonces. */
export function sessionNonceOf(line: RuntimeLine, v: DoorValue): Got<bigint> {
  const s = stated(line, "the session nonce", line.records.sessionNonce, SESSION_NONCE_TYPE);
  if (s.kind === "unknown") return s;
  return valueOf(SESSION_NONCE_TYPE, v, "the session nonce") as Got<bigint>;
}
freezeFunction(sessionNonceOf);

/** The circuit breaker's state from the door's value of FlopSessionKeys.CircuitBreakers. */
export function circuitBreakerOf(line: RuntimeLine, v: DoorValue): Got<CircuitBreakerRecord> {
  const s = stated(line, "the circuit breaker", line.records.circuitBreaker, CIRCUIT_BREAKER_FIELDS);
  if (s.kind === "unknown") return s;
  return recordOf(CIRCUIT_BREAKER_FIELDS, v, "the circuit breaker") as Got<CircuitBreakerRecord>;
}
freezeFunction(circuitBreakerOf);
