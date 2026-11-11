import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogRefused, appendSnapshot, canonicalJson, hashSnapshot, logLine, readDayLog, readSnapshots, sealSnapshot, verifyChain } from "../src/store.js";
import { writeFeeds } from "../src/feed.js";
import type { EscrowState, Snapshot } from "../src/types.js";

const G = "0x" + "ab".repeat(32);
const ID_CLAIMED = "0x" + "01".repeat(32);
const ID_REFUNDED = "0x" + "02".repeat(32);
const ID_UNVERIFIED = "0x" + "03".repeat(32);
const T = "2026-01-01T00:00:00.000Z";
const SCOPE = "settlement only; says nothing about output quality" as const;

function esc1(id: string, state: EscrowState["state"], evEvent: string | null): EscrowState {
  return {
    schema: "flop-observatory/escrow-state@0",
    escrow_id: id,
    state,
    evidence: evEvent ? [{ event: evEvent, block_hash: "0x" + "cd".repeat(32), block_number: 7, event_index: 1, genesis: G }] : [],
    notes: state === "unverified" ? ["no finalized evidence"] : [],
    finalized_height: 10,
    observed_at: T,
    trust: "fixture",
    scope: SCOPE,
  };
}

function build(over: Partial<Snapshot> = {}): Snapshot {
  const base: Omit<Snapshot, "hash"> = {
    schema: "flop-observatory/snapshot@0",
    seq: 0,
    prev_hash: null,
    observed_at: T,
    trust: "fixture",
    pin: { source_sha: null, source: "fixture:test", genesis: G, finalized_height: 10, finalized_hash: null, node: "none" },
    status: {
      schema: "flop-observatory/network-status@0",
      observed_at: T,
      trust: "fixture",
      genesis: { pinned: G, faucet: null, rpc: G },
      reset_detected: null,
      conflicts: [],
      finalized_height: 10,
      finalized_hash: null,
      best_height: null,
      finality_lag: null,
      runtime_version: null,
      rpc: { health: "ok", http: null, detail: null, observed_at: T, stale: null },
      gateway: { health: "unknown", http: null, detail: null, observed_at: null },
      faucet: { health: "unknown", http: null, detail: null, observed_at: null, ready: null, limits: null },
    },
    escrows: [
      esc1(ID_CLAIMED, "claimed", "hasStation.EscrowReleased"),
      esc1(ID_REFUNDED, "refunded", "hasStation.EscrowRefunded"),
      esc1(ID_UNVERIFIED, "unverified", null),
    ],
    census: {
      schema: "flop-observatory/census@0",
      observed_at: T,
      trust: "fixture",
      genesis: G,
      requested: { from_block: 0, to_block: 100 },
      covered: [{ from_block: 0, to_block: 49 }],
      gaps: [{ from_block: 50, to_block: 100 }],
      complete: false,
      status: "partial",
      totals: { escrows_opened: 3, escrows_released: 1, escrows_refunded: 1, channels_opened: 0, channels_settled: 0 },
      by_account: {},
      totals_label: "partial",
      requested_blocks: 101,
      covered_blocks: 50,
      reset_detected: null,
      notes: [],
      pending_unfinalized: 0,
      duplicates_dropped: 0,
      excluded_other_genesis: 0,
      malformed_dropped: 0,
      event_names: {
        escrows_opened: { event: "hasStation.EscrowOpened", confirmed: true },
        escrows_released: { event: "hasStation.EscrowReleased", confirmed: true },
        escrows_refunded: { event: "hasStation.EscrowRefunded", confirmed: true },
        channels_opened: { event: "computeChannel.ChannelOpened", confirmed: false },
        channels_settled: { event: "computeChannel.ChannelSettled", confirmed: false },
      },
    },
    drift: null,
    ...over,
  };
  return { ...base, hash: hashSnapshot(base) };
}

const FAUCET_G = "0x" + "ef".repeat(32);
const FIN_HASH = "0x" + "aa".repeat(32);

/** A reset scenario: reset true, stale true, conflicts, finalized height and hash, a differing faucet genesis,
 *  an escrow with empty notes, a complete census with empty gaps, and a drift report with an unknown item. */
function buildReset(): Snapshot {
  const b = build();
  const st = b.status;
  const census = { ...b.census!, complete: true, status: "complete" as const, totals_label: "complete" as const, covered: [{ from_block: 0, to_block: 100 }], gaps: [], covered_blocks: 101, reset_detected: true, notes: ["page on another genesis ignored"] };
  const drift = {
    schema: "flop-observatory/drift@0" as const, observed_at: T, trust: "fixture" as const, genesis: G, finalized_height: 10, runtime_version: 5, spec_source: "spec.yaml", runtime_observed_at: null,
    items: [
      { param: "a", runtime_path: "api.consts.a", spec: 5, runtime: 5, status: "match" as const, note: null, mapping: "constant" as const, unit: null, expected: "5" },
      { param: "b", runtime_path: null, spec: "", runtime: null, status: "unknown" as const, note: "", mapping: "none" as const, unit: null, expected: null },
    ],
    matches: 1, mismatches: 0, unknown: 1,
  };
  return build({
    status: {
      ...st,
      genesis: { pinned: G, faucet: FAUCET_G, rpc: G },
      reset_detected: true,
      conflicts: ["faucet genesis differs from pinned", "second conflict"],
      finalized_height: 10,
      finalized_hash: FIN_HASH,
      best_height: 12,
      finality_lag: 2,
      runtime_version: 5,
      rpc: { ...st.rpc, health: "degraded", http: 200, detail: "stale head", stale: true },
    },
    census,
    drift,
  });
}

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "obs-store-"));
  made.push(d);
  return d;
}
function fresh() {
  const { hash: _h, seq: _s, prev_hash: _p, ...rest } = build();
  return rest;
}

describe("canonical json and hash", () => {
  it("sorts keys, no whitespace, numbers as JS prints them", () => {
    expect(canonicalJson({ b: 1, a: { d: 1.5, c: [2, { z: null, y: 1e21 }] } })).toBe('{"a":{"c":[2,{"y":1e+21,"z":null}],"d":1.5},"b":1}');
  });
  it("hash ignores the hash field and key order, and changes with content", () => {
    const s = build();
    expect(hashSnapshot(s)).toBe(s.hash);
    expect(hashSnapshot({ ...s, hash: "junk" })).toBe(s.hash);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(s).reverse()))) as Snapshot;
    expect(hashSnapshot(reordered)).toBe(s.hash);
    expect(hashSnapshot({ ...s, observed_at: "2026-01-02T00:00:00.000Z" })).not.toBe(s.hash);
  });
});

describe("snapshot log chain", () => {
  it("appends with seq and prev_hash from the last line and verifies", () => {
    const p = join(tmp(), "log", "snapshots.jsonl");
    const a = appendSnapshot(p, fresh());
    const b = appendSnapshot(p, fresh());
    const c = appendSnapshot(p, fresh());
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
    expect(a.prev_hash).toBeNull();
    expect(b.prev_hash).toBe(a.hash);
    expect(c.prev_hash).toBe(b.hash);
    expect(readSnapshots(p).map((s) => s.hash)).toEqual([a.hash, b.hash, c.hash]);
    expect(verifyChain(p)).toBeNull();
  });
  it("an empty or missing log verifies", () => {
    expect(verifyChain(join(tmp(), "none.jsonl"))).toBeNull();
  });
  it("detects an edited line at its seq", () => {
    const p = join(tmp(), "s.jsonl");
    appendSnapshot(p, fresh());
    appendSnapshot(p, fresh());
    appendSnapshot(p, fresh());
    const ls = readFileSync(p, "utf8").trim().split("\n");
    const mid = JSON.parse(ls[1] as string);
    mid.observed_at = "2030-01-01T00:00:00.000Z";
    // Canonical, so only the hash check can catch it.
    ls[1] = canonicalJson(mid);
    writeFileSync(p, ls.join("\n") + "\n");
    expect(verifyChain(p)).toBe(1);
  });
  it("detects a wrong prev_hash even when the line's own hash is valid", () => {
    const p = join(tmp(), "s.jsonl");
    const a = appendSnapshot(p, fresh());
    const forged = { ...fresh(), seq: 1, prev_hash: "0".repeat(64) } as Omit<Snapshot, "hash">;
    // In canonical form with a hash of its own that verifies, so only the prev_hash check can catch it.
    const line = canonicalJson({ ...forged, hash: hashSnapshot(forged) });
    expect(canonicalJson(JSON.parse(line))).toBe(line);
    appendFileSync(p, line + "\n");
    expect(a.seq).toBe(0);
    expect(verifyChain(p)).toBe(1);
  });
  it("detects a deleted first line and a non-JSON line", () => {
    const p = join(tmp(), "s.jsonl");
    appendSnapshot(p, fresh());
    appendSnapshot(p, fresh());
    const ls = readFileSync(p, "utf8").trim().split("\n");
    writeFileSync(p, (ls[1] as string) + "\n");
    expect(verifyChain(p)).toBe(0);
    writeFileSync(p, (ls[0] as string) + "\nnot json\n");
    expect(verifyChain(p)).toBe(1);
  });
});

describe("snapshot log read strictly", () => {
  it("refuses a line that holds a key twice, even though its hash verifies", () => {
    const p = join(tmp(), "log.jsonl");
    appendSnapshot(p, fresh());
    const line = readFileSync(p, "utf8").trim();
    // The first copy says the opposite; JSON.parse keeps the last, so the hash still verifies.
    const twice = line.replace('"reset_detected":null,"rpc"', '"reset_detected":true,"reset_detected":null,"rpc"');
    expect(twice).not.toBe(line);
    writeFileSync(p, twice + "\n");
    const parsed = JSON.parse(twice) as Snapshot;
    expect(hashSnapshot(parsed)).toBe(parsed.hash);
    expect(verifyChain(p)).toBe(0);
    expect(() => readSnapshots(p)).toThrow(/line 0 holds the key "reset_detected" twice in one object/);
  });
  it("refuses a line that is not valid UTF-8, which a lossy read would accept", () => {
    const p = join(tmp(), "log.jsonl");
    const s = fresh();
    appendSnapshot(p, { ...s, escrows: [{ ...s.escrows[0]!, notes: ["a \uFFFD in a note"] }, ...s.escrows.slice(1)] });
    const raw = readFileSync(p);
    const at = raw.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
    expect(at).toBeGreaterThan(0);
    const bad = Buffer.concat([raw.subarray(0, at), Buffer.from([0xff]), raw.subarray(at + 3)]);
    writeFileSync(p, bad);
    // Read lossily, the bad byte turns back into U+FFFD and the hash verifies; read strictly, it refuses.
    const lossy = JSON.parse(new TextDecoder("utf-8").decode(bad).trim()) as Snapshot;
    expect(hashSnapshot(lossy)).toBe(lossy.hash);
    expect(verifyChain(p)).toBe(0);
    expect(() => readSnapshots(p)).toThrow(/line 0 is not valid UTF-8/);
  });
  it("refuses every line that is not exactly what appendSnapshot writes (Fable review r7 L6)", () => {
    const dir = tmp();
    const p = join(dir, "log.jsonl");
    appendSnapshot(p, fresh());
    appendSnapshot(p, fresh());
    const [a, b] = readFileSync(p, "utf8").trim().split("\n") as [string, string];
    expect(verifyChain(p)).toBeNull();
    const cases: [string, string | Buffer, number, RegExp][] = [
      ["a blank line between", `${a}\n\n${b}\n`, 1, /line 1 is blank/],
      ["a last line with no newline", `${a}\n${b}`, 1, /line 1 does not end with a newline/],
      ["a byte order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${a}\n${b}\n`)]), 0, /line 0 is not JSON/],
      ["a padded line", ` ${a}\n${b}\n`, 0, /line 0 is not in canonical form/],
      ["a carriage return", `${a}\r\n${b}\n`, 0, /line 0 is not in canonical form/],
      ["seq written as 0.0e0", `${a.replace('"seq":0', '"seq":0.0e0')}\n${b}\n`, 0, /line 0 is not in canonical form/],
    ];
    for (const [name, text, at, why] of cases) {
      writeFileSync(p, text);
      expect(verifyChain(p), name).toBe(at);
      expect(() => readSnapshots(p), name).toThrow(why);
    }
  });
  it("refuses an integer past 2^53 - 1 that JSON.parse rounds, though the rounded line's hash verifies", () => {
    const p = join(tmp(), "log.jsonl");
    appendSnapshot(p, fresh());
    const line = readFileSync(p, "utf8").trim();
    const parsed = JSON.parse(line) as Snapshot;
    // finalized_height 10 is in the line; spell a value past 2^53 - 1 that reads as 2^53.
    const unsafe = { ...parsed, status: { ...parsed.status, runtime_version: 2 ** 53 } };
    const { hash: _h, ...rest } = unsafe;
    const hashed = { ...rest, hash: hashSnapshot(rest as Snapshot) };
    const text = canonicalJson(hashed).replace('"runtime_version":9007199254740992', '"runtime_version":9007199254740993');
    expect(text).toContain("9007199254740993");
    writeFileSync(p, text + "\n");
    const back = JSON.parse(text) as Snapshot;
    expect(hashSnapshot(back)).toBe(back.hash);
    expect(verifyChain(p)).toBe(0);
    expect(() => readSnapshots(p)).toThrow(/line 0 is not in canonical form/);
  });
  it("an empty file is an empty log", () => {
    const p = join(tmp(), "log.jsonl");
    writeFileSync(p, "");
    expect(verifyChain(p)).toBeNull();
    expect(readSnapshots(p)).toEqual([]);
  });
});

describe("sealing a snapshot onto a log", () => {
  it("is what appendSnapshot appends: seq and prev_hash from the last line, then the hash", () => {
    const p = join(tmp(), "s.jsonl");
    const a = appendSnapshot(p, fresh());
    const b = sealSnapshot(fresh(), a);
    expect([b.seq, b.prev_hash, b.hash]).toEqual([1, a.hash, hashSnapshot(b)]);
    expect(appendSnapshot(p, fresh())).toEqual(b);
    expect(readFileSync(p, "utf8").split("\n")[1] + "\n").toBe(logLine(b));
    expect(sealSnapshot(fresh(), undefined)).toEqual(a);
  });
});

describe("a log split by day", () => {
  /** A log folder holding these day files, each with these lines. */
  function dayLog(files: Record<string, string>): string {
    const dir = join(tmp(), "log");
    mkdirSync(dir);
    for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
    return dir;
  }
  /** n snapshots in one chain, each a different reading. */
  function chain(n: number, from: Snapshot | undefined = undefined): Snapshot[] {
    const out: Snapshot[] = [];
    let last = from;
    for (let i = 0; i < n; i++) {
      last = sealSnapshot({ ...fresh(), observed_at: `2026-01-0${i + 1}T00:00:00.000Z` }, last);
      out.push(last);
    }
    return out;
  }
  const text = (ss: Snapshot[]) => ss.map(logLine).join("");
  const refusal = (dir: string): [string, string] => {
    try {
      readDayLog(dir);
    } catch (e) {
      if (e instanceof LogRefused) return [e.kind, e.message.split(dir).join("<log>")];
      throw e;
    }
    return ["read", ""];
  };

  it("reads its day files in name order as one chain", () => {
    const [a, b, c] = chain(3) as [Snapshot, Snapshot, Snapshot];
    const dir = dayLog({ "2026-01-02.jsonl": logLine(c), "2026-01-01.jsonl": logLine(a) + logLine(b) });
    expect(readDayLog(dir)).toEqual({ files: ["2026-01-01.jsonl", "2026-01-02.jsonl"], snapshots: [a, b, c] });
  });

  it("is no earlier snapshot when the folder does not exist, and none when it holds no line", () => {
    expect(readDayLog(join(tmp(), "none"))).toBeNull();
    expect(readDayLog(dayLog({}))).toEqual({ files: [], snapshots: [] });
    expect(readDayLog(dayLog({ "2026-01-01.jsonl": "" }))).toEqual({ files: ["2026-01-01.jsonl"], snapshots: [] });
  });

  it("refuses a line that does not follow the one before it, across day files too", () => {
    const [a, b, c] = chain(3) as [Snapshot, Snapshot, Snapshot];
    expect(refusal(dayLog({ "2026-01-01.jsonl": logLine(a), "2026-01-02.jsonl": logLine(c) }))).toEqual(["broken", "2026-01-02.jsonl line 0 has seq 2, not 1"]);
    // Day files out of order: the later file's line comes first by name.
    expect(refusal(dayLog({ "2026-01-02.jsonl": logLine(a) + logLine(b), "2026-01-01.jsonl": logLine(c) }))).toEqual(["broken", "2026-01-01.jsonl line 0 has seq 2, not 0"]);
    const forged = { ...b, prev_hash: "0".repeat(64) };
    const relinked = { ...forged, hash: hashSnapshot(forged) };
    expect(refusal(dayLog({ "2026-01-01.jsonl": logLine(a) + logLine(relinked) }))).toEqual(["broken", "2026-01-01.jsonl line 1 does not name the hash of the line before it as prev_hash"]);
    const edited = { ...b, observed_at: "2030-01-01T00:00:00.000Z" };
    expect(refusal(dayLog({ "2026-01-01.jsonl": logLine(a) + logLine(edited) }))).toEqual(["broken", "2026-01-01.jsonl line 1 fails its hash check"]);
  });

  it("reads the one-line logs published before runs kept memory, then the chain on from the last of them", () => {
    const [x] = chain(1) as [Snapshot];
    const y = sealSnapshot({ ...fresh(), observed_at: "2026-01-05T00:00:00.000Z" }, undefined);
    const [z, w] = chain(2, y) as [Snapshot, Snapshot];
    const dir = dayLog({ "2026-01-01.jsonl": logLine(x) + logLine(y), "2026-01-02.jsonl": logLine(z) + logLine(w) });
    expect(readDayLog(dir)?.snapshots).toEqual([x, y, z, w]);
    expect([z.seq, z.prev_hash]).toEqual([1, y.hash]);
    // A one-line log must pass its own hash check.
    const bad = { ...x, observed_at: "2030-01-01T00:00:00.000Z" };
    expect(refusal(dayLog({ "2026-01-01.jsonl": logLine(bad) + logLine(y) }))).toEqual(["broken", "2026-01-01.jsonl line 0 fails its hash check"]);
  });

  it("never restarts part way: once the chain has begun, a line with seq 0 breaks it", () => {
    const [a, b] = chain(2) as [Snapshot, Snapshot];
    const restart = sealSnapshot(fresh(), undefined);
    expect(refusal(dayLog({ "2026-01-01.jsonl": logLine(a) + logLine(b), "2026-01-02.jsonl": logLine(restart) }))).toEqual(["broken", "2026-01-02.jsonl line 0 has seq 0, not 2"]);
  });

  it("refuses anything the publish job does not write: a line it cannot read, another name, a link, a folder", () => {
    const [a] = chain(1) as [Snapshot];
    expect(refusal(dayLog({ "2026-01-01.jsonl": logLine(a) + "not json\n" }))).toEqual(["unreadable", "2026-01-01.jsonl line 1 is not JSON"]);
    expect(refusal(dayLog({ "2026-01-01.jsonl": logLine(a).slice(0, -1) }))).toEqual(["unreadable", "2026-01-01.jsonl line 0 does not end with a newline (a line cut short)"]);
    expect(refusal(dayLog({ "2026-01-01.jsonl": logLine(a), "README.md": "x" }))).toEqual(["unreadable", 'the log folder holds "README.md", which is no <UTC date>.jsonl day file']);
    expect(refusal(dayLog({ "2026-02-30.jsonl": logLine(a) }))).toEqual(["unreadable", 'the log folder holds "2026-02-30.jsonl", which is no <UTC date>.jsonl day file']);
    const linked = dayLog({});
    const elsewhere = join(tmp(), "elsewhere.jsonl");
    writeFileSync(elsewhere, logLine(a));
    symlinkSync(elsewhere, join(linked, "2026-01-01.jsonl"));
    expect(refusal(linked)).toEqual(["unreadable", "2026-01-01.jsonl is not a regular file"]);
    const nested = dayLog({});
    mkdirSync(join(nested, "2026-01-01.jsonl"));
    expect(refusal(nested)).toEqual(["unreadable", "2026-01-01.jsonl is not a regular file"]);
    const file = join(tmp(), "log");
    writeFileSync(file, logLine(a));
    expect(refusal(file)).toEqual(["unreadable", "the log folder is not a folder"]);
    const folderLink = join(tmp(), "link");
    symlinkSync(dayLog({ "2026-01-01.jsonl": logLine(a) }), folderLink);
    expect(refusal(folderLink)).toEqual(["unreadable", "the log folder is not a folder"]);
  });
});

describe("feeds", () => {
  it("are deterministic, sorted, indented, newline terminated, and carry observed_at, trust and hash", () => {
    const s = build();
    const d1 = tmp();
    const d2 = tmp();
    const names = writeFeeds(d1, s);
    writeFeeds(d2, s);
    expect(names).toEqual(["status.json", "escrows.json", "census.json", "drift.json", "snapshot.json"]);
    for (const n of names) {
      const t = readFileSync(join(d1, n), "utf8");
      expect(t).toBe(readFileSync(join(d2, n), "utf8"));
      expect(t.endsWith("}\n")).toBe(true);
      expect(t.startsWith('{\n  "')).toBe(true);
      const o = JSON.parse(t);
      expect(Object.keys(o)).toEqual([...Object.keys(o)].sort());
      expect(typeof o.observed_at).toBe("string");
      expect(o.trust).toBe("fixture");
      expect(o.snapshot_hash ?? o.hash).toBe(s.hash);
    }
  });
  it("writes a null census and drift as null, never an empty object with zeros", () => {
    const s = build({ census: null, drift: null });
    const d = tmp();
    writeFeeds(d, s);
    const c = JSON.parse(readFileSync(join(d, "census.json"), "utf8"));
    const dr = JSON.parse(readFileSync(join(d, "drift.json"), "utf8"));
    expect(c.census).toBeNull();
    expect(dr.drift).toBeNull();
    expect(readFileSync(join(d, "census.json"), "utf8")).not.toContain("escrows_opened");
  });
  it("keeps accounts named __proto__ and constructor in census.json and snapshot.json, which still verifies", () => {
    // JSON.parse makes __proto__ an own key, as the census does for an account of that name.
    const odd = JSON.parse('{"__proto__":{"escrows_opened":1},"alice":{"escrows_opened":2},"constructor":{"escrows_opened":3}}');
    const s = build({ census: { ...build().census!, by_account: odd } });
    const d = tmp();
    writeFeeds(d, s);
    const census = JSON.parse(readFileSync(join(d, "census.json"), "utf8")).census;
    expect(Object.keys(census.by_account)).toEqual(["__proto__", "alice", "constructor"]);
    expect(census.by_account.__proto__).not.toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(census.by_account, "__proto__")?.value).toEqual({ escrows_opened: 1 });
    const snap = JSON.parse(readFileSync(join(d, "snapshot.json"), "utf8")) as Snapshot;
    expect(Object.keys(snap.census!.by_account)).toEqual(["__proto__", "alice", "constructor"]);
    expect(hashSnapshot(snap)).toBe(s.hash);
  });
  it("keeps null status values null, not 0", () => {
    const d = tmp();
    writeFeeds(d, build());
    const st = JSON.parse(readFileSync(join(d, "status.json"), "utf8")).status;
    expect(st.finalized_hash).toBeNull();
    expect(st.best_height).toBeNull();
    expect(st.finality_lag).toBeNull();
    expect(st.reset_detected).toBeNull();
    expect(st.gateway.health).toBe("unknown");
  });
});
