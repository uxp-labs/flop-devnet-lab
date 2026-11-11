// The anchor and the spec floor through a live run (RULES.md 1.1 and section 7): synthetic second
// readings (fixtures/anchor-*, marked synthetic, each holding the anchor call a run on a log makes)
// on top of the first real reading, and the real readings from the data branch (fixtures/published-*).
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { earlierOf, readHistory } from "../src/history.js";
import { runLive } from "../src/live-run.js";
import { EXIT } from "../src/run-command.js";
import { judgeLatest } from "../src/published.js";
import { checkSnapshot } from "../src/snapshot-check.js";
import { DEVNET_GENESIS } from "../src/status.js";
import { hashSnapshot, logLine } from "../src/store.js";
import { TapeTransport } from "../src/tape.js";
import type { Transport } from "../src/transport.js";
import type { NetworkStatus, Snapshot } from "../src/types.js";
import { anchoredAs, answeringAnchor } from "./helpers/tapes.js";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const fixture = (dir: string, name: string) => readFileSync(new URL(`${dir}/${name}`, FIXTURES), "utf8");
const json = <T = Record<string, unknown>>(dir: string, name: string) => JSON.parse(fixture(dir, name)) as T;
const FIRST = "published-2026-11-11-0808";
const SECOND = "published-2026-11-11-0823";
const NOON = "published-2026-11-11-1206";
const LATE = "published-2026-11-11-1239";
const DAY = "2026-11-11.jsonl";
const CLOCK = () => "2026-11-11T13:00:00.000Z";

let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "obs-anchor-"));
});
afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

const tapeOf = (dir: string) => TapeTransport.parse(fixture(dir, "tape.jsonl"), `tape:${dir}`);
/** A transport that answers from a tape but says it is the network, as the live one does. */
function asLive(inner: Transport): Transport {
  return { trust: "trusted RPC", label: "rpc wss://rpc.devnet.flop.network", rpc: (m, p) => inner.rpc(m, p), httpGet: (u) => inner.httpGet(u), now: () => inner.now(), close: () => inner.close() };
}

let serial = 0;
/** One run of a transport into a new folder, on the log folder given. */
async function run(transport: Transport, log: string) {
  const out = join(box, "runs", String(++serial));
  const r = await runLive(transport, { out, log, sourceSha: null, clock: CLOCK });
  return { out, r, s: r.snapshot as Snapshot };
}

/** A log folder holding the given day file text. */
function logOf(text: string): string {
  const log = join(box, `log-${++serial}`);
  mkdirSync(log, { recursive: true });
  writeFileSync(join(log, DAY), text);
  return log;
}
/** What the publish job does with a run's output: append its one line to the day file. */
const publish = (out: string, log: string) => appendFileSync(join(log, DAY), readFileSync(join(out, "snapshots.jsonl")));

const F = "0x39ec5c58218ed6f195942411d94a1d7d1198a3c8421f0eaf5a3f68ff7b31a23f";
const LOST = "the finalized chain is not the one the log saw";
const was = `finalized block 3457487 was ${F} when an earlier snapshot logged it, and the node now`;
const NOT_ON_CHAIN = "the finalized block an earlier snapshot logged at 3457487 is not on the node's chain";

/** The first real reading's status as a replay gives it, every time moved 1800 s on, and the chain gone on to block 3457787. */
function wentOn(): NetworkStatus {
  const later = (t: string | null) => (t === null ? null : new Date(Date.parse(t) + 1800_000).toISOString());
  const s = json<Snapshot>(FIRST, "snapshot.json").status;
  return {
    ...s,
    trust: "fixture",
    observed_at: later(s.observed_at) as string,
    finalized_height: 3457787,
    finalized_hash: "0x" + "d1".repeat(32),
    best_height: 3457791,
    finality_lag: 4,
    rpc: { ...s.rpc, observed_at: later(s.rpc.observed_at) },
    gateway: { ...s.gateway, observed_at: later(s.gateway.observed_at) },
    faucet: { ...s.faucet, observed_at: later(s.faucet.observed_at) },
  };
}

/** Each synthetic reading on top of the first real one: its whole status and its exit code. */
const CASES: [string, NetworkStatus, number][] = [
  // The node still holds the logged block under the logged hash: nothing changes.
  ["anchor-same", { ...wentOn(), reset_detected: false }, EXIT.ok],
  [
    "anchor-other-hash",
    {
      ...wentOn(),
      reset_detected: true,
      conflicts: [`${was} gives ${"0x" + "e2".repeat(32)} at that height: ${LOST}`],
      rpc: { ...wentOn().rpc, health: "degraded", detail: NOT_ON_CHAIN },
    },
    EXIT.reset,
  ],
  [
    "anchor-gone",
    {
      ...wentOn(),
      reset_detected: true,
      conflicts: [`${was} has no block at that height: ${LOST}`],
      rpc: { ...wentOn().rpc, health: "degraded", detail: NOT_ON_CHAIN },
    },
    EXIT.reset,
  ],
  [
    "anchor-read-failed",
    {
      ...wentOn(),
      // No verdict: never false, and no conflict.
      reset_detected: null,
      rpc: {
        ...wentOn().rpc,
        health: "unknown",
        detail:
          "the anchor, finalized block 3457487 an earlier snapshot logged, could not be read back (chain_getBlockHash(3457487): rpc chain_getBlockHash timed out after 15000 ms), so whether the finalized chain is the one the log saw is unknown",
      },
    },
    EXIT.ok,
  ],
  [
    "anchor-spec-below-floor",
    {
      ...wentOn(),
      reset_detected: null,
      conflicts: ["runtime version 1014013 is below the version 1014014 an earlier snapshot saw on this genesis"],
      runtime_version: 1014013,
      rpc: { ...wentOn().rpc, health: "degraded", detail: "runtime version went backwards" },
    },
    EXIT.reset,
  ],
  // An upgrade: no conflict, and nothing else changes.
  ["anchor-spec-above-floor", { ...wentOn(), reset_detected: false, runtime_version: 1014015 }, EXIT.ok],
];

describe("the anchor and the spec floor, over synthetic tapes on top of the first real reading", () => {
  it("every anchor fixture is a tape marked synthetic, and every one has a case here", () => {
    const dirs = readdirSync(FIXTURES).filter((d) => d.startsWith("anchor-")).sort();
    expect(dirs).toEqual(CASES.map(([n]) => n).sort());
    for (const d of dirs) {
      expect([json(d, "meta.json").scenario, json(d, "meta.json").synthetic], d).toEqual([d, true]);
      expect(readdirSync(new URL(`${d}/`, FIXTURES)).sort(), d).toEqual(["meta.json", "tape.jsonl"]);
    }
  });

  it.each(CASES)("%s: the whole status and the exit code; the run makes exactly the tape's requests, the anchor call among them", async (name, status, code) => {
    const first = json<Snapshot>(FIRST, "snapshot.json");
    const t = tapeOf(name);
    const { out, r, s } = await run(t, logOf(fixture(FIRST, `log/${DAY}`)));
    expect(s.status).toEqual(status);
    expect([r.code, s.seq, s.prev_hash]).toEqual([code, 1, first.hash]);
    // The snapshot passes every check the reader holds it to, a lost anchor's reset included.
    expect(checkSnapshot(s)).toEqual([]);
    expect([t.remaining(), readFileSync(join(out, "tape.jsonl"), "utf8")]).toEqual([0, fixture(name, "tape.jsonl")]);
  });

  it.each(CASES)("%s: beside a reading in between with the RPC down, the anchor is still the first reading's block, and the status the same", async (name, status, code) => {
    const log = logOf(fixture(FIRST, `log/${DAY}`));
    const down = await run(anchoredAs("memory-rpc-down", tapeOf("memory-rpc-down")), log);
    expect([down.r.code, down.s.status.finalized_height, down.s.status.reset_detected]).toEqual([EXIT.ok, null, null]);
    publish(down.out, log);
    expect(earlierOf(readHistory(log).snapshots, DEVNET_GENESIS).anchor).toEqual({ height: 3457487, hash: F });
    const { r, s } = await run(tapeOf(name), log);
    expect(s.status).toEqual(status);
    expect([r.code, s.seq, s.prev_hash]).toEqual([code, 2, down.s.hash]);
  });

  it("on no log, a tape that holds an anchor call is refused: a first run makes none, and a replay never skips a request", async () => {
    const { r } = await run(tapeOf("anchor-same"), join(box, "no-log"));
    expect([r.code, r.snapshot]).toEqual([EXIT.crashed, null]);
    expect(r.reason).toBe("the run broke before a snapshot was written: request 10 is the clock, but the next one on the tape is rpc chain_getBlockHash [3457487]");
  });

  it("a lost anchor's reading is published and read back: the reader serves it, and the next run builds on it", async () => {
    const log = logOf(fixture(FIRST, `log/${DAY}`));
    // Replayed as the network would answer, so its trust is the one the reader asks for.
    const { out, s } = await run(asLive(tapeOf("anchor-gone")), log);
    expect([s.status.reset_detected, s.trust]).toEqual([true, "trusted RPC"]);
    const files = Object.fromEntries(readdirSync(out).map((n) => [n, readFileSync(join(out, n), "utf8")]));
    const j = judgeLatest(files, { now: "2026-11-11T08:40:00.000Z", maxAgeSeconds: 3600 });
    expect([j.usable, (j as { snapshot?: Snapshot }).snapshot?.hash]).toEqual([true, s.hash]);
    publish(out, log);
    const h = readHistory(log);
    expect([h.state, h.snapshots.at(-1)?.hash]).toEqual(["read", s.hash]);
    // Its own finalized head, block 3457787, is the next run's anchor.
    expect(earlierOf(h.snapshots, DEVNET_GENESIS).anchor).toEqual({ height: 3457787, hash: "0x" + "d1".repeat(32) });
  });
});

describe("the real readings on the data branch, and the anchor", () => {
  it.each([FIRST, SECOND])("%s: a first run's tape, replayed on a log that names an anchor, is refused at the anchor call it does not hold", async (dir) => {
    const { r } = await run(tapeOf(dir), logOf(fixture(FIRST, `log/${DAY}`)));
    expect([r.code, r.snapshot]).toEqual([EXIT.crashed, null]);
    expect(r.reason).toBe("the run broke before a snapshot was written: request 10 is rpc chain_getBlockHash [3457487], but the next one on the tape is the clock");
  });

  const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

  it.each([
    [NOON, 1, "down", null, 5],
    [LATE, 2, "ok", 3473481, 6],
  ] as const)("%s: is marked real, with its provenance, and every kept file matches the SHA256SUMS the workflow wrote", (dir, seq, rpc, height, before) => {
    const meta = json<{ scenario: string; synthetic: unknown; now: string; provenance: Record<string, unknown> }>(dir, "meta.json");
    expect([meta.scenario, meta.synthetic]).toEqual([dir, false]);
    expect(readdirSync(new URL(`${dir}/`, FIXTURES)).sort()).toEqual(["SHA256SUMS", "log", "meta.json", "run.json", "snapshot.json", "tape.jsonl"]);
    const sums = fixture(dir, "SHA256SUMS").split("\n");
    for (const f of ["run.json", "snapshot.json", "tape.jsonl"]) expect(sums, f).toContain(`${sha256(fixture(dir, f))}  ${f}`);
    expect(meta.provenance.tape_sha256).toBe(sha256(fixture(dir, "tape.jsonl")));
    const snap = json<Snapshot>(dir, "snapshot.json");
    const runJson = json<Record<string, unknown> & { history: Record<string, unknown> }>(dir, "run.json");
    expect([snap.hash, checkSnapshot(snap)]).toEqual([hashSnapshot(snap), []]);
    expect([meta.provenance.snapshot_hash, runJson.snapshot_hash, meta.now]).toEqual([snap.hash, snap.hash, snap.observed_at]);
    // Built on the readings before it by the memory step, which read no anchor back.
    expect([snap.seq, snap.status.rpc.health, snap.status.finalized_height, runJson.exit_code, runJson.history.snapshots]).toEqual([seq, rpc, height, 0, before]);
    // The day file as the data branch held it ends with this reading's line.
    expect(fixture(dir, `log/${DAY}`).endsWith(logLine(snap))).toBe(true);
  });

  it(`${LATE}: replayed on the log it was read on, with the anchor (block 3469732) answered with the hash the log holds (synthetic), gives the recorded status but for its trust`, async () => {
    const lines = fixture(LATE, `log/${DAY}`).split("\n");
    const recorded = json<Snapshot>(LATE, "snapshot.json");
    const logged = "0x01480d968331997ce13e0c949f9879fdb2193693f24f18c51efaf7e949a40794";
    const bare = await run(tapeOf(LATE), logOf(lines.slice(0, -2).join("\n") + "\n"));
    expect(bare.r.reason).toBe("the run broke before a snapshot was written: request 10 is rpc chain_getBlockHash [3469732], but the next one on the tape is the clock");
    const { r, s } = await run(answeringAnchor(tapeOf(LATE), (h) => ({ result: h === 3469732 ? logged : null })), logOf(lines.slice(0, -2).join("\n") + "\n"));
    expect(s.status).toEqual({ ...recorded.status, trust: "fixture" });
    expect([r.code, s.seq, s.prev_hash, s.status.reset_detected]).toEqual([EXIT.ok, 2, recorded.prev_hash, false]);
  });

  it(`${NOON}: the run that made it read no anchor; replayed on the log it was read on, the replay asks for the anchor the tape does not hold`, async () => {
    const lines = fixture(NOON, `log/${DAY}`).split("\n");
    const before = lines.slice(0, -2).join("\n") + "\n";
    const { r } = await run(tapeOf(NOON), logOf(before));
    expect(r.reason).toBe("the run broke before a snapshot was written: request 8 is rpc chain_getBlockHash [3469732], but the next one on the tape is the clock");
  });

  it(`${NOON}: with that call answered as the socket answered every other (synthetic), the replay gives the recorded status, and says the anchor could not be read`, async () => {
    const lines = fixture(NOON, `log/${DAY}`).split("\n");
    const recorded = json<Snapshot>(NOON, "snapshot.json");
    const socket = "rpc socket error: Received network error or non-101 status code.";
    const { r, s } = await run(answeringAnchor(tapeOf(NOON), () => ({ error: socket })), logOf(lines.slice(0, -2).join("\n") + "\n"));
    expect(s.status).toEqual({
      ...recorded.status,
      trust: "fixture",
      rpc: {
        ...recorded.status.rpc,
        detail: `${recorded.status.rpc.detail}; the anchor, finalized block 3469732 an earlier snapshot logged, could not be read back (chain_getBlockHash(3469732): ${socket}), so whether the finalized chain is the one the log saw is unknown`,
      },
    });
    expect([r.code, s.seq, s.prev_hash, s.status.reset_detected]).toEqual([EXIT.ok, 1, recorded.prev_hash, null]);
  });

  it("the log as the data branch held it at 12:06: the next run reads back block 3469732, the latest finalized head on the pinned genesis, past the reading with the RPC down", () => {
    const h = readHistory(logOf(fixture(NOON, `log/${DAY}`)));
    expect([h.state, h.snapshots.length]).toEqual(["read", 6]);
    expect(earlierOf(h.snapshots, DEVNET_GENESIS).anchor).toEqual({ height: 3469732, hash: "0x01480d968331997ce13e0c949f9879fdb2193693f24f18c51efaf7e949a40794" });
  });

  it("the log as the data branch holds it now, ending with the memory step's reading at 12:39: the next run reads back that reading's finalized head, block 3473481", async () => {
    const log = logOf(fixture(LATE, `log/${DAY}`));
    const h = readHistory(log);
    expect([h.state, h.snapshots.length]).toEqual(["read", 7]);
    const anchor = earlierOf(h.snapshots, DEVNET_GENESIS).anchor;
    expect(anchor).toEqual({ height: 3473481, hash: "0x32f70298f8a58b4645f8258ded9c8bd063da07d0d241b5e662f95f623ae8ddca" });
    // The request it makes, after the head calls: the one call a tape of the next run holds that no earlier tape does.
    const calls: string[] = [];
    const t = anchoredAs(SECOND, tapeOf(SECOND));
    const spy: Transport = { ...t, rpc: (m, p) => (calls.push(`${m} ${JSON.stringify(p)}`), m === "chain_getBlockHash" && p[0] === 3473481 ? Promise.resolve(anchor?.hash) : t.rpc(m, p)) };
    await run(spy, log);
    expect(calls.at(-1)).toBe("chain_getBlockHash [3473481]");
  });
});
