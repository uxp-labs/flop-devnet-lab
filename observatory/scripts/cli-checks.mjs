#!/usr/bin/env node
// The command line wiring, end to end through dist/cli.js: unreadable pages reach the census and
// the escrows, a snapshot refuses parts pinned to another chain, and the status health rules
// show up in the command's output. The MCP binary (dist/mcp-bin.js) serves a snapshot whose hash
// verifies and refuses one whose hash fails, one read lossily or with a key twice, and an object
// that hashes to itself but is no snapshot. Unit tests cover the modules; this covers the plumbing.
// Prints a JSON array; exit 1 on any failed expectation.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { feedText } from "../dist/feed.js";
import { hashSnapshot } from "../dist/store.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = realpathSync(mkdtempSync(join(tmpdir(), "obs-cli-checks-")));
const fx = (n) => join("fixtures", n);
const cli = (...args) => {
  const r = spawnSync("node", [join(pkg, "dist", "cli.js"), ...args], { cwd: pkg, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { exit: r.status, json, stderr: (r.stderr ?? "").trim() };
};

// A copy of census-complete pinned to another genesis, for the one-chain rule.
const otherPin = join(work, "census-other-pin");
cpSync(join(pkg, fx("census-complete")), otherPin, { recursive: true });
const meta = JSON.parse(readFileSync(join(otherPin, "meta.json"), "utf8"));
meta.pinned_genesis = "0x" + "ab".repeat(32);
writeFileSync(join(otherPin, "meta.json"), JSON.stringify(meta, null, 2));

// Two snapshots into one log: the second rolls the finalized height back on the same genesis.
const rollA = join(work, "roll-a");
const rollB = join(work, "roll-b");
cpSync(join(pkg, fx("status-healthy")), rollA, { recursive: true });
cpSync(join(pkg, fx("status-healthy")), rollB, { recursive: true });
{
  const edit = (dir, file, fn) => {
    const p = join(dir, file);
    const o = JSON.parse(readFileSync(p, "utf8"));
    fn(o);
    writeFileSync(p, JSON.stringify(o, null, 2));
  };
  edit(rollB, "rpc-head.json", (o) => {
    o.finalized = { number: 3340000, hash: "0x" + "11".repeat(32) };
    o.best_number = 3340002;
    o.observed_at = "2026-11-09T23:48:40Z";
  });
  edit(rollB, "meta.json", (o) => (o.now = "2026-11-09T23:48:41Z"));
  for (const f of ["faucet-health.json", "faucet-chain.json", "gateway-models.json"]) edit(rollB, f, (o) => (o.fetched_at = "2026-11-09T23:48:40Z"));
}
const rollLog = join(work, "roll.jsonl");
// The IMD follow-up audit's case: A, then a snapshot with no RPC reading at all, then a rollback.
const gap = join(work, "roll-gap");
cpSync(join(pkg, fx("status-healthy")), gap, { recursive: true });
rmSync(join(gap, "rpc-head.json"));
const gapLog = join(work, "roll-gap.jsonl");
// The Fable review's case M4: the earlier snapshot's head had no reading time. Its height still
// sets the floor; only the stuck check needs the time.
const noTime = join(work, "roll-no-time");
cpSync(join(pkg, fx("status-healthy")), noTime, { recursive: true });
{
  const p = join(noTime, "rpc-head.json");
  const o = JSON.parse(readFileSync(p, "utf8"));
  o.observed_at = null;
  writeFileSync(p, JSON.stringify(o, null, 2));
}
const noTimeLog = join(work, "roll-no-time.jsonl");
// The round 7 review's case M1: a head that has lost its finalized head and reports a best
// height far below what the earlier snapshot saw finalized, on the same genesis.
const restart = join(work, "restart-low-best");
cpSync(join(pkg, fx("status-healthy")), restart, { recursive: true });
{
  const p = join(restart, "rpc-head.json");
  const o = JSON.parse(readFileSync(p, "utf8"));
  o.finalized = null;
  o.best_number = 10;
  writeFileSync(p, JSON.stringify(o, null, 2));
}
// The round 7 review's case L1: an earlier snapshot taken later than the next one, with no head time.
const later = join(work, "later-no-head-time");
cpSync(join(pkg, fx("status-healthy")), later, { recursive: true });
{
  const edit = (file, fn) => {
    const p = join(later, file);
    const o = JSON.parse(readFileSync(p, "utf8"));
    fn(o);
    writeFileSync(p, JSON.stringify(o, null, 2));
  };
  edit("meta.json", (o) => (o.now = "2026-11-09T23:48:41Z"));
  edit("rpc-head.json", (o) => (o.observed_at = null));
}
// The Fable review's case L8: one escrow id listed twice, once in upper case hex.
const dupIds = join(work, "escrows-dup-ids");
cpSync(join(pkg, fx("escrows-verification")), dupIds, { recursive: true });
{
  const p = join(dupIds, "meta.json");
  const o = JSON.parse(readFileSync(p, "utf8"));
  const first = o.escrow_ids[0];
  o.escrow_ids = [first, "0x" + first.slice(2).toUpperCase(), ...o.escrow_ids.slice(1)];
  writeFileSync(p, JSON.stringify(o, null, 2));
}

// The MCP binary on one real snapshot, as written and with one field changed after hashing.
const mcp = (snapshotPath) => {
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_status", arguments: {} } };
  const r = spawnSync("node", [join(pkg, "dist", "mcp-bin.js"), snapshotPath], { cwd: pkg, encoding: "utf8", input: JSON.stringify(call) + "\n" });
  return { exit: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").trim() };
};
const mcpSnapshot = () => {
  const out = join(work, "mcp-snap");
  const r = cli("snapshot", "--status", fx("status-healthy"), "--out", out);
  if (r.exit !== 0) throw new Error(`snapshot for the MCP checks failed: ${r.stderr}`);
  return join(out, "snapshot.json");
};

const cases = [
  {
    name: "census refuses a scenario with an unreadable page file",
    run: () => cli("census", "--fixtures", fx("census-unreadable-page")),
    ok: (r) => r.exit === 2 && /(unreadable|unusable) event page/.test(r.stderr) && /01-unreadable\.json/.test(r.stderr),
  },
  {
    name: "every escrow is unverified when a page file is unreadable, and the note names it",
    run: () => cli("escrow", "--fixtures", fx("escrows-unreadable-page")),
    ok: (r) =>
      r.exit === 0 &&
      Array.isArray(r.json) &&
      r.json.length > 0 &&
      r.json.every((e) => e.state === "unverified" && e.notes.some((n) => /event-pages\/.*not valid JSON/.test(n))),
  },
  {
    name: "a snapshot passes unreadable escrow pages through to the escrows",
    run: () => {
      const out = join(work, "snap-unreadable");
      const r = cli("snapshot", "--status", fx("status-healthy"), "--escrows", fx("escrows-unreadable-page"), "--out", out);
      if (r.exit !== 0) return r;
      return { ...r, json: JSON.parse(readFileSync(join(out, "escrows.json"), "utf8")) };
    },
    ok: (r) => r.exit === 0 && r.json.escrows.length > 0 && r.json.escrows.every((e) => e.state === "unverified"),
  },
  {
    name: "a snapshot refuses a census with an unreadable page file",
    run: () => cli("snapshot", "--status", fx("status-healthy"), "--census", fx("census-unreadable-page"), "--out", join(work, "snap-census")),
    ok: (r) => r.exit === 2 && /(unreadable|unusable) event page/.test(r.stderr),
  },
  {
    name: "a snapshot refuses a part pinned to a different genesis",
    run: () => cli("snapshot", "--status", fx("status-healthy"), "--census", otherPin, "--out", join(work, "snap-pin")),
    ok: (r) => r.exit === 2 && /pinned to genesis 0xabab/.test(r.stderr),
  },
  {
    name: "a snapshot reads the previous one from its log: a rollback on the same genesis is a conflict",
    run: () => {
      const first = cli("snapshot", "--status", rollA, "--out", join(work, "roll-o1"), "--log", rollLog);
      if (first.exit !== 0) return first;
      const second = cli("snapshot", "--status", rollB, "--out", join(work, "roll-o2"), "--log", rollLog);
      if (second.exit !== 0) return second;
      return { ...second, json: JSON.parse(readFileSync(join(work, "roll-o2", "status.json"), "utf8")).status };
    },
    ok: (r) => r.exit === 0 && r.json.rpc.health === "degraded" && r.json.conflicts.some((c) => /went backwards from 3341575 to 3340000/.test(c)),
  },
  {
    name: "a snapshot with no RPC reading in between cannot hide a rollback: every earlier snapshot on the genesis counts",
    run: () => {
      for (const [i, dir] of [rollA, gap].entries()) {
        const r = cli("snapshot", "--status", dir, "--out", join(work, `gap-o${i}`), "--log", gapLog);
        if (r.exit !== 0) return r;
      }
      const third = cli("snapshot", "--status", rollB, "--out", join(work, "gap-o2"), "--log", gapLog);
      if (third.exit !== 0) return third;
      return { ...third, json: JSON.parse(readFileSync(join(work, "gap-o2", "status.json"), "utf8")).status };
    },
    ok: (r) => r.exit === 0 && r.json.rpc.health === "degraded" && r.json.conflicts.some((c) => /went backwards from 3341575 to 3340000/.test(c)),
  },
  {
    name: "an earlier snapshot whose head had no reading time still raises the floor: a rollback after it is a conflict",
    run: () => {
      const first = cli("snapshot", "--status", noTime, "--out", join(work, "no-time-o1"), "--log", noTimeLog);
      if (first.exit !== 0) return first;
      const seen = JSON.parse(readFileSync(join(work, "no-time-o1", "status.json"), "utf8")).status;
      if (seen.rpc.observed_at !== null || seen.finalized_height !== 3341575) throw new Error("the first snapshot should hold 3341575 with no head time");
      const second = cli("snapshot", "--status", rollB, "--out", join(work, "no-time-o2"), "--log", noTimeLog);
      if (second.exit !== 0) return second;
      return { ...second, json: JSON.parse(readFileSync(join(work, "no-time-o2", "status.json"), "utf8")).status };
    },
    ok: (r) => r.exit === 0 && r.json.rpc.health === "degraded" && r.json.conflicts.some((c) => /went backwards from 3341575 to 3340000/.test(c)),
  },
  {
    name: "a head with no finalized head and a best height below an earlier finalized height is a conflict, and reset_detected is not false",
    run: () => {
      const first = cli("snapshot", "--status", fx("status-healthy"), "--out", join(work, "restart-o1"), "--log", join(work, "restart.jsonl"));
      if (first.exit !== 0) return first;
      const second = cli("snapshot", "--status", restart, "--escrows", fx("escrows-opened-only"), "--out", join(work, "restart-o2"), "--log", join(work, "restart.jsonl"));
      if (second.exit !== 0) return second;
      return { ...second, json: JSON.parse(readFileSync(join(work, "restart-o2", "status.json"), "utf8")).status };
    },
    ok: (r) => r.exit === 0 && r.json.reset_detected === null && r.json.conflicts.some((c) => /best block 10 is below the finalized height 3341575/.test(c)),
  },
  {
    name: "an earlier snapshot taken later than this one is a conflict, though it recorded no head time",
    run: () => {
      const first = cli("snapshot", "--status", later, "--out", join(work, "later-o1"), "--log", join(work, "later.jsonl"));
      if (first.exit !== 0) return first;
      const second = cli("snapshot", "--status", fx("status-healthy"), "--out", join(work, "later-o2"), "--log", join(work, "later.jsonl"));
      if (second.exit !== 0) return second;
      return { ...second, json: JSON.parse(readFileSync(join(work, "later-o2", "status.json"), "utf8")).status };
    },
    ok: (r) => r.exit === 0 && r.json.reset_detected === null && r.json.conflicts.some((c) => /an earlier snapshot was taken at 2026-11-09T23:48:41Z, later than this snapshot time/.test(c)),
  },
  {
    name: "a snapshot refuses to extend or trust a log whose hash chain is broken",
    run: () => {
      const lines = readFileSync(rollLog, "utf8").split("\n").filter(Boolean);
      const bad = JSON.parse(lines[0]);
      bad.status.finalized_height = 1;
      writeFileSync(join(work, "broken.jsonl"), [JSON.stringify(bad), ...lines.slice(1)].join("\n") + "\n");
      return cli("snapshot", "--status", rollA, "--out", join(work, "roll-o3"), "--log", join(work, "broken.jsonl"));
    },
    ok: (r) => r.exit === 2 && /is broken at line 0/.test(r.stderr),
  },
  {
    name: "the census command reads --from and --to as ASCII digits only, refusing anything else as a request problem",
    run: () => {
      for (const text of [" 0", "+5", "1_0", "0x10", "\u0663"]) {
        const r = cli("census", "--fixtures", fx("census-complete"), "--from", text, "--to", "199");
        if (r.exit !== 2 || !/census refused \(request\): --from must be a non-negative integer/.test(r.stderr)) return { ...r, stderr: `for ${JSON.stringify(text)}: ${r.stderr}` };
      }
      return cli("census", "--fixtures", fx("census-complete"), "--from", "00", "--to", "199");
    },
    ok: (r) => r.exit === 0 && r.json?.complete === true,
  },
  {
    name: "the census command refuses a scenario folder that does not exist as an input problem",
    run: () => cli("census", "--fixtures", fx("no-such-scenario"), "--from", "0", "--to", "10"),
    ok: (r) => r.exit === 2 && /census refused \(input\): /.test(r.stderr),
  },
  {
    name: "the census command checks a range given on the command line before the folder: an inverted range is a request problem first",
    run: () => cli("census", "--fixtures", fx("no-such-scenario"), "--from", "9", "--to", "3"),
    ok: (r) => r.exit === 2 && /census refused \(request\): the requested range is inverted/.test(r.stderr),
  },
  {
    name: "pin.json is the snapshot's pin in the feed format",
    run: () => {
      const path = mcpSnapshot();
      const pinText = readFileSync(join(dirname(path), "pin.json"), "utf8");
      return { exit: pinText === feedText(JSON.parse(readFileSync(path, "utf8")).pin) ? 0 : 1, stderr: pinText.slice(0, 200) };
    },
    ok: (r) => r.exit === 0,
  },
  {
    name: "a snapshot refuses an escrow id listed twice, in either case",
    run: () => cli("snapshot", "--status", fx("status-healthy"), "--escrows", dupIds, "--out", join(work, "dup-ids-o")),
    ok: (r) => r.exit === 2 && /is listed twice/.test(r.stderr),
  },
  {
    name: "the escrow command refuses the same --id given twice",
    run: () => {
      const id = JSON.parse(readFileSync(join(dupIds, "meta.json"), "utf8")).escrow_ids[0];
      return cli("escrow", "--fixtures", fx("escrows-verification"), "--id", id, "--id", id.toUpperCase().replace("0X", "0x"));
    },
    ok: (r) => r.exit === 2 && /--id: escrow id .* is listed twice/.test(r.stderr),
  },
  {
    name: "the MCP binary serves a snapshot whose hash verifies",
    run: () => mcp(mcpSnapshot()),
    ok: (r) => {
      const lines = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return r.exit === 0 && lines.length === 1 && lines[0].id === 1 && typeof lines[0].result?.content?.[0]?.text === "string";
    },
  },
  {
    name: "the MCP binary refuses a snapshot changed after hashing, and serves nothing",
    run: () => {
      const path = mcpSnapshot();
      const s = JSON.parse(readFileSync(path, "utf8"));
      s.status.reset_detected = !s.status.reset_detected;
      const bad = join(work, "mcp-tampered.json");
      writeFileSync(bad, JSON.stringify(s, null, 2) + "\n");
      return mcp(bad);
    },
    ok: (r) => r.exit === 2 && r.stdout === "" && /fails its hash check; refusing to serve it/.test(r.stderr),
  },
  {
    name: "the MCP binary refuses a snapshot that holds a key twice, though its hash verifies",
    run: () => {
      const path = mcpSnapshot();
      const text = readFileSync(path, "utf8");
      const v = JSON.parse(text).status.reset_detected;
      // The first copy says the opposite; JSON.parse keeps the last, so the hash still verifies.
      const twice = text.replace(`"reset_detected": ${v},\n    "rpc"`, `"reset_detected": ${!v},\n    "reset_detected": ${v},\n    "rpc"`);
      if (twice === text) throw new Error("no status reset_detected line");
      const s = JSON.parse(twice);
      if (s.hash !== hashSnapshot(s)) throw new Error("the edited snapshot should still verify");
      const bad = join(work, "mcp-twice.json");
      writeFileSync(bad, twice);
      return mcp(bad);
    },
    ok: (r) => r.exit === 2 && r.stdout === "" && /holds the key "reset_detected" twice in one object; refusing to serve it/.test(r.stderr),
  },
  {
    name: "the MCP binary refuses a snapshot that is not valid UTF-8, though a lossy read verifies",
    run: () => {
      const s = JSON.parse(readFileSync(mcpSnapshot(), "utf8"));
      s.status.conflicts = [...s.status.conflicts, "a \uFFFD in a conflict"];
      s.hash = hashSnapshot(s);
      // In the written form, so the bad byte is the only thing wrong with the file.
      const raw = Buffer.from(feedText(s), "utf8");
      const at = raw.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
      if (at < 0) throw new Error("no U+FFFD to replace");
      // One invalid byte where U+FFFD was: a lossy read turns it back into U+FFFD and verifies.
      const bad = join(work, "mcp-not-utf8.json");
      writeFileSync(bad, Buffer.concat([raw.subarray(0, at), Buffer.from([0xff]), raw.subarray(at + 3)]));
      return mcp(bad);
    },
    ok: (r) => r.exit === 2 && r.stdout === "" && /it is not valid UTF-8; refusing to serve it/.test(r.stderr),
  },
  {
    name: "the MCP binary refuses an object that hashes to its own hash field but is no snapshot",
    run: () => {
      const bad = join(work, "mcp-not-a-snapshot.json");
      writeFileSync(bad, feedText({ hash: hashSnapshot({}) }));
      return mcp(bad);
    },
    ok: (r) => r.exit === 2 && r.stdout === "" && /is not an observatory snapshot; refusing to serve it/.test(r.stderr),
  },
  {
    name: "the MCP binary refuses a hashed snapshot whose parts are empty shells",
    run: () => {
      // Only the status is an empty shell, so the status check alone has to refuse it.
      const s = { schema: "flop-observatory/snapshot@0", observed_at: "2026-11-10T00:00:00Z", trust: "fixture", pin: {}, status: {}, escrows: [], census: null, drift: null, seq: 0, prev_hash: null };
      const bad = join(work, "mcp-empty-parts.json");
      writeFileSync(bad, feedText({ ...s, hash: hashSnapshot(s) }));
      return mcp(bad);
    },
    ok: (r) => r.exit === 2 && r.stdout === "" && /is not an observatory snapshot; refusing to serve it/.test(r.stderr),
  },
  {
    name: "the MCP binary refuses a snapshot behind a byte order mark",
    run: () => {
      const bad = join(work, "mcp-bom.json");
      writeFileSync(bad, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(mcpSnapshot())]));
      return mcp(bad);
    },
    ok: (r) => r.exit === 2 && r.stdout === "" && /it is not JSON; refusing to serve it/.test(r.stderr),
  },
  {
    name: "the MCP binary refuses an integer past 2^53 - 1, though the value JSON.parse reads hashes right",
    run: () => {
      const s = JSON.parse(readFileSync(mcpSnapshot(), "utf8"));
      s.status.runtime_version = 2 ** 53;
      s.hash = hashSnapshot(s);
      const text = feedText(s).replace('"runtime_version": 9007199254740992', '"runtime_version": 9007199254740993');
      if (!text.includes("9007199254740993")) throw new Error("no runtime_version to respell");
      const bad = join(work, "mcp-unsafe.json");
      writeFileSync(bad, text);
      return mcp(bad);
    },
    ok: (r) => r.exit === 2 && r.stdout === "" && /it is not in the written form/.test(r.stderr),
  },
  {
    name: "the MCP binary refuses a file nested 20000 levels deep with its own refusal, not a crash",
    run: () => {
      const bad = join(work, "mcp-deep.json");
      writeFileSync(bad, "[".repeat(20000) + "]".repeat(20000));
      return mcp(bad);
    },
    ok: (r) => r.exit === 2 && r.stdout === "" && /nests deeper than 64 levels; refusing to serve it/.test(r.stderr),
  },
  {
    name: "a snapshot refuses a log whose line is not in canonical form, and appends nothing",
    run: () => {
      const first = cli("snapshot", "--status", fx("status-healthy"), "--out", join(work, "pad-o1"), "--log", join(work, "pad.jsonl"));
      if (first.exit !== 0) return first;
      const p = join(work, "pad.jsonl");
      writeFileSync(p, " " + readFileSync(p, "utf8"));
      const before = readFileSync(p, "utf8");
      const second = cli("snapshot", "--status", fx("status-healthy"), "--out", join(work, "pad-o2"), "--log", p);
      return { ...second, unchanged: readFileSync(p, "utf8") === before };
    },
    ok: (r) => r.exit === 2 && /is broken at line 0/.test(r.stderr) && r.unchanged === true,
  },
  {
    name: "status: a head time later than the snapshot time is a conflict and degraded",
    run: () => cli("status", "--fixtures", fx("status-rpc-future-head")),
    ok: (r) => r.exit === 0 && r.json.rpc.health === "degraded" && r.json.rpc.stale === null && r.json.conflicts.some((c) => /later than the snapshot time/.test(c)),
  },
  {
    name: "status: a 503 faucet with an ok body is degraded",
    run: () => cli("status", "--fixtures", fx("status-faucet-503-ok-body")),
    ok: (r) => r.exit === 0 && r.json.faucet.health === "degraded",
  },
  {
    name: "status: no observed_at on the head leaves rpc health unknown",
    run: () => cli("status", "--fixtures", fx("status-rpc-no-observed-at")),
    ok: (r) => r.exit === 0 && r.json.rpc.health === "unknown" && r.json.rpc.stale === null,
  },
];

const results = [];
let bad = 0;
try {
  for (const c of cases) {
    const r = c.run();
    let pass = false;
    try {
      pass = Boolean(c.ok(r));
    } catch {
      pass = false;
    }
    if (!pass) bad++;
    results.push({ check: c.name, exit: r.exit, outcome: pass ? "pass" : "fail", stderr: pass ? undefined : r.stderr.slice(0, 300) });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
process.exit(bad ? 1 : 0);
