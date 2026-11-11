// Findings of the memory review (branch claude/observatory-memory) that need no shell. The ones that
// run the publish job's shell are in test/publish-shell.test.ts, under "open defects".
//
// Each test pins what the code does today, which is wrong, so the suite stays green while the
// defect is open; it fails once the defect is fixed, and is then turned round to assert the fix.
// (scripts/test-report-check.mjs refuses a test that passes on failure, so these assert the
// defective behaviour itself.)
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHistory } from "../src/history.js";
import { parseLiveArgs, runLive } from "../src/live-run.js";
import { logLine } from "../src/store.js";
import { TapeTransport } from "../src/tape.js";
import type { Snapshot } from "../src/types.js";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const tape = (dir: string) => TapeTransport.parse(readFileSync(new URL(`${dir}/tape.jsonl`, FIXTURES), "utf8"), `tape:${dir}`);
const CLOCK = () => "2026-11-11T09:00:00.000Z";

let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "obs-review-memory-"));
});
afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

let serial = 0;
/** One live run of a fixture's tape on the log folder given. */
async function snap(dir: string, log: string): Promise<Snapshot> {
  const r = await runLive(tape(dir), { out: join(box, `out-${++serial}`), log, sourceSha: null, clock: CLOCK });
  return r.snapshot as Snapshot;
}
function logOf(...ss: Snapshot[]): string {
  const dir = join(box, `log-${++serial}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "2026-11-11.jsonl"), ss.map(logLine).join(""));
  return dir;
}

describe("open defects (memory review)", () => {
  it("DEFECT 4: the one-line logs at the start of a log are not chained to each other, so all but the last can be reordered, and one can be added, and the chain still verifies", async () => {
    const none = join(box, "none");
    // Three one-line logs, as published before runs kept memory, in time order: 08:08, 08:18, 08:23.
    const a = await snap("published-2026-11-11-0808", none);
    const b = await snap("memory-stuck", none);
    const c = await snap("published-2026-11-11-0823", none);
    expect([a, b, c].map((s) => [s.seq, s.prev_hash])).toEqual([[0, null], [0, null], [0, null]]);
    const d = await snap("memory-rpc-down", logOf(a, b, c));
    expect([d.seq, d.prev_hash]).toEqual([1, c.hash]);
    expect(readHistory(logOf(a, b, c, d)).state).toBe("read");
    // RULES.md section 7: "The log shows the lines were not changed or reordered since they were
    // written." Reordered (08:18 before 08:08), and with a one-line log added out of time order
    // (08:23:57, before 08:18): both still read as a chain that verifies.
    const reordered = readHistory(logOf(b, a, c, d));
    expect([reordered.state, reordered.snapshots.map((s) => s.hash)]).toEqual(["read", [b.hash, a.hash, c.hash, d.hash]]);
    const extra = await snap("memory-rpc-down", none);
    expect(readHistory(logOf(a, extra, b, c, d)).state).toBe("read");
    // The allowance is not limited to readings from before memory: a chain's own first line is a
    // one-line log too, so a restart after it, while no line has seq 1 yet, is read as a chain.
    expect(readHistory(logOf(c, extra)).state).toBe("read");
  });

  it("DEFECT 5: the usage line in src/live-bin.ts leaves out --log, and the command refuses it as written", () => {
    const source = readFileSync(new URL("../src/live-bin.ts", import.meta.url), "utf8");
    const usage = /^\/\/\s+node dist\/live-bin\.js (.*)$/m.exec(source)?.[1] ?? "";
    expect(usage).toBe("--out <new folder> [--source-sha <revision>]");
    // Its required flags, with each <placeholder> given a value and the [optional] part left out.
    const args = usage.replace(/\[[^\]]*\]/g, "").replace(/<[^>]*>/g, "x").trim().split(/\s+/);
    expect(parseLiveArgs(args)).toBe("missing --log");
  });
});
