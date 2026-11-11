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
import { hashSnapshot, logLine } from "../src/store.js";
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
  it("the lines from before memory are each checked alone; their order and number are not protected by the chain, which protects every line from the first chained one on, and a log that runs backwards still shows as a conflict", async () => {
    const none = join(box, "none");
    // Three one-line logs, as published before runs kept memory, in time order: 08:08, 08:18, 08:23.
    const a = await snap("published-2026-11-11-0808", none);
    const b = await snap("memory-stuck", none);
    const c = await snap("published-2026-11-11-0823", none);
    expect([a, b, c].map((s) => [s.seq, s.prev_hash])).toEqual([[0, null], [0, null], [0, null]]);
    const d = await snap("memory-rpc-down", logOf(a, b, c));
    expect([d.seq, d.prev_hash]).toEqual([1, c.hash]);
    expect(readHistory(logOf(a, b, c, d)).state).toBe("read");
    // Each is checked alone: by its own hash, and by the snapshot checks.
    expect(readHistory(logOf({ ...a, observed_at: "2026-11-11T08:00:00.000Z" }, b, c, d)).detail).toBe("2026-11-11.jsonl line 0 fails its hash check");
    const odd = { ...b, schema: "flop-observatory/snapshot@9" } as unknown as Snapshot;
    expect(readHistory(logOf(a, { ...odd, hash: hashSnapshot(odd) }, c)).state).toBe("unchecked");
    // Their order and number are not protected: moved, added, removed among them, the log reads.
    const extra = await snap("memory-rpc-down", none);
    for (const log of [[b, a, c, d], [a, extra, b, c, d], [b, c, d], [c, extra]]) expect(readHistory(logOf(...log)).state).toBe("read");
    // From the first chained line on, every line is protected: moved or removed but at the end, refused.
    const e = await snap("memory-changed-hash", logOf(a, b, c, d));
    expect([readHistory(logOf(a, b, c, e, d)).state, readHistory(logOf(a, b, c, e)).state, readHistory(logOf(a, b, d, c, e)).state]).toEqual(["broken", "broken", "broken"]);
    // A log that runs backwards in time shows, as a conflict, in the next run built on it.
    const late = await snap("memory-other-genesis", none);
    expect(late.observed_at > d.observed_at).toBe(true);
    const next = await snap("published-2026-11-11-0823", logOf(a, late, b, c, d));
    expect(next.status.conflicts).toContain(`an earlier snapshot was taken at ${late.observed_at}, later than this snapshot time ${next.observed_at}`);
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
