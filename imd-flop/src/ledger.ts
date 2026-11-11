/**
 * ledger.jsonl: one line per state change of an attempt (spend-guard rule 6). The latest line for a
 * request_id wins. Tokens, keys and prompts are never written; only a prompt hash.
 * States: refused_local, sent, timeout_unknown, error, reserved, estimated, settled, released.
 * A pre-mint refusal appends refused_local (cap charge 0). That latest line supersedes the pre-call sent line.
 */
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { knownAmount } from "./amount.js";
import { ledgerFile } from "./paths.js";
import { ceil6 } from "./rounding.js";
import { appendJsonlSafe, readJsonl } from "./store.js";
import type { Payer } from "./config.js";

export interface LedgerEntry {
  ts: string;
  day: string; // UTC date; the daily cap resets at 00:00 UTC
  request_id: string | null;
  seat: string; // NFT tokenId
  did: string | null; // the seat's FLOP did:key at call time
  job: string;
  provider: "mock" | "flop";
  network: string;
  payer: Payer;
  model: string;
  max_tokens: number;
  prompt_sha256: string;
  quote_raw: number | null;
  quote_padded: number | null;
  per_call_cap: number | null;
  daily_cap: number | null;
  job_budget: number | null;
  spent_before: number | null; // the seat's spend today before this call, for every payer: the daily cap's running total. Null is unknown
  // Requester row: this job's requester spend before this call, the job budget's running total. Null on a holder row.
  // Rows written before the daily cap bounded requester calls (audit 8ddc5d2, finding 13) lack the field, and on
  // those requester rows spent_before held the job's spend. A missing value is unknown, never 0.
  job_spent_before?: number | null;
  state: string;
  reason: string | null;
  spend: number | null; // finite settled spend >= 0; null = unknown (negative, non-finite, and missing are unknown, never coerced to 0)
  cost_reported: number | null; // usage.cost_flop from the completion, if any. Recorded as reported; not a settlement.
  cap_charge: number; // known finite settled spend (explicit 0 included), or while spend is unknown the padded quote; either is raised to the reported cost when that is higher
  http: number | null;
  mock: boolean;
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function appendLedger(h: string, e: LedgerEntry): void {
  withLedgerLock(h, () => appendJsonlSafe(ledgerFile(h), e, "ledger.jsonl"));
}

/**
 * Latest line per request_id. Lines with no request_id are omitted.
 * A locally proven pre-dispatch refusal may still have a request_id; that line is kept and its cap_charge is 0, so it adds nothing to spend.
 * A generic refusal label or unknown spend does not imply a zero charge, and those lines stay in this list.
 */
export function latestAttempts(h: string): LedgerEntry[] {
  const m = new Map<string, LedgerEntry>();
  for (const e of readJsonl<LedgerEntry>(ledgerFile(h))) if (e.request_id) m.set(e.request_id, e);
  return [...m.values()];
}

export class UnusableLedgerCharge extends Error {}

/** A cap charge counts only when it is a known amount (amount.ts): a finite number and not negative. Null is not 0. */
export function usableCapCharge(value: unknown): boolean {
  return knownAmount(value) !== null;
}

/** The total of these rows' cap charges. Money already spent rounds up to 6 decimals, so the total never understates it. */
function sumCharges(rows: LedgerEntry[]): number {
  let sum = 0;
  for (const row of rows) {
    if (!usableCapCharge(row.cap_charge)) throw new UnusableLedgerCharge("ledger cap_charge unusable; next call refused");
    sum += row.cap_charge;
  }
  return ceil6(sum);
}

/**
 * The seat's spend on one UTC day: the daily cap's running total.
 * The seat's daily cap bounds every call the seat's key pays for, whoever the call is for. Today the gateway
 * has no third party payment, so the seat's key pays for every call, and every row of the seat counts: there
 * is no payer filter. When FLOP ships proxies or escrow pools and a call is funded by another account, that
 * account's limit will bound the call and it will not count here.
 */
export function spentToday(h: string, seat: string, provider: string, day = utcDay()): number {
  return sumCharges(latestAttempts(h).filter((e) => e.seat === seat && e.provider === provider && e.day === day));
}

/** The requester spend on one job, on any day: the job budget's running total. */
export function jobSpent(h: string, job: string, provider: string): number {
  return sumCharges(latestAttempts(h).filter((e) => e.job === job && e.provider === provider && e.payer === "requester"));
}

/** The ledger lock could not be taken. Thrown before the guarded work runs, so nothing in it happened. */
export class LedgerLockError extends Error {}

const lockDepth = new Map<string, number>();

interface LockOwner { pid: number; host: string; token: string }

function readOwner(path: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    if (Number.isInteger(o?.pid) && o.pid > 0 && typeof o.host === "string" && typeof o.token === "string") return o;
  } catch { /* unreadable or malformed: never provably stale */ }
  return null;
}

/** True only when the owner is on this host and its process is gone. Anything unproven counts as alive. */
function provablyDead(o: LockOwner | null): boolean {
  if (!o || o.host !== hostname()) return false;
  try { process.kill(o.pid, 0); return false; } // alive (or reachable)
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } // EPERM means alive
}

/**
 * Reclaim an old lock only if its recorded owner is provably dead. The lock is moved aside atomically
 * first, so two waiters can't both act on one stale file; if what was moved turns out to belong to
 * a live owner, it is linked back, and if that can't be done the caller refuses rather than reserve.
 */
function reclaimIfDead(path: string): boolean {
  if (!provablyDead(readOwner(path))) return false;
  const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
  try { renameSync(path, aside); } catch { return false; } // someone else moved or released it
  if (provablyDead(readOwner(aside))) { try { unlinkSync(aside); } catch { /* gone */ } return true; }
  try { linkSync(aside, path); unlinkSync(aside); } catch { throw new LedgerLockError("ledger lock contested"); }
  return false;
}

function takeLock(path: string): { fd: number; token: string } {
  const start = Date.now();
  const owner: LockOwner = { pid: process.pid, host: hostname(), token: randomBytes(16).toString("hex") };
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify(owner));
      return { fd, token: owner.token };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let old = false;
      try { old = Date.now() - statSync(path).mtimeMs > 30_000; } catch { continue; } // the holder removed it
      if (old && reclaimIfDead(path)) continue;
      if (Date.now() - start > 5_000) throw new LedgerLockError("ledger lock timeout");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** Remove the lock only if it is still ours. */
function releaseLock(path: string, token: string): void {
  if (readOwner(path)?.token !== token) return;
  try { unlinkSync(path); } catch { /* already released */ }
}

/**
 * The lock is released when fn returns, so fn must be synchronous. A promise-returning body would run
 * its awaited part after the release, outside the lock; it is refused (after its lock is released).
 */
function syncResult<T>(r: T): T {
  if (r !== null && (typeof r === "object" || typeof r === "function") && typeof (r as { then?: unknown }).then === "function") {
    (r as unknown as PromiseLike<unknown>).then(undefined, () => { /* the body's own failure is moot: it was refused */ });
    throw new TypeError("withLedgerLock body must be synchronous: an async body would run its awaited part after the lock is released");
  }
  return r;
}

/**
 * Exclusive lock over a read of the ledger and the append that follows from it: the cap check with its
 * `sent` row (run.ts), and the booking of a receipt read (booking.ts). Re-enters in this process.
 * Synchronous bodies only.
 */
export function withLedgerLock<T>(h: string, fn: () => T): T {
  const key = ledgerFile(h);
  const depth = lockDepth.get(key) ?? 0;
  if (depth > 0) {
    lockDepth.set(key, depth + 1);
    try { return syncResult(fn()); }
    finally { lockDepth.set(key, depth); }
  }
  const { fd, token } = takeLock(`${key}.lock`);
  lockDepth.set(key, 1);
  try { return syncResult(fn()); }
  finally {
    lockDepth.set(key, 0);
    try { closeSync(fd); } catch { /* already closed */ }
    releaseLock(`${key}.lock`, token);
  }
}
