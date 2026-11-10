#!/usr/bin/env node
// Output agreement on a real rendered snapshot (RULES.md section 5), not a hand-built one.
//
// Usage: node scripts/consistency.mjs <outputs dir>
// The dir holds what `cli.js snapshot` and scripts/mcp-transcript.mjs write: snapshot.json, the
// log, pin.json, the four feeds, index.html and mcp-transcript.jsonl.
//
// Checks, with snapshot.json as the reference:
// 1. The snapshot's hash verifies, it equals the last line of the log, and pin.json is its pin.
// 2. Each feed's payload equals the matching part of the snapshot exactly, every field included,
//    and each wrapper carries the snapshot hash, observed_at and trust of that part.
// 3. MCP tool text equals the feed files byte for byte; get_escrow_state equals each escrow;
//    get_snapshot_meta matches the snapshot. Every tool and every escrow was called.
// 4. Every data-k cell on the page resolves to a path in the snapshot and renders that value by
//    the rules in RULES.md section 5. A key that does not resolve fails, and so does a missing
//    required key, so a field cannot drop out of the comparison silently.
// 5. The census is internally consistent: complete only with no gaps, and totals labeled the same.
// Prints {"dir", "checks", "keys", "failures"}; exit 1 on any failure.
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { canonicalJson, hashSnapshot } from "../dist/store.js";

const dir = resolve(process.argv[2] ?? "out");
const read = (f) => readFileSync(join(dir, f), "utf8");
const snapshot = JSON.parse(read("snapshot.json"));

let checks = 0;
const failures = [];
const expectEq = (what, a, b) => {
  checks++;
  if (a !== b) failures.push({ what, got: a, want: b });
};
const expectSame = (what, a, b) => expectEq(what, canonicalJson(a ?? null), canonicalJson(b ?? null));
const fail = (what, detail) => {
  checks++;
  failures.push({ what, detail });
};

// 1. Snapshot integrity.
{
  const { hash, ...rest } = snapshot;
  expectEq("snapshot.json hash verifies", hashSnapshot(rest), hash);
  const lines = read("snapshots.jsonl").split("\n").filter(Boolean);
  expectSame("snapshot.json equals the last line of the snapshot log", JSON.parse(lines.at(-1) ?? "null"), snapshot);
  expectSame("pin.json equals snapshot.pin", JSON.parse(read("pin.json")), snapshot.pin);
}

// 2. Feeds against the snapshot.
const feedText = {
  get_status: read("status.json"),
  list_escrows: read("escrows.json"),
  get_census: read("census.json"),
  get_drift: read("drift.json"),
};
const feed = Object.fromEntries(Object.entries(feedText).map(([k, t]) => [k, JSON.parse(t)]));
const wrappers = [
  ["status.json", feed.get_status, "status", snapshot.status, snapshot.status.observed_at, snapshot.status.trust],
  ["escrows.json", feed.list_escrows, "escrows", snapshot.escrows, snapshot.observed_at, snapshot.trust],
  ["census.json", feed.get_census, "census", snapshot.census, snapshot.census?.observed_at ?? snapshot.observed_at, snapshot.census?.trust ?? snapshot.trust],
  ["drift.json", feed.get_drift, "drift", snapshot.drift, snapshot.drift?.observed_at ?? snapshot.observed_at, snapshot.drift?.trust ?? snapshot.trust],
];
for (const [name, f, key, part, observedAt, trust] of wrappers) {
  expectSame(`${name} ${key} equals snapshot.${key}, every field`, f[key], part);
  expectEq(`${name} snapshot_hash`, f.snapshot_hash, snapshot.hash);
  expectEq(`${name} observed_at`, f.observed_at, observedAt);
  expectEq(`${name} trust`, f.trust, trust);
}

// 3. MCP against the feeds and the snapshot.
const transcript = read("mcp-transcript.jsonl")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const mcpText = new Map();
for (const { request, response } of transcript) {
  if (request?.method !== "tools/call" || !response?.result) continue;
  const name = request.params.name;
  const key = name === "get_escrow_state" ? `escrow:${request.params.arguments.escrow_id}` : name;
  mcpText.set(key, response.result.content?.[0]?.text ?? null);
}
for (const [tool, text] of Object.entries(feedText)) {
  if (!mcpText.has(tool)) fail(`mcp ${tool} was called`, "no result in the transcript");
  else expectEq(`mcp ${tool} equals the feed file byte for byte`, mcpText.get(tool), text);
}
for (const e of snapshot.escrows) {
  const text = mcpText.get(`escrow:${e.escrow_id}`);
  if (text === undefined) fail(`mcp get_escrow_state ${e.escrow_id} was called`, "no result in the transcript");
  else expectSame(`mcp get_escrow_state ${e.escrow_id} equals the snapshot escrow`, JSON.parse(text ?? "null"), e);
}
{
  const meta = JSON.parse(mcpText.get("get_snapshot_meta") ?? "null");
  if (!meta) fail("mcp get_snapshot_meta was called", "no result in the transcript");
  else {
    expectEq("mcp get_snapshot_meta snapshot_hash", meta.snapshot_hash, snapshot.hash);
    for (const k of ["seq", "prev_hash", "observed_at", "trust", "pin"]) expectSame(`mcp get_snapshot_meta ${k}`, meta[k], snapshot[k]);
  }
}

// 4. The page. Each marked element: data-k, data-v, data-n, class and its visible text.
const html = read("index.html");
const unescape = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const attr = (attrs, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? unescape(m[1]) : null;
};
const cells = new Map();
for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bdata-k="[^"]*"[^>]*)>([^<]*)(<code>([^<]*)<\/code>)?/g)) {
  const k = attr(m[2], "data-k");
  if (cells.has(k)) fail(`page key ${k} appears once`, "duplicate data-k");
  cells.set(k, {
    v: attr(m[2], "data-v"),
    n: attr(m[2], "data-n"),
    cls: attr(m[2], "class") ?? "",
    text: unescape(m[3] || m[5] || ""),
  });
}

const MISSING = Symbol("missing");
function resolvePath(key) {
  const parts = key.split(".");
  const head = parts[0];
  if (head === "snapshot" && parts.length === 2) return parts[1] in snapshot ? snapshot[parts[1]] : MISSING;
  if (head === "escrow") {
    const field = key.slice(key.lastIndexOf(".") + 1);
    const id = key.slice("escrow.".length, key.lastIndexOf("."));
    const e = snapshot.escrows.find((x) => x.escrow_id === id);
    return e && field in e ? e[field] : MISSING;
  }
  let cur;
  if (head === "status") cur = snapshot.status;
  else if (head === "census") cur = snapshot.census;
  else if (head === "drift") {
    cur = snapshot.drift;
    if (cur && parts.length > 1 && /^\d+$/.test(parts[1])) {
      cur = cur.items?.[Number(parts[1])];
      parts.splice(1, 1);
      if (cur === undefined) return MISSING;
    }
  } else return MISSING;
  for (const p of parts.slice(1)) {
    if (cur === null || typeof cur !== "object" || !(p in cur)) return MISSING;
    cur = cur[p];
  }
  return cur;
}

const isRange = (x) => x && typeof x === "object" && "from_block" in x && "to_block" in x;
const isEvidence = (x) => x && typeof x === "object" && "block_hash" in x && "event" in x;
function joinList(list) {
  if (list.every(isEvidence)) return list.map((v) => `${v.event} @ ${v.block_number ?? "?"} ${v.block_hash} #${v.event_index}`).join("; ");
  if (list.every(isRange)) return list.map((r) => `${r.from_block}-${r.to_block}`).join(", ");
  if (list.every((x) => typeof x === "string")) return list.join("; ");
  return null;
}
const isUnknownWord = (key) => /^status\.(rpc|gateway|faucet)\.health$/.test(key) || /^drift\.\d+\.status$/.test(key);

function checkCell(key, cell, value) {
  const rendered = cell.v !== null ? cell.v : cell.text !== "" ? cell.text : null;
  if (key === "census.status") {
    // A banner, not a cell: its value is in data-v and its words must say partial or complete.
    expectEq(`page ${key}`, cell.v, value);
    expectEq(`page ${key} banner says ${value}`, /^PARTIAL\b/.test(cell.text) ? "partial" : /^Complete\b/.test(cell.text) ? "complete" : "neither", value);
    return;
  }
  if (isUnknownWord(key) && value === "unknown") {
    expectEq(`page ${key} unknown is blank with data-v unknown`, `${cell.v}|${cell.text}|${/\bunk\b/.test(cell.cls)}`, "unknown||true");
    return;
  }
  if (value === null || value === undefined) {
    expectEq(`page ${key} is blank for null`, `${rendered}|${cell.n}|${/\bunk\b/.test(cell.cls)}`, "null|null|true");
    return;
  }
  if (Array.isArray(value)) {
    expectEq(`page ${key} data-n`, cell.n, String(value.length));
    if (value.length === 0) {
      expectEq(`page ${key} empty list shows none`, rendered, "none");
      return;
    }
    const joined = joinList(value);
    if (joined === null) fail(`page ${key} list format`, "the checker does not know this list shape");
    else expectEq(`page ${key}`, rendered, joined);
    return;
  }
  if (cell.n !== null) fail(`page ${key} data-n only on lists`, `data-n ${cell.n} on a non-list value`);
  let want;
  if (typeof value === "boolean" || typeof value === "number") want = String(value);
  else if (typeof value === "string") want = value;
  else if (isRange(value)) want = `${value.from_block} to ${value.to_block}`;
  else want = JSON.stringify(value);
  if (want === "") {
    expectEq(`page ${key} empty string`, `${cell.v}|${cell.text}`, "|(empty)");
    return;
  }
  expectEq(`page ${key}`, rendered, want);
  if (cell.v !== null && cell.text !== "") expectEq(`page ${key} shows its data-v`, cell.text, cell.v);
}

for (const [key, cell] of cells) {
  const value = resolvePath(key);
  if (value === MISSING) {
    fail(`page key ${key} resolves in the snapshot`, "the page shows a value the checker cannot find");
    continue;
  }
  checkCell(key, cell, value);
}

// Required keys: the fields that must agree everywhere cannot be left off the page.
const required = [
  "snapshot.hash",
  "status.observed_at",
  "status.trust",
  "status.reset_detected",
  "status.conflicts",
  "status.genesis.pinned",
  "status.genesis.faucet",
  "status.genesis.rpc",
  "status.finalized_height",
  "status.finalized_hash",
  "status.rpc.stale",
  "status.rpc.health",
  "status.gateway.health",
  "status.faucet.health",
];
for (const e of snapshot.escrows) {
  for (const f of ["escrow_id", "state", "evidence", "notes", "observed_at", "trust", "scope"]) required.push(`escrow.${e.escrow_id}.${f}`);
}
if (snapshot.census === null) required.push("census");
else {
  required.push("census.status", "census.observed_at", "census.trust", "census.covered", "census.gaps", "census.reset_detected");
  for (const k of Object.keys(snapshot.census.totals)) required.push(`census.totals.${k}`);
}
if (snapshot.drift === null) required.push("drift");
else required.push("drift.observed_at", "drift.trust", "drift.mismatches", "drift.unknown");
for (const k of required) {
  checks++;
  if (!cells.has(k)) failures.push({ what: `page shows ${k}`, detail: "required key missing" });
}

// 5. Census internal consistency.
if (snapshot.census) {
  const c = snapshot.census;
  expectEq("census complete only when no gaps", c.complete, c.gaps.length === 0);
  expectEq("census status matches complete", c.status, c.complete ? "complete" : "partial");
  expectEq("census totals_label matches status", c.totals_label, c.status);
}

console.log(JSON.stringify({ dir: basename(dir), checks, keys: cells.size, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
