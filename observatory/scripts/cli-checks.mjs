#!/usr/bin/env node
// The command line wiring, end to end through dist/cli.js: unreadable pages reach the census and
// the escrows, a snapshot refuses parts pinned to another chain, and the status health rules
// show up in the command's output. The MCP binary (dist/mcp-bin.js) serves a snapshot whose hash
// verifies and refuses one whose hash fails, one read lossily or with a key twice, and an object
// that hashes to itself but is no snapshot, naming the checks a refused snapshot breaks (each
// check is tested on its own in test/snapshot-check.test.ts). Unit tests cover the modules; this
// covers the plumbing.
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
// Every node this script starts runs with its warnings off, so a warning Node prints for the
// environment it finds (NODE_USE_ENV_PROXY, say) never reaches a check that reads a refusal whole
// (the third IMD audit's specialists saw two checks fail on one).
// Each has a minute, so a command that waits for ever fails its check instead of the run.
const node = (args, opts = {}) => spawnSync("node", args, { cwd: pkg, encoding: "utf8", timeout: 60000, ...opts, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
const cli = (...args) => cliWithin(60000, ...args);
/** The command line, stopped after ms: a command stopped so has no exit code. */
function cliWithin(ms, ...args) {
  const r = node([join(pkg, "dist", "cli.js"), ...args], { timeout: ms });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { exit: r.status, json, stderr: (r.stderr ?? "").trim() };
}

// A copy of census-complete pinned to another genesis, for the one-chain rule.
const otherPin = join(work, "census-other-pin");
cpSync(join(pkg, fx("census-complete")), otherPin, { recursive: true });
const meta = JSON.parse(readFileSync(join(otherPin, "meta.json"), "utf8"));
meta.pinned_genesis = "0x" + "ab".repeat(32);
writeFileSync(join(otherPin, "meta.json"), JSON.stringify(meta, null, 2));

// The snapshot command's --upgrade (RULES.md 7.2): copies of watch-authorized with its storage.json
// gone, not JSON, holding a key more, with an answer of another form, or pinned to another genesis;
// and a status a little later, so a second watch on one log is compared with the first.
const upgradeCopy = (name, edit) => {
  const d = join(work, name);
  cpSync(join(pkg, fx("watch-authorized")), d, { recursive: true });
  edit(d);
  return d;
};
const upNoFile = upgradeCopy("up-no-file", (d) => rmSync(join(d, "storage.json")));
const upNotJson = upgradeCopy("up-not-json", (d) => writeFileSync(join(d, "storage.json"), "{"));
const upKeyMore = upgradeCopy("up-key-more", (d) => {
  const o = JSON.parse(readFileSync(join(d, "storage.json"), "utf8"));
  o["System.Code"] = { result: null };
  writeFileSync(join(d, "storage.json"), JSON.stringify(o));
});
const upBadAnswer = upgradeCopy("up-bad-answer", (d) => {
  const o = JSON.parse(readFileSync(join(d, "storage.json"), "utf8"));
  o["System.AuthorizedUpgrade"] = { result: null, error: "both" };
  writeFileSync(join(d, "storage.json"), JSON.stringify(o));
});
const upOtherPin = upgradeCopy("up-other-pin", (d) => {
  const o = JSON.parse(readFileSync(join(d, "meta.json"), "utf8"));
  o.pinned_genesis = "0x" + "ab".repeat(32);
  writeFileSync(join(d, "meta.json"), JSON.stringify(o));
});
const upLater = join(work, "up-later");
cpSync(join(pkg, fx("status-healthy")), upLater, { recursive: true });
{
  const p = join(upLater, "rpc-head.json");
  const o = JSON.parse(readFileSync(p, "utf8"));
  o.finalized = { number: o.finalized.number + 10, hash: "0x" + "12".repeat(32) };
  o.best_number += 10;
  writeFileSync(p, JSON.stringify(o, null, 2));
}
const upLog = join(work, "up.jsonl");

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
// The round 8 review's case L1: an earlier snapshot read a best height but no finalized head; the
// next reads a fresh, low head on the same genesis, as a chain restarted from the same spec would.
const bestOnly = join(work, "best-only-high");
const restartLow = join(work, "restart-low-head");
cpSync(join(pkg, fx("status-healthy")), bestOnly, { recursive: true });
cpSync(join(pkg, fx("status-healthy")), restartLow, { recursive: true });
{
  const edit = (dir, file, fn) => {
    const p = join(dir, file);
    const o = JSON.parse(readFileSync(p, "utf8"));
    fn(o);
    writeFileSync(p, JSON.stringify(o, null, 2));
  };
  edit(bestOnly, "rpc-head.json", (o) => (o.finalized = null));
  edit(restartLow, "rpc-head.json", (o) => {
    o.finalized = { number: 5, hash: "0x" + "55".repeat(32) };
    o.best_number = 8;
    o.observed_at = "2026-11-09T23:48:40Z";
  });
  edit(restartLow, "meta.json", (o) => (o.now = "2026-11-09T23:48:41Z"));
  for (const f of ["faucet-health.json", "faucet-chain.json", "gateway-models.json"]) edit(restartLow, f, (o) => (o.fetched_at = "2026-11-09T23:48:40Z"));
}
// The round 9 review's case L5 and the round 10 review's case L4: finality stalls with the best
// block 100 ahead, then 75 blocks fall away. That may be a long fork lost or a restart, so the head
// is not usable (it fails closed) until the best height is back within the lag limit.
const stalled = join(work, "stalled-finality");
const reorged = join(work, "after-reorg");
const healed = join(work, "healed");
cpSync(join(pkg, fx("status-healthy")), stalled, { recursive: true });
cpSync(join(pkg, fx("status-healthy")), reorged, { recursive: true });
cpSync(join(pkg, fx("status-healthy")), healed, { recursive: true });
{
  const edit = (dir, file, fn) => {
    const p = join(dir, file);
    const o = JSON.parse(readFileSync(p, "utf8"));
    fn(o);
    writeFileSync(p, JSON.stringify(o, null, 2));
  };
  edit(stalled, "rpc-head.json", (o) => (o.best_number = 3341675));
  edit(reorged, "rpc-head.json", (o) => {
    o.finalized = { number: 3341580, hash: "0x" + "58".repeat(32) };
    o.best_number = 3341600;
    o.observed_at = "2026-11-09T23:48:40Z";
  });
  edit(reorged, "meta.json", (o) => (o.now = "2026-11-09T23:48:41Z"));
  for (const f of ["faucet-health.json", "faucet-chain.json", "gateway-models.json"]) edit(reorged, f, (o) => (o.fetched_at = "2026-11-09T23:48:40Z"));
  edit(healed, "rpc-head.json", (o) => {
    o.finalized = { number: 3341650, hash: "0x" + "65".repeat(32) };
    o.best_number = 3341660;
    o.observed_at = "2026-11-09T23:49:28Z";
  });
  edit(healed, "meta.json", (o) => (o.now = "2026-11-09T23:49:29Z"));
  for (const f of ["faucet-health.json", "faucet-chain.json", "gateway-models.json"]) edit(healed, f, (o) => (o.fetched_at = "2026-11-09T23:49:28Z"));
}
// The round 8 review's case L2: a usable /chain reading whose body names no genesis.
const chainEmpty = join(work, "chain-body-empty");
cpSync(join(pkg, fx("status-healthy")), chainEmpty, { recursive: true });
{
  const p = join(chainEmpty, "faucet-chain.json");
  const o = JSON.parse(readFileSync(p, "utf8"));
  o.body = {};
  writeFileSync(p, JSON.stringify(o, null, 2));
}
// The round 8 review's case I2: escrow ids the MCP server would refuse to look up.
const oddIds = join(work, "escrows-odd-ids");
cpSync(join(pkg, fx("escrows-verification")), oddIds, { recursive: true });
{
  const p = join(oddIds, "meta.json");
  const o = JSON.parse(readFileSync(p, "utf8"));
  o.escrow_ids = [...o.escrow_ids, "0x12"];
  writeFileSync(p, JSON.stringify(o, null, 2));
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
  const r = node([join(pkg, "dist", "mcp-bin.js"), snapshotPath], { input: JSON.stringify(call) + "\n" });
  return { exit: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").trim() };
};
const mcpSnapshot = () => {
  const out = join(work, "mcp-snap");
  const r = cli("snapshot", "--status", fx("status-healthy"), "--out", out);
  if (r.exit !== 0) throw new Error(`snapshot for the MCP checks failed: ${r.stderr}`);
  return join(out, "snapshot.json");
};

// Third IMD audit J3: scenarios whose meta.json gives no time, or one that is no time.
const timeless = {};
for (const [part, name] of [["status", "status-healthy"], ["escrow", "escrows-verification"], ["census", "census-complete"], ["drift", "drift-seeded"]]) {
  for (const [how, now] of [["missing", undefined], ["a-word", "yesterday"]]) {
    const d = join(work, `${part}-now-${how}`);
    cpSync(join(pkg, fx(name)), d, { recursive: true });
    const m = JSON.parse(readFileSync(join(d, "meta.json"), "utf8"));
    if (now === undefined) delete m.now;
    else m.now = now;
    // The drift spec stays where it is: the copy names it by its full path.
    if (m.params_spec) m.params_spec = join(pkg, fx(name), m.params_spec);
    writeFileSync(join(d, "meta.json"), JSON.stringify(m, null, 2));
    timeless[`${part}-${how}`] = d;
  }
}
// Third IMD audit J4: named pipes where a command reads a file. Nothing ever writes to them, so a
// command that opened one to read would wait for ever; each run below has ten seconds.
const fifo = (p) => {
  const r = spawnSync("mkfifo", [p], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`mkfifo ${p} failed: ${r.stderr ?? r.error?.message}`);
  return p;
};
const pipedReading = join(work, "status-faucet-health-a-pipe");
cpSync(join(pkg, fx("status-healthy")), pipedReading, { recursive: true });
rmSync(join(pipedReading, "faucet-health.json"));
fifo(join(pipedReading, "faucet-health.json"));
const pipedMeta = join(work, "status-meta-a-pipe");
cpSync(join(pkg, fx("status-healthy")), pipedMeta, { recursive: true });
rmSync(join(pipedMeta, "meta.json"));
fifo(join(pipedMeta, "meta.json"));
const pipe = fifo(join(work, "a-pipe"));

const cases = [
  {
    name: "the request list writer writes recordings/requests.json byte for byte, and refuses a call without --out",
    run: () => {
      const out = join(work, "requests.json");
      const w = node([join(pkg, "scripts", "write-requests.mjs"), "--out", out]);
      const bare = node([join(pkg, "scripts", "write-requests.mjs")]);
      let same = false;
      try {
        same = readFileSync(out).equals(readFileSync(join(pkg, "recordings", "requests.json")));
      } catch {
        same = false;
      }
      return { exit: w.status, same, bare: bare.status, stderr: `${w.stderr ?? ""}${bare.stderr ?? ""}`.trim() };
    },
    ok: (r) => r.exit === 0 && r.same && r.bare === 2 && r.stderr === "usage: node scripts/write-requests.mjs --out <file>",
  },
  {
    name: "the request list writer refuses, in one line of its own and with exit 1, a Node without type stripping",
    run: () => {
      const w = node(["--no-experimental-strip-types", join(pkg, "scripts", "write-requests.mjs"), "--out", join(work, "requests-old.json")]);
      return { exit: w.status, stderr: (w.stderr ?? "").trim() };
    },
    ok: (r) => r.exit === 1 && /^write-requests needs Node 22\.18 or later, with type stripping; this is Node [0-9.]+$/.test(r.stderr),
  },
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
    name: "a snapshot with --upgrade refuses a storage.json that is missing, not JSON, holds a key more or an answer of another form",
    run: () => {
      const got = [upNoFile, upNotJson, upKeyMore, upBadAnswer].map((d, i) => cli("snapshot", "--status", fx("status-healthy"), "--upgrade", d, "--out", join(work, `up-refused-${i}`)));
      const want = [/storage\.json cannot be read as a regular file/, /storage\.json is not valid JSON/, /must hold exactly System\.AuthorizedUpgrade and System\.LastRuntimeUpgrade/, /System\.AuthorizedUpgrade must be \{"result": \.\.\.\} or \{"error": "\.\.\."\}/];
      const bad = got.findIndex((r, i) => !(r.exit === 2 && want[i].test(r.stderr)));
      return bad === -1 ? { exit: 2, json: null, stderr: "ok" } : got[bad];
    },
    ok: (r) => r.exit === 2 && r.stderr === "ok",
  },
  {
    name: "a snapshot with --upgrade refuses a status with no finalized head to count the reads at, and a part pinned to another genesis",
    run: () => {
      const none = cli("snapshot", "--status", fx("status-unknown"), "--upgrade", fx("watch-authorized"), "--out", join(work, "up-no-head"));
      if (!(none.exit === 2 && /--upgrade needs a status fixture with a finalized head/.test(none.stderr))) return none;
      return cli("snapshot", "--status", fx("status-healthy"), "--upgrade", upOtherPin, "--out", join(work, "up-pin"));
    },
    ok: (r) => r.exit === 2 && /pinned to genesis 0xabab/.test(r.stderr),
  },
  {
    name: "a snapshot with --upgrade writes the watch at the status's finalized head, and the next one on the log is compared with it",
    run: () => {
      const first = cli("snapshot", "--status", fx("status-healthy"), "--upgrade", fx("watch-authorized"), "--out", join(work, "up-o1"), "--log", upLog);
      if (first.exit !== 0) return first;
      const second = cli("snapshot", "--status", upLater, "--upgrade", fx("watch-authorized"), "--out", join(work, "up-o2"), "--log", upLog);
      if (second.exit !== 0) return second;
      const a = JSON.parse(readFileSync(join(work, "up-o1", "upgrade.json"), "utf8")).upgrade;
      const b = JSON.parse(readFileSync(join(work, "up-o2", "upgrade.json"), "utf8")).upgrade;
      const head = JSON.parse(readFileSync(join(upLater, "rpc-head.json"), "utf8")).finalized;
      const said = [a?.compared_with, a?.executing?.state, a?.authorized?.state, b?.at?.hash, b?.at?.number, b?.compared_with, b?.executing_changed, b?.authorization_appeared];
      const want = [null, "reviewed", "present", head.hash, head.number, a?.at?.number, false, false];
      return { exit: JSON.stringify(said) === JSON.stringify(want) ? 0 : 1, json: null, stderr: JSON.stringify(said) };
    },
    ok: (r) => r.exit === 0,
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
      // A change no shape or sense check reads, so the hash check alone has to refuse it.
      s.status.conflicts = [...s.status.conflicts, "a conflict added after hashing"];
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
    ok: (r) => r.exit === 2 && r.stdout === "" && r.stderr.endsWith("is not an observatory snapshot; refusing to serve it (it breaks snapshot.fields)"),
  },
  {
    name: "the MCP binary refuses a hashed snapshot whose parts are empty shells",
    run: () => {
      // Only the status is an empty shell, so it is the one check broken: the agreements are read
      // only once every shape holds.
      const pin = { source_sha: null, source: "fixture:none", genesis: null, finalized_height: null, finalized_hash: null, node: "v22.23.4" };
      const s = { schema: "flop-observatory/snapshot@0", observed_at: "2026-11-10T00:00:00Z", trust: "fixture", pin, status: {}, escrows: [], census: null, drift: null, seq: 0, prev_hash: null };
      const bad = join(work, "mcp-empty-parts.json");
      writeFileSync(bad, feedText({ ...s, hash: hashSnapshot(s) }));
      return mcp(bad);
    },
    ok: (r) => r.exit === 2 && r.stdout === "" && r.stderr.endsWith("is not an observatory snapshot; refusing to serve it (it breaks status.fields)"),
  },
  {
    // Every check and its case live in src/snapshot-check.ts and test/snapshot-check.test.ts. This
    // shows the binary refuses on the module's verdict and names what it found, end to end.
    name: "the MCP binary serves a hashed snapshot every check passes, and refuses one that breaks a check, naming the checks it breaks",
    run: () => {
      const out = join(work, "mcp-snap-escrows");
      const made = cli("snapshot", "--status", fx("status-healthy"), "--escrows", fx("escrows-verification"), "--out", out);
      if (made.exit !== 0) return { ...made, runs: [] };
      const s0 = JSON.parse(readFileSync(join(out, "snapshot.json"), "utf8"));
      const variant = (name, edit, breaks) => {
        const { hash: _hash, ...s } = structuredClone(s0);
        edit(s);
        const p = join(work, `mcp-${name}.json`);
        writeFileSync(p, feedText({ ...s, hash: hashSnapshot(s) }));
        return { name, breaks, ...mcp(p) };
      };
      const runs = [
        variant("honest", () => {}, null),
        // A value the snapshot command writes (seventh rerun U1).
        variant("gateway-http-negative", (s) => (s.status.gateway.http = -1), null),
        variant("escrow-extra-field", (s) => (s.escrows[0].approved = true), "escrow.fields"),
        variant("lag-that-does-not-add-up", (s) => (s.status.finality_lag = 99), "status.lag-adds-up"),
        variant("two-shapes", (s) => ((s.status.rpc.health = "great"), (s.escrows[0].trust = "approved")), "status.rpc.health, escrow.trust"),
        variant(
          "every-status-field-a-word",
          (s) => (s.status = Object.fromEntries(Object.keys(s.status).map((k) => [k, "x"]))),
          "status.schema, status.observed_at, status.trust, status.genesis, status.reset_detected and 9 more",
        ),
      ];
      // Each snapshot by name with its exit, so a failure says which one was served.
      return { exit: runs.map((x) => x.exit).join(","), stderr: runs.map((x) => `${x.name}: exit ${x.exit} ${x.stderr}`).join("; "), runs };
    },
    ok: (r) =>
      r.runs.length === 6 &&
      r.runs.every((x) =>
        x.breaks === null
          ? x.exit === 0 && JSON.parse(x.stdout).id === 1
          : x.exit === 2 && x.stdout === "" && x.stderr.endsWith(`is not an observatory snapshot; refusing to serve it (it breaks ${x.breaks})`),
      ),
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
  {
    name: "an earlier best height with no finalized head is a floor too: a fresh low head on that genesis is a conflict, and reset_detected is not false",
    run: () => {
      const first = cli("snapshot", "--status", bestOnly, "--out", join(work, "best-o1"), "--log", join(work, "best.jsonl"));
      if (first.exit !== 0) return first;
      const second = cli("snapshot", "--status", restartLow, "--escrows", fx("escrows-opened-only"), "--out", join(work, "best-o2"), "--log", join(work, "best.jsonl"));
      if (second.exit !== 0) return second;
      return { ...second, json: JSON.parse(readFileSync(join(work, "best-o2", "snapshot.json"), "utf8")) };
    },
    ok: (r) =>
      r.exit === 0 &&
      r.json.status.reset_detected === null &&
      r.json.status.rpc.health === "degraded" &&
      r.json.status.conflicts.some((c) => /best block 8 is more than 30 blocks below the best block 3341577/.test(c)) &&
      r.json.escrows.every((e) => e.finalized_height === null),
  },
  {
    name: "status: a usable /chain reading that names no genesis says so in the faucet's detail",
    run: () => cli("status", "--fixtures", chainEmpty),
    ok: (r) => r.exit === 0 && r.json.reset_detected === null && /the \/chain reading does not count: it names no genesisHash/.test(r.json.faucet.detail ?? ""),
  },
  {
    name: "a snapshot refuses an escrow id that is not 0x plus 64 hex, which the MCP server could not look up",
    run: () => cli("snapshot", "--status", fx("status-healthy"), "--escrows", oddIds, "--out", join(work, "odd-ids-o")),
    ok: (r) => r.exit === 2 && /escrow id "0x12" is not 0x plus 64 hex/.test(r.stderr),
  },
  {
    name: "a command refuses a flag it does not read, a flag given twice and a value after =",
    run: () => {
      const runs = [
        cli("status", "--fixtures", fx("status-healthy"), "--log", join(work, "x.jsonl")),
        cli("snapshot", "--status", fx("status-healthy"), "--status", fx("status-reset"), "--out", join(work, "twice-o")),
        cli("status", `--fixtures=${fx("status-healthy")}`),
        cli("status", fx("status-healthy")),
      ];
      return { exit: runs.map((x) => x.exit).join(","), stderr: runs.map((x) => x.stderr).join(" | "), runs };
    },
    ok: (r) =>
      r.runs.every((x) => x.exit === 2 && x.json === null) &&
      /--log is not a flag status reads/.test(r.runs[0].stderr) &&
      /--status is given twice/.test(r.runs[1].stderr) &&
      /give a flag's value as the next argument, not after =/.test(r.runs[2].stderr) &&
      /is no flag's value/.test(r.runs[3].stderr),
  },
  {
    name: "a command refuses an empty flag value, as an unset shell variable gives, and a --now that is no time",
    run: () => {
      const runs = [
        cli("snapshot", "--status", restartLow, "--log", "", "--out", join(work, "empty-log-o")),
        cli("snapshot", "--status", fx("status-healthy"), "--census", "", "--out", join(work, "empty-census-o")),
        cli("census", "--fixtures", fx("census-complete"), "--now", "yesterday"),
        cli("status", "--fixtures", fx("status-healthy"), "--now", ""),
      ];
      return { exit: runs.map((x) => x.exit).join(","), stderr: runs.map((x) => x.stderr).join(" | "), runs };
    },
    ok: (r) =>
      r.runs.every((x) => x.exit === 2 && x.json === null) &&
      /--log needs a value/.test(r.runs[0].stderr) &&
      /--census needs a value/.test(r.runs[1].stderr) &&
      /census refused \(request\): --now must be an ISO 8601 time with a zone/.test(r.runs[2].stderr) &&
      /--now needs a value/.test(r.runs[3].stderr),
  },
  {
    name: "census without its folder flag is a refusal of the request, as the recount's missing --dir is",
    run: () => cli("census", "--genesis", "0x" + "99".repeat(32), "--from", "0", "--to", "10"),
    ok: (r) => r.exit === 2 && /census refused \(request\): missing --fixtures/.test(r.stderr),
  },
  {
    name: "census of a scenario with no range given and none in its meta.json is a refusal of the request, named as one (sixth rerun U8)",
    run: () => cli("census", "--fixtures", fx("status-healthy")),
    ok: (r) => r.exit === 2 && r.stderr === "flop-observatory: census refused (request): no --from/--to and no census_request in meta.json",
  },
  {
    name: "census of a scenario folder that does not exist names it in one line, a line break in its name shown as %0A (sixth rerun U8)",
    run: () => cli("census", "--fixtures", join(work, "no\nsuch-folder"), "--genesis", "0x" + "99".repeat(32), "--from", "0", "--to", "10"),
    // The output is read trimmed, so one line is no line break at all.
    ok: (r) => r.exit === 2 && !/[\n\r]/.test(r.stderr) && r.stderr.includes("census refused (input): fixture ") && r.stderr.endsWith("no%0Asuch-folder has no readable meta.json"),
  },
  {
    name: "after a finality stall, a best height that falls further than the lag limit is a conflict (a restart looks the same), and once it is back within the limit the head counts again",
    run: () => {
      const first = cli("snapshot", "--status", stalled, "--out", join(work, "stall-o1"), "--log", join(work, "stall.jsonl"));
      if (first.exit !== 0) return first;
      const second = cli("snapshot", "--status", reorged, "--out", join(work, "stall-o2"), "--log", join(work, "stall.jsonl"));
      if (second.exit !== 0) return second;
      const third = cli("snapshot", "--status", healed, "--out", join(work, "stall-o3"), "--log", join(work, "stall.jsonl"));
      if (third.exit !== 0) return third;
      const read = (o) => JSON.parse(readFileSync(join(work, o, "status.json"), "utf8")).status;
      return { ...third, json: { fell: read("stall-o2"), back: read("stall-o3") } };
    },
    ok: (r) =>
      r.exit === 0 &&
      r.json.fell.reset_detected === null &&
      r.json.fell.conflicts.some((c) => /best block 3341600 is more than 30 blocks below the best block 3341675/.test(c)) &&
      r.json.back.reset_detected === false &&
      r.json.back.conflicts.length === 0,
  },
  {
    name: "every command refuses a scenario whose meta.json now is missing or no time, unless --now gives one, census as an input problem (third IMD audit J3)",
    run: () => {
      const runs = [];
      for (const how of ["missing", "a-word"]) {
        runs.push({ name: `status-${how}`, ...cli("status", "--fixtures", timeless[`status-${how}`]) });
        runs.push({ name: `escrow-${how}`, ...cli("escrow", "--fixtures", timeless[`escrow-${how}`]) });
        runs.push({ name: `census-${how}`, ...cli("census", "--fixtures", timeless[`census-${how}`]) });
        runs.push({ name: `drift-${how}`, ...cli("drift", "--fixtures", timeless[`drift-${how}`]) });
        runs.push({ name: `snapshot-${how}`, ...cli("snapshot", "--status", timeless[`status-${how}`], "--out", join(work, `now-${how}-out`)) });
      }
      const given = "2026-11-10T00:00:00Z";
      const withNow = [
        cli("escrow", "--fixtures", timeless["escrow-missing"], "--now", given),
        cli("census", "--fixtures", timeless["census-missing"], "--now", given),
        cli("drift", "--fixtures", timeless["drift-a-word"], "--now", given),
      ];
      return { exit: runs.map((x) => x.exit).join(","), stderr: runs.map((x) => `${x.name}: ${x.stderr}`).join(" | "), runs, withNow, given };
    },
    ok: (r) =>
      r.runs.length === 10 &&
      r.runs.every(
        (x) =>
          x.exit === 2 &&
          x.stderr ===
            `flop-observatory: ${x.name.startsWith("census") ? "census refused (input): " : ""}meta.json now must be an ISO 8601 time with a zone, such as 2026-11-09T23:47:41Z, or --now must give one`,
      ) &&
      r.withNow.every((x) => x.exit === 0) &&
      r.withNow[0].json.every((e) => e.observed_at === r.given) &&
      r.withNow[1].json.observed_at === r.given &&
      r.withNow[2].json.observed_at === r.given,
  },
  {
    name: "a saved reading that is a named pipe counts as nothing read, naming the file, and the command answers at once (third IMD audit J4)",
    run: () => cliWithin(10000, "status", "--fixtures", pipedReading),
    ok: (r) => r.exit === 0 && r.json.faucet.health === "unknown" && r.json.faucet.detail === "faucet-health.json: not a regular file",
  },
  {
    name: "a meta.json, a snapshot log, a drift spec or a served snapshot that is a named pipe is refused at once, never waited on (third IMD audit J4)",
    run: () => {
      const served = node([join(pkg, "dist", "mcp-bin.js"), pipe], { input: "", timeout: 10000 });
      const runs = [
        { name: "meta", ...cliWithin(10000, "status", "--fixtures", pipedMeta) },
        { name: "log", ...cliWithin(10000, "snapshot", "--status", fx("status-healthy"), "--out", join(work, "pipe-log-out"), "--log", pipe) },
        { name: "spec", ...cliWithin(10000, "drift", "--fixtures", fx("drift-seeded"), "--spec", pipe) },
        { name: "mcp", exit: served.status, stderr: (served.stderr ?? "").trim() },
      ];
      return { exit: runs.map((x) => x.exit).join(","), stderr: runs.map((x) => `${x.name}: ${x.stderr}`).join(" | "), runs };
    },
    ok: (r) =>
      r.runs.every((x) => x.exit === 2) &&
      /has no readable meta\.json/.test(r.runs[0].stderr) &&
      r.runs[1].stderr === `flop-observatory: snapshot log ${pipe} is not a regular file; it is never extended or trusted` &&
      r.runs[2].stderr === `flop-observatory: cannot read spec ${pipe}: not a regular file` &&
      r.runs[3].stderr === `cannot read snapshot ${pipe}: it is not a regular file; refusing to serve it`,
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
// exitCode, not exit(): the mutation runner reads this report through a pipe, where a write is
// asynchronous and exit() could cut it short.
process.exitCode = bad ? 1 : 0;
