// Independent review of the upgrade watch (review round 26, brief 2026-11-12-review-upgrade-watch).
// Written by the reviewer, who wrote none of the code under review. A test named HELD passes and shows
// a promise held under attack. The two DEFECT tests failed on the branch as reviewed; the lead's rules
// F1 and F2 fixed both, and each is now named "review defect n, fixed". Values come from research/2026-11-12-runtime-upgrade/results.json through
// test/helpers/upgrade.ts, and from the public data branch observatory-data at 392fa7b, copied
// unchanged into fixtures/observatory-data-392fa7b (log/ and latest/, no recordings; its meta.json
// names each file's sha256, held by test/upgrade-live.test.ts).
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { feedFiles, feedText, upgradeFeed } from "../src/feed.js";
import { earlierOf, readHistory } from "../src/history.js";
import { noticeLine, runLive } from "../src/live-run.js";
import { handleMcp } from "../src/mcp.js";
import { renderPage } from "../src/page.js";
import { judgeLatest } from "../src/published.js";
import { EXIT } from "../src/run-command.js";
import { runtimeOfBlock } from "../src/scale/block.js";
import { toHex } from "../src/scale/reader.js";
import { checkSnapshot } from "../src/snapshot-check.js";
import { DEVNET_GENESIS } from "../src/status.js";
import { hashSnapshot, logLine } from "../src/store.js";
import { TapeTransport } from "../src/tape.js";
import type { Transport } from "../src/transport.js";
import type { Snapshot, UpgradeWatch } from "../src/types.js";
import { DETAIL, UPGRADE_KEYS, type UpgradeReading, watchUpgrade } from "../src/upgrade-watch.js";
import { cat, compact, str } from "./helpers/scale-write.js";
import { answeringUpgrade } from "./helpers/tapes.js";
import { AUTHORIZED_BYTES, FIRST_NEW, LAST_OLD, NOT_REVIEWED, RESULTS, SHA, readingAt } from "./helpers/upgrade.js";

const FIXTURES = new URL("../fixtures/", import.meta.url);
const fixture = (dir: string, name: string) => readFileSync(new URL(`${dir}/${name}`, FIXTURES), "utf8");
const DATA = new URL("../fixtures/observatory-data-392fa7b/", import.meta.url);
const data = (name: string) => readFileSync(new URL(name, DATA), "utf8");
const DAY = "2026-11-11.jsonl";

let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "obs-review-watch-"));
});
afterEach(() => {
  rmSync(box, { recursive: true, force: true });
});

function asLive(inner: Transport): Transport {
  return { trust: "trusted RPC", label: "rpc wss://rpc.devnet.flop.network", rpc: (m, p) => inner.rpc(m, p), httpGet: (u) => inner.httpGet(u), now: () => inner.now(), close: () => inner.close() };
}
let serial = 0;
async function run(transport: Transport, log: string) {
  const out = join(box, "runs", String(++serial));
  const r = await runLive(transport, { out, log, sourceSha: null, clock: () => "2026-11-11T13:00:00.000Z" });
  return { out, r, s: r.snapshot as Snapshot };
}
const outFiles = (out: string) => Object.fromEntries(readdirSync(out).map((n) => [n, readFileSync(join(out, n), "utf8")]));

/** A synthetic tape with the answer of one storage read replaced: key is the storage key read. */
function tapeWith(dir: string, answers: { lru?: unknown; au?: unknown }): TapeTransport {
  const lines = fixture(dir, "tape.jsonl").trimEnd().split("\n").map((l) => JSON.parse(l));
  for (const x of lines) {
    const p = x.request?.params;
    if (x.request?.method !== "state_getStorage") continue;
    if (p[0] === UPGRADE_KEYS.lastRuntimeUpgrade && answers.lru !== undefined) x.answer = answers.lru;
    if (p[0] === UPGRADE_KEYS.authorizedUpgrade && answers.au !== undefined) x.answer = answers.au;
  }
  return TapeTransport.parse(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", `tape:${dir}`);
}
/** A whole LastRuntimeUpgrade record of a spec name and version, as hex. */
const recordHex = (name: string, version: number) => toHex(cat(compact(version), str(name)));

/** Every output a reader sees of a live run but the tape, which keeps the answers by design. */
function surfaces(out: string, s: Snapshot, notice: string): Record<string, string> {
  const f = outFiles(out);
  delete f["tape.jsonl"];
  const mcp = handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_upgrade", arguments: {} } }, { snapshot: s }) as { result: { content: { text: string }[] } };
  return { ...f, "index.html": renderPage(s), notice, get_upgrade: mcp.result.content[0]?.text as string };
}

// ===== A. Hostile text (P4) =====

const HOSTILE_NAMES: [string, string][] = [
  ["a newline then a workflow error command", "tzkv-runtime\n::error::the watch was forged"],
  ["a carriage return then set-output", "x\r::set-output name=publish::true"],
  ["a percent encoded newline", "x%0A::error::forged"],
  ["HTML", '<script>alert(1)</script><img src=x onerror="y">'],
  ["a NUL", "tzkv\u0000runtime"],
  ["256 characters", "a".repeat(256)],
  ["a look alike of tzkv-runtime", "tzkv‐runtime"],
  ["a line separator", "tzkv ::error::x"],
];

describe("A. hostile text in a spec name or a node's error (P4)", () => {
  it.each(HOSTILE_NAMES)("HELD: a spec name with %s is kept as data, bounded, and escaped on every surface", async (_why, name) => {
    const { out, r, s } = await run(asLive(tapeWith("upgrade-not-reviewed", { lru: { result: recordHex(name, 1014021) } })), join(box, "no-log"));
    expect(r.code).toBe(EXIT.ok);
    expect(s.upgrade?.executing).toEqual({ state: "not reviewed", spec_name: name, spec_version: 1014021, detail: DETAIL.notReviewed });
    const notice = r.notice as string;
    // The notice is one line, a GitHub command only at its start.
    expect(notice.split(/\r|\n/)).toHaveLength(1);
    expect(notice.startsWith("::notice title=networkStatus::")).toBe(true);
    expect(notice.indexOf("::", 2)).toBe("::notice title=networkStatus".length);
    const all = surfaces(out, s, notice);
    // The page escapes HTML; every JSON file and the notice escape a line break; JSON keeps the name as data.
    expect(all["index.html"]?.includes("<script>")).toBe(false);
    for (const [n, t] of Object.entries(all)) if (n !== "index.html") expect([t.includes("\n::"), t.includes("\r")], n).toEqual([false, false]);
    expect(checkSnapshot(s)).toEqual([]);
    expect(judgeLatest(outFiles(out), { now: s.observed_at, maxAgeSeconds: 3600 })).toMatchObject({ usable: true });
  });

  it("HELD: a spec name past 256 characters is no record: unknown, and the name reaches no surface", async () => {
    const name = "Q".repeat(257);
    const { out, r, s } = await run(asLive(tapeWith("upgrade-not-reviewed", { lru: { result: recordHex(name, 1014021) } })), join(box, "no-log"));
    expect([s.upgrade?.executing.state, s.upgrade?.executing.spec_name]).toEqual(["unknown", null]);
    for (const [n, t] of Object.entries(surfaces(out, s, r.notice as string))) expect(t.includes("Q".repeat(40)), n).toBe(false);
  });

  it("HELD: a node error whose message carries a command, HTML and a NUL reaches no surface but the tape", async () => {
    const msg = "boom\n::error::forged <b>x</b> \u0000 %0A";
    const { out, r, s } = await run(asLive(tapeWith("upgrade-before", { lru: { error: msg }, au: { error: msg } })), join(box, "no-log"));
    expect([s.upgrade?.executing.detail, s.upgrade?.authorized.detail]).toEqual([DETAIL.lruFailed, DETAIL.auFailed]);
    for (const [n, t] of Object.entries(surfaces(out, s, r.notice as string))) expect(t.includes("forged"), n).toBe(false);
    expect(readFileSync(join(out, "tape.jsonl"), "utf8").includes("forged")).toBe(true);
  });

  it("HELD: the refusal runtimeOfBlock gives for no record names positions and lengths, never the bytes", () => {
    const tail = cat(compact(1014014), str("tzkv-runtime"), str("<script>"));
    const r = runtimeOfBlock(tail);
    expect(r.found).toBe(false);
    if (!r.found) expect([r.named, r.refused.includes("script")]).toEqual([null, false]);
  });
});

// ===== B. Unknown is not absent (P2, P6) =====

const AT = "0x" + "d1".repeat(32);
const G = DEVNET_GENESIS;
const read = (lru: { result: unknown } | { error: string }, au: { result: unknown } | { error: string }, n: number | null = 10): UpgradeReading => ({
  hash: AT,
  number: n,
  observedAt: "2026-11-12T04:04:20.000Z",
  trust: "fixture",
  lastRuntimeUpgrade: lru,
  authorizedUpgrade: au,
});
const MIB_HEX = "0x" + "ab".repeat(512 * 1024);
/** [what, answer, the executing state it gives, the authorised state it gives]. */
const ANSWERS: [string, { result: unknown } | { error: string }, string, string][] = [
  ["a timeout", { error: "the rpc call state_getStorage timed out after 10000 ms" }, "unknown", "unknown"],
  ["a JSON-RPC error", { error: "rpc error -32000: State already discarded" }, "unknown", "unknown"],
  ["a number", { result: 0 }, "unknown", "unknown"],
  ["an object", { result: { value: "0x00" } }, "unknown", "unknown"],
  ["a list", { result: ["0x00"] }, "unknown", "unknown"],
  ["a boolean", { result: false }, "unknown", "unknown"],
  ["an empty string", { result: "" }, "unknown", "unknown"],
  ["0x", { result: "0x" }, "unknown", "present"],
  ["odd length hex", { result: "0xabc" }, "unknown", "unknown"],
  ["upper case hex", { result: AUTHORIZED_BYTES.toUpperCase().replace("0X", "0x") }, "unknown", "unknown"],
  ["no 0x", { result: AUTHORIZED_BYTES.slice(2) }, "unknown", "unknown"],
  ["1 MiB of hex", { result: MIB_HEX }, "unknown", "present"],
  ["null", { result: null }, "absent", "absent"],
];

describe("B. unknown is never absent, false or 0 (P2, P6)", () => {
  it.each(ANSWERS)("HELD: %s for each read alone and for both", (_w, a, exec, auth) => {
    const good = { result: LAST_OLD.last_runtime_upgrade.hex };
    const lruOnly = watchUpgrade({ reading: read(a, { result: null }), genesis: G, earlier: [] });
    const auOnly = watchUpgrade({ reading: read(good, a), genesis: G, earlier: [] });
    const both = watchUpgrade({ reading: read(a, a), genesis: G, earlier: [] });
    expect([lruOnly.executing.state, both.executing.state]).toEqual([exec, exec]);
    expect([auOnly.authorized.state, both.authorized.state]).toEqual([auth, auth]);
    expect(auOnly.executing.state).toBe("reviewed");
    for (const w of [lruOnly, auOnly, both]) {
      if (w.executing.state === "unknown") expect([w.executing.spec_name, w.executing.spec_version, typeof w.executing.detail]).toEqual([null, null, "string"]);
      if (w.authorized.state === "unknown") expect([w.authorized.bytes, w.authorized.length, typeof w.authorized.detail]).toEqual([null, null, "string"]);
    }
  });

  // The watch compared with, as [what, earlier list, now's reading, compared_with, executing_changed, authorization_appeared].
  const old = { result: LAST_OLD.last_runtime_upgrade.hex };
  const neu = { result: FIRST_NEW.last_runtime_upgrade.hex };
  const fail = { error: "timed out" };
  const at = (n: number, lru: { result: unknown } | { error: string }, au: { result: unknown } | { error: string }, g = G) => ({ genesis: g, watch: watchUpgrade({ reading: read(lru, au, n), genesis: g, earlier: [] }) });
  const OTHER = "0x" + "77".repeat(32);
  const ROWS: [string, ReturnType<typeof at>[], UpgradeReading, number | null, boolean | null, boolean | null][] = [
    ["none (an @0 log)", [], read(old, { result: AUTHORIZED_BYTES }), null, null, null],
    ["an unknown earlier authorisation", [at(9, old, fail)], read(old, { result: AUTHORIZED_BYTES }), 9, false, null],
    ["an unknown earlier runtime", [at(9, fail, { result: null })], read(old, { result: AUTHORIZED_BYTES }), 9, null, true],
    ["an unknown authorisation now", [at(9, old, { result: null })], read(old, fail), 9, false, null],
    ["an unknown runtime now", [at(9, old, { result: null })], read(fail, { result: null }), 9, null, false],
    ["an absent runtime before", [at(9, { result: null }, { result: null })], read(old, { result: null }), 9, null, false],
    ["the same block", [at(10, old, { result: null })], read(old, { result: AUTHORIZED_BYTES }), null, null, null],
    ["a higher block", [at(11, old, { result: null })], read(old, { result: AUTHORIZED_BYTES }), null, null, null],
    ["another genesis", [at(9, old, { result: null }, OTHER)], read(old, { result: AUTHORIZED_BYTES }), null, null, null],
    ["the same bytes", [at(9, old, { result: AUTHORIZED_BYTES })], read(old, { result: AUTHORIZED_BYTES }), 9, false, false],
    ["other bytes of the same count", [at(9, old, { result: "0x" + "00".repeat(33) })], read(old, { result: AUTHORIZED_BYTES }), 9, false, true],
    ["other bytes", [at(9, old, { result: "0x00" })], read(old, { result: AUTHORIZED_BYTES }), 9, false, true],
    ["present then absent", [at(9, old, { result: AUTHORIZED_BYTES })], read(neu, { result: null }), 9, true, false],
    ["absent then absent", [at(9, old, { result: null })], read(old, { result: null }), 9, false, false],
    ["a lower one behind a higher one", [at(8, old, { result: null }), at(12, old, { result: AUTHORIZED_BYTES })], read(old, { result: AUTHORIZED_BYTES }), 8, false, true],
    ["the latest of two lower ones", [at(8, old, { result: null }), at(9, old, { result: AUTHORIZED_BYTES })], read(old, { result: AUTHORIZED_BYTES }), 9, false, false],
    ["no height now", [at(9, old, { result: null })], read(old, { result: AUTHORIZED_BYTES }, null), null, null, null],
  ];
  it.each(ROWS)("HELD: compared with %s", (_w, earlier, reading, cw, changed, appeared) => {
    const w = watchUpgrade({ reading, genesis: G, earlier });
    expect([w.compared_with, w.executing_changed, w.authorization_appeared]).toEqual([cw, changed, appeared]);
  });

  it("HELD: on 4000 random pairs, authorization_appeared is a flag only when both sides are known, and executing_changed only when both name a runtime", () => {
    let seed = 0x5eed;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const pool = [...ANSWERS.filter((x) => x[0] !== "1 MiB of hex").map((x) => x[1]), old, neu, { result: AUTHORIZED_BYTES }, { result: "0x00" }, { result: recordHex("evil", 1) }];
    for (let i = 0; i < 4000; i++) {
      const before = watchUpgrade({ reading: read(pick(pool), pick(pool), 9), genesis: G, earlier: [] });
      const now = watchUpgrade({ reading: read(pick(pool), pick(pool), 10), genesis: G, earlier: [{ genesis: G, watch: before }] });
      const known = now.authorized.state !== "unknown" && before.authorized.state !== "unknown";
      expect(now.authorization_appeared === null, JSON.stringify([before.authorized, now.authorized])).toBe(!known);
      if (now.authorization_appeared === true) expect(now.authorized.state).toBe("present");
      const named = now.executing.spec_name !== null && before.executing.spec_name !== null;
      expect(now.executing_changed === null).toBe(!named);
    }
  });
});

// ===== C. The raw bytes (P2, P4) =====

describe("C. AuthorizedUpgrade kept as raw bytes", () => {
  // Rule F1 changed what this test holds: a present authorisation carries its length and sha256, and
  // keeps the bytes only up to 256 of them.
  it.each([0, 1, 32, 33, 34, 256, 257, 100000])("HELD: %i bytes are present with their count and sha256, never decoded, and kept only up to 256", (n) => {
    const hex = "0x" + "5a".repeat(n);
    const w = watchUpgrade({ reading: read({ result: LAST_OLD.last_runtime_upgrade.hex }, { result: hex }), genesis: G, earlier: [] });
    expect(w.authorized).toEqual(n <= 256 ? { state: "present", bytes: hex, length: n, sha256: SHA(hex), detail: null } : { state: "present", bytes: null, length: n, sha256: SHA(hex), detail: DETAIL.auNotKept });
  });

  it("review defect 1, fixed: an AuthorizedUpgrade answer of 100000 bytes keeps only its length and sha256, so the snapshot line the log keeps for ever and every feed stay small", async () => {
    const big = "0x" + "5a".repeat(100000);
    const { out, s } = await run(asLive(tapeWith("upgrade-before", { au: { result: big } })), join(box, "no-log"));
    expect(s.upgrade?.authorized.length).toBe(100000);
    // What should hold: the watch, the line and each feed stay small whatever the node answers.
    // The real value is 33 bytes; the 1 MiB answer limit is the only bound the code has now.
    const sizes = Object.fromEntries(["snapshots.jsonl", "snapshot.json", "upgrade.json"].map((n) => [n, readFileSync(join(out, n)).length]));
    for (const [n, size] of Object.entries(sizes)) expect(size, n).toBeLessThan(16 * 1024);
  });
});

// ===== D. The snapshot reader (P5) =====

describe("D. the snapshot reader", () => {
  async function honest(): Promise<Snapshot> {
    return (await run(asLive(tapeWith("upgrade-before", {})), join(box, "no-log"))).s;
  }
  const realZero = (): Snapshot => JSON.parse(data("latest/snapshot.json"));
  const rehash = (s: Record<string, unknown>) => {
    const { hash: _h, ...rest } = s;
    return { ...rest, hash: hashSnapshot(rest as unknown as Snapshot) } as unknown as Snapshot;
  };

  it("HELD: an @1 snapshot and the real @0 latest read; each variant is refused by the check and by judgeLatest", async () => {
    const s = await honest();
    expect(checkSnapshot(s)).toEqual([]);
    expect(checkSnapshot(realZero())).toEqual([]);
    const variants: [string, (x: Record<string, unknown>) => void, boolean][] = [
      ["@1 with upgrade missing", (x) => delete x.upgrade, false],
      ["@1 with one more field", (x) => (x.extra = null), false],
      ["@1 with upgrade a string", (x) => (x.upgrade = "reviewed"), false],
      ["@1 with upgrade a list", (x) => (x.upgrade = []), false],
      ["@1 with upgrade.at missing", (x) => delete (x.upgrade as Record<string, unknown>).at, false],
      ["@1 with upgrade.at.number a string", (x) => ((x.upgrade as { at: Record<string, unknown> }).at.number = "10"), false],
      ["@1 with an extra field in executing", (x) => ((x.upgrade as { executing: Record<string, unknown> }).executing.extra = 1), false],
      ["@1 with length a float", (x) => ((x.upgrade as { authorized: Record<string, unknown> }).authorized.length = 33.5), false],
      ["@1 with bytes in upper case", (x) => ((x.upgrade as { authorized: Record<string, unknown> }).authorized.bytes = AUTHORIZED_BYTES.toUpperCase().replace("0X", "0x")), false],
      ["@1 with the state in upper case", (x) => ((x.upgrade as { executing: Record<string, unknown> }).executing.state = "REVIEWED"), false],
      ["@2", (x) => (x.schema = "flop-observatory/snapshot@2"), false],
      ["@01", (x) => (x.schema = "flop-observatory/snapshot@01"), false],
      ["upper case @1", (x) => (x.schema = "FLOP-OBSERVATORY/SNAPSHOT@1"), false],
      ["@0 that carries the upgrade part", (x) => (x.schema = "flop-observatory/snapshot@0"), false],
      ["@1 with upgrade null", (x) => (x.upgrade = null), true],
    ];
    for (const [what, edit, ok] of variants) {
      const x = structuredClone(s) as unknown as Record<string, unknown>;
      edit(x);
      const y = rehash(x);
      expect(checkSnapshot(y).length === 0, what).toBe(ok);
    }
    const z = structuredClone(realZero()) as unknown as Record<string, unknown>;
    z.schema = "flop-observatory/snapshot@1";
    expect(checkSnapshot(rehash(z)).length, "an @1 line without the part").toBeGreaterThan(0);
    const z2 = structuredClone(realZero()) as unknown as Record<string, unknown>;
    z2.upgrade = null;
    expect(checkSnapshot(rehash(z2)).length, "an @0 line with upgrade null").toBeGreaterThan(0);
  });

  it("HELD: a log of @0 lines then @1 lines reads, and its watches are only the @1 ones", async () => {
    const log = join(box, "log");
    mkdirSync(log);
    copyFileSync(new URL("log/2026-11-11.jsonl", DATA), join(log, DAY));
    copyFileSync(new URL("log/2026-11-12.jsonl", DATA), join(log, "2026-11-12.jsonl"));
    const h = readHistory(log);
    expect(h.state).toBe("read");
    const last = h.snapshots.at(-1) as Snapshot;
    expect(last.schema).toBe("flop-observatory/snapshot@0");
    expect(earlierOf(h.snapshots, DEVNET_GENESIS).earlierUpgrades).toEqual([]);
  });

  it("review defect 2, fixed: the check refuses a watch read at the status's finalized hash that names another height, so no comparison rests on a height the block does not have", async () => {
    const s = await honest();
    const x = structuredClone(s) as unknown as { upgrade: UpgradeWatch; status: { finalized_height: number } };
    expect(x.upgrade.at.hash).toBe(s.status.finalized_hash);
    // The same block by its hash, but a height 1000 above the one the status read for it.
    x.upgrade.at.number = x.status.finalized_height + 1000;
    const y = rehash(x as unknown as Record<string, unknown>);
    expect(checkSnapshot(y)).not.toEqual([]);
  });
});

// ===== E. The reads (P1) =====

describe("E. the two reads", () => {
  it("HELD: a tape whose reads are at another block than F is refused by the replay, and the run writes no snapshot", async () => {
    const lines = fixture("upgrade-before", "tape.jsonl").trimEnd().split("\n").map((l) => JSON.parse(l));
    for (const x of lines) if (x.request?.method === "state_getStorage") x.request.params[1] = "0x" + "ee".repeat(32);
    const t = TapeTransport.parse(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "tape:other-block");
    const { r } = await run(asLive(t), join(box, "no-log"));
    expect([r.code, r.snapshot]).toEqual([EXIT.crashed, null]);
  });

  it("HELD: when state_getRuntimeVersion(F) failed, both reads are still made at F", async () => {
    const lines = fixture("upgrade-before", "tape.jsonl").trimEnd().split("\n").map((l) => JSON.parse(l));
    for (const x of lines) if (x.request?.method === "state_getRuntimeVersion") x.answer = { error: "timed out" };
    const { s } = await run(asLive(TapeTransport.parse(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "tape:rv-failed")), join(box, "no-log"));
    expect([s.status.runtime_version, s.upgrade?.executing.state, s.upgrade?.authorized.state]).toEqual([null, "reviewed", "absent"]);
  });
});

// ===== I. The first run after the merge, on the real published log (P10) =====

describe("I. the first live run after the merge, on the real data branch at 392fa7b", () => {
  it("HELD: the real last reading replayed on the log it was read on gives the same status, an @1 line after the @0 log, and a latest/ the new reader takes", async () => {
    const log = join(box, "log");
    mkdirSync(log);
    copyFileSync(new URL("log/2026-11-11.jsonl", DATA), join(log, DAY));
    const twelve = data("log/2026-11-12.jsonl").trimEnd().split("\n");
    // The log as the last real run read it: every line but its own.
    appendFileSync(join(log, "2026-11-12.jsonl"), twelve.slice(0, -1).map((l) => `${l}\n`).join(""));
    const recorded = JSON.parse(data("latest/snapshot.json")) as Snapshot;
    // The real tape holds neither read: answered as the chain then ran 1014020 (results.json boundary.2) with no authorisation. Synthetic.
    const tape = answeringUpgrade(TapeTransport.parse(data("latest/tape.jsonl"), "tape:latest-392fa7b"), { lastRuntimeUpgrade: { result: FIRST_NEW.last_runtime_upgrade.hex }, authorizedUpgrade: { result: null } });
    const out = join(box, "out");
    const r = await runLive(asLive(tape), { out, log, sourceSha: recorded.pin.source_sha, clock: () => recorded.observed_at });
    expect(r.code).toBe(EXIT.ok);
    const s = r.snapshot as Snapshot;
    expect([s.schema, s.seq, s.prev_hash]).toEqual(["flop-observatory/snapshot@1", recorded.seq, recorded.prev_hash]);
    expect(s.status).toEqual(recorded.status);
    expect(s.upgrade?.executing).toEqual({ state: "reviewed", spec_name: FIRST_NEW.last_runtime_upgrade.spec_name, spec_version: FIRST_NEW.last_runtime_upgrade.spec_version, detail: null });
    expect([s.upgrade?.compared_with, s.upgrade?.at.hash]).toEqual([null, recorded.status.finalized_hash]);
    const files = outFiles(out);
    expect(Object.keys(files).sort()).toEqual(["SHA256SUMS", "census.json", "drift.json", "escrows.json", "run.json", "snapshot.json", "snapshots.jsonl", "status.json", "tape.jsonl", "upgrade.json"]);
    expect(judgeLatest(files, { now: recorded.observed_at, maxAgeSeconds: 3600 })).toEqual({ usable: true, snapshot: s, reset: null });
    // The real @0 latest/ is refused by the new reader only for the file it lacks.
    const old = Object.fromEntries(readdirSync(new URL("latest/", DATA)).map((n) => [n, data(`latest/${n}`)]));
    expect(judgeLatest(old, { now: recorded.observed_at, maxAgeSeconds: 3600 })).toEqual({ usable: false, refused: ["missing upgrade.json"] });
    // Published as the job does, the next run reads the log of @0 lines and the new @1 line and compares with it.
    appendFileSync(join(log, "2026-11-12.jsonl"), logLine(s));
    const h = readHistory(log);
    expect([h.state, h.snapshots.length, earlierOf(h.snapshots, DEVNET_GENESIS).earlierUpgrades.map((e) => e.watch.at.number)]).toEqual(["read", twelve.length + 18, [s.upgrade?.at.number]]);
  });
});

// ===== F. Agreement of the surfaces (P7): the feed and the tool =====

describe("F. upgrade.json and get_upgrade", () => {
  it("HELD: for an @0 snapshot, upgrade.json and get_upgrade say null, the part not read", () => {
    const s = JSON.parse(data("latest/snapshot.json")) as Snapshot;
    const feed = feedText(upgradeFeed(s));
    const mcp = handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_upgrade", arguments: {} } }, { snapshot: s }) as { result: { content: { text: string }[] } };
    expect(mcp.result.content[0]?.text).toBe(feed);
    expect(JSON.parse(feed).upgrade).toBeNull();
    expect(feedFiles(s).map(([n]) => n)).toContain("upgrade.json");
    expect(noticeLine({ ...s, seq: 0, prev_hash: null }).includes('"executing_state":null')).toBe(true);
  });
});

// ===== J. Tests for the survivors of the reviewer's mutants (mutants/review-watch.json) =====

describe("J. what the builder's tests let through", () => {
  it("HELD: the notice names the version the record states, not state_getRuntimeVersion's (rw-notice-version-from-rv)", async () => {
    const { r, s } = await run(asLive(tapeWith("upgrade-not-reviewed", {})), join(box, "no-log"));
    expect(s.status.runtime_version).not.toBe(NOT_REVIEWED.specVersion);
    expect(JSON.parse((r.notice as string).slice("::notice title=networkStatus::".length)).executing_spec_version).toBe(NOT_REVIEWED.specVersion);
  });

  it("HELD: an earlier watch is filed under the RPC genesis its snapshot read, not the pinned one (rw-history-pinned)", async () => {
    const { s } = await run(asLive(tapeWith("upgrade-before", {})), join(box, "no-log"));
    const other = "0x" + "77".repeat(32);
    const moved = { ...s, status: { ...s.status, genesis: { ...s.status.genesis, rpc: other } } } as Snapshot;
    expect(earlierOf([moved], DEVNET_GENESIS).earlierUpgrades.map((e) => e.genesis)).toEqual([other]);
  });

  it("HELD: absent is a word on the page, never the blank unknown cell (rw-page-absent-blank)", async () => {
    const { s } = await run(asLive(tapeWith("upgrade-before", {})), join(box, "no-log"));
    expect(s.upgrade?.authorized.state).toBe("absent");
    expect(renderPage(s).includes('<td data-k="upgrade.authorized.state" data-v="absent">absent</td>')).toBe(true);
  });
});

describe("K. the published files", () => {
  it("HELD: judgeLatest refuses an upgrade.json changed by one byte of its hex, resummed (no list in published.test.ts or mcp.test.ts names upgrade.json)", async () => {
    const { out, s } = await run(asLive(tapeWith("upgrade-before", { au: { result: AUTHORIZED_BYTES } })), join(box, "no-log"));
    const f = outFiles(out);
    const changed = (f["upgrade.json"] as string).replace(AUTHORIZED_BYTES, AUTHORIZED_BYTES.slice(0, -2) + "00");
    expect(changed).not.toBe(f["upgrade.json"]);
    const { sumsOf } = await import("../src/sums.js");
    const next: Record<string, string> = { ...f, "upgrade.json": changed };
    delete next.SHA256SUMS;
    next.SHA256SUMS = sumsOf(Object.keys(next).sort().map((n) => [n, next[n] as string] as const));
    expect(judgeLatest(next, { now: s.observed_at, maxAgeSeconds: 3600 })).toEqual({ usable: false, refused: ["upgrade.json is not the one the snapshot gives"] });
  });
});

// Unused import guard: NOT_REVIEWED and RESULTS are the builder's values the rows above lean on.
it("HELD: the not reviewed record the builder uses is one past the newest reviewed line, as results.json's new runtime is reviewed", () => {
  expect(runtimeOfBlock(Uint8Array.from(Buffer.from(FIRST_NEW.last_runtime_upgrade.hex.slice(2), "hex"))).found).toBe(true);
  expect(NOT_REVIEWED.specVersion).toBe(FIRST_NEW.last_runtime_upgrade.spec_version + 1);
  expect(RESULTS.boundary[2].last_runtime_upgrade.spec_version).toBe(FIRST_NEW.last_runtime_upgrade.spec_version);
});
