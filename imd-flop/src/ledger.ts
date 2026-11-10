/**
 * ledger.jsonl: one line per state change of an attempt (spend-guard rule 6). The latest line for a
 * request_id wins. Tokens, keys and prompts are never written; only a prompt hash.
 * States: refused_local, sent, timeout_unknown, error, reserved, estimated, settled, released.
 * A pre-mint refusal appends refused_local (cap charge 0). That latest line supersedes the pre-call sent line.
 */
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { ledgerFile } from "./paths.js";
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
  spent_before: number | null; // holder: today's spend; requester: this job's spend
  state: string;
  reason: string | null;
  spend: number | null; // finite settled spend >= 0; null = unknown (negative, non-finite, and missing are unknown, never coerced to 0)
  cost_reported: number | null; // usage.cost_flop from the completion, if any. Recorded as reported; not a settlement.
  cap_charge: number; // known finite settled spend, including explicit 0; while spend is unknown, the padded quote, raised if reported cost is higher
  http: number | null;
  mock: boolean;
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function appendLedger(h: string, e: LedgerEntry): void {
  withLedgerLock(h, () => appendJsonlSafe(ledgerFile(h), e, "ledger.jsonl"));
}

/** Latest entry per attempt. Refusals have no request_id and never count. */
export function latestAttempts(h: string): LedgerEntry[] {
  const m = new Map<string, LedgerEntry>();
  for (const e of readJsonl<LedgerEntry>(ledgerFile(h))) if (e.request_id) m.set(e.request_id, e);
  return [...m.values()];
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export class UnusableLedgerCharge extends Error {}

/** A cap charge counts only when it is a finite number and not negative. Null is not 0. */
export function usableCapCharge(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sumCharges(rows: LedgerEntry[]): number {
  let sum = 0;
  for (const row of rows) {
    if (!usableCapCharge(row.cap_charge)) throw new UnusableLedgerCharge("ledger cap_charge unusable; next call refused");
    sum += row.cap_charge;
  }
  return round6(sum);
}

export function spentToday(h: string, seat: string, provider: string, day = utcDay()): number {
  return sumCharges(latestAttempts(h).filter((e) => e.seat === seat && e.provider === provider && e.payer === "holder" && e.day === day));
}

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

/** Exclusive lock from a cap check through its ledger append. Re-enters in this process. */
export function withLedgerLock<T>(h: string, fn: () => T): T {
  const key = ledgerFile(h);
  const depth = lockDepth.get(key) ?? 0;
  if (depth > 0) {
    lockDepth.set(key, depth + 1);
    try { return fn(); }
    finally { lockDepth.set(key, depth); }
  }
  const { fd, token } = takeLock(`${key}.lock`);
  lockDepth.set(key, 1);
  try { return fn(); }
  finally {
    lockDepth.set(key, 0);
    try { closeSync(fd); } catch { /* already closed */ }
    releaseLock(`${key}.lock`, token);
  }
}
