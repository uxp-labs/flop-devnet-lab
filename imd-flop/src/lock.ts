/**
 * The ledger lock. One file, `<ledger>.lock`, holds its owner `{pid, host, token}`. Every cap decision and
 * every ledger append runs under it (ledger.ts withLedgerLock).
 *
 * The rules (audit 33f3b9f, findings 1, 7 and 11):
 *  - The lock is created with its owner already in it: a temporary file, then link. It is never empty.
 *  - Release unlinks the lock only if it still carries our token.
 *  - Nothing renames or moves the lock. A waiter removes it only when both hold:
 *    a. its recorded owner is provably dead: same host and the pid is gone (ESRCH), or the pid is our own
 *       pid and the token is not one this process holds now;
 *    b. the waiter holds the reclaim right for that exact token: the file `<lock>.reclaim.<token>.<n>`,
 *       created the same exclusive way and carrying the waiter's own owner. Level 1 first. If level n
 *       exists and its owner is provably dead, the right passes to level n+1. If its owner is alive or
 *       cannot be read, the waiter has no right and waits.
 *    Under the right the waiter reads the lock again and unlinks it only if it still carries that token.
 *    Then it removes its own right file. The lock first, the right file second.
 *  - No age rule. A provably dead owner is reclaimable at once. A lock with no readable owner, a lock of
 *    another host and a lock whose owner is alive are never removed: the waiter times out with a message
 *    that names the owner and the way back.
 *  - Right after taking the lock, the holder removes leftover right files and temporary files whose
 *    owners are provably dead. Never the lock.
 *
 * Why it is exclusive. Tokens are random and never reused, so a lock that stops carrying a token never
 * carries it again. While the lock carries token T, no right file of T is removed: its holder removes it
 * only after the lock stopped carrying T, and the sweep runs only under a lock that carries another
 * token. So while the lock carries T the right files of T only grow, and at most one live process holds
 * a right of T. Only that process can unlink the lock, and its re-read and unlink see the same lock.
 * test/lock-model.test.ts checks this over every interleaving of three waiters, with a crash.
 *
 * The algorithm is written as generators that yield before every file operation. The driver here runs
 * them on the real file system. The model check runs them over an in memory file system and interleaves
 * them at every yield.
 */
import { closeSync, linkSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

/** The ledger lock could not be taken, or an append found it no longer ours. Either way that append wrote nothing. */
export class LedgerLockError extends Error {}

/**
 * The ledger lock cannot be created at all: no permission to create the file, or a read only file system.
 * Not a busy ledger and not a crash. A reader reads without the lock (ledger.ts ledgerLines); a writer refuses.
 */
export class LedgerUnlockable extends Error {}

export interface LockOwner {
  pid: number;
  host: string;
  token: string;
}

/** The process that runs a step: its owner record and the tokens it holds now. */
export interface Self extends LockOwner {
  held: ReadonlySet<string>;
}

/**
 * The file operations a step may yield. Each yield is a point where another process may run.
 *  - create: exclusive create with content. True when created, false when the path exists.
 *  - read: the file's text, or null when there is no such file.
 *  - unlink: true when removed, false when it was gone. With bestEffort, a failure is ignored.
 *  - list: the full paths of the files whose path starts with prefix.
 *  - alive: false only when the pid is provably gone on this host.
 *  - wait: nothing to do now; try again later.
 */
export type FileOp =
  | { kind: "create"; path: string; content: string }
  | { kind: "read"; path: string }
  | { kind: "unlink"; path: string; bestEffort?: boolean }
  | { kind: "list"; prefix: string }
  | { kind: "alive"; pid: number }
  | { kind: "wait" };

export type Step<R> = Generator<FileOp, R, unknown>;

function* create(path: string, content: string): Step<boolean> {
  return (yield { kind: "create", path, content }) as boolean;
}
function* read(path: string): Step<string | null> {
  return (yield { kind: "read", path }) as string | null;
}
function* unlink(path: string, bestEffort = false): Step<boolean> {
  return (yield { kind: "unlink", path, bestEffort }) as boolean;
}
function* list(prefix: string): Step<string[]> {
  return (yield { kind: "list", prefix }) as string[];
}
function* alive(pid: number): Step<boolean> {
  return (yield { kind: "alive", pid }) as boolean;
}

export const ownerText = (o: LockOwner): string => JSON.stringify({ pid: o.pid, host: o.host, token: o.token });

/** The owner a lock or right file records, or null when there is none to read. */
export function parseOwner(text: string | null): LockOwner | null {
  if (text === null) return null;
  try {
    const o = JSON.parse(text);
    if (Number.isInteger(o?.pid) && o.pid > 0 && typeof o.host === "string" && typeof o.token === "string") return { pid: o.pid, host: o.host, token: o.token };
  } catch { /* unreadable or malformed: never provably dead */ }
  return null;
}

/** The reclaim right of level n for the lock that carries token. */
export const rightPath = (lock: string, token: string, n: number): string => `${lock}.reclaim.${token}.${n}`;

/**
 * True only when the owner is provably dead. Another host is never provably dead. Our own pid is dead
 * when the token is not one this process holds now: an earlier process had our pid. Anything else asks
 * whether the pid is gone. Anything unproven counts as alive.
 */
export function* provablyDead(self: Self, o: LockOwner): Step<boolean> {
  if (o.host !== self.host) return false;
  if (o.pid === self.pid) return !self.held.has(o.token);
  return !(yield* alive(o.pid));
}

/** What one attempt to take the lock ended in: taken, try again at once, or wait and then try again. */
export type Attempt = "taken" | "again" | "wait";

/**
 * One attempt to take the lock. An attempt carries nothing over from the one before: every attempt
 * starts from the files as they are. The model check relies on that.
 */
export function* attempt(self: Self, lock: string): Step<Attempt> {
  if (yield* create(lock, ownerText(self))) {
    yield* sweep(self, lock);
    return "taken";
  }
  const text = yield* read(lock);
  if (text === null) return "again"; // released between our create and our read
  const o = parseOwner(text);
  if (o !== null && (yield* provablyDead(self, o)) && (yield* reclaim(self, lock, o.token))) return "again";
  return "wait";
}

/** Take the lock: attempts until one takes it, with a wait after each attempt that ends in wait. */
export function* acquire(self: Self, lock: string): Step<void> {
  for (;;) {
    const r = yield* attempt(self, lock);
    if (r === "taken") return;
    if (r === "wait") yield { kind: "wait" };
  }
}

/**
 * Remove the lock that carries token, whose owner was judged provably dead, if this process gets the
 * reclaim right for it. True when it held the right (and so the lock may be free now). False when it got
 * no right: another live process is reclaiming it, or a right file cannot be read.
 */
export function* reclaim(self: Self, lock: string, token: string): Step<boolean> {
  for (let n = 1; ; n++) {
    const right = rightPath(lock, token, n);
    if (yield* create(right, ownerText(self))) {
      if (parseOwner(yield* read(lock))?.token === token) yield* unlink(lock);
      yield* unlink(right);
      return true;
    }
    const r = parseOwner(yield* read(right));
    if (r === null || !(yield* provablyDead(self, r))) return false;
  }
}

/** Release the lock only if it still carries our token. */
export function* release(self: Self, lock: string): Step<void> {
  if (parseOwner(yield* read(lock))?.token === self.token) yield* unlink(lock);
}

const isRightName = (lock: string, path: string) => path.startsWith(`${lock}.reclaim.`) && !path.endsWith(".tmp");
const isTmpName = (lock: string, path: string) => path.startsWith(`${lock}.`) && path.endsWith(".tmp");

/**
 * Under the lock: remove leftover right files and temporary files whose owners are provably dead. Best
 * effort. Never the lock. Safe because the lock carries our own live token, so no right of an older
 * token can still unlink it.
 */
export function* sweep(self: Self, lock: string): Step<void> {
  for (const path of yield* list(`${lock}.`)) {
    if (!isRightName(lock, path) && !isTmpName(lock, path)) continue;
    const o = parseOwner(yield* read(path));
    if (o !== null && (yield* provablyDead(self, o))) yield* unlink(path, true);
  }
}

// The production driver: the steps above on the real file system.

const UNLOCKABLE = new Set(["EACCES", "EPERM", "EROFS"]);
const WAIT_MS = 25;
const TIMEOUT_MS = 5_000;
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * Exclusive create with content: the content goes to a temporary file that is then linked to the path.
 * The link fails with EEXIST when the path exists. So the file is never seen empty. The temporary file
 * carries the same owner, so a creator that died before removing it leaves a file the sweep can judge.
 */
function createFile(path: string, content: string): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx");
    try { writeSync(fd, content); } finally { closeSync(fd); }
  } catch (e) {
    const c = code(e);
    if (c !== undefined && UNLOCKABLE.has(c)) throw new LedgerUnlockable(`the ledger could not be locked: ${path} cannot be created (${c})`);
    throw e;
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    const c = code(e);
    if (c === "EEXIST") return false;
    if (c !== undefined && UNLOCKABLE.has(c)) throw new LedgerUnlockable(`the ledger could not be locked: ${path} cannot be created (${c})`);
    throw e;
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

/** The file's text, null when there is none. A file that exists and cannot be read reads as no owner. */
function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (e) { return code(e) === "ENOENT" ? null : ""; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } // alive (or reachable)
  catch (e) { return code(e) !== "ESRCH"; } // EPERM means alive
}

function listPrefix(prefix: string): string[] {
  const dir = dirname(prefix);
  const start = basename(prefix);
  try { return readdirSync(dir).filter((n) => n.startsWith(start)).map((n) => join(dir, n)); } catch { return []; }
}

/** Run one step to completion on the real file system. onWait runs at each wait and may throw. */
export function runOnDisk<R>(step: Step<R>, onWait: () => void): R {
  let next = step.next();
  while (!next.done) {
    const op = next.value;
    let result: unknown;
    switch (op.kind) {
      case "create": result = createFile(op.path, op.content); break;
      case "read": result = readText(op.path); break;
      case "unlink":
        try { unlinkSync(op.path); result = true; } catch (e) {
          if (code(e) === "ENOENT") result = false;
          else if (op.bestEffort) result = false;
          else throw e;
        }
        break;
      case "list": result = listPrefix(op.prefix); break;
      case "alive": result = processAlive(op.pid); break;
      case "wait": onWait(); result = undefined; break;
    }
    next = step.next(result);
  }
  return next.value;
}

/**
 * The timeout message: the lock file, its age, the recorded owner and the way back, so a holder can see
 * what is in the way and how to clear it.
 */
export function timeoutMessage(lock: string): string {
  let age: string;
  try { age = `${Math.floor((Date.now() - statSync(lock).mtimeMs) / 1000)} s old`; } catch { age = "gone"; }
  const o = parseOwner(readText(lock));
  const owner = o ? `is held by pid ${o.pid} on host ${o.host}` : "has no readable owner";
  return `ledger lock timeout: ${lock} (${age}) ${owner}. If no imd-flop process is using this home any more, remove that file and run again.`;
}

/** The tokens this process holds now: its lock while it waits for it or holds it. Never provably dead. */
const held = new Set<string>();
/** Re-entry depth per ledger file. Read by ledger.ts ledgerLines. */
const depth = new Map<string, number>();
export const lockDepth: ReadonlyMap<string, number> = depth;
/** The token of the lock this process holds, per ledger file. */
const tokens = new Map<string, string>();

function self(token: string): Self {
  return { pid: process.pid, host: hostname(), token, held };
}

function takeLock(lock: string): string {
  const token = randomBytes(16).toString("hex");
  held.add(token);
  const start = Date.now();
  try {
    runOnDisk(acquire(self(token), lock), () => {
      if (Date.now() - start > TIMEOUT_MS) throw new LedgerLockError(timeoutMessage(lock));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_MS);
    });
    return token;
  } catch (e) {
    held.delete(token);
    throw e;
  }
}

function releaseLock(lock: string, token: string): void {
  try { runOnDisk(release(self(token), lock), () => {}); }
  finally { held.delete(token); }
}

/**
 * Defense in depth, not part of the proof: right before an append, the lock file still carries this
 * process's token. It catches a lock removed by hand while a holder is inside.
 */
export function assertLockHeld(key: string): void {
  const lock = `${key}.lock`;
  const token = tokens.get(key);
  if (token === undefined || parseOwner(readText(lock))?.token !== token) {
    throw new LedgerLockError(`ledger lock lost: ${lock} no longer carries this process's token, so nothing was appended`);
  }
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

/** Exclusive lock on `<key>.lock` around fn. Re-enters in this process. Synchronous bodies only. */
export function withLock<T>(key: string, fn: () => T): T {
  const d = depth.get(key) ?? 0;
  if (d > 0) {
    depth.set(key, d + 1);
    try { return syncResult(fn()); }
    finally { depth.set(key, d); }
  }
  const lock = `${key}.lock`;
  const token = takeLock(lock);
  tokens.set(key, token);
  depth.set(key, 1);
  try { return syncResult(fn()); }
  finally {
    depth.set(key, 0);
    tokens.delete(key);
    releaseLock(lock, token);
  }
}
