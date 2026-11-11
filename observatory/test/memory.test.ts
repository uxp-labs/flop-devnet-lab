// Memory between live runs, over real readings from the data branch (fixtures/published-*, marked
// synthetic false, with their provenance) and synthetic second readings (fixtures/memory-*, marked
// synthetic true) for what real data cannot show. Each run reads the published log, a folder of
// day files, and builds its snapshot on every snapshot in it.
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHistory } from "../src/history.js";
import { EXIT, RUN_SCHEMA, runLive } from "../src/live-run.js";
import { judgeLatest } from "../src/published.js";
import { checkSnapshot } from "../src/snapshot-check.js";
import { hashSnapshot, logLine, readDayLog } from "../src/store.js";
import { TapeTransport } from "../src/tape.js";
import type { Transport } from "../src/transport.js";
import type { NetworkStatus, Snapshot } from "../src/types.js";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const fixture = (dir: string, name: string) => readFileSync(new URL(`${dir}/${name}`, FIXTURES), "utf8");
const json = <T = Record<string, unknown>>(dir: string, name: string) => JSON.parse(fixture(dir, name)) as T;
const FIRST = "published-2026-11-11-0808";
const SECOND = "published-2026-11-11-0823";
const DAY = "2026-11-11.jsonl";
const CLOCK = () => "2026-11-11T09:00:00.000Z";

let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "obs-memory-"));
});
afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

/** A transport that answers from a tape but says it is the network, as the live one does. */
function asLive(inner: Transport): Transport {
  return { trust: "trusted RPC", label: "rpc wss://rpc.devnet.flop.network", rpc: (m, p) => inner.rpc(m, p), httpGet: (u) => inner.httpGet(u), now: () => inner.now(), close: () => inner.close() };
}

const tapeOf = (dir: string) => TapeTransport.parse(fixture(dir, "tape.jsonl"), `tape:${dir}`);

/** One run of a fixture's tape into a new folder, on the log folder given. */
async function run(dir: string, log: string, name = dir, transport: Transport = tapeOf(dir), sourceSha: string | null = null) {
  const out = join(box, "runs", name);
  const r = await runLive(transport, { out, log, sourceSha, clock: CLOCK });
  return { out, r, runJson: JSON.parse(readFileSync(join(out, "run.json"), "utf8")) as Record<string, unknown> };
}

/** A log folder holding the day file a fixture keeps, as the data branch held it. */
function publishedLog(dir: string, name = "log"): string {
  const log = join(box, name);
  mkdirSync(log, { recursive: true });
  copyFileSync(new URL(`${dir}/log/${DAY}`, FIXTURES), join(log, DAY));
  return log;
}

/** What the publish job does with a run's output: append its one line to the day file. */
function publish(out: string, log: string, day = DAY): void {
  mkdirSync(log, { recursive: true });
  appendFileSync(join(log, day), readFileSync(join(out, "snapshots.jsonl")));
}

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

describe("real readings from the data branch", () => {
  it.each([FIRST, SECOND])("%s: is marked real, with its provenance, and every kept file matches the SHA256SUMS the workflow wrote", (dir) => {
    const meta = json<{ scenario: string; synthetic: unknown; now: string; provenance: Record<string, unknown> }>(dir, "meta.json");
    expect([meta.scenario, meta.synthetic]).toEqual([dir, false]);
    expect(readdirSync(new URL(`${dir}/`, FIXTURES)).sort()).toEqual(["SHA256SUMS", "log", "meta.json", "run.json", "snapshot.json", "tape.jsonl"]);
    const sums = fixture(dir, "SHA256SUMS").split("\n");
    for (const f of ["run.json", "snapshot.json", "tape.jsonl"]) expect(sums, f).toContain(`${sha256(fixture(dir, f))}  ${f}`);
    // The tape's recorded hash, computed again.
    expect(meta.provenance.tape_sha256).toBe(sha256(fixture(dir, "tape.jsonl")));
    const snap = json<Snapshot>(dir, "snapshot.json");
    const runJson = json(dir, "run.json");
    expect([snap.hash, checkSnapshot(snap)]).toEqual([hashSnapshot(snap), []]);
    expect([meta.provenance.snapshot_hash, runJson.snapshot_hash, meta.now]).toEqual([snap.hash, snap.hash, snap.observed_at]);
    expect([meta.provenance.revision, meta.provenance.data_branch]).toEqual([runJson.source_sha, "observatory-data"]);
    expect([snap.trust, snap.seq, snap.prev_hash, runJson.exit_code]).toEqual(["trusted RPC", 0, null, 0]);
    // The day file as the data branch held it ends with this reading's line.
    expect(fixture(dir, `log/${DAY}`).endsWith(logLine(snap))).toBe(true);
  });

  it.each([FIRST, SECOND])("%s: replayed through LiveSource on the log it was read on (none), gives the same snapshot but for where it came from", async (dir) => {
    const recorded = json<Snapshot>(dir, "snapshot.json");
    const sourceSha = json(dir, "run.json").source_sha as string;
    const { r } = await run(dir, join(box, "no-log"), dir, tapeOf(dir), sourceSha);
    const again = r.snapshot as Snapshot;
    // A replay's trust is "fixture" (saved data, RULES.md section 7) and its source names the tape;
    // pin.node is the Node version that ran it. The hash covers all three, so it differs too.
    expect([again.trust, again.status.trust, again.pin.source]).toEqual(["fixture", "fixture", `live:tape:${dir}`]);
    const asRecorded = { ...again, trust: recorded.trust, status: { ...again.status, trust: recorded.status.trust }, pin: { ...again.pin, source: recorded.pin.source, node: recorded.pin.node } };
    expect({ ...asRecorded, hash: hashSnapshot(asRecorded) }).toEqual(recorded);
    // Replayed as the network would answer, on the same Node version, it is the same byte for byte.
    if (process.version === recorded.pin.node) {
      const live = await run(dir, join(box, "no-log"), `${dir}-live`, asLive(tapeOf(dir)), sourceSha);
      expect(readFileSync(join(live.out, "snapshot.json"), "utf8")).toBe(fixture(dir, "snapshot.json"));
    }
  });

  it("the second real reading, built on the log as the data branch held it after the first, follows the first in one chain", async () => {
    const first = json<Snapshot>(FIRST, "snapshot.json");
    const recorded = json<Snapshot>(SECOND, "snapshot.json");
    const log = publishedLog(FIRST);
    const { out, r, runJson } = await run(SECOND, log);
    const s = r.snapshot as Snapshot;
    expect([r.code, s.seq, s.prev_hash]).toEqual([EXIT.ok, 1, first.hash]);
    expect(runJson.history).toEqual({ state: "read", detail: "read 1 snapshot from 1 day file, and the chain verifies", files: 1, snapshots: 1, last_hash: first.hash });
    // Every check against the first reading ran and found nothing: the status is the one the second
    // reading gave alone, but for its trust.
    expect(s.status).toEqual({ ...recorded.status, trust: "fixture" });
    expect(r.notice).toContain(`"seq":1,"prev_hash":"${first.hash}"`);
    publish(out, log);
    expect(readDayLog(log)?.snapshots.map((x) => x.hash)).toEqual([first.hash, s.hash]);
    expect(readHistory(log).state).toBe("read");
  });

  it("the log as published before runs kept memory, two one-line logs, is read whole, and the chain goes on from its last line", async () => {
    const log = publishedLog(SECOND);
    const h = readHistory(log);
    expect([h.state, h.snapshots.map((x) => [x.seq, x.prev_hash])]).toEqual(["read", [[0, null], [0, null]]]);
    const last = json<Snapshot>(SECOND, "snapshot.json");
    // A synthetic reading after both: the one that holds the same block 600 s on.
    const { out, r } = await run("memory-stuck", log);
    expect([(r.snapshot as Snapshot).seq, (r.snapshot as Snapshot).prev_hash]).toEqual([1, last.hash]);
    publish(out, log);
    expect(readDayLog(log)?.snapshots.length).toBe(3);
  });
});

/** The first real reading's status as a replay of it gives, with every time moved later by seconds. */
function firstStatus(seconds: number): NetworkStatus {
  const later = (t: string | null) => (t === null ? null : new Date(Date.parse(t) + seconds * 1000).toISOString());
  const s = json<Snapshot>(FIRST, "snapshot.json").status;
  return {
    ...s,
    trust: "fixture",
    observed_at: later(s.observed_at) as string,
    rpc: { ...s.rpc, observed_at: later(s.rpc.observed_at) },
    gateway: { ...s.gateway, observed_at: later(s.gateway.observed_at) },
    faucet: { ...s.faucet, observed_at: later(s.faucet.observed_at) },
  };
}

const F = "0x39ec5c58218ed6f195942411d94a1d7d1198a3c8421f0eaf5a3f68ff7b31a23f";
const OTHER = "0x" + "5e".repeat(32);

/** Each synthetic second reading: its status on top of the first real reading, and its exit code. */
const SECONDS: [string, NetworkStatus, number][] = [
  [
    "memory-finalized-below-floor",
    {
      ...firstStatus(1800),
      reset_detected: null,
      conflicts: ["finalized height went backwards from 3457487 to 3457477 on the same genesis"],
      finalized_height: 3457477,
      finalized_hash: "0x" + "f1".repeat(32),
      best_height: 3457481,
      rpc: { ...firstStatus(1800).rpc, health: "degraded", detail: "finalized height went backwards", stale: false },
    },
    EXIT.reset,
  ],
  [
    "memory-changed-hash",
    {
      ...firstStatus(1800),
      reset_detected: null,
      conflicts: ["finalized block 3457487 changed hash since the previous snapshot"],
      finalized_hash: "0x" + "c4".repeat(32),
      // The stuck check runs on a head that changed its hash too (RULES.md 1.1).
      rpc: { ...firstStatus(1800).rpc, health: "degraded", detail: "finalized block changed; finalized height stuck at 3457487 for 1806s", stale: true },
    },
    EXIT.reset,
  ],
  [
    "memory-best-below-floor",
    {
      ...firstStatus(1800),
      reset_detected: null,
      conflicts: [
        "best block 3457400 is below the finalized height 3457487 an earlier snapshot saw on this genesis",
        "best block 3457400 is more than 30 blocks below the best block 3457491 an earlier snapshot saw on this genesis",
      ],
      finalized_height: null,
      finalized_hash: null,
      best_height: 3457400,
      finality_lag: null,
      runtime_version: null,
      rpc: {
        ...firstStatus(1800).rpc,
        health: "degraded",
        detail: "best height is below an earlier finalized height; best height fell further than the lag limit below an earlier best height; no valid finalized head",
        stale: false,
      },
    },
    EXIT.reset,
  ],
  [
    "memory-stuck",
    {
      ...firstStatus(600),
      // Stuck past the stale limit: never known not to be stuck, so never false, and no conflict.
      reset_detected: null,
      rpc: { ...firstStatus(600).rpc, health: "degraded", detail: "finalized height stuck at 3457487 for 606s", stale: true },
    },
    EXIT.ok,
  ],
  [
    "memory-rpc-down",
    {
      ...firstStatus(900),
      genesis: { ...firstStatus(0).genesis, rpc: null },
      reset_detected: null,
      finalized_height: null,
      finalized_hash: null,
      best_height: null,
      finality_lag: null,
      runtime_version: null,
      rpc: {
        ...firstStatus(900).rpc,
        health: "down",
        detail: "chain_getBlockHash(0): rpc socket error; chain_getFinalizedHead(): rpc socket error; chain_getHeader(): rpc socket error",
        stale: null,
      },
    },
    EXIT.ok,
  ],
  [
    "memory-other-genesis",
    {
      ...firstStatus(1800),
      genesis: { pinned: firstStatus(0).genesis.pinned, faucet: OTHER, rpc: OTHER },
      reset_detected: true,
      finalized_height: 120,
      finalized_hash: "0x" + "a0".repeat(32),
      best_height: 124,
    },
    EXIT.reset,
  ],
];

describe("synthetic second readings on top of the first real one", () => {
  it("every memory fixture is a tape marked synthetic, and every one has a case here", () => {
    const dirs = readdirSync(FIXTURES).filter((d) => d.startsWith("memory-")).sort();
    expect(dirs).toEqual(SECONDS.map(([n]) => n).sort());
    for (const d of dirs) {
      expect([json(d, "meta.json").scenario, json(d, "meta.json").synthetic], d).toEqual([d, true]);
      expect(readdirSync(new URL(`${d}/`, FIXTURES)).sort(), d).toEqual(["meta.json", "tape.jsonl"]);
    }
  });

  it.each(SECONDS)("%s: the whole status and the exit code, with the snapshot following the log's last line", async (name, status, code) => {
    const first = json<Snapshot>(FIRST, "snapshot.json");
    const { r, runJson } = await run(name, publishedLog(FIRST));
    const s = r.snapshot as Snapshot;
    expect(s.status).toEqual(status);
    expect([r.code, runJson.exit_code, s.seq, s.prev_hash]).toEqual([code, code, 1, first.hash]);
    expect(checkSnapshot(s)).toEqual([]);
  });

  it.each(SECONDS.filter(([n]) => n !== "memory-other-genesis"))("%s: without the log, the same tape raises nothing against history", async (name) => {
    const { r } = await run(name, join(box, "no-log"));
    const s = r.snapshot as Snapshot;
    expect(s.status.conflicts).toEqual([]);
    expect([s.seq, s.prev_hash]).toEqual([0, null]);
    expect(s.status.rpc.detail ?? "").not.toMatch(/earlier|stuck|changed|backwards/);
  });

  it("a reading in between with the RPC down hides nothing: the floor is the first reading's, not the last line's", async () => {
    const log = publishedLog(FIRST);
    const down = await run("memory-rpc-down", log);
    publish(down.out, log);
    const { r } = await run("memory-finalized-below-floor", log);
    const s = r.snapshot as Snapshot;
    expect([r.code, s.seq, s.status.conflicts]).toEqual([EXIT.reset, 2, ["finalized height went backwards from 3457487 to 3457477 on the same genesis"]]);
  });

  it("another genesis after a logged one: the logged heads set no floor on the new chain, and the log still chains", async () => {
    const log = publishedLog(FIRST);
    const { out, r } = await run("memory-other-genesis", log);
    // Finalized 120 under a floor of 3457487 is no rollback: the floor is per genesis.
    expect((r.snapshot as Snapshot).status.conflicts).toEqual([]);
    publish(out, log);
    expect(readHistory(log).snapshots.length).toBe(2);
  });
});

describe("a published log the run cannot build on", () => {
  /** The first real reading and one more after it, in a log of one day file. */
  async function twoLines(): Promise<string> {
    const log = publishedLog(FIRST);
    const { out } = await run(SECOND, log, "second");
    publish(out, log);
    return log;
  }

  /** A run on the log given that must be refused: no network read, no snapshot, and why in run.json. */
  async function refused(log: string, state: string, detail: string) {
    let reads = 0;
    const counting: Transport = { ...asLive(tapeOf(SECOND)), rpc: async () => (reads++, null), httpGet: async () => (reads++, { http: null, body: null, error: "x", fetched_at: null }) };
    const { out, r, runJson } = await run(SECOND, log, "refused", counting);
    expect([r.code, r.snapshot, r.notice, reads]).toEqual([EXIT.crashed, null, null, 0]);
    expect(r.reason).toBe(`the published log was refused (${state}), so nothing was read and no snapshot was written: ${detail}`);
    expect(readdirSync(out).sort()).toEqual(["SHA256SUMS", "run.json", "tape.jsonl"]);
    expect(readFileSync(join(out, "tape.jsonl"), "utf8")).toBe('{"schema":"flop-observatory/tape@0"}\n');
    expect(runJson).toMatchObject({ schema: RUN_SCHEMA, exit_code: EXIT.crashed, snapshot_hash: null, history: { state, detail, files: 0, snapshots: 0, last_hash: null } });
  }

  it("broken (synthetic): an edited line fails its hash check, and the run never starts a new log over it", async () => {
    const log = await twoLines();
    const text = readFileSync(join(log, DAY), "utf8");
    writeFileSync(join(log, DAY), text.replace('"best_height":3457491', '"best_height":3457492'));
    await refused(log, "broken", `${DAY} line 0 fails its hash check`);
  });

  it("broken (synthetic): a line removed from the middle of the chain", async () => {
    const log = await twoLines();
    const { out } = await run("memory-stuck", log, "third");
    publish(out, log);
    const lines = readFileSync(join(log, DAY), "utf8").split("\n");
    writeFileSync(join(log, DAY), [lines[0], lines[2], ""].join("\n"));
    await refused(log, "broken", `${DAY} line 1 has seq 2, not 1`);
  });

  it("broken (synthetic): a first run's line laid on a log that already has a chain", async () => {
    const log = await twoLines();
    const { out } = await run("memory-stuck", join(box, "no-log"), "fresh");
    publish(out, log);
    await refused(log, "broken", `${DAY} line 2 has seq 0, not 2`);
  });

  it("unreadable: a line cut short, and a file that is no day file", async () => {
    const log = await twoLines();
    const text = readFileSync(join(log, DAY), "utf8");
    writeFileSync(join(log, DAY), text.slice(0, -1));
    await refused(log, "unreadable", `${DAY} line 1 does not end with a newline (a line cut short)`);
    rmSync(join(box, "runs", "refused"), { recursive: true });
    writeFileSync(join(log, DAY), text);
    writeFileSync(join(log, "notes.txt"), "x");
    await refused(log, "unreadable", 'the log folder holds "notes.txt", which is no <UTC date>.jsonl day file');
  });

  it("unchecked: a line in the chain that is no snapshot this code can check", async () => {
    const log = join(box, "log");
    mkdirSync(log);
    const first = json<Snapshot>(FIRST, "snapshot.json");
    const odd = { ...first, schema: "flop-observatory/snapshot@9" } as unknown as Snapshot;
    writeFileSync(join(log, DAY), logLine({ ...odd, hash: hashSnapshot(odd) }));
    const h = readHistory(log);
    await refused(log, "unchecked", h.detail);
    expect(h.detail).toMatch(/^line 0 of the log, counted across its day files, is no snapshot this code can check: it breaks /);
  });

  it("absent and empty are first runs, and say so", async () => {
    const absent = await run(SECOND, join(box, "nothing"), "absent");
    expect([absent.r.code, (absent.r.snapshot as Snapshot).seq, absent.runJson.history]).toEqual([
      EXIT.ok,
      0,
      { state: "absent", detail: "the log folder does not exist, so this is a first run", files: 0, snapshots: 0, last_hash: null },
    ]);
    const log = join(box, "empty");
    mkdirSync(log);
    const empty = await run(SECOND, log, "empty");
    expect([empty.r.code, (empty.r.snapshot as Snapshot).seq, empty.runJson.history]).toEqual([
      EXIT.ok,
      0,
      { state: "empty", detail: "the log folder holds no snapshot, so this snapshot starts the log", files: 0, snapshots: 0, last_hash: null },
    ]);
  });
});

describe("the reader contract over a reading built on the log", () => {
  /** The output folder of the second real reading built on the first, as a consumer holds latest/. */
  async function latest(): Promise<Record<string, string>> {
    const { out } = await run(SECOND, publishedLog(FIRST), "latest", asLive(tapeOf(SECOND)));
    return Object.fromEntries(readdirSync(out).map((n) => [n, readFileSync(join(out, n), "utf8")]));
  }
  const NOW = "2026-11-11T08:30:00.000Z";

  it("uses it: the log line is the snapshot's one line, with its seq and prev_hash, and run.json names the line it follows", async () => {
    const f = await latest();
    const j = judgeLatest(f, { now: NOW, maxAgeSeconds: 3600 });
    expect(j.usable).toBe(true);
    const s = (j as { snapshot: Snapshot }).snapshot;
    expect([s.seq, s.prev_hash, f["snapshots.jsonl"]]).toEqual([1, json<Snapshot>(FIRST, "snapshot.json").hash, logLine(s)]);
  });

  it("refuses a run.json that names no log, or another line, than the one the snapshot follows", async () => {
    const f = await latest();
    const runJson = JSON.parse(f["run.json"] as string) as Record<string, Record<string, unknown>>;
    const { feedText } = await import("../src/feed.js");
    const { sumsOf } = await import("../src/sums.js");
    const { PUBLISHED_FILES } = await import("../src/published.js");
    const withHistory = (history: unknown) => {
      const g = { ...f, "run.json": feedText({ ...runJson, history }) };
      return judgeLatest({ ...g, SHA256SUMS: sumsOf(PUBLISHED_FILES.map((n) => [n, g[n] as string] as const)) }, { now: NOW, maxAgeSeconds: 3600 });
    };
    const why = { usable: false, refused: ["run.json does not name the published log the snapshot follows"] };
    expect(withHistory({ ...runJson.history, last_hash: "0".repeat(64) })).toEqual(why);
    expect(withHistory({ ...runJson.history, state: "absent" })).toEqual(why);
    expect(withHistory({ ...runJson.history, state: "broken" })).toEqual(why);
    expect(withHistory(null)).toEqual(why);
    expect(withHistory(runJson.history).usable).toBe(true);
  });
});
