#!/usr/bin/env node
// Census cross-check: for every fixtures/census-* scenario, run the TypeScript census
// (dist/cli.js census) and the independent Python recount (tools/recount.py) on the same
// request, and compare every shared field. Both refusing the same input counts as agreement.
// Prints a JSON array; exit 1 on any disagreement or a scenario without census_request.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// --perturb is the self-test: add one to one TypeScript total before comparing. Every scenario
// that produced a report must then disagree; exit 0 only if the comparison caught them all.
const perturb = process.argv.includes("--perturb");
const DEVNET = "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631";
const KEYS = [
  "complete",
  "status",
  "covered",
  "gaps",
  "totals",
  "by_account",
  "pending_unfinalized",
  "duplicates_dropped",
  "excluded_other_genesis",
  "malformed_dropped",
];

function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: pkg, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { exit: r.status, json, stderr: (r.stderr ?? "").trim().slice(0, 400) };
}

const results = [];
let bad = 0;
const dirs = readdirSync(join(pkg, "fixtures")).filter((d) => d.startsWith("census-")).sort();
if (dirs.length === 0) {
  results.push({ scenario: null, outcome: "no census fixtures found" });
  bad++;
}
for (const d of dirs) {
  const dir = join("fixtures", d);
  const meta = JSON.parse(readFileSync(join(pkg, dir, "meta.json"), "utf8"));
  const req = meta.census_request;
  if (!req) {
    results.push({ scenario: d, outcome: "missing census_request in meta.json" });
    bad++;
    continue;
  }
  const genesis = meta.pinned_genesis ?? DEVNET;
  const ts = run("node", ["dist/cli.js", "census", "--fixtures", dir]);
  const py = run("python3", ["-I", "tools/recount.py", "--dir", dir, "--genesis", genesis, "--from", String(req.from_block), "--to", String(req.to_block)]);
  if (ts.exit !== 0 || py.exit !== 0) {
    const agree = ts.exit !== 0 && py.exit !== 0;
    if (!agree) bad++;
    results.push({ scenario: d, outcome: agree ? "both-refused" : "disagree-on-refusal", ts_exit: ts.exit, py_exit: py.exit, ts_err: ts.stderr, py_err: py.stderr });
    continue;
  }
  if (perturb && ts.json?.totals) ts.json.totals.escrows_opened += 1;
  const diffs = KEYS.filter((k) => canon(ts.json?.[k]) !== canon(py.json?.[k])).map((k) => ({ key: k, ts: ts.json?.[k], py: py.json?.[k] }));
  if (perturb ? diffs.length === 0 : diffs.length > 0) bad++;
  results.push({
    scenario: d,
    outcome: diffs.length ? "disagree" : "agree",
    complete: ts.json?.complete,
    status: ts.json?.status,
    totals: ts.json?.totals,
    diffs,
  });
}
console.log(JSON.stringify(results, null, 2));
process.exit(bad ? 1 : 0);
