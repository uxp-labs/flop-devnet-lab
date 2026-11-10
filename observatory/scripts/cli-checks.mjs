#!/usr/bin/env node
// The command line wiring, end to end through dist/cli.js: unreadable pages reach the census and
// the escrows, a snapshot refuses parts pinned to another chain, and the status health rules
// show up in the command's output. Unit tests cover the modules; this covers the plumbing.
// Prints a JSON array; exit 1 on any failed expectation.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "obs-cli-checks-"));
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

const cases = [
  {
    name: "census refuses a scenario with an unreadable page file",
    run: () => cli("census", "--fixtures", fx("census-unreadable-page")),
    ok: (r) => r.exit === 2 && /unreadable event page/.test(r.stderr) && /01-unreadable\.json/.test(r.stderr),
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
    ok: (r) => r.exit === 2 && /unreadable event page/.test(r.stderr),
  },
  {
    name: "a snapshot refuses a part pinned to a different genesis",
    run: () => cli("snapshot", "--status", fx("status-healthy"), "--census", otherPin, "--out", join(work, "snap-pin")),
    ok: (r) => r.exit === 2 && /pinned to genesis 0xabab/.test(r.stderr),
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
