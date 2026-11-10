#!/usr/bin/env node
// Census cross-check: for every fixtures/census-* scenario, run the TypeScript census
// (dist/cli.js census) and the independent Python recount (tools/recount.py) on the same
// request, and compare every shared field. Both refusing counts as agreement only for the same
// reason (RULES.md 3.1 clause 16): the same kind, and for a page file problem the same file.
// Then command line inputs both sides must refuse alike: request numbers that are not plain
// digits or too long, an inverted range, an empty genesis, a missing folder, and arguments read
// other than as --name followed by its value (round 8 review L7).
// Prints a JSON array; exit 1 on any disagreement, a run that printed no census, or a scenario
// without census_request.
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
  const r = spawnSync(cmd, args, { cwd: pkg, encoding: "utf8", maxBuffer: 1 << 28 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { exit: r.status, json, stderr: (r.stderr ?? "").trim() };
}

/**
 * A file name as both sides show it: when it is UTF-8 as itself but for % and the control
 * characters, else byte for byte, each as %XX (round 9 review I2).
 */
function shownName(raw) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/[%\u0000-\u001f\u007f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  } catch {
    return [...raw].map((b) => (b >= 0x20 && b < 0x7f && b !== 0x25 ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
  }
}

/**
 * Every file a refusal can name in a scenario: event-pages itself and each entry in it, longest
 * first, so a name that holds a colon or a semicolon is read whole (round 8 review I6).
 */
function namesIn(dir) {
  const names = ["event-pages"];
  try {
    for (const e of readdirSync(join(resolve(pkg, dir), "event-pages"), { encoding: "buffer" })) names.push(`event-pages/${shownName(e)}`);
  } catch {
    // No folder: only event-pages itself can be named.
  }
  return names.sort((a, b) => b.length - a.length);
}

/**
 * The reason one side refused (clause 16), from the first "census refused (kind): ..." line: its
 * kind and, for a page file problem, the file, read as the longest name in the scenario that the
 * message names before a colon. A message that names none keeps its whole text, so two such
 * messages agree only if they are the same.
 */
function refusal(stderr, names) {
  const m = /census refused \(([a-z-]+)\): ([^\n]*)/.exec(stderr);
  if (!m) return { kind: null, file: null };
  if (m[1] !== "page-file") return { kind: m[1], file: null };
  const rest = m[2].replace(/^unusable event page file\(s\): /, "");
  return { kind: m[1], file: names.find((n) => rest.startsWith(`${n}:`)) ?? `no file of the scenario: ${rest}` };
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
{
  // A bad page file whose name holds a colon and a semicolon, beside a good one whose name starts
  // the same way, so each side must name the file whole (round 8 review I6).
  const dir = join(generatedRoot, "generated-page-name-with-a-colon");
  mkdirSync(join(dir, "event-pages"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ scenario: "generated-page-name-with-a-colon", description: "made at run time", now: "2026-11-10T00:00:00.000Z", synthetic: true, census_request: { from_block: 0, to_block: 99 }, pinned_genesis: DEVNET }));
  writeFileSync(join(dir, "event-pages", "01.json"), JSON.stringify({ genesis: DEVNET, from_block: 0, to_block: 99, page: 0, next_page: null, events: [] }));
  try {
    writeFileSync(join(dir, "event-pages", "01:a;b.json"), "{ not json");
    generated.push(dir);
  } catch (e) {
    generated.push({ skipped: "generated-page-name-with-a-colon", why: `this filesystem refuses the name: ${e.code ?? e.message}` });
  }
}
{
  // Two bad page files whose names differ only after a line break, and one that holds %FF as
  // text, so each side must show % and a line break as %XX to name the file whole (round 9 review
  // I2).
  const dir = join(generatedRoot, "generated-page-names-with-a-line-break");
  mkdirSync(join(dir, "event-pages"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ scenario: "generated-page-names-with-a-line-break", description: "made at run time", now: "2026-11-10T00:00:00.000Z", synthetic: true, census_request: { from_block: 0, to_block: 99 }, pinned_genesis: DEVNET }));
  try {
    writeFileSync(join(dir, "event-pages", "01\na.json"), "{ not json");
    writeFileSync(join(dir, "event-pages", "01\nb.json"), "{ not json either");
    writeFileSync(join(dir, "event-pages", "02%FF.json"), "{ not json");
    generated.push(dir);
  } catch (e) {
    generated.push({ skipped: "generated-page-names-with-a-line-break", why: `this filesystem refuses the name: ${e.code ?? e.message}` });
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
  compare(d, ts, py, false, namesIn(dir));
}

// Command line inputs (RULES.md 3.1 clause 16): both sides get the same arguments and must refuse
// them with the same kind. A request problem comes first, so an inverted range is named before a
// missing folder.
{
  const complete = join("fixtures", "census-complete");
  const missing = join("fixtures", "no-such-scenario");
  const req = (from, to, genesis = DEVNET) => ["--genesis", genesis, "--from", from, "--to", to];
  // [name, folder, every argument after the folder flag, both must refuse]
  const cases = [
    ["request-number-with-a-space", complete, req(" 0", "199"), true],
    ["request-number-with-a-plus", complete, req("+5", "199"), true],
    ["request-number-with-an-underscore", complete, req("1_0", "199"), true],
    ["request-number-of-5000-digits", complete, req("0", "9".repeat(5000)), true],
    ["request-inverted", complete, req("9", "3"), true],
    ["request-inverted-and-no-folder", missing, req("9", "3"), true],
    ["genesis-empty", complete, req("0", "199", ""), true],
    ["scenario-folder-missing", missing, req("0", "199"), true],
    // Every flag is --name and then its value as the next argument, on both sides.
    ["flag-value-after-equals", complete, [`--genesis=${DEVNET}`, "--from", "0", "--to", "199"], true],
    ["flag-abbreviated", complete, ["--gen", DEVNET, "--from", "0", "--to", "199"], true],
    ["flag-unknown", complete, [...req("0", "199"), "--form", "100"], true],
    ["flag-value-starts-with-a-dash", complete, req("-a", "199"), true],
    ["flag-value-negative", complete, req("-5", "199"), true],
    ["flag-without-a-value-at-the-end", complete, ["--genesis", DEVNET, "--from", "0", "--to"], true],
    ["flag-whose-value-is-a-flag", complete, ["--genesis", DEVNET, "--from", "--to", "199"], true],
    ["flag-given-twice", complete, [...req("0", "199"), "--from", "5"], true],
    ["argument-that-is-no-flag-value", complete, [...req("0", "199"), "extra"], true],
    ["flag-unknown-and-no-folder", missing, [...req("0", "199"), "--form", "100"], true],
    // An empty value, as an unset shell variable gives, is a flag with no value (round 9 review L3).
    ["flag-value-empty", complete, ["--genesis", DEVNET, "--from", "", "--to", "199"], true],
    ["folder-flag-value-empty", "", req("0", "199"), true],
    // The same flags in another order count the same.
    ["flags-in-another-order", complete, ["--to", "199", "--genesis", DEVNET, "--from", "0"], false],
  ];
  for (const [name, dir, args, mustRefuse] of cases) {
    const ts = run("node", ["dist/cli.js", "census", "--fixtures", dir, ...args]);
    const py = run("python3", ["-I", "tools/recount.py", "--dir", dir, ...args]);
    compare(`command-line:${name}`, ts, py, mustRefuse, namesIn(dir));
  }
  // The folder flag left out (round 9 review I1): a request problem on both sides. The command's
  // own --now has no counterpart in the recount, so no case passes it.
  {
    const ts = run("node", ["dist/cli.js", "census", ...req("0", "199")]);
    const py = run("python3", ["-I", "tools/recount.py", ...req("0", "199")]);
    compare("command-line:folder-flag-left-out", ts, py, true, namesIn(complete));
  }
}

/** Compares one run of each side, recording the outcome. mustRefuse: both must refuse. */
function compare(d, ts, py, mustRefuse, names) {
  if (ts.exit !== 0 || py.exit !== 0) {
    const tr = refusal(ts.stderr, names);
    const pr = refusal(py.stderr, names);
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
      ts_err: ts.stderr.slice(0, 400),
      py_err: py.stderr.slice(0, 400),
    });
    return;
  }
  if (mustRefuse) {
    bad++;
    results.push({ scenario: d, outcome: "should-have-refused", ts_exit: ts.exit, py_exit: py.exit });
    return;
  }
  // Both exited 0, so both must have printed a census: one with every compared key. Two runs that
  // printed nothing would otherwise compare undefined with undefined and agree.
  const report = (j) => j !== null && typeof j === "object" && !Array.isArray(j) && KEYS.every((k) => k in j);
  if (!report(ts.json) || !report(py.json)) {
    bad++;
    results.push({ scenario: d, outcome: "no-report", ts_report: report(ts.json), py_report: report(py.json) });
    return;
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
// The canary must nudge at least one counted scenario and at least one refusal, or it proves
// nothing about either comparison (Fable review L9).
if (perturb) {
  const counted = results.filter((r) => r.outcome === "agree" || r.outcome === "disagree").length;
  const refused = results.filter((r) => r.outcome === "both-refused" || r.outcome === "disagree-on-reason").length;
  if (counted === 0 || refused === 0) {
    bad++;
    results.push({ scenario: null, outcome: "nothing-perturbed", counted, refused });
  }
}
console.log(JSON.stringify(results, null, 2));
// exitCode, not exit(): a caller may read this report through a pipe, where a write is
// asynchronous and exit() could cut it short (round 9 review L7).
process.exitCode = bad ? 1 : 0;
