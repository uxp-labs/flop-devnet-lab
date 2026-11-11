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
 *    that names the owner, any right file in the way, and the way back.
 *  - Only ENOENT means the lock is absent. A lock path that cannot be read or is not a regular file has
 *    no readable owner. An attempt answers "again" only right after this process removed the lock itself;
 *    every other outcome waits, so the deadline is reached whatever is at the path.
 *  - Right after taking the lock, the holder removes every right file whose token is not its own, and
 *    every temporary file whose owner is provably dead. Never the lock.
 *
 * Why it is exclusive. Tokens are random and never reused, so a lock that stops carrying a token never
 * carries it again. While the lock carries token T, a right file of T is removed only by its own creator:
 * the sweep runs only under a lock that carries another token, so it never removes a right of T while the
 * lock carries T. A right of T is created exclusively and passes to the next level only when its owner is
 * provably dead. So while the lock carries T, at most one live process holds a right of T. Only a process
 * that holds a right of T unlinks the lock, and only after a re-read under the right shows T. So at most
 * one process can remove the lock that carries T, and when it does the lock carried T.
 * The sweep may remove a right of an older token whose creator is still alive. That creator's re-read shows
 * the lock no longer carries that token, so it unlinks nothing. Its own removal of the right file then finds
 * ENOENT, or removes a right a later reclaimer made for that same old token, which is just as harmless: the
 * old token never comes back, so no right of it can remove anything.
 * test/lock-model.test.ts checks this over every interleaving of three waiters, with crashes.
 *
 * The algorithm is written as generators that yield before every file operation. The driver here runs
 * them on the real file system. The model check runs them over an in memory file system and interleaves
 * them at every yield.
 */
import { closeSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

/** The ledger lock could not be taken. Thrown before the guarded work runs, so nothing in it happened. */
export class LedgerLockError extends Error {}

/**
 * An append found the lock no longer ours (it was removed by hand while this process was inside). The
 * append wrote nothing. Not a busy ledger: it is a failed append, and callers treat it as one.
 */
export class LedgerLockLost extends Error {}

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
 *  - unlink: "removed", "absent" when it was gone, or { denied: code } when this user may not remove it
 *    (EPERM, EACCES). Any other failure is a LedgerLockError that names the file and the code. With
 *    bestEffort every failure reads as "absent".
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

/** What an unlink did. */
export type Unlinked = "removed" | "absent" | { denied: string };

function* create(path: string, content: string): Step<boolean> {
  return (yield { kind: "create", path, content }) as boolean;
}
function* read(path: string): Step<string | null> {
  return (yield { kind: "read", path }) as string | null;
}
function* unlink(path: string, bestEffort = false): Step<Unlinked> {
  return (yield { kind: "unlink", path, bestEffort }) as Unlinked;
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

/**
 * What one attempt to take the lock ended in: taken, try again at once, or wait and then try again.
 * "again" only right after this process itself removed the lock. Every other outcome waits, so no loop of
 * attempts is free of a wait, and the deadline is reached whatever is at the lock path.
 */
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
  // Absent here means released between our create and our read: wait, then try again.
  const o = parseOwner(yield* read(lock));
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
 * reclaim right for it. True only when this process removed the lock. False when it got no right
 * (another live process is reclaiming it, or a right file cannot be read), when under the right the lock
 * no longer carried that token, or when this user may not remove the lock. In every case the waiter
 * removes its own right file before it returns.
 */
export function* reclaim(self: Self, lock: string, token: string): Step<boolean> {
  for (let n = 1; ; n++) {
    const right = rightPath(lock, token, n);
    if (yield* create(right, ownerText(self))) {
      let removed = false;
      if (parseOwner(yield* read(lock))?.token === token) removed = (yield* unlink(lock)) === "removed";
      yield* unlink(right);
      return removed;
    }
    const r = parseOwner(yield* read(right));
    if (r === null || !(yield* provablyDead(self, r))) return false;
  }
}

/** Release the lock only if it still carries our token. Says what the unlink did, "absent" when it was not ours. */
export function* release(self: Self, lock: string): Step<Unlinked> {
  if (parseOwner(yield* read(lock))?.token !== self.token) return "absent";
  return yield* unlink(lock);
}

/** The token a right file name is for, or null when the path is not a right file of this lock. */
export function rightToken(lock: string, path: string): string | null {
  const m = path.startsWith(`${lock}.reclaim.`) ? /^([^.]+)\.\d+$/.exec(path.slice(`${lock}.reclaim.`.length)) : null;
  return m ? m[1] : null;
}
const isTmpName = (lock: string, path: string) => path.startsWith(`${lock}.`) && path.endsWith(".tmp");

/**
 * Under the lock: remove every right file whose token is not the lock's token, which is our own, and
 * every temporary file whose owner is provably dead. Best effort. Never the lock. Why a right of another
 * token may go whoever holds it: see the header.
 */
export function* sweep(self: Self, lock: string): Step<void> {
  for (const path of yield* list(`${lock}.`)) {
    if (isTmpName(lock, path)) {
      const o = parseOwner(yield* read(path));
      if (o !== null && (yield* provablyDead(self, o))) yield* unlink(path, true);
      continue;
    }
    const t = rightToken(lock, path);
    if (t !== null && t !== self.token) yield* unlink(path, true);
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
 * On any failure the temporary file is removed before the error goes on. Known defect: a process killed
 * between creating its temporary file and writing it leaves an empty one, which has no readable owner and
 * so is never swept (about one per 600 kills at that moment in the review). It is never read as a lock.
 */
function createFile(path: string, content: string): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx");
    try {
      try { writeSync(fd, content); } finally { closeSync(fd); }
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* gone */ }
      throw e;
    }
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

/**
 * The file's text, null when there is none. Only ENOENT means absent. A path that cannot be read, or is
 * not a regular file (a symbolic link, a directory, anything else), reads as no owner: never removed.
 */
function readText(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return "";
    return readFileSync(path, "utf8");
  } catch (e) {
    return absentOrUnreadable(e);
  }
}
const absentOrUnreadable = (e: unknown): string | null => (code(e) === "ENOENT" ? null : "");

/** What is at a path that has no readable owner, for the timeout message. Null when it is a regular file that reads. */
function whatItIs(path: string): string | null {
  let st;
  try { st = lstatSync(path); } catch (e) { return code(e) === "ENOENT" ? null : `it cannot be examined (${code(e)})`; }
  if (st.isSymbolicLink()) return "it is a symbolic link";
  if (st.isDirectory()) return "it is a directory";
  if (!st.isFile()) return "it is not a regular file";
  try { readFileSync(path); } catch (e) { return `it cannot be read (${code(e)})`; }
  return null;
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

/** A lock error that carries the error code of the file operation that failed. */
class LockFileError extends LedgerLockError {
  constructor(message: string, readonly code: string) { super(message); }
}

const DENIED = new Set(["EPERM", "EACCES"]);

function unlinkFile(path: string, bestEffort: boolean): Unlinked {
  try {
    unlinkSync(path);
    return "removed";
  } catch (e) {
    const c = code(e) ?? "unknown";
    if (c === "ENOENT" || bestEffort) return "absent";
    if (DENIED.has(c)) return { denied: c };
    throw new LockFileError(`ledger lock error: ${path} cannot be removed (${c})`, c);
  }
}

/**
 * Run one step to completion on the real file system. onWait runs at each wait and may throw. onResult,
 * when given, sees every operation with its result.
 */
export function runOnDisk<R>(step: Step<R>, onWait: () => void, onResult?: (op: FileOp, result: unknown) => void): R {
  let next = step.next();
  while (!next.done) {
    const op = next.value;
    let result: unknown;
    switch (op.kind) {
      case "create": result = createFile(op.path, op.content); break;
      case "read": result = readText(op.path); break;
      case "unlink": result = unlinkFile(op.path, op.bestEffort === true); break;
      case "list": result = listPrefix(op.prefix); break;
      case "alive": result = processAlive(op.pid); break;
      case "wait": onWait(); result = undefined; break;
    }
    onResult?.(op, result);
    next = step.next(result);
  }
  return next.value;
}

const ageOf = (path: string): string => {
  try { return `${Math.floor((Date.now() - lstatSync(path).mtimeMs) / 1000)} s old`; } catch { return "gone"; }
};
const uidOf = (path: string): string => {
  try { return `uid ${lstatSync(path).uid}`; } catch { return "an unknown user"; }
};

/** What the waiter met on its last attempt that a fresh look at the files would not show. */
export interface Blocked {
  /** The unlink of the lock was refused with this code (EPERM, EACCES). */
  denied?: string;
}

/**
 * The right file in the way of a reclaim of the lock that carries token: the first level whose owner is
 * not provably dead or cannot be read. Null when there is none.
 */
function rightInTheWay(me: Self, lock: string, token: string): { path: string; owner: LockOwner | null } | null {
  for (let n = 1; ; n++) {
    const path = rightPath(lock, token, n);
    const text = readText(path);
    if (text === null) return null;
    const o = parseOwner(text);
    if (o === null || !runOnDisk(provablyDead(me, o), () => {})) return { path, owner: o };
  }
}

/**
 * The timeout message: the lock file, its age, the recorded owner and the way back, so a holder can see
 * what is in the way and how to clear it.
 */
export function timeoutMessage(lock: string, blocked: Blocked = {}): string {
  const text = readText(lock);
  const o = parseOwner(text);
  const what = text === null ? null : whatItIs(lock);
  const me = self("");
  let owner: string;
  if (text === null) owner = "is gone now";
  else if (o === null) owner = `has no readable owner${what ? `: ${what}` : ""}`;
  else if (!runOnDisk(provablyDead(me, o), () => {})) owner = `is held by pid ${o.pid} on host ${o.host}`;
  else if (blocked.denied) owner = `was held by pid ${o.pid} on host ${o.host}, which is gone, and this user cannot remove that file (${blocked.denied}; it belongs to ${uidOf(lock)})`;
  else {
    const right = rightInTheWay(me, lock, o.token);
    const who = right?.owner ? `is held by pid ${right.owner.pid} on host ${right.owner.host}` : "has no readable owner";
    owner = `was held by pid ${o.pid} on host ${o.host}, which is gone${right ? `, and its reclaim right ${right.path} (${ageOf(right.path)}) ${who}` : ""}`;
  }
  return `ledger lock timeout: ${lock} (${ageOf(lock)}) ${owner}. If no imd-flop process is using this home any more, remove that file and run again.`;
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
  const me = self(token);
  try {
    // The deadline is checked before every attempt, not only at a wait.
    let blocked: Blocked = {};
    for (;;) {
      if (Date.now() - start > TIMEOUT_MS) throw new LedgerLockError(timeoutMessage(lock, blocked));
      const seen: Blocked = {};
      const r = runOnDisk(attempt(me, lock), () => {}, (op, result) => {
        if (op.kind === "unlink" && op.path === lock && typeof result === "object" && result !== null) seen.denied = (result as { denied: string }).denied;
      });
      blocked = seen;
      if (r === "taken") return token;
      if (r === "wait") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_MS);
    }
  } catch (e) {
    held.delete(token);
    throw e;
  }
}

/**
 * Release never throws: the protected work is done. If the lock cannot be removed, one line on stderr
 * names the file and the code. The lock then names a pid that is gone once this process ends, so a
 * waiter reclaims it then.
 */
function releaseLock(lock: string, token: string): void {
  let failed: string | null = null;
  try {
    const r = runOnDisk(release(self(token), lock), () => {});
    if (typeof r === "object") failed = r.denied;
  } catch (e) {
    failed = e instanceof LockFileError ? e.code : (code(e) ?? (e as Error).message);
  } finally {
    held.delete(token);
  }
  if (failed !== null) process.stderr.write(`imd-flop: the ledger lock ${lock} could not be removed (${failed}); it will be reclaimed when this process ends.\n`);
}

/**
 * Defense in depth, not part of the proof: right before an append, the lock file still carries this
 * process's token. It catches a lock removed by hand while a holder is inside.
 */
export function assertLockHeld(key: string): void {
  const lock = `${key}.lock`;
  const token = tokens.get(key);
  if (token === undefined || parseOwner(readText(lock))?.token !== token) {
    throw new LedgerLockLost(`ledger lock lost: ${lock} no longer carries this process's token, so nothing was appended`);
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
