/**
 * Fail-first probes for the v6 ledger lock: a lock whose holder is alive must never be stolen,
 * however old its mtime. Only a lock proven stale (its owner process is gone) may be reclaimed.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLines, readySeat, tmpHome } from "./helpers.js";

const SEAT = "9001";
const root = join(import.meta.dirname, "..");
const lockPath = (home: string) => `${join(home, "ledger.jsonl")}.lock`;

function build() { execFileSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: root }); }

function runnerFile(home: string): string {
  const runner = join(home, "runner.mjs");
  writeFileSync(runner, `
import { main } from ${JSON.stringify(join(root, "dist", "cli.js"))};
const provider = {
  name: "mock", calls: 0,
  async estimate() { return { estimated_cost_flop: 0.066, estimated_input_tokens: 3, estimated_output_tokens: 8 }; },
  async complete() { this.calls += 1; process.stdout.write("COMPLETE_CALLED\\n");
    return { request_id: "x", text: "ok", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_flop: 0.01 } }; },
  async readReceipt(id) { return { http: 200, error: null, receipt: { request_id: id, correlation_id: "imd-job-" + process.env.JOB, state: "estimated", settled_spend: null, reserved_spend: 0.186, model: "m" } }; },
};
const code = await main(["run", "--seat", ${JSON.stringify(SEAT)}, "--job", process.env.JOB, "--prompt", "Say hi", "--max-tokens", "8", "--provider", "mock"], {
  out(s) { process.stdout.write(s + "\\n"); }, err(s) { process.stderr.write(s + "\\n"); },
  env: { ...process.env, IMD_FLOP_HOME: ${JSON.stringify(home)} }, provider,
});
process.exit(code ?? 1);
`);
  return runner;
}

/** A live process that takes the real ledger lock, ages its lockfile past 30 s, and keeps holding. */
function startHolder(home: string, holdMs: number): Promise<ChildProcess> {
  const holder = join(home, "holder.mjs");
  writeFileSync(holder, `
import { withLedgerLock } from ${JSON.stringify(join(root, "dist", "ledger.js"))};
import { utimesSync } from "node:fs";
withLedgerLock(${JSON.stringify(home)}, () => {
  const old = (Date.now() - 31_000) / 1000;
  utimesSync(${JSON.stringify(lockPath(home))}, old, old);
  process.stdout.write("HOLDING\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
});
`);
  const child = spawn(process.execPath, [holder], { env: { ...process.env, IMD_FLOP_HOME: home } });
  return new Promise((resolve, reject) => {
    child.stdout!.on("data", (d) => { if (String(d).includes("HOLDING")) resolve(child); });
    child.on("exit", (c) => reject(new Error("holder exited early " + c)));
  });
}

function runCli(home: string, job: string) {
  return new Promise<{ code: number; out: string; err: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [runnerFile(home)], { env: { ...process.env, JOB: job, IMD_FLOP_HOME: home } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code: code ?? 1, out, err, ms: Date.now() - t0 }));
  });
}

const sentRows = (home: string) =>
  existsSync(join(home, "ledger.jsonl")) ? readLines(join(home, "ledger.jsonl")).filter((e: any) => e.state === "sent") : [];

describe("v6 ledger lock liveness", () => {
  it("never steals a >30 s old lock while its holder is alive; the second call refuses and reserves nothing", async () => {
    build();
    const home = tmpHome();
    await readySeat(home, SEAT, "0.186");
    const holder = await startHolder(home, 9_000);
    try {
      const r = await runCli(home, "steal-b");
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("ledger lock timeout");
      expect(r.out).not.toContain("COMPLETE_CALLED");
      expect(sentRows(home)).toHaveLength(0);
      expect(existsSync(lockPath(home))).toBe(true); // the live holder's lock is still in place
    } finally {
      holder.kill("SIGKILL");
    }
  }, 30_000);

  it("reclaims an old lock only when its recorded owner process is gone", async () => {
    build();
    const home = tmpHome();
    await readySeat(home, SEAT, "0.186");
    const dead = spawn(process.execPath, ["-e", "0"]);
    const deadPid: number = await new Promise((res) => dead.on("exit", () => res(dead.pid!)));
    writeFileSync(lockPath(home), JSON.stringify({ pid: deadPid, host: (await import("node:os")).hostname(), token: "dead" }));
    const old = (Date.now() - 31_000) / 1000;
    utimesSync(lockPath(home), old, old);
    const r = await runCli(home, "reclaim");
    expect(r.code).toBe(0);
    expect(sentRows(home)).toHaveLength(1);
    expect(existsSync(lockPath(home))).toBe(false);
  }, 30_000);

  it("does not steal an old lock whose owner is on another host", async () => {
    // Moved (review fixes 4, item 5): this also held an empty and a "not json" lock. A lock with no readable
    // owner is now reclaimed past the reclaim window, as a dead owner's is (the next test).
    build();
    for (const body of [JSON.stringify({ pid: 1, host: "some-other-host", token: "x" })]) {
      const home = tmpHome();
      await readySeat(home, SEAT, "0.186");
      writeFileSync(lockPath(home), body);
      const old = (Date.now() - 31_000) / 1000;
      utimesSync(lockPath(home), old, old);
      const r = await runCli(home, "unproven");
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("ledger lock timeout");
      expect(r.out).not.toContain("COMPLETE_CALLED");
      expect(sentRows(home)).toHaveLength(0);
      expect(readFileSync(lockPath(home), "utf8")).toBe(body);
    }
  }, 60_000);

  it("reclaims an old lock with no readable owner (empty or not JSON), as a dead owner's", async () => {
    build();
    for (const body of ["", "not json"]) {
      const home = tmpHome();
      await readySeat(home, SEAT, "0.186");
      writeFileSync(lockPath(home), body);
      const old = (Date.now() - 31_000) / 1000;
      utimesSync(lockPath(home), old, old);
      const r = await runCli(home, "reclaim");
      expect(r.code, r.err).toBe(0);
      expect(sentRows(home)).toHaveLength(1);
      expect(existsSync(lockPath(home))).toBe(false);
    }
  }, 60_000);
});
