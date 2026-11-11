/**
 * Model check of the ledger lock (src/lock.ts), audit 33f3b9f findings 1, 7 and 11 item (1).
 *
 * The lock steps are generators that yield before every file operation. Here they run over an in memory
 * file system, and the checker explores every interleaving of the processes, depth first, with the
 * states it has seen remembered. Each process takes the lock, enters, leaves and releases. In any run one
 * process may also die at any scheduling point: from then on its pid is gone.
 *
 * A process that yields wait is blocked until the world (the files and the set of dead pids) differs from
 * the world its attempt started in. That loses no behavior: if every step of the attempt saw that same
 * world, trying again in it does exactly the same thing. If the world changed during the attempt, the
 * process is not blocked at all.
 *
 * Invariants, checked in every state:
 *  - never two live processes inside at once;
 *  - a lock whose owner is alive and holds it is never unlinked by another process, and a lock the tool
 *    must not remove (no readable owner, another host) is never unlinked;
 *  - a right file of token T is never unlinked by another process than its creator while the lock carries
 *    T (the sweep may remove a right of another token, whoever holds it), and a temporary file whose owner
 *    is alive is never unlinked by another process;
 *  - a process that enters finds the lock carrying its own token;
 *  - in a terminal state every live process has finished, unless the lock is one the tool must not
 *    remove, and then no process got in and the lock is unchanged;
 *  - when every process finished and none died, no file is left: no lock, no right file, no temporary file.
 *    When one died, no lock of a live owner is left;
 *  - liveness: no cycle of states without a wait. A path that comes back to a state it has already passed,
 *    with no attempt on the way that ended in a wait, is a spin: the processes would run for ever without
 *    one wait. Cycles through a wait are allowed and counted.
 *
 * The same checker run against wrong rules must find a violation: the old reclaim (read the owner, rename
 * aside, check, link back), an unlink under the right with no re-read, and a right file removed before the
 * lock. That shows the check bites.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attempt, ownerText, parseOwner, provablyDead, reclaim, release, rightPath, rightToken, sweep, type Attempt, type FileOp, type LockOwner, type Self, type Step, type Unlinked } from "../src/lock.js";

const HOST = "here";
const MAX_STATES = 3_000_000;
const LOCK = "/h/ledger.jsonl.lock";

/** One algorithm under test: one attempt to take the lock, and the release. */
interface Algo {
  attempt(self: Self, lock: string): Step<Attempt>;
  release(self: Self, lock: string): Step<unknown>;
}
const RIGHT: Algo = { attempt, release };

type Phase = "acquire" | "inside" | "release" | "done" | "crashed" | "error" | "unborn";
interface Proc {
  name: string;
  pid: number;
  token: string;
  phase: Phase;
  hist: unknown[]; // the results fed to the current step so far; the step is replayed from them
  pending: FileOp | null; // the operation the step yields next
  blockedOn: string | null; // blocked until the world differs from this
  attemptWorld: string | null; // the world the current attempt started in
  dirty: boolean; // another process changed the world during the current attempt
  entered: boolean;
  bornAfter?: string; // an unborn process starts once this one has crashed, and takes its pid if it is given the same
}
interface State {
  fs: Map<string, string>;
  procs: Proc[];
  crashed: number;
}
/** How a start state must end. finish: every live process finishes. barred: nobody gets in, the lock stays. */
type Expect = "finish" | "barred";
interface Start {
  name: string;
  files: Record<string, string>;
  procs: { name: string; pid: number; token: string; phase: "acquire" | "inside" | "unborn"; bornAfter?: string }[];
  maxCrashes?: number; // how many processes may die in one run (default 1)
  doneIsDead?: boolean; // a process that has finished has exited: its pid is gone
  alwaysAlive?: number[]; // pids that are alive and never released: not scheduled, never die
  denyUnlink?: string[]; // paths this user may not remove: unlink answers { denied: "EPERM" }
  expect: Expect;
}

const owner = (pid: number, token: string, host = HOST): string => ownerText({ pid, host, token });
const waiters = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `w${i + 1}`, pid: i + 1, token: `w${i + 1}`, phase: "acquire" as const }));

/** The phases of a process whose pid is alive. "done" too, unless the start says finished processes exit. */
const LIVE: ReadonlySet<Phase> = new Set(["acquire", "inside", "release", "error"]);
function stateKey(s: State, world: string): string {
  const text = JSON.stringify([world, s.crashed, s.procs.map((p) => [p.phase, p.hist, p.blockedOn, p.attemptWorld, p.dirty, p.entered])]);
  return createHash("sha256").update(text).digest("base64");
}

class Violation extends Error {}

/** One run of the checker over one start state. */
class Checker {
  states = 0;
  terminals = 0;
  private seen = new Set<string>();
  private start: Start;
  private original: string | undefined;

  readonly found = new Map<string, string>();
  /** Cycles that pass through at least one wait. Allowed: a waiter that waits may meet the same files again. */
  cyclesWithWait = 0;
  private path = new Map<string, number>();
  /** The last step ended an attempt in a wait. */
  private waited = false;

  constructor(private readonly algo: Algo, start: Start, private readonly allowCrash: boolean, private readonly collect = false, private readonly maxStates = MAX_STATES) {
    this.start = start;
    this.original = start.files[LOCK];
  }

  private self(p: Proc): Self {
    return { pid: p.pid, host: HOST, token: p.token, held: new Set([p.token]) };
  }

  /**
   * Replay the process's current step (an attempt, or the release) from its results. Returns the next
   * operation, or the step's result when it is done. Throws what the step throws.
   */
  private replay(p: Proc, hist: unknown[]): { op: FileOp } | { done: unknown } {
    const g: Step<unknown> = p.phase === "acquire" ? this.algo.attempt(this.self(p), LOCK) : this.algo.release(this.self(p), LOCK);
    let r = g.next();
    for (const x of hist) {
      if (r.done) throw new Error("replay ran past the end");
      r = g.next(x);
    }
    return r.done ? { done: r.value } : { op: r.value };
  }

  /** Start a new step for the process: its first operation, or the end of a step that does none. */
  private begin(s: State, p: Proc): void {
    p.hist = [];
    const r = this.replay(p, []);
    if ("op" in r) p.pending = r.op;
    else throw new Error("a step that does no file operation");
  }

  private procAlive(p: Proc): boolean {
    return LIVE.has(p.phase) || (p.phase === "done" && !this.start.doneIsDead);
  }

  /** The pids that are alive: the processes that run, and the start's always alive owners. */
  private livePids(s: State): number[] {
    return [...new Set([...s.procs.filter((p) => this.procAlive(p)).map((p) => p.pid), ...(this.start.alwaysAlive ?? [])])].sort();
  }

  private alive(s: State, pid: number): boolean {
    return this.livePids(s).includes(pid);
  }

  /** The owner of a token is alive: its process runs, or it is an always alive start owner. With pid reuse a live pid need not be the owner. */
  private ownerAlive(s: State, o: LockOwner): boolean {
    const p = s.procs.find((q) => q.token === o.token);
    if (p) return this.procAlive(p);
    return (this.start.alwaysAlive ?? []).includes(o.pid);
  }

  /** The world: the files, and which pids are alive. */
  private world(s: State): string {
    return JSON.stringify([[...s.fs.entries()].sort(), this.livePids(s)]);
  }

  /** Report a violation of one kind. The first stops the search, unless the checker collects every kind. */
  private fail(s: State, kind: string, why: string): void {
    const text = `${this.start.name}: ${why}; procs ${JSON.stringify(s.procs.map((p) => [p.name, p.phase]))}; files ${JSON.stringify([...s.fs.entries()])}`;
    if (!this.collect) throw new Violation(text);
    if (!this.found.has(kind)) this.found.set(kind, text);
  }

  /** Run one file operation on the state. Returns its result. Checks the unlink invariant. */
  private exec(s: State, p: Proc, op: FileOp): unknown {
    switch (op.kind) {
      case "create":
        if (s.fs.has(op.path)) return false;
        s.fs.set(op.path, op.content);
        return true;
      case "read":
        return s.fs.get(op.path) ?? null;
      case "unlink": {
        if (op.path === LOCK && s.fs.has(LOCK)) {
          const o = parseOwner(s.fs.get(LOCK)!);
          if (o === null) this.fail(s, "barred removed", `${p.name} unlinked a lock with no readable owner`);
          else if (o.host !== HOST) this.fail(s, "barred removed", `${p.name} unlinked a lock of another host`);
          // A live owner's lock is its own: it holds it, or is about to look at it. Our own pid is us.
          else if (o.token !== p.token && this.ownerAlive(s, o)) {
            const holder = s.procs.find((q) => q.token === o.token);
            this.fail(s, "live lock removed", `${p.name} unlinked the lock of ${holder?.name ?? `pid ${o.pid}`}, which is alive and holds it`);
          }
        }
        const t = rightToken(LOCK, op.path);
        if (t !== null && s.fs.has(op.path)) {
          // A right file of token T: only its own creator removes it while the lock carries T.
          const o = parseOwner(s.fs.get(op.path)!);
          if (parseOwner(s.fs.get(LOCK) ?? null)?.token === t && o?.token !== p.token) this.fail(s, "live right removed", `${p.name} unlinked ${op.path} while the lock carries its token`);
        } else if (op.path !== LOCK && s.fs.has(op.path)) {
          // A temporary file: only its owner removes it while that owner is alive.
          const o = parseOwner(s.fs.get(op.path)!);
          if (o !== null && o.token !== p.token && this.ownerAlive(s, o)) this.fail(s, "live file removed", `${p.name} unlinked ${op.path}, whose owner is alive`);
        }
        if (this.start.denyUnlink?.includes(op.path) && s.fs.has(op.path)) return { denied: "EPERM" };
        return s.fs.delete(op.path) ? "removed" : "absent";
      }
      case "list":
        return [...s.fs.keys()].filter((k) => k.startsWith(op.prefix)).sort();
      case "alive":
        return this.alive(s, op.pid);
      case "wait":
        return undefined;
    }
    // The old rule's own operations (OLD below).
    const x = op as unknown as { kind: string; from: string; to: string };
    if (x.kind === "rename") {
      if (!s.fs.has(x.from)) return false;
      s.fs.set(x.to, s.fs.get(x.from)!);
      s.fs.delete(x.from);
      return true;
    }
    if (x.kind === "link") {
      if (!s.fs.has(x.from) || s.fs.has(x.to)) return false;
      s.fs.set(x.to, s.fs.get(x.from)!);
      return true;
    }
    throw new Error(`unknown op ${x.kind}`);
  }

  /** The world changed: every other attempt that is under way saw something new. */
  private dirtyOthers(s: State, by: Proc | null): void {
    for (const q of s.procs) if (q !== by && q.attemptWorld !== null) q.dirty = true;
  }

  private clone(s: State): State {
    return { fs: new Map(s.fs), procs: s.procs.map((p) => ({ ...p })), crashed: s.crashed };
  }

  private enabled(s: State, world: string): number[] {
    const out: number[] = [];
    s.procs.forEach((p, i) => {
      if (p.phase === "unborn") {
        if (s.procs.find((q) => q.name === p.bornAfter)?.phase === "crashed") out.push(i);
        return;
      }
      if (p.phase === "inside") out.push(i);
      else if ((p.phase === "acquire" || p.phase === "release") && (p.blockedOn === null || p.blockedOn !== world)) out.push(i);
    });
    return out;
  }

  /** Advance process i by one scheduling point. */
  private step(s0: State, i: number, world: string): State {
    this.waited = false;
    const s = this.clone(s0);
    const p = s.procs[i];
    if (p.phase === "unborn") {
      p.phase = "acquire";
      this.begin(s, p);
      this.dirtyOthers(s, p); // its pid is alive now
      return s;
    }
    if (p.phase === "inside") {
      p.phase = "release";
      this.begin(s, p);
      return s;
    }
    const op = p.pending!;
    if (p.attemptWorld === null) {
      p.attemptWorld = world;
      p.dirty = false;
    }
    p.blockedOn = null;
    let r: { op: FileOp } | { done: unknown } = { op };
    // An alive query reads no file: it commutes with every file operation of the others, and a crash
    // between it and the next operation ends in the same state as a crash right after that operation.
    // So it runs in the same scheduling point as the operation before it.
    do {
      const result = this.exec(s, p, r.op);
      p.hist = [...p.hist, result];
      try {
        r = this.replay(p, p.hist);
      } catch (e) {
        if (e instanceof Violation) throw e;
        p.phase = "error";
        p.pending = null;
        return s;
      }
    } while ("op" in r && r.op.kind === "alive");
    // Only a change by another process makes an attempt dirty. A process's own creates and removes do not.
    if (this.world(s) !== world) this.dirtyOthers(s, p);
    if ("op" in r) {
      p.pending = r.op;
      return s;
    }
    if (p.phase === "release") {
      p.phase = "done";
      p.pending = null;
      p.hist = [];
      p.attemptWorld = null;
        return s;
    }
    // An attempt ended. The next attempt starts fresh: it carries nothing over (lock.ts attempt).
    const ended = r.done as Attempt;
    const startedIn = p.attemptWorld;
    p.attemptWorld = null;
    if (ended === "taken") {
      p.phase = "inside";
      p.entered = true;
      p.hist = [];
      p.pending = null;
      if (parseOwner(s.fs.get(LOCK) ?? null)?.token !== p.token) this.fail(s, "entered without the lock", `${p.name} entered while the lock does not carry its token`);
      const inside = s.procs.filter((q) => q.phase === "inside");
      if (inside.length > 1) this.fail(s, "two holders", `two holders: ${inside.map((q) => q.name).join(" and ")} are inside at once`);
      return s;
    }
    // wait: blocked until the world differs from the one the attempt started in, unless it changed during
    // the attempt (or by the attempt's own last operation), when trying again at once may see something new.
    if (ended === "wait") this.waited = true;
    if (ended === "wait" && !p.dirty && this.world(s) === startedIn) p.blockedOn = startedIn;
    this.begin(s, p);
    return s;
  }

  private terminal(s: State): void {
    this.terminals++;
    const live = s.procs.filter((p) => p.phase !== "crashed" && p.phase !== "unborn");
    if (this.start.expect === "finish") {
      const stuck = live.filter((p) => p.phase !== "done");
      if (stuck.length > 0) this.fail(s, "not finished", `terminal state with ${stuck.map((p) => `${p.name} (${p.phase})`).join(", ")} not finished`);
      if (!s.crashed && s.fs.size > 0) this.fail(s, "files left", `every process finished and files are left: ${[...s.fs.keys()].join(", ")}`);
      if (s.crashed && s.fs.has(LOCK)) {
        const o = parseOwner(s.fs.get(LOCK)!);
        if (o === null || this.ownerAlive(s, o)) this.fail(s, "live lock left", "a lock of a live owner is left");
      }
    } else {
      const inn = s.procs.filter((p) => p.entered);
      if (inn.length > 0) this.fail(s, "barred entered", `${inn.map((p) => p.name).join(", ")} got past a lock the tool must not remove`);
      if (s.fs.get(LOCK) !== this.original) this.fail(s, "barred changed", "the lock the tool must not remove was changed");
      if (live.some((p) => p.phase === "error")) this.fail(s, "error", "a process failed with an error");
      const others = [...s.fs.keys()].filter((k) => k !== LOCK);
      if (!s.crashed && others.length > 0) this.fail(s, "files left", `files are left beside the lock: ${others.join(", ")}`);
    }
  }

  /**
   * Depth first. waits counts the attempts on the current path that ended in a wait. A state met again on
   * the current path closes a cycle. A cycle with no wait in it is a spin: processes that run for ever
   * without one wait, so the deadline, which follows the clock, would be the only way out. The liveness
   * property is that there is none.
   */
  private visit(s0: State): void {
    // Iterative, so long paths through waits do not overflow the call stack.
    interface Frame { key: string; waits: number; next: (() => { s: State; waited: boolean })[] }
    const stack: Frame[] = [];
    const enter = (s: State, waits: number): void => {
      const world = this.world(s);
      const key = stateKey(s, world);
      const onPath = this.path.get(key);
      if (onPath !== undefined) {
        if (onPath === waits) this.fail(s, "spin", "a cycle with no wait: the processes run for ever without one wait");
        else this.cyclesWithWait++;
        return;
      }
      if (this.seen.has(key)) return;
      if (this.seen.size > this.maxStates) throw new Error(`more than ${this.maxStates} states`);
      this.seen.add(key);
      this.states++;
      this.path.set(key, waits);
      const en = this.enabled(s, world);
      if (en.length === 0) this.terminal(s);
      const next: Frame["next"] = en.map((i) => () => {
        const t = this.step(s, i, world);
        return { s: t, waited: this.waited };
      });
      if (this.allowCrash && s.crashed < (this.start.maxCrashes ?? 1)) {
        s.procs.forEach((p, i) => {
          if (p.phase !== "acquire" && p.phase !== "inside" && p.phase !== "release") return;
          next.push(() => {
            const c = this.clone(s);
            c.procs[i].phase = "crashed";
            c.procs[i].pending = null;
            c.crashed += 1;
            this.dirtyOthers(c, c.procs[i]);
            return { s: c, waited: false };
          });
        });
      }
      next.reverse();
      stack.push({ key, waits, next });
    };
    enter(s0, 0);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const n = top.next.pop();
      if (!n) {
        this.path.delete(top.key);
        stack.pop();
        continue;
      }
      const { s, waited } = n();
      enter(s, top.waits + (waited ? 1 : 0));
    }
  }

  run(): void {
    const procs: Proc[] = this.start.procs.map((d) => ({ ...d, hist: [], pending: null, blockedOn: null, attemptWorld: null, dirty: false, entered: d.phase === "inside" }));
    const s: State = { fs: new Map(Object.entries(this.start.files)), procs, crashed: 0 };
    for (const p of procs) if (p.phase === "acquire") this.begin(s, p);
    this.visit(s);
  }
}

/** Every kind of violation the checker finds for the algorithm, with the first trace of each. */
function violations(algo: Algo, start: Start, allowCrash = false): Map<string, string> {
  const c = new Checker(algo, start, allowCrash, true);
  c.run();
  return c.found;
}

function check(algo: Algo, start: Start, allowCrash: boolean, maxStates = MAX_STATES): { states: number; terminals: number; cyclesWithWait: number; violation: string | null } {
  const c = new Checker(algo, start, allowCrash, false, maxStates);
  try {
    c.run();
    return { states: c.states, terminals: c.terminals, cyclesWithWait: c.cyclesWithWait, violation: null };
  } catch (e) {
    if (!(e instanceof Violation)) throw e;
    return { states: c.states, terminals: c.terminals, cyclesWithWait: c.cyclesWithWait, violation: e.message };
  }
}

const DEAD = 20; // a pid that is gone
const DEAD_RECLAIMER = 21;
const STARTS: Start[] = [
  { name: "a dead holder's lock", files: { [LOCK]: owner(DEAD, "td") }, procs: waiters(3), expect: "finish" },
  { name: "no lock", files: {}, procs: waiters(3), expect: "finish" },
  { name: "a live holder that releases during the run", files: { [LOCK]: owner(10, "th") }, procs: [{ name: "holder", pid: 10, token: "th", phase: "inside" }, ...waiters(3)], expect: "finish" },
  { name: "a dead holder's lock with a dead reclaimer's right at level 1", files: { [LOCK]: owner(DEAD, "td"), [rightPath(LOCK, "td", 1)]: owner(DEAD_RECLAIMER, "tr") }, procs: waiters(3), expect: "finish" },
  { name: "our own pid with a token we do not hold (an earlier process had our pid)", files: { [LOCK]: owner(1, "old") }, procs: waiters(3), expect: "finish" },
  {
    name: "no lock, with leftovers of dead processes: a temporary file of the lock and a right file with its temporary file",
    files: { [`${LOCK}.${DEAD}.aa.tmp`]: owner(DEAD, "td"), [rightPath(LOCK, "tz", 1)]: owner(DEAD_RECLAIMER, "tr"), [`${rightPath(LOCK, "tz", 2)}.${DEAD_RECLAIMER}.bb.tmp`]: owner(DEAD_RECLAIMER, "tr") },
    procs: waiters(3),
    expect: "finish",
  },
  { name: "a lock with no readable owner", files: { [LOCK]: "not json" }, procs: waiters(3), expect: "barred" },
  { name: "a lock owned by another host", files: { [LOCK]: owner(DEAD, "tx", "elsewhere") }, procs: waiters(3), expect: "barred" },
  { name: "a dead holder's lock this user may not remove (EPERM): no right file is left, and nobody spins", files: { [LOCK]: owner(DEAD, "td") }, denyUnlink: [LOCK], procs: waiters(3), expect: "barred" },
  { name: "a live owner that never releases", files: { [LOCK]: owner(11, "tf") }, procs: waiters(3), alwaysAlive: [11], expect: "barred" },
];

// Wrong rules. Each is the lock with one rule broken. The checker must find a violation for each.

function* op<R>(o: FileOp | { kind: "rename" | "link"; from: string; to: string }): Step<R> {
  return (yield o as FileOp) as R;
}

/**
 * The OLD reclaim, a faithful port of ledger.ts at 33f3b9f (reclaimIfDead): read the owner, judge it, rename
 * whatever is at the path aside, judge what was moved, unlink it, or link it back and throw "contested".
 * Its lock is old here (the 30 s window has passed), as in the auditor's reproduction. A lock with no
 * readable owner was reclaimable. No own pid rule. No sweep.
 */
const OLD: Algo = {
  *attempt(self, lock) {
    const oldDead = function* (o: LockOwner | null): Step<boolean> {
      if (o === null) return true;
      if (o.host !== self.host) return false;
      return !(yield* op<boolean>({ kind: "alive", pid: o.pid }));
    };
    if (yield* op<boolean>({ kind: "create", path: lock, content: ownerText(self) })) return "taken";
    const text = yield* op<string | null>({ kind: "read", path: lock });
    if (text === null) return "again"; // statSync failed: the holder removed it
    if (yield* oldDead(parseOwner(text))) {
      const aside = `${lock}.stale.${self.pid}`;
      if (yield* op<boolean>({ kind: "rename", from: lock, to: aside })) {
        if (yield* oldDead(parseOwner(yield* op<string | null>({ kind: "read", path: aside })))) {
          yield* op<boolean>({ kind: "unlink", path: aside });
          return "again";
        }
        if (!(yield* op<boolean>({ kind: "link", from: aside, to: lock }))) throw new Error(`ledger lock contested: ${lock}`);
        yield* op<boolean>({ kind: "unlink", path: aside });
      }
    }
    return "wait";
  },
  release,
};

/** The right rules with one change to reclaim. */
function withReclaim(reclaim: (self: Self, lock: string, token: string) => Step<boolean>): Algo {
  return {
    *attempt(self, lock) {
      if (yield* op<boolean>({ kind: "create", path: lock, content: ownerText(self) })) {
        yield* sweep(self, lock);
        return "taken";
      }
      const o = parseOwner(yield* op<string | null>({ kind: "read", path: lock }));
      if (o !== null && (yield* provablyDead(self, o)) && (yield* reclaim(self, lock, o.token))) return "again";
      return "wait";
    },
    release,
  };
}

/** Wrong: under the right, unlink the lock with no re-read (finding 11 item (1): the re-check made always true). */
const NO_REREAD = withReclaim(function* (self, lock, token) {
  for (let n = 1; ; n++) {
    const right = rightPath(lock, token, n);
    if (yield* op<boolean>({ kind: "create", path: right, content: ownerText(self) })) {
      const removed = (yield* op<Unlinked>({ kind: "unlink", path: lock })) === "removed";
      yield* op<Unlinked>({ kind: "unlink", path: right });
      return removed;
    }
    const r = parseOwner(yield* op<string | null>({ kind: "read", path: right }));
    if (r === null || !(yield* provablyDead(self, r))) return false;
  }
});

/** Wrong: remove the right file before the lock. */
const RIGHT_FIRST = withReclaim(function* (self, lock, token) {
  for (let n = 1; ; n++) {
    const right = rightPath(lock, token, n);
    if (yield* op<boolean>({ kind: "create", path: right, content: ownerText(self) })) {
      const same = parseOwner(yield* op<string | null>({ kind: "read", path: lock }))?.token === token;
      yield* op<Unlinked>({ kind: "unlink", path: right });
      return same && (yield* op<Unlinked>({ kind: "unlink", path: lock })) === "removed";
    }
    const r = parseOwner(yield* op<string | null>({ kind: "read", path: right }));
    if (r === null || !(yield* provablyDead(self, r))) return false;
  }
});

/** Wrong: no level chain. A right file that exists means no right, whoever owns it. */
const NO_LEVELS = withReclaim(function* (self, lock, token) {
  const right = rightPath(lock, token, 1);
  if (!(yield* op<boolean>({ kind: "create", path: right, content: ownerText(self) }))) return false;
  let removed = false;
  if (parseOwner(yield* op<string | null>({ kind: "read", path: lock }))?.token === token) removed = (yield* op<Unlinked>({ kind: "unlink", path: lock })) === "removed";
  yield* op<Unlinked>({ kind: "unlink", path: right });
  return removed;
});

/**
 * Wrong: the sweep run by a waiter before it holds the lock, with the waiter's own token. It removes a right
 * of the token the lock still carries, so two waiters can each hold a right of it.
 */
const SWEEP_BEFORE_TAKE: Algo = {
  *attempt(self, lock) {
    yield* sweep(self, lock);
    return yield* attempt(self, lock);
  },
  release,
};

/** Wrong (review M21): "again" after any reclaim try, whether or not this process removed the lock. */
const AGAIN_AFTER_ANY_TRY: Algo = {
  *attempt(self, lock) {
    if (yield* op<boolean>({ kind: "create", path: lock, content: ownerText(self) })) {
      yield* sweep(self, lock);
      return "taken";
    }
    const o = parseOwner(yield* op<string | null>({ kind: "read", path: lock }));
    if (o !== null && (yield* provablyDead(self, o))) {
      yield* reclaim(self, lock, o.token);
      return "again";
    }
    return "wait";
  },
  release,
};

/**
 * Wrong (review M28 with the rule before the fix): a lock that cannot be read is read as absent, and an
 * absent lock means "again". A lock that exists for create and reads as absent then spins.
 */
const UNREADABLE_AS_ABSENT: Algo = {
  *attempt(self, lock) {
    if (yield* op<boolean>({ kind: "create", path: lock, content: ownerText(self) })) {
      yield* sweep(self, lock);
      return "taken";
    }
    const text = yield* op<string | null>({ kind: "read", path: lock });
    const o = parseOwner(text);
    if (text === null || o === null) return "again";
    if ((yield* provablyDead(self, o)) && (yield* reclaim(self, lock, o.token))) return "again";
    return "wait";
  },
  release,
};

/**
 * The review's extensions: pid reuse (a process born after another crashed, with its pid), finished
 * processes counted as exited, two crashes, four waiters. The light ones run in every suite run. The heavy
 * ones run when any STRESS_ size is set, the same switch as the long stress blocks.
 */
const FULL = ["STRESS_PROCS", "STRESS_OPS", "STRESS_ROUNDS"].some((k) => process.env[k] !== undefined);
const W = waiters;
const reuse = (pid: number, after: string, name: string) => ({ name, pid, token: name, phase: "unborn" as const, bornAfter: after });
const EXT: (Start & { heavy?: boolean; maxStates?: number })[] = [
  { name: "pid reuse: w3 takes w1's pid after w1 crashed, at a dead holder's lock", files: { [LOCK]: owner(DEAD, "td") }, procs: [...W(2), reuse(1, "w1", "w3")], expect: "finish" },
  { name: "pid reuse with finished processes exited: w3 takes w1's pid after w1 crashed, at a dead holder's lock", files: { [LOCK]: owner(DEAD, "td") }, procs: [...W(2), reuse(1, "w1", "w3")], expect: "finish", doneIsDead: true },
  { name: "pid reuse: w4 takes w1's pid after w1 crashed, at a dead holder's lock, 3 waiters", files: { [LOCK]: owner(DEAD, "td") }, procs: [...W(3), reuse(1, "w1", "w4")], expect: "finish", heavy: true },
  { name: "pid reuse with finished processes exited: w4 takes w1's pid, at a dead holder's lock, 3 waiters", files: { [LOCK]: owner(DEAD, "td") }, procs: [...W(3), reuse(1, "w1", "w4")], expect: "finish", doneIsDead: true, heavy: true },
  { name: "pid reuse: w3 takes w1's pid after w1 crashed, no lock, two crashes, finished processes exited", files: {}, procs: [...W(2), reuse(1, "w1", "w3")], expect: "finish", maxCrashes: 2, doneIsDead: true },
  { name: "no lock, 3 waiters, two crashes", files: {}, procs: W(3), expect: "finish", maxCrashes: 2 },
  { name: "a dead holder's lock, 3 waiters, two crashes", files: { [LOCK]: owner(DEAD, "td") }, procs: W(3), expect: "finish", maxCrashes: 2, heavy: true },
  { name: "a dead holder's lock, 3 waiters, two crashes, finished processes exited", files: { [LOCK]: owner(DEAD, "td") }, procs: W(3), expect: "finish", maxCrashes: 2, doneIsDead: true, heavy: true },
  { name: "a dead holder's lock with a dead reclaimer's right, 3 waiters, two crashes", files: { [LOCK]: owner(DEAD, "td"), [rightPath(LOCK, "td", 1)]: owner(DEAD_RECLAIMER, "tr") }, procs: W(3), expect: "finish", maxCrashes: 2, heavy: true },
  { name: "our own pid with a token we do not hold, 3 waiters, two crashes", files: { [LOCK]: owner(1, "old") }, procs: W(3), expect: "finish", maxCrashes: 2, heavy: true },
  { name: "a live holder that releases, 3 waiters, two crashes", files: { [LOCK]: owner(10, "th") }, procs: [{ name: "holder", pid: 10, token: "th", phase: "inside" }, ...W(3)], expect: "finish", maxCrashes: 2, heavy: true },
  { name: "a dead holder's lock, 4 waiters, no crash", files: { [LOCK]: owner(DEAD, "td") }, procs: W(4), expect: "finish", maxCrashes: 0, heavy: true },
  { name: "no lock, 4 waiters, one crash", files: {}, procs: W(4), expect: "finish", heavy: true },
  { name: "a dead holder's lock, 4 waiters, one crash", files: { [LOCK]: owner(DEAD, "td") }, procs: W(4), expect: "finish", heavy: true, maxStates: 12_000_000 },
];

/** Wrong: our own pid is never dead, whatever the token. A process that took a crashed one's pid then waits for its own pid for ever. */
const OWN_PID_NEVER_DEAD: Algo = {
  attempt: (self, lock) => attempt({ ...self, held: { has: () => true } as unknown as ReadonlySet<string> }, lock),
  release,
};

describe("ledger lock model check, the review's extensions", () => {
  // The heavy runs are registered only when the switch is set: no test is skipped.
  for (const start of EXT.filter((x) => FULL || !x.heavy)) {
    it(`${start.name}`, () => {
      const t0 = Date.now();
      const r = check(RIGHT, start, true, start.maxStates);
      console.log(`lock model ext: ${start.name}: ${r.states} states (${r.terminals} terminal, ${r.cyclesWithWait} cycles through a wait, none without), ${Date.now() - t0} ms`);
      expect(r.violation).toBeNull();
      expect(r.terminals).toBeGreaterThan(0);
    }, 3_600_000);
  }

  it("control: the pid reuse start catches the unlink with no re-read under the right", () => {
    expect(check(NO_REREAD, EXT[0], true).violation).not.toBeNull();
  });

  it("control: the pid reuse start catches an own pid rule that never judges our own pid dead", () => {
    expect(check(OWN_PID_NEVER_DEAD, EXT[1], true).violation).toMatch(/terminal state with .*w3 \(acquire\).* not finished/);
  });
});

describe("ledger lock model check (src/lock.ts)", () => {
  for (const start of STARTS) {
    it(`${start.name}: every interleaving of ${start.procs.length} processes, with and without one crash`, () => {
      const plain = check(RIGHT, start, false);
      expect(plain.violation).toBeNull();
      const crash = check(RIGHT, start, true);
      expect(crash.violation).toBeNull();
      // The search is real: it reached terminal states, and the crash runs are a superset of the plain ones.
      expect(plain.terminals).toBeGreaterThan(0);
      expect(crash.states).toBeGreaterThan(plain.states);
      console.log(`lock model: ${start.name}: ${plain.states} states without a crash, ${crash.states} with one crash (${crash.terminals} terminal, ${crash.cyclesWithWait} cycles through a wait, none without)`);
    }, 300_000); // alone it takes seconds; beside the other test files on two cores it can take far longer
  }

  it("the old reclaim (read, rename aside, check, link back) lets two holders in at a dead holder's lock", () => {
    const found = violations(OLD, STARTS[0]);
    console.log(`lock model: old reclaim: ${[...found.values()].join("\n  ")}`);
    expect(found.get("two holders")).toMatch(/two holders: w\d and w\d are inside at once/);
    // And finding 1 (b): a waiter links a released lock back, and the seat is locked behind it.
    expect(found.get("not finished")).toBeDefined();
  });

  it("unlinking under the right with no re-read (the re-check made always true) unlinks a live holder's lock and lets two holders in", () => {
    const found = violations(NO_REREAD, STARTS[0]);
    expect(found.get("live lock removed")).toMatch(/unlinked the lock of w\d, which is alive and holds it/);
    expect(found.get("two holders")).toBeDefined();
  });

  it("removing the right file before the lock unlinks a live holder's lock and lets two holders in", () => {
    const found = violations(RIGHT_FIRST, STARTS[0]);
    expect(found.get("live lock removed")).toMatch(/unlinked the lock of w\d, which is alive and holds it/);
    expect(found.get("two holders")).toBeDefined();
  });

  it("the sweep run before the lock is taken removes a right of the token the lock carries", () => {
    const found = violations(SWEEP_BEFORE_TAKE, STARTS[0]);
    expect(found.get("live right removed")).toMatch(/unlinked \S+reclaim\.td\.1 while the lock carries its token/);
  });

  it("liveness: answering again after any reclaim try (review M21) spins at a dead holder's lock", () => {
    const found = violations(AGAIN_AFTER_ANY_TRY, STARTS[0]);
    expect(found.get("spin")).toMatch(/a cycle with no wait/);
  });

  it("liveness: a lock that cannot be read taken as absent, with again for absent (review M28), spins", () => {
    const unreadable = STARTS.find((x) => x.name === "a lock with no readable owner")!;
    const found = violations(UNREADABLE_AS_ABSENT, unreadable);
    expect(found.get("spin")).toMatch(/a cycle with no wait/);
  });

  it("a right file that blocks whoever owns it locks the seat out once a reclaimer died holding it", () => {
    const found = violations(NO_LEVELS, STARTS[3]);
    expect(found.get("not finished")).toBeDefined();
  });
});
