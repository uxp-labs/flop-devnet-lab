// The reader contract for the data branch (src/published.ts): given the text of the files under
// latest/, may a consumer use the reading? Offline: each latest/ here is a live run's output
// folder, written over a tape, and then changed one way at a time.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { feedText } from "../src/feed.js";
import { runLive } from "../src/live-run.js";
import { PUBLISHED_FILES, judgeLatest } from "../src/published.js";
import { canonicalJson, hashSnapshot } from "../src/store.js";
import { sumsOf } from "../src/sums.js";
import { TapeTransport } from "../src/tape.js";
import type { Transport } from "../src/transport.js";
import type { Snapshot } from "../src/types.js";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const tapeText = (name: string) => readFileSync(new URL(`${name}/tape.jsonl`, FIXTURES), "utf8");
/** The healthy tape's snapshot and status time is 06:00:01.000. */
const NOW = "2026-11-11T06:10:00.000Z";
const HOUR = 3600;

let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "obs-published-"));
});
afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

/** A transport that answers from a tape but says it is the network, as the live one does. */
function asLive(inner: Transport): Transport {
  return { trust: "trusted RPC", label: "rpc wss://rpc.devnet.flop.network", rpc: (m, p) => inner.rpc(m, p), httpGet: (u) => inner.httpGet(u), now: () => inner.now(), close: () => inner.close() };
}

type Files = Record<string, string>;

/** The files of a live run's output folder, by name, as a consumer would hold them after a GET of each. */
async function latest(tape: string, live = true): Promise<Files> {
  const out = join(box, "latest");
  const t = TapeTransport.parse(tapeText(tape), `tape:${tape}`);
  await runLive(live ? asLive(t) : t, { out, log: join(box, "no-log"), sourceSha: null, clock: () => "2026-11-11T06:00:02.000Z" });
  return Object.fromEntries(readdirSync(out).map((n) => [n, readFileSync(join(out, n), "utf8")]));
}

/** The same files with SHA256SUMS written again over them, as a publisher that changed one would. */
function resummed(f: Files): Files {
  return { ...f, SHA256SUMS: sumsOf(PUBLISHED_FILES.map((n) => [n, f[n] as string] as const)) };
}

/** The files with snapshot.json, its log line and every feed made again from a changed snapshot. */
function withSnapshot(f: Files, change: (s: Snapshot) => void, rehash = true): Files {
  const s = JSON.parse(f["snapshot.json"] as string) as Snapshot;
  change(s);
  if (rehash) s.hash = hashSnapshot(s);
  return resummed({ ...f, "snapshot.json": feedText(s), "snapshots.jsonl": canonicalJson(s) + "\n" });
}

const judge = (f: Files, now = NOW, maxAgeSeconds = HOUR) => judgeLatest(f, { now, maxAgeSeconds });

describe("judgeLatest", () => {
  it("names the files a published latest/ holds: the live run's output folder, SHA256SUMS last", async () => {
    expect([...PUBLISHED_FILES, "SHA256SUMS"].sort()).toEqual(Object.keys(await latest("live-healthy")).sort());
  });

  it("uses a reading the live run wrote, fresh and unchanged, and says it holds no reset signal", async () => {
    const f = await latest("live-healthy");
    const j = judge(f);
    expect(j).toEqual({ usable: true, snapshot: JSON.parse(f["snapshot.json"] as string), reset: null });
  });

  it("uses a reading that holds a reset signal, and names the signal", async () => {
    const j = judge(await latest("live-other-genesis"));
    expect(j.usable && j.reset).toBe("reset_detected is true");
  });

  it("refuses a missing file and a file it does not know, naming each, before reading any", async () => {
    const f = await latest("live-healthy");
    const { "tape.jsonl": _tape, ...missing } = f;
    expect(judge(missing)).toEqual({ usable: false, refused: ["missing tape.jsonl"] });
    expect(judge({ ...f, "extra.json": "{}\n" })).toEqual({ usable: false, refused: ["unexpected extra.json"] });
  });

  it("refuses a file that differs from its sum, naming it, and reads nothing else", async () => {
    const f = await latest("live-healthy");
    expect(judge({ ...f, "status.json": "{}\n" })).toEqual({ usable: false, refused: ["status.json differs from SHA256SUMS"] });
    expect(judge({ ...f, "tape.jsonl": f["tape.jsonl"] + "\n" })).toEqual({ usable: false, refused: ["tape.jsonl differs from SHA256SUMS"] });
  });

  it("refuses SHA256SUMS in any form but the one the live run writes", async () => {
    const f = await latest("live-healthy");
    const sums = f.SHA256SUMS as string;
    const reordered = sums.trimEnd().split("\n").reverse().join("\n") + "\n";
    expect(judge({ ...f, SHA256SUMS: reordered })).toEqual({ usable: false, refused: ["SHA256SUMS is not in the written form"] });
    expect(judge({ ...f, SHA256SUMS: sums + "\n" })).toEqual({ usable: false, refused: ["SHA256SUMS is not in the written form"] });
  });

  it("refuses a snapshot.json that is not JSON in the written form, even with its sums written again", async () => {
    const f = await latest("live-healthy");
    const s = JSON.parse(f["snapshot.json"] as string) as unknown;
    expect(judge(resummed({ ...f, "snapshot.json": "not json\n" }))).toEqual({ usable: false, refused: ["snapshot.json is not JSON"] });
    expect(judge(resummed({ ...f, "snapshot.json": JSON.stringify(s) }))).toEqual({ usable: false, refused: ["snapshot.json is not in the written form"] });
    // Nesting is read before any parser runs; this text is in the written form.
    const deep = feedText(JSON.parse("[".repeat(65) + "]".repeat(65)));
    expect(judge(resummed({ ...f, "snapshot.json": deep }))).toEqual({ usable: false, refused: ["snapshot.json nests deeper than 64 levels"] });
  });

  it("refuses a snapshot that breaks a snapshot check, naming the check", async () => {
    const f = await latest("live-healthy");
    const j = judge(withSnapshot(f, (s) => ((s as unknown as Record<string, unknown>).schema = "flop-observatory/snapshot@2")));
    expect(j).toEqual({ usable: false, refused: ["snapshot.json breaks snapshot.schema"] });
  });

  it("refuses a snapshot that fails its hash check", async () => {
    const f = await latest("live-healthy");
    // The pin's node is text that no agreement ties to anything else, so only the hash can tell.
    expect(judge(withSnapshot(f, (s) => (s.pin.node = "v0.0.0"), false))).toEqual({ usable: false, refused: ["snapshot.json fails its hash check"] });
  });

  it("refuses a snapshot whose trust is not trusted RPC", async () => {
    const j = judge(await latest("live-healthy", false));
    expect(j).toEqual({ usable: false, refused: ['snapshot.json has trust "fixture", not "trusted RPC"'] });
  });

  it.each(["status.json", "escrows.json", "census.json", "drift.json", "snapshots.jsonl"])("refuses a %s that is not the one the snapshot gives", async (name) => {
    const f = await latest("live-healthy");
    const changed = (f[name] as string).replace(/\n$/, " \n");
    expect(judge(resummed({ ...f, [name]: changed }))).toEqual({ usable: false, refused: [`${name} is not the one the snapshot gives`] });
  });

  it("refuses a run.json that names another snapshot, another schema or an exit other than the snapshot's", async () => {
    const f = await latest("live-healthy");
    const run = JSON.parse(f["run.json"] as string) as Record<string, unknown>;
    const withRun = (change: Record<string, unknown>) => judge(resummed({ ...f, "run.json": feedText({ ...run, ...change }) }));
    expect(withRun({ snapshot_hash: "0".repeat(64) })).toEqual({ usable: false, refused: ["run.json names another snapshot"] });
    // A run.json from before runs kept memory: its reading spoke for itself only.
    expect(withRun({ schema: "flop-observatory/live-run@0" })).toEqual({ usable: false, refused: ["run.json is not a flop-observatory/live-run@1"] });
    expect(withRun({ exit_code: 3 })).toEqual({ usable: false, refused: ["run.json says exit 3, the snapshot says 0"] });
    expect(withRun({ exit_code: 4 })).toEqual({ usable: false, refused: ["run.json says exit 4, the snapshot says 0"] });
    expect(judge(resummed({ ...f, "run.json": JSON.stringify(run) }))).toEqual({ usable: false, refused: ["run.json is not in the written form"] });
    expect(judge(resummed({ ...f, "run.json": "run\n" }))).toEqual({ usable: false, refused: ["run.json is not JSON"] });
    expect(judge(resummed({ ...f, "run.json": "[]\n" }))).toEqual({ usable: false, refused: ["run.json is not an object"] });
    expect(judge(resummed({ ...f, "run.json": "null\n" }))).toEqual({ usable: false, refused: ["run.json is not an object"] });
  });

  it("refuses a reading older than the limit, and uses one exactly at it", async () => {
    const f = await latest("live-healthy");
    expect(judge(f, "2026-11-11T07:00:01.000Z").usable).toBe(true);
    expect(judge(f, "2026-11-11T07:00:01.001Z")).toEqual({
      usable: false,
      refused: ["snapshot.json observed_at 2026-11-11T06:00:01.000Z is older than 3600 s", "status.json observed_at 2026-11-11T06:00:01.000Z is older than 3600 s"],
    });
  });

  it("refuses a reading from the future, and uses one taken at now", async () => {
    const f = await latest("live-healthy");
    expect(judge(f, "2026-11-11T06:00:00.999Z")).toEqual({
      usable: false,
      refused: ["snapshot.json observed_at 2026-11-11T06:00:01.000Z is in the future", "status.json observed_at 2026-11-11T06:00:01.000Z is in the future"],
    });
    expect(judge(f, "2026-11-11T06:00:01.000Z").usable).toBe(true);
  });

  it.each([
    ["2026-11-11T06:10:00", HOUR, "now must be a time with a zone"],
    [NOW, -1, "maxAgeSeconds must be a whole number of seconds from 0"],
    [NOW, 1.5, "maxAgeSeconds must be a whole number of seconds from 0"],
  ])("throws for a caller's mistake: now %j, max age %j", async (now, max, why) => {
    const f = await latest("live-healthy");
    expect(() => judge(f, now, max)).toThrow(why);
  });
});
