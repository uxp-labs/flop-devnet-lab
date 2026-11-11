/**
 * Independent review of the lock reclaim (src/lock.ts at 34f922e). Each DEFECT test asserts today's
 * wrong behavior: it passes now and fails once the defect is fixed.
 */
import { spawnSync } from "node:child_process";
import { chownSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withLedgerLock } from "../src/ledger.js";
import { acquire, runOnDisk, type FileOp, type Self, type Step } from "../src/lock.js";
import { LEDGER_BUSY } from "../src/receipt-store.js";
import { DISAGREE } from "../src/settlement.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";

// A pass through of lock.ts. Only when loseLockAt is set does assertLockHeld first remove the lock by
// hand (the one way, inside the stated rules, to reach "ledger lock lost"), then run the real check.
const hook = vi.hoisted(() => ({ loseLock: false }));
vi.mock("../src/lock.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lock.js")>();
  const fs = await import("node:fs");
  return {
    ...real,
    assertLockHeld(key: string) {
      if (hook.loseLock) { hook.loseLock = false; fs.unlinkSync(`${key}.lock`); }
      return real.assertLockHeld(key);
    },
  };
});

const SEAT = "9001";
const root = join(import.meta.dirname, "..");
const lockPath = (h: string) => join(h, "ledger.jsonl.lock");
const lockFiles = (h: string) => readdirSync(h).filter((f) => f.startsWith("ledger.jsonl.lock")).sort();
const owner = (pid: number, token: string, host = hostname()) => JSON.stringify({ pid, host, token });
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
const self = (pid: number, token: string): Self => ({ pid, host: hostname(), token, held: new Set([token]) });

/** Drive a step, but stop it after limit operations, or at its first wait. */
function* bounded(step: Step<unknown>, limit: number, seen: { ops: number }): Step<"taken" | "waited" | "spun"> {
  let r = step.next();
  while (!r.done) {
    if (r.value.kind === "wait") return "waited";
    if (++seen.ops > limit) return "spun";
    const x: unknown = yield r.value as FileOp;
    r = step.next(x);
  }
  return "taken";
}

/** A script that takes the ledger lock of home once through dist/ledger.js and prints how it ended. */
function lockScript(dir: string, home: string): string {
  const script = join(dir, "take-lock.mjs");
  writeFileSync(script, `
const { withLedgerLock } = await import(${JSON.stringify(join(root, "dist", "ledger.js"))});
const t0 = Date.now();
try { withLedgerLock(${JSON.stringify(home)}, () => {}); process.stdout.write("TAKEN " + (Date.now() - t0)); }
catch (e) { process.stdout.write((e.constructor?.name ?? "Error") + " " + (Date.now() - t0) + " " + e.message); }
`);
  return script;
}

/** A script that runs `run` once through dist/cli.js with a mock provider and prints its exit code, calls and stderr. */
function runScript(dir: string, home: string): string {
  const script = join(dir, "run-once.mjs");
  writeFileSync(script, `
const { main } = await import(${JSON.stringify(join(root, "dist", "cli.js"))});
let calls = 0;
const err = [];
const provider = {
  name: "mock",
  async estimate() { return { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }; },
  async complete(req) { calls++; return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; },
  async readReceipt(id) { return { http: 200, error: null, receipt: { request_id: id, correlation_id: "c", state: "estimated", settled_spend: null, reserved_spend: 0.186, model: "m" } }; },
};
const code = await main(["run", "--seat", ${JSON.stringify(SEAT)}, "--job", "j1", "--prompt", "hi", "--max-tokens", "8", "--provider", "mock"], {
  out() {}, err(s) { err.push(s); }, env: { IMD_FLOP_HOME: ${JSON.stringify(home)} }, provider,
});
process.stdout.write(JSON.stringify({ code, calls, err: err.join("\\n") }));
`);
  return script;
}

describe("review defect 1, fixed: a lock that exists for link but reads as absent", () => {
  // Was: createFile's link said EEXIST, readText said ENOENT (null), attempt returned "again", and acquire
  // tried again at once, never yielding wait, so the 5 s timeout (checked only at a wait) never fired. A
  // dangling symlink at ledger.jsonl.lock was enough.
  // Decided: only ENOENT means absent; a path that is not a regular file is a lock with no readable owner;
  // "again" only right after this process removed the lock itself; the deadline is checked on every attempt.
  it("review defect 1, fixed: a dangling symlink at the lock path is waited on, and the 5 s timeout names it", () => {
    const h = tmpHome();
    symlinkSync(join(h, "no-such-target"), lockPath(h));
    // In process: the first attempt ends in a wait.
    const seen = { ops: 0 };
    expect(runOnDisk(bounded(acquire(self(process.pid, "t-spin"), lockPath(h)), 20_000, seen), () => {})).toBe("waited");
    expect(seen.ops).toBeLessThan(10);
    // A real process: the timeout fires after about 5 s, with the lock named and what it is.
    const r = spawnSync(process.execPath, [lockScript(h, h)], { timeout: 15_000, encoding: "utf8" });
    expect(r.signal).toBeNull();
    const m = r.stdout.match(/^LedgerLockError (\d+) (.*)$/s);
    expect(m, r.stdout).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(5_000);
    expect(Number(m![1])).toBeLessThan(10_000);
    expect(m![2]).toMatch(/^ledger lock timeout: \S+ledger\.jsonl\.lock \(\d+ s old\) has no readable owner: it is a symbolic link\. If no imd-flop process is using this home any more, remove that file and run again\.$/);
    expect(lockFiles(h)).toEqual(["ledger.jsonl.lock"]);
  }, 60_000);
});

describe("review defect 2, fixed: a dead holder's lock that this process may not unlink", () => {
  // The home is a sticky directory (mode 1777) of another OS user, and the dead holder's lock is that
  // user's file: a waiter may create files there but not unlink the lock. Was: the EPERM at the reclaim
  // unlink was rethrown raw (exit 1, no lock message), and each try left one more right file.
  // Decided: the waiter removes its own right file, gets no "again", and waits. The timeout says this user
  // cannot remove the lock, names the file and its owner, and gives the way back.
  it("review defect 2, fixed: run exits 10 with the lock message, and no right file is left", async () => {
    const h = tmpHome();
    const home = join(h, "home");
    mkdirSync(home);
    await readySeat(home, SEAT, "1");
    const lock = lockPath(home);
    const dead = deadPid();
    writeFileSync(lock, owner(dead, "dead"));
    // Another user's file in another user's sticky directory (a temporary directory of this test).
    chownSync(lock, 65534, 65534);
    chownSync(home, 65534, 65534);
    chmodSync(home, 0o1777);
    const script = runScript(h, home);
    // Root without CAP_FOWNER and without the DAC overrides: an ordinary user for the sticky bit.
    const drop = "-fowner,-dac_override,-dac_read_search";
    const once = () => {
      const r = spawnSync("setpriv", [`--bounding-set=${drop}`, `--inh-caps=${drop}`, process.execPath, script], { encoding: "utf8", timeout: 60_000 });
      return JSON.parse(r.stdout) as { code: number; calls: number; err: string };
    };
    const want = new RegExp(`^imd-flop: refused locally, nothing sent: ledger lock timeout: \\S+ledger\\.jsonl\\.lock \\(\\d+ s old\\) was held by pid ${dead} on host ${hostname().replace(/\./g, "\\.")}, which is gone, and this user cannot remove that file \\(EPERM; it belongs to uid 65534\\)\\. If no imd-flop process is using this home any more, remove that file and run again\\.$`);
    for (let i = 0; i < 2; i++) {
      const r = once();
      expect({ code: r.code, calls: r.calls }, r.err).toEqual({ code: 10, calls: 0 });
      expect(r.err).toMatch(want);
      expect(lockFiles(home)).toEqual(["ledger.jsonl.lock"]);
    }
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("dead");
  }, 120_000);
});

describe("review defect 3, fixed: a write error while creating the lock leaves no temporary file", () => {
  // Was: createFile opened the temporary file and wrote the owner; when the write failed (EFBIG here, the
  // same path for ENOSPC or EDQUOT) the catch rethrew without removing it, so an empty .tmp stayed for ever.
  // Decided: createFile removes its temporary file on any failure before it rethrows.
  it("review defect 3, fixed: a live process whose write fails leaves no file of the lock behind", () => {
    const h = tmpHome();
    const script = lockScript(h, h);
    // A file size limit of 0: every write to a regular file fails with EFBIG (node ignores SIGXFSZ).
    const r = spawnSync("bash", ["-c", 'ulimit -f 0 && exec "$0" "$1"', process.execPath, script], { encoding: "utf8", timeout: 60_000 });
    expect(r.stdout).toMatch(/^Error \d+ EFBIG: file too large, write$/);
    expect(lockFiles(h)).toEqual([]);
  }, 60_000);
});

describe("DEFECT 4: a right file held by a live unrelated process", () => {
  // The lock's owner is dead, but the level 1 right file names a live pid (a reclaimer that died and
  // whose pid was reused). By rule the waiter has no right and waits. The timeout then says the lock "is
  // held by pid <the dead owner>": it blames a process that is gone and does not name the file that is
  // really in the way. The way back (remove the lock) works, but the right file stays after it, through
  // every sweep, for as long as the unrelated process lives.
  it("DEFECT 4 (info): the timeout names a dead pid as the holder and not the right file in the way, and that right file is never swept", () => {
    const h = tmpHome();
    const dead = deadPid();
    writeFileSync(lockPath(h), owner(dead, "T"));
    writeFileSync(`${lockPath(h)}.reclaim.T.1`, owner(process.ppid, "reused"));
    let msg = "";
    try { withLedgerLock(h, () => {}); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(new RegExp(`^ledger lock timeout: \\S+ \\(\\d+ s old\\) is held by pid ${dead} on host `));
    expect(msg).not.toContain("reclaim");
    unlinkSync(lockPath(h));
    withLedgerLock(h, () => {});
    expect(existsSync(`${lockPath(h)}.reclaim.T.1`)).toBe(true);
    expect(lockFiles(h)).toEqual(["ledger.jsonl.lock.reclaim.T.1"]);
  }, 30_000);
});

describe("DEFECT 5: receipt --refresh calls a lost lock a busy ledger", () => {
  // receipt-store.ts refreshReceipt prints LEDGER_BUSY for every LedgerLockError. "ledger lock lost" is a
  // LedgerLockError too, so an append that found the lock no longer ours prints "ledger busy". README
  // (Lock-timeout rule) and the refreshReceipt comment say the busy line is for a lock that could not be
  // taken, and that any other failure, "a failed append for one", prints DISAGREE. The lock was taken
  // here; the append failed. The new error reached a branch whose words do not cover it.
  it("DEFECT 5 (low): an append that finds the lock lost during a refresh prints the busy line, not DISAGREE", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT, "1");
    const quote = { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 };
    const receipt = (id: string, fields: Record<string, unknown>) => ({ http: 200, error: null, receipt: { request_id: id, correlation_id: "imd-job-j1", model: "m", reserved_spend: 0.186, settled_spend: null, state: "estimated", ...fields } });
    const provider = (fields: Record<string, unknown>) => ({
      name: "mock" as const,
      async estimate() { return quote as never; },
      async complete(req: { requestId: string }) { return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as never; },
      async readReceipt(id: string) { return receipt(id, fields) as never; },
    }) as never;
    const run = await cli(h, ["run", "--seat", SEAT, "--job", "j1", "--prompt", "hi", "--provider", "mock", "--max-tokens", "8", "--json"], { provider: provider({}) });
    expect(run.code, run.err).toBe(0);
    const rid = run.json().request_id as string;
    const before = readLines(join(h, "ledger.jsonl")).length;
    hook.loseLock = true;
    const r = await cli(h, ["receipt", rid, "--refresh", "--json", "--seat", SEAT], { provider: provider({ state: "settled", settled_spend: 0.05 }) });
    expect(hook.loseLock).toBe(false); // the append ran its check, and the lock was gone
    expect(readLines(join(h, "ledger.jsonl"))).toHaveLength(before); // nothing appended
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/^ledger busy; the receipt read was stored and nothing was booked \(ledger lock lost: \S+ledger\.jsonl\.lock no longer carries this process's token, so nothing was appended\)$/);
    expect(r.err.startsWith(LEDGER_BUSY)).toBe(true);
    expect(r.err).not.toContain(DISAGREE);
  }, 30_000);
});

describe("DEFECT 6: two copies of lock.ts in one thread", () => {
  // The own pid rule trusts that `held` lists every token this process holds. `held` is module state, so
  // it lists only the tokens of one copy of lock.ts. Two copies in one process (here src/lock.ts through
  // vitest and dist/lock.js, the same as a package loaded from two paths) each see the other's live lock
  // as "our own pid, a token we do not hold": provably dead. The second copy reclaims the first copy's
  // live lock and enters while the first is still inside. No worker thread is involved, so the planned
  // "main thread only" rule does not cover it.
  it("DEFECT 6 (low): a second copy of lock.ts in the same thread reclaims the first copy's live lock, and both are inside at once", async () => {
    const h = tmpHome();
    const dist = (await import(join(root, "dist", "ledger.js"))) as typeof import("../src/ledger.js");
    const inside: string[] = [];
    withLedgerLock(h, () => {
      inside.push("src");
      const mine = readFileSync(lockPath(h), "utf8");
      dist.withLedgerLock(h, () => {
        inside.push(`dist while src holds the lock: ${inside.includes("src")}`);
        // dist's lock replaced src's: the first holder's lock is gone while it is still inside.
        expect(readFileSync(lockPath(h), "utf8")).not.toBe(mine);
      });
    });
    expect(inside).toEqual(["src", "dist while src holds the lock: true"]);
  });
});
