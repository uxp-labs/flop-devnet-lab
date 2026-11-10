#!/usr/bin/env node
// Census cross-check: for every fixtures/census-* scenario, run the TypeScript census
// (dist/cli.js census) and the independent Python recount (tools/recount.py) on the same
// request, and compare every shared field. Both refusing counts as agreement only for the same
// reason (RULES.md 3.1 clause 16): the same kind, and for a page file problem the same file.
// Prints a JSON array; exit 1 on any disagreement or a scenario without census_request.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// --perturb is the self-test: add one to one TypeScript total before comparing, and change the
// TypeScript refusal reason (the file for a page file problem, else the kind). Every scenario must
// then disagree; exit 0 only if the comparison caught them all.
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

/** The reason one side refused (clause 16), from the first "census refused (kind): ..." line. */
function refusal(stderr) {
  const m = /census refused \(([a-z-]+)\): ([^\n]*)/.exec(stderr);
  if (!m) return { kind: null, file: null };
  const file = m[1] === "page-file" ? (/^(?:unusable event page file\(s\): )?(event-pages(?:\/[^:;]*)?)(?=:)/.exec(m[2])?.[1] ?? null) : null;
  return { kind: m[1], file };
}

// Scenarios made at run time, for inputs that git cannot hold on every machine: a page file whose
// name is not UTF-8 (macOS refuses such names). Each is skipped, and says so, only where the
// filesystem refuses to make it.
const generatedRoot = realpathSync(mkdtempSync(join(tmpdir(), "obs-recount-gen-")));
const generated = [];
{
  const dir = join(generatedRoot, "generated-page-name-not-utf8");
  mkdirSync(join(dir, "event-pages"), { recursive: true });
  const ev = (block, method) => ({ block_number: block, block_hash: "0xa1" + block.toString(16).padStart(62, "0"), finalized: true, index: 0, section: "hasStation", method, data: { who: "synthetic-alice" } });
  const page = (from, to, events) => JSON.stringify({ genesis: DEVNET, from_block: from, to_block: to, page: 0, next_page: null, events });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ scenario: "generated-page-name-not-utf8", description: "made at run time", now: "2026-11-10T00:00:00.000Z", synthetic: true, census_request: { from_block: 0, to_block: 199 }, pinned_genesis: DEVNET }));
  writeFileSync(join(dir, "event-pages", "00.json"), page(0, 99, [ev(10, "EscrowOpened")]));
  try {
    writeFileSync(Buffer.concat([Buffer.from(join(dir, "event-pages") + "/"), Buffer.from([0x30, 0x31, 0x2d, 0xff, 0x2e, 0x6a, 0x73, 0x6f, 0x6e])]), page(100, 199, [ev(150, "EscrowReleased")]));
    generated.push(dir);
  } catch (e) {
    generated.push({ skipped: "generated-page-name-not-utf8", why: `this filesystem refuses the name: ${e.code ?? e.message}` });
  }
}

const results = [];
let bad = 0;
const dirs = readdirSync(join(pkg, "fixtures")).filter((d) => d.startsWith("census-")).sort();
if (dirs.length === 0) {
  results.push({ scenario: null, outcome: "no census fixtures found" });
  bad++;
}
const scenarios = [...dirs.map((d) => ({ name: d, dir: join("fixtures", d) }))];
for (const g of generated) {
  if (typeof g === "string") scenarios.push({ name: g.split("/").pop(), dir: g });
  else results.push({ scenario: g.skipped, outcome: "not-made", why: g.why });
}
for (const { name: d, dir } of scenarios) {
  const meta = JSON.parse(readFileSync(resolve(pkg, dir, "meta.json"), "utf8"));
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
    const tr = refusal(ts.stderr);
    const pr = refusal(py.stderr);
    if (perturb && tr.kind !== null) {
      if (tr.file !== null) tr.file += "x";
      else tr.kind = tr.kind === "page-structure" ? "page-file" : "page-structure";
    }
    // A refusal exits 2 and names its reason. Any other exit, a crash say, is never a refusal.
    const both = ts.exit === 2 && py.exit === 2;
    const same = both && tr.kind !== null && tr.kind === pr.kind && tr.file === pr.file;
    if (perturb ? same : !same) bad++;
    results.push({
      scenario: d,
      outcome: !both ? "disagree-on-refusal" : same ? "both-refused" : "disagree-on-reason",
      ts_exit: ts.exit,
      py_exit: py.exit,
      ts_reason: tr,
      py_reason: pr,
      ts_err: ts.stderr,
      py_err: py.stderr,
    });
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
rmSync(generatedRoot, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
process.exit(bad ? 1 : 0);
