/**
 * The ledger lock on the real file system (src/lock.ts), audit 33f3b9f findings 1, 7 and 11 item (1).
 * test/lock-model.test.ts checks every interleaving over an in memory file system. Here:
 *  - the re-check under the reclaim right, in the one order that needs it (finding 11 item (1));
 *  - the own pid rule, the timeout message and the append re-check;
 *  - stress with real processes: many processes meet a dead holder's lock at the same moment, and two or
 *    more `run` processes meet it with a cap that has room for exactly one call. Size: STRESS_PROCS
 *    processes x STRESS_OPS entries x STRESS_ROUNDS rounds (defaults 6 x 20 x 2).
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendLedger, LedgerLockError, LedgerLockLost, withLedgerLock, type LedgerEntry } from "../src/ledger.js";
import { provablyDead, reclaim, rightPath, runOnDisk, sweep, timeoutMessage, type Self, type Step } from "../src/lock.js";
import { cli, readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9001";
const root = join(import.meta.dirname, "..");
const ledgerPath = (h: string) => join(h, "ledger.jsonl");
const lockPath = (h: string) => `${ledgerPath(h)}.lock`;
const lockFiles = (h: string) => readdirSync(h).filter((f) => f.startsWith("ledger.jsonl.lock")).sort();
const owner = (pid: number, token: string, host = hostname()) => JSON.stringify({ pid, host, token });
/** The pid of a process that has exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;
const WAY_BACK = "If no imd-flop process is using this home any more, remove that file and run again.";
const noWait = () => { throw new Error("waited"); };
const self = (pid: number, token: string, held: string[] = [token]): Self => ({ pid, host: hostname(), token, held: new Set(held) });

describe("finding 11 item (1): the re-check under the reclaim right", () => {
  // Waiters B and C both read a dead holder's lock (token T) and judge it dead. B reclaims it, and A takes
  // the lock and is inside. Only then does C get the right for T: B removed its right file, so level 1 is
  // free. Under the right, C reads the lock again: it carries A's token, not T, so C must unlink nothing.
  // With the re-check made always true, C unlinks A's live lock, and a fourth waiter would get in beside A.
  it("a reclaimer that gets the right after the dead lock is gone leaves the new holder's lock in place", () => {
    const h = tmpHome();
    const lock = lockPath(h);
    const pid = deadPid();
    writeFileSync(lock, owner(pid, "T"));
    const b = self(4_000_001, "b");
    const c = self(4_000_002, "c");
    // B: the right for T, the lock unlinked, the right removed.
    expect(runOnDisk(reclaim(b, lock, "T"), noWait)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    // A takes the lock.
    withLedgerLock(h, () => {
      const held = readFileSync(lock, "utf8");
      expect(JSON.parse(held).pid).toBe(process.pid);
      // C, which judged T dead before B acted, now gets the right for T. It removes nothing, so it does not
      // answer "again".
      expect(runOnDisk(reclaim(c, lock, "T"), noWait)).toBe(false);
      expect(existsSync(lock) && readFileSync(lock, "utf8")).toBe(held);
      expect(lockFiles(h)).toEqual(["ledger.jsonl.lock"]);
    });
    expect(lockFiles(h)).toEqual([]);
  });

  it("a right whose owner is alive means no right: the waiter unlinks nothing and goes back to waiting", () => {
    const h = tmpHome();
    const lock = lockPath(h);
    writeFileSync(lock, owner(deadPid(), "T"));
    writeFileSync(rightPath(lock, "T", 1), owner(process.ppid, "busy"));
    expect(runOnDisk(reclaim(self(4_000_003, "c"), lock, "T"), noWait)).toBe(false);
    expect(lockFiles(h)).toEqual(["ledger.jsonl.lock", "ledger.jsonl.lock.reclaim.T.1"]);
  });

  it("a right whose owner is dead passes to the next level, and the holder sweeps the dead one", () => {
    const h = tmpHome();
    const lock = lockPath(h);
    writeFileSync(lock, owner(deadPid(), "T"));
    writeFileSync(rightPath(lock, "T", 1), owner(deadPid(), "r1"));
    writeFileSync(rightPath(lock, "T", 2), owner(deadPid(), "r2"));
    writeFileSync(`${lock}.${deadPid()}.ab.tmp`, owner(deadPid(), "t1"));
    const t0 = Date.now();
    withLedgerLock(h, () => expect(lockFiles(h)).toEqual(["ledger.jsonl.lock"]));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(lockFiles(h)).toEqual([]);
  });
});

describe("L6: the sweep under the lock", () => {
  // Moved (review of the lock reclaim, defect 4): right files of a live process, with no readable owner, or of
  // another host were kept. The sweep now removes every right file whose token is not the current lock's,
  // whoever holds it (the lock.ts header says why that is safe). Temporary files are judged by their owner.
  it("removes every right file of another token, temporary files of dead processes, and leaves live temporary files, other names and the lock", () => {
    const h = tmpHome();
    const lock = lockPath(h);
    const dead = deadPid();
    const files: Record<string, string> = {
      [rightPath(lock, "old", 1)]: owner(dead, "r"),
      [`${lock}.${dead}.aa.tmp`]: owner(dead, "t"),
      [`${rightPath(lock, "old", 2)}.${dead}.bb.tmp`]: owner(dead, "t2"),
      [rightPath(lock, "busy", 1)]: owner(process.ppid, "live-right"),
      [`${lock}.${process.ppid}.cc.tmp`]: owner(process.ppid, "live-tmp"),
      [`${lock}.${dead}.dd.tmp`]: "",
      [rightPath(lock, "odd", 1)]: "not json",
      [rightPath(lock, "far", 1)]: owner(dead, "far", "some-other-host"),
      [`${lock}.stale.123.ab`]: owner(dead, "stale"),
    };
    for (const [path, body] of Object.entries(files)) writeFileSync(path, body);
    const kept = [`ledger.jsonl.lock.${process.ppid}.cc.tmp`, `ledger.jsonl.lock.${dead}.dd.tmp`, "ledger.jsonl.lock.stale.123.ab"].sort();
    withLedgerLock(h, () => expect(lockFiles(h)).toEqual(["ledger.jsonl.lock", ...kept].sort()));
    expect(lockFiles(h)).toEqual(kept);
  });

  it("keeps a right file of the holder's own token", () => {
    const h = tmpHome();
    const lock = lockPath(h);
    writeFileSync(rightPath(lock, "mine", 1), owner(deadPid(), "x"));
    writeFileSync(rightPath(lock, "other", 1), owner(deadPid(), "y"));
    runOnDisk(sweep(self(process.pid, "mine"), lock), noWait);
    expect(lockFiles(h)).toEqual(["ledger.jsonl.lock.reclaim.mine.1"]);
  });
});

describe("defect 1: only ENOENT means the lock is absent", () => {
  // Runs under the suite's dropped capabilities (no DAC override), so mode 000 cannot be read, even by root.
  it("a lock that cannot be read (mode 000) is a lock with no readable owner: never removed, waited on, named in the timeout", () => {
    const h = tmpHome();
    writeFileSync(lockPath(h), owner(deadPid(), "dead"));
    chmodSync(lockPath(h), 0o000);
    try {
      let unreadable = true;
      try { readFileSync(lockPath(h)); unreadable = false; } catch { /* EACCES, as wanted */ }
      expect(unreadable, "run the suite without the DAC override capabilities (setpriv)").toBe(true);
      const t0 = Date.now();
      expect(() => withLedgerLock(h, () => 1)).toThrow(/^ledger lock timeout: \S+ledger\.jsonl\.lock \(\d+ s old\) has no readable owner: it cannot be read \(EACCES\)\. If no imd-flop process is using this home any more, remove that file and run again\.$/);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(5_000);
      expect(lockFiles(h)).toEqual(["ledger.jsonl.lock"]);
    } finally {
      chmodSync(lockPath(h), 0o644);
    }
  }, 20_000);

  it("a directory at the lock path is waited on and named", () => {
    const h = tmpHome();
    mkdirSync(lockPath(h));
    expect(() => withLedgerLock(h, () => 1)).toThrow(/has no readable owner: it is a directory\. If no imd-flop/);
    expect(lockFiles(h)).toEqual(["ledger.jsonl.lock"]);
  }, 20_000);
});

describe("defect 2: unlink errors are never swallowed and never raw", () => {
  it("an unlink that fails other than ENOENT, EPERM or EACCES is a lock error naming the file and the code (review M22)", () => {
    const h = tmpHome();
    const dir = join(h, "a-directory");
    mkdirSync(dir);
    function* unlinkDir(): Step<unknown> {
      return yield { kind: "unlink", path: dir };
    }
    expect(() => runOnDisk(unlinkDir(), noWait)).toThrow(LedgerLockError);
    expect(() => runOnDisk(unlinkDir(), noWait)).toThrow(`ledger lock error: ${dir} cannot be removed (EISDIR)`);
    function* unlinkDirBestEffort(): Step<unknown> {
      return yield { kind: "unlink", path: dir, bestEffort: true };
    }
    expect(runOnDisk(unlinkDirBestEffort(), noWait)).toBe("absent");
  });

  it("release never throws after the work is done: a lock it cannot remove gets one stderr line naming the file and the code (review M30)", () => {
    const h = tmpHome();
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
    let result: number;
    try {
      // A read only home: the lock cannot be removed (EACCES under the suite's dropped capabilities).
      result = withLedgerLock(h, () => { chmodSync(h, 0o555); return 42; });
    } finally {
      spy.mockRestore();
      chmodSync(h, 0o755);
    }
    expect(result).toBe(42);
    expect(lines).toEqual([`imd-flop: the ledger lock ${lockPath(h)} could not be removed (EACCES); it will be reclaimed when this process ends.\n`]);
    // The lock is still there. This process no longer holds its token, so by the own pid rule the next take
    // here reclaims it at once. Another process reclaims it once this one has ended.
    expect(lockFiles(h)).toEqual(["ledger.jsonl.lock"]);
    expect(withLedgerLock(h, () => 7)).toBe(7);
    expect(lockFiles(h)).toEqual([]);
  });
});

describe("L1: the lock is never seen without its owner", () => {
  // The lock is written to a temporary file that is then linked into place, so the lock path holds the
  // owner from its first instant. With open and then write it would exist empty for a moment, and a write
  // that fails would leave it empty for good. A file size limit of 0 makes every write fail (EFBIG): then no
  // lock may exist at all. This fails for a lock created by open and write (review M3b).
  it("a take whose write fails leaves no lock file, and no file of the lock at all", () => {
    const h = tmpHome();
    const script = join(h, "take.mjs");
    writeFileSync(script, `
const { withLedgerLock } = await import(${JSON.stringify(join(root, "dist", "ledger.js"))});
try { withLedgerLock(${JSON.stringify(h)}, () => {}); process.stdout.write("TAKEN"); } catch (e) { process.stdout.write(e.code ?? e.message); }
`);
    const r = spawnSync("bash", ["-c", 'ulimit -f 0 && exec "$0" "$1"', process.execPath, script], { encoding: "utf8", timeout: 60_000 });
    expect(r.stdout).toBe("EFBIG");
    expect(existsSync(lockPath(h))).toBe(false);
    expect(lockFiles(h)).toEqual([]);
  }, 60_000);
});

describe("L4: no age rule", () => {
  it("a provably dead owner's lock is reclaimed at once, however young", () => {
    const h = tmpHome();
    writeFileSync(lockPath(h), owner(deadPid(), "young"));
    const t0 = Date.now();
    expect(withLedgerLock(h, () => 7)).toBe(7);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(lockFiles(h)).toEqual([]);
  });
});

describe("L3a: our own pid", () => {
  it("a lock with our own pid and a token this process does not hold is dead: an earlier process had our pid", () => {
    const h = tmpHome();
    writeFileSync(lockPath(h), owner(process.pid, "earlier"));
    writeFileSync(rightPath(lockPath(h), "earlier", 1), owner(process.pid, "earlier-right"));
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockPath(h), old, old);
    const t0 = Date.now();
    expect(withLedgerLock(h, () => lockFiles(h))).toEqual(["ledger.jsonl.lock"]);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(lockFiles(h)).toEqual([]);
  });

  it("a token this process holds is this process itself, never dead", () => {
    const run = (s: Self, o: { pid: number; host: string; token: string }) => runOnDisk(provablyDead(s, o), noWait);
    const me = self(process.pid, "mine", ["mine", "also"]);
    expect(run(me, { pid: process.pid, host: hostname(), token: "mine" })).toBe(false);
    expect(run(me, { pid: process.pid, host: hostname(), token: "also" })).toBe(false);
    expect(run(me, { pid: process.pid, host: hostname(), token: "other" })).toBe(true);
    // Another host is never provably dead, whatever its pid.
    expect(run(me, { pid: process.pid, host: "elsewhere", token: "other" })).toBe(false);
    expect(run(me, { pid: deadPid(), host: "elsewhere", token: "other" })).toBe(false);
    // On this host: a live pid is alive, a gone pid is dead.
    expect(run(me, { pid: process.ppid, host: hostname(), token: "other" })).toBe(false);
    expect(run(me, { pid: deadPid(), host: hostname(), token: "other" })).toBe(true);
  });

  it("a lock that carries a token this process holds now is never removed, though it names our own pid", () => {
    // Inside the lock of one home, this process meets a lock with its own pid and the token it holds for
    // that home. The token is in the held set, so the owner is this process, alive: the lock stays and
    // the waiter times out with the usual message.
    const h1 = tmpHome();
    const h2 = tmpHome();
    withLedgerLock(h1, () => {
      const mine = readFileSync(lockPath(h1), "utf8");
      writeFileSync(lockPath(h2), mine);
      expect(() => withLedgerLock(h2, () => 1)).toThrow(new RegExp(`^ledger lock timeout: \\S+ \\(\\d+ s old\\) is held by pid ${process.pid} on host `));
      expect(readFileSync(lockPath(h2), "utf8")).toBe(mine);
    });
    expect(lockFiles(h1)).toEqual([]);
    expect(lockFiles(h2)).toEqual(["ledger.jsonl.lock"]);
  }, 20_000);
});

describe("L5: the timeout message names the owner and the way back", () => {
  it("names the lock file, its age, the recorded owner, or no readable owner, and the way back", () => {
    const h = tmpHome();
    const lock = lockPath(h);
    const old = new Date(Date.now() - 7_200_000);
    const msg = (body: string) => {
      writeFileSync(lock, body);
      utimesSync(lock, old, old);
      return timeoutMessage(lock);
    };
    const age = (m: string) => Number(m.match(/\((\d+) s old\)/)?.[1]);
    const other = msg(owner(1, "x", "some-other-host"));
    expect(other).toBe(`ledger lock timeout: ${lock} (${age(other)} s old) is held by pid 1 on host some-other-host. ${WAY_BACK}`);
    expect(age(other)).toBeGreaterThanOrEqual(7_200);
    const live = msg(owner(process.ppid, "x"));
    expect(live).toBe(`ledger lock timeout: ${lock} (${age(live)} s old) is held by pid ${process.ppid} on host ${hostname()}. ${WAY_BACK}`);
    for (const body of ["", "not json", JSON.stringify({ pid: "1", host: "h", token: "t" })]) {
      const none = msg(body);
      expect(none).toBe(`ledger lock timeout: ${lock} (${age(none)} s old) has no readable owner. ${WAY_BACK}`);
    }
  });

  it("run against a lock of another host: exit 10, nothing sent, the message names the owner and the way back, and the way back works", async () => {
    const h = tmpHome();
    await readySeat(h, SEAT, "1");
    writeFileSync(lockPath(h), owner(1, "abc", "some-other-host"));
    const calls = { n: 0 };
    const provider = mockProvider(calls);
    const r = await cli(h, ["run", "--seat", SEAT, "--job", "j1", "--prompt", "hi", "--provider", "mock", "--max-tokens", "8"], { provider });
    expect({ code: r.code, calls: calls.n }).toEqual({ code: 10, calls: 0 });
    expect(r.err).toMatch(new RegExp(`^imd-flop: refused locally, nothing sent: ledger lock timeout: \\S+ledger\\.jsonl\\.lock \\(\\d+ s old\\) is held by pid 1 on host some-other-host\\. ${WAY_BACK.replace(/\./g, "\\.")}$`));
    expect(readFileSync(lockPath(h), "utf8")).toBe(owner(1, "abc", "some-other-host"));
    unlinkSync(lockPath(h));
    const again = await cli(h, ["run", "--seat", SEAT, "--job", "j1", "--prompt", "hi", "--provider", "mock", "--max-tokens", "8"], { provider });
    expect({ code: again.code, calls: calls.n }, again.err).toEqual({ code: 0, calls: 1 });
  }, 20_000);
});

describe("L7: every append re-checks that the lock is still ours", () => {
  const row = (): LedgerEntry => ({ ts: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), request_id: "mock-9001-aa", seat: SEAT, did: null, job: "j", provider: "mock", network: "devnet", payer: "holder", model: "m", max_tokens: 8, prompt_sha256: "0", quote_raw: 0.066, quote_padded: 0.186, per_call_cap: 1, daily_cap: 1, job_budget: null, spent_before: 0, state: "sent", reason: null, spend: null, cost_reported: null, cap_charge: 0.186, http: null, mock: true });

  it("an append under the lock writes its row", () => {
    const h = tmpHome();
    withLedgerLock(h, () => appendLedger(h, row()));
    expect(readLines(ledgerPath(h))).toHaveLength(1);
  });

  it("a lock removed by hand while a holder is inside: the append refuses and writes nothing", () => {
    const h = tmpHome();
    // A lost lock is its own error, not a busy ledger (review of the lock reclaim, defect 5).
    const err = (() => { try { withLedgerLock(h, () => { unlinkSync(lockPath(h)); appendLedger(h, row()); }); } catch (e) { return e; } })();
    expect({ lost: err instanceof LedgerLockLost, busy: err instanceof LedgerLockError }).toEqual({ lost: true, busy: false });
    expect(() => withLedgerLock(h, () => { unlinkSync(lockPath(h)); appendLedger(h, row()); })).toThrow(/^ledger lock lost: \S+ledger\.jsonl\.lock no longer carries this process's token, so nothing was appended$/);
    expect(existsSync(ledgerPath(h))).toBe(false);
  });

  it("a lock removed by hand and taken by another process: the append refuses, writes nothing, and the release leaves the other lock", () => {
    const h = tmpHome();
    expect(() => withLedgerLock(h, () => { writeFileSync(lockPath(h), owner(process.ppid, "someone")); appendLedger(h, row()); })).toThrow(LedgerLockLost);
    expect(existsSync(ledgerPath(h))).toBe(false);
    expect(readFileSync(lockPath(h), "utf8")).toBe(owner(process.ppid, "someone"));
  });
});

function mockProvider(calls: { n: number }) {
  return {
    name: "mock" as const,
    async estimate() { return { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 } as never; },
    async complete(req: { requestId: string }) { calls.n += 1; return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as never; },
    async readReceipt(id: string) { return { http: 200, error: null, receipt: { request_id: id, correlation_id: "imd-job-j1", state: "estimated", settled_spend: null, reserved_spend: 0.186, model: "m" } } as never; },
  } as never;
}

describe("lock stress: real processes meet a dead holder's lock at the same moment", () => {
  const PROCS = Number(process.env.STRESS_PROCS ?? 6);
  const OPS = Number(process.env.STRESS_OPS ?? 20);
  const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 2);

  /** Spawn n copies of a script that all start at the same deadline. Resolves with each exit and output. */
  function race(script: string, n: number, env: Record<string, string>): Promise<{ code: number; out: string; err: string }[]> {
    const deadline = String(Date.now() + 1_000 + n * 50);
    return Promise.all(Array.from({ length: n }, (_, i) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, ...env, DEADLINE: deadline, RACER: String(i) } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("exit", (c) => resolve({ code: c ?? 1, out, err }));
    })));
  }

  it(`${PROCS} processes x ${OPS} entries x ${ROUNDS} rounds: entries and exits alternate strictly, no error, no lock file left`, async () => {
    const summary: { round: number; entries: number; errors: string[]; left: string[]; overlap: boolean }[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const h = tmpHome();
      const lock = lockPath(h);
      writeFileSync(lock, owner(deadPid(), "dead"));
      // Every other round also leaves a dead reclaimer's right at level 1, so the right passes to level 2.
      if (round % 2 === 1) writeFileSync(rightPath(lock, "dead", 1), owner(deadPid(), "dead-reclaimer"));
      const script = join(h, "racer.mjs");
      writeFileSync(script, `
import { appendFileSync } from "node:fs";
const { withLedgerLock } = await import(${JSON.stringify(join(root, "dist", "ledger.js"))});
const home = ${JSON.stringify(h)};
const log = home + "/race.log";
while (Date.now() < Number(process.env.DEADLINE)) {}
for (let i = 0; i < ${OPS}; i++) {
  try {
    withLedgerLock(home, () => {
      appendFileSync(log, "E\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, i % 3);
      appendFileSync(log, "X\\n");
    });
  } catch (e) { appendFileSync(log, "ERR " + e.message + "\\n"); }
}
`);
      const results = await race(script, PROCS, { IMD_FLOP_HOME: h });
      for (const r of results) expect(r.code, r.err).toBe(0);
      const lines = readFileSync(join(h, "race.log"), "utf8").split("\n").filter(Boolean);
      let inside = 0;
      let overlap = false;
      for (const l of lines) {
        if (l === "E" && ++inside > 1) overlap = true;
        if (l === "X") inside--;
      }
      const errors = lines.filter((l) => l.startsWith("ERR"));
      summary.push({ round, entries: lines.filter((l) => l === "E").length, errors, left: lockFiles(h), overlap });
    }
    if (process.env.STRESS_REPORT) writeFileSync(`${process.env.STRESS_REPORT}.lock-race.json`, JSON.stringify({ procs: PROCS, ops: OPS, rounds: ROUNDS, summary }));
    expect(summary).toEqual(Array.from({ length: ROUNDS }, (_, round) => ({ round, entries: PROCS * OPS, errors: [], left: [], overlap: false })));
  }, 3_600_000);

  it(`${Math.max(2, PROCS)} run processes x ${ROUNDS} rounds at a dead holder's lock, with room for exactly one call: exactly one is admitted`, async () => {
    const n = Math.max(2, PROCS);
    const summary: { round: number; codes: number[]; sent: number; completed: number; left: string[] }[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const h = tmpHome();
      await readySeat(h, SEAT, "0.186"); // the padded quote is 0.186: room for exactly one call
      writeFileSync(lockPath(h), owner(deadPid(), "dead"));
      const script = join(h, "runner.mjs");
      writeFileSync(script, `
const { main } = await import(${JSON.stringify(join(root, "dist", "cli.js"))});
const provider = {
  name: "mock",
  async estimate() { return { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }; },
  async complete(req) { process.stdout.write("COMPLETE_CALLED\\n"); return { request_id: req.requestId, text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; },
  async readReceipt(id) { return { http: 200, error: null, receipt: { request_id: id, correlation_id: "c", state: "estimated", settled_spend: null, reserved_spend: 0.186, model: "m" } }; },
};
while (Date.now() < Number(process.env.DEADLINE)) {}
const code = await main(["run", "--seat", ${JSON.stringify(SEAT)}, "--job", "j" + process.env.RACER, "--prompt", "hi", "--max-tokens", "8", "--provider", "mock"], {
  out(s) { process.stdout.write(s + "\\n"); }, err(s) { process.stderr.write(s + "\\n"); }, env: { IMD_FLOP_HOME: ${JSON.stringify(h)} }, provider,
});
process.exit(code ?? 1);
`);
      const results = await race(script, n, { IMD_FLOP_HOME: h });
      const rows = readLines(ledgerPath(h)) as LedgerEntry[];
      summary.push({
        round,
        codes: results.map((r) => r.code).sort(),
        sent: rows.filter((r) => r.state === "sent").length,
        completed: results.filter((r) => r.out.includes("COMPLETE_CALLED")).length,
        left: lockFiles(h),
      });
    }
    if (process.env.STRESS_REPORT) writeFileSync(`${process.env.STRESS_REPORT}.lock-run.json`, JSON.stringify({ procs: n, rounds: ROUNDS, summary }));
    // One run admitted and sent; every other run refused by the cap (exit 3) before anything was sent.
    expect(summary).toEqual(Array.from({ length: ROUNDS }, (_, round) => ({ round, codes: [0, ...Array(n - 1).fill(3)], sent: 1, completed: 1, left: [] })));
  }, 3_600_000);
});
