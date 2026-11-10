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
//    the rules in RULES.md section 5, in data-v and in its whole visible text, nested tags
//    included. A key that does not resolve fails, a missing required key fails, and a td or span
//    without data-k outside a marked element fails, so a value cannot escape the comparison.
// 5. Every value sits where a person reads it: labeled rows bind th to td by data-for and read the
//    key's label, escrow cards and drift rows hold only their own cells.
// 6. The census is internally consistent: complete only with no gaps, and totals labeled the same.
// 7. Nothing on the page is hidden (IMD audit finding 12): no comment and no other <! markup but
//    the doctype, only the elements and attributes the renderer writes, and only its one
//    stylesheet (PAGE_CSS in src/page.ts, which test/page.test.ts reviews), so no value can sit
//    in a comment, a hidden element or a rule that hides it.
// 8. Every value sits in its own section: each table names its section (data-section), holds only
//    that section's cells and sits under that section's heading, the headings come in order, and
//    the drift item table names each column once, reads it, and every item row holds its cells
//    in that order.
// 9. No text states a value the check does not compare (IMD follow-up audit): every th is a row
//    label (data-for) or a drift column (data-col), every row but the drift header holds a td,
//    the title is fixed, and every piece of text outside a marked cell and a th is one of the
//    page's fixed words, in order, built here from the snapshot (the intro's seq included).
//    aria-label appears only as "unknown" on a blank unknown cell, and each cell's class is the
//    one its value calls for.
// Prints {"dir", "checks", "keys", "failures"}; exit 1 on any failure.
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { PAGE_CSS } from "../dist/page.js";
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
const keysIn = (fragment) => [...fragment.matchAll(/\bdata-k="([^"]*)"/g)].map((m) => unescape(m[1]));
const cells = new Map();
const marked = [];
// Each marked element's visible text runs to its closing tag, nested tags included, so a value
// hidden inside a nested span cannot escape the comparison.
for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bdata-k="[^"]*"[^>]*)>/g)) {
  const tag = m[1];
  const start = m.index + m[0].length;
  const end = html.indexOf(`</${tag}>`, start);
  const inner = end === -1 ? "" : html.slice(start, end);
  marked.push([start, end === -1 ? start : end]);
  const k = attr(m[2], "data-k");
  if (cells.has(k)) fail(`page key ${k} appears once`, "duplicate data-k");
  cells.set(k, {
    tag,
    v: attr(m[2], "data-v"),
    n: attr(m[2], "data-n"),
    cls: attr(m[2], "class") ?? "",
    aria: attr(m[2], "aria-label"),
    text: unescape(inner.replace(/<[^>]*>/g, "")),
  });
}
// Every td and span carries data-k, unless it sits inside a marked element, whose whole text is
// already compared. A value shown anywhere else would escape the check.
{
  let masked = "";
  let at = 0;
  for (const [s0, e0] of marked.sort((x, y) => x[0] - y[0])) {
    if (s0 < at) continue;
    masked += html.slice(at, s0);
    at = e0;
  }
  masked += html.slice(at);
  for (const m of masked.matchAll(/<(td|span)\b([^>]*)>/g)) {
    checks++;
    if (!/\bdata-k="/.test(m[2])) failures.push({ what: `every ${m[1]} carries data-k`, detail: m[0].slice(0, 120) });
  }
}

// Where each value sits (RULES.md section 5): a labeled row binds its th to its td and reads the
// key's label, an escrow card holds only that escrow's cells, and a drift item row holds only that
// item's cells. A correct value in the wrong row or card is still a wrong page.
{
  const partialCensus = snapshot.census !== null && (snapshot.census.status !== "complete" || snapshot.census.complete !== true);
  const labelFor = (key) => {
    if (key === "census" || key === "drift") return key;
    const rest = key.startsWith("escrow.") ? key.slice(key.lastIndexOf(".") + 1) : key.slice(key.indexOf(".") + 1);
    const label = rest.replace(/[._]/g, " ");
    return partialCensus && key.startsWith("census.totals.") ? `partial ${label}` : label;
  };
  const inRow = new Set();
  for (const row of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)) {
    const body = row[2];
    const dataRow = attr(row[1], "data-row");
    if (dataRow !== null) {
      for (const k of keysIn(body)) {
        checks++;
        inRow.add(k);
        if (!k.startsWith(`${dataRow}.`)) failures.push({ what: `row ${dataRow} holds only its own cells`, detail: k });
      }
      continue;
    }
    const ths = [...body.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)];
    const tds = [...body.matchAll(/<td\b([^>]*)>/g)];
    if (tds.length === 0) {
      // Only the drift item table's header row holds no td, and its cells are all columns.
      checks++;
      if (ths.length === 0 || ths.some((t) => attr(t[1], "data-col") === null)) {
        failures.push({ what: "a row holds a td, unless it is the drift header of data-col columns", detail: body.replace(/\s+/g, " ").slice(0, 160) });
      }
      continue;
    }
    if (ths.length !== 1 || tds.length !== 1) {
      fail("a labeled row is one th and one td", body.replace(/\s+/g, " ").slice(0, 160));
      continue;
    }
    const tdKey = attr(tds[0][1], "data-k");
    expectEq(`row label for ${tdKey} names its cell (data-for)`, attr(ths[0][1], "data-for"), tdKey);
    if (tdKey !== null) expectEq(`row label for ${tdKey} reads its field`, unescape(ths[0][2].replace(/<[^>]*>/g, "")), labelFor(tdKey));
  }
  for (const k of cells.keys()) {
    if (/^drift\.\d+\./.test(k)) {
      checks++;
      if (!inRow.has(k)) failures.push({ what: `drift cell ${k} sits in its item row`, detail: "not inside a data-row row" });
    }
  }
  const inCard = new Set();
  for (const card of html.matchAll(/<div\b([^>]*\bdata-escrow="[^"]*"[^>]*)>([\s\S]*?)<\/div>/g)) {
    const id = attr(card[1], "data-escrow");
    for (const k of keysIn(card[2])) {
      checks++;
      inCard.add(k);
      if (!k.startsWith(`escrow.${id}.`)) failures.push({ what: `escrow card ${id} holds only its own cells`, detail: k });
    }
  }
  for (const k of cells.keys()) {
    if (k.startsWith("escrow.")) {
      checks++;
      if (!inCard.has(k)) failures.push({ what: `escrow cell ${k} sits in its own card`, detail: "not inside a data-escrow card" });
    }
  }
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

/** The class the renderer gives a cell for its value (src/page.ts); anything else fails. */
function classFor(key, value) {
  if (key === "census.status") return value === "complete" && snapshot.census?.complete === true ? "note" : "partial";
  if (value === null || value === undefined) return "unk";
  if (isUnknownWord(key) && value === "unknown") return "unk";
  if (/^status\.(rpc|gateway|faucet)\.health$/.test(key)) return `h-${value}`;
  if (/^escrow\..+\.state$/.test(key)) return `s-${value}`;
  return "";
}

function checkCell(key, cell, value) {
  expectEq(`page ${key} class`, cell.cls, classFor(key, value));
  // aria-label replaces a cell's words for a screen reader, so it may only say unknown, on a
  // blank unknown cell.
  if (cell.aria !== null) expectEq(`page ${key} aria-label only on a blank unknown cell`, `${cell.aria}|${cell.v}|${cell.text}`, "unknown|unknown|");
  if (key === "census.status") {
    // A banner, not a cell: its value is in data-v and its words must say partial or complete.
    expectEq(`page ${key}`, cell.v, value);
    expectEq(`page ${key} banner says ${value}`, /^PARTIAL\b/.test(cell.text) ? "partial" : /^Complete\b/.test(cell.text) ? "complete" : "neither", value);
    return;
  }
  const unk = /\bunk\b/.test(cell.cls);
  if (isUnknownWord(key) && value === "unknown") {
    expectEq(`page ${key} unknown is blank with data-v unknown`, `${cell.v}|${cell.text}|${unk}`, "unknown||true");
    return;
  }
  if (value === null || value === undefined) {
    expectEq(`page ${key} is blank for null`, `${cell.v}|${cell.n}|${cell.text}|${unk}`, "null|null||true");
    return;
  }
  if (Array.isArray(value)) {
    expectEq(`page ${key} data-n`, cell.n, String(value.length));
    if (value.length === 0) {
      expectEq(`page ${key} empty list shows none`, `${cell.v}|${cell.text}`, "null|none");
      return;
    }
    const joined = joinList(value);
    if (joined === null) fail(`page ${key} list format`, "the checker does not know this list shape");
    else {
      expectEq(`page ${key} data-v`, cell.v, joined);
      expectEq(`page ${key} visible text`, cell.text, joined);
    }
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
  // Every value shows as itself: in data-v when the element has one, and always in its text.
  if (cell.v !== null) expectEq(`page ${key} data-v`, cell.v, want);
  expectEq(`page ${key} visible text`, cell.text, want);
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
  "status.best_height",
  "status.finality_lag",
  "status.rpc.health",
  "status.gateway.health",
  "status.faucet.health",
];
for (const e of snapshot.escrows) {
  for (const f of ["escrow_id", "state", "evidence", "notes", "observed_at", "trust", "scope", "finalized_height"]) required.push(`escrow.${e.escrow_id}.${f}`);
}
if (snapshot.census === null) required.push("census");
else {
  required.push(
    "census.status",
    "census.observed_at",
    "census.trust",
    "census.covered",
    "census.gaps",
    "census.reset_detected",
    "census.pending_unfinalized",
    "census.duplicates_dropped",
    "census.excluded_other_genesis",
    "census.malformed_dropped",
  );
  for (const k of Object.keys(snapshot.census.totals)) required.push(`census.totals.${k}`);
}
if (snapshot.drift === null) required.push("drift");
else required.push("drift.observed_at", "drift.trust", "drift.mismatches", "drift.unknown");
for (const k of required) {
  checks++;
  if (!cells.has(k)) failures.push({ what: `page shows ${k}`, detail: "required key missing" });
}

// 7. Nothing on the page is hidden.
{
  const bangs = [...html.matchAll(/<!/g)].map((m) => m.index);
  expectSame("the page holds no comment or other <! markup but the doctype", bangs, [0]);
  expectEq("the page starts with the doctype", html.slice(0, 15).toLowerCase(), "<!doctype html>");
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)];
  expectEq("the page has one stylesheet", styles.length, 1);
  if (styles.length === 1) expectEq("the stylesheet is the renderer's own, which hides nothing", styles[0][1], PAGE_CSS);
  const TAGS = new Set(["html", "head", "meta", "title", "style", "body", "h1", "h2", "p", "code", "span", "div", "table", "tr", "th", "td"]);
  const ATTRS = new Set(["lang", "charset", "name", "content", "class", "scope", "aria-label", "data-k", "data-v", "data-n", "data-for", "data-row", "data-section", "data-col", "data-escrow"]);
  const markup = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "<style></style>");
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>/g)) {
    checks++;
    const tag = m[2].toLowerCase();
    if (!TAGS.has(tag)) {
      failures.push({ what: "the page uses only the elements the renderer writes", detail: m[0].slice(0, 120) });
      continue;
    }
    if (m[1] === "/") continue;
    const rest = m[3].replace(/\s+([a-z][a-z-]*)="[^"]*"/g, (_all, name) => {
      if (!ATTRS.has(name)) failures.push({ what: "the page uses only the attributes the renderer writes", detail: `${name} on <${tag}>` });
      return "";
    });
    if (rest.trim() !== "") failures.push({ what: "the page uses only the attributes the renderer writes", detail: `<${tag}> ${rest.trim().slice(0, 80)}` });
  }
}

// 8. Every value sits in its own section.
{
  const HEADINGS = [
    ["status", "Network status"],
    ["escrow", "Escrows"],
    ["census", "Census"],
    ["drift", "Spec drift"],
  ];
  const headingOf = Object.fromEntries(HEADINGS);
  const h2s = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => ({ at: m.index, text: unescape(m[1].replace(/<[^>]*>/g, "")) }));
  expectSame("the section headings, in order", h2s.map((h) => h.text), HEADINGS.map(([, t]) => t));
  // The intro line and the census banner are the only values outside a section table.
  const OUTSIDE = new Set(["snapshot.hash", "snapshot.observed_at", "snapshot.trust", "census.status"]);
  const inSection = new Set();
  const tables = [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/g)];
  for (const t of tables) {
    const section = attr(t[1], "data-section");
    if (section === null || !(section in headingOf)) {
      fail("every table names its section (data-section)", t[0].slice(0, 120));
      continue;
    }
    const heading = h2s.filter((h) => h.at < t.index).at(-1)?.text ?? null;
    expectEq(`a ${section} table sits under the ${headingOf[section]} heading`, heading, headingOf[section]);
    for (const k of keysIn(t[2])) {
      checks++;
      inSection.add(k);
      if (k !== section && !k.startsWith(`${section}.`)) failures.push({ what: `a ${section} table holds only ${section} cells`, detail: k });
    }
  }
  for (const k of cells.keys()) {
    if (OUTSIDE.has(k)) continue;
    checks++;
    if (!inSection.has(k)) failures.push({ what: `cell ${k} sits in a section table`, detail: "outside every data-section table" });
  }
  // A data-col column header exists only in the drift item table's header row, which is checked
  // below; anywhere else its words would escape every check.
  const colHeaders = [...html.matchAll(/<th\b[^>]*\bdata-col="/g)].length;
  if (snapshot.drift === null) expectEq("no drift column headers without a drift report", colHeaders, 0);
  if (snapshot.drift !== null) {
    const itemTables = tables.filter((t) => /<th\b[^>]*\bdata-col="/.test(t[2]));
    expectEq("the page has one drift item table", itemTables.length, 1);
    const t = itemTables[0];
    if (t) {
      expectEq("the drift item table is in the drift section", attr(t[1], "data-section"), "drift");
      const header = /<tr\b[^>]*>([\s\S]*?)<\/tr>/.exec(t[2]);
      const cols = [...(header?.[1] ?? "").matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)].map((m) => ({ col: attr(m[1], "data-col"), text: unescape(m[2].replace(/<[^>]*>/g, "")) }));
      for (const c of cols) expectEq(`drift column ${c.col} reads its field`, c.text, String(c.col).replace(/_/g, " "));
      const names = cols.map((c) => c.col);
      expectEq("each drift column is named once", new Set(names).size, names.length);
      expectEq("every drift column header sits in the drift item table's header row", colHeaders, cols.length);
      snapshot.drift.items.forEach((item, i) => {
        expectSame(`drift item ${i} shows every field as a column`, Object.keys(item).sort(), [...names].sort());
        const row = new RegExp(`<tr\\b[^>]*\\bdata-row="drift\\.${i}"[^>]*>([\\s\\S]*?)<\\/tr>`).exec(t[2]);
        if (!row) {
          fail(`drift item ${i} has its row in the item table`, "no row");
          return;
        }
        expectSame(`drift row ${i} holds its cells in the header's column order`, keysIn(row[1]).map((k) => k.slice(`drift.${i}.`.length)), names);
      });
    }
  }
}

// 9. No text states a value the check does not compare.
{
  for (const th of html.matchAll(/<th\b([^>]*)>/g)) {
    checks++;
    if (attr(th[1], "data-for") === null && attr(th[1], "data-col") === null) {
      failures.push({ what: "every th is a row label (data-for) or a drift column (data-col)", detail: th[0].slice(0, 120) });
    }
  }
  for (const a of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\baria-label="[^"]*"[^>]*)>/g)) {
    checks++;
    if (a[1] !== "td" || attr(a[2], "data-k") === null) failures.push({ what: "aria-label only on a marked cell", detail: a[0].slice(0, 120) });
  }
  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  expectEq("the page title", title ? unescape(title[1]) : null, "FLOP Observatory");
  // The text outside every marked element and every th, in order.
  let body = html.replace(/^[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*$/, "");
  for (const m of [...body.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)]) body = body.replace(m[0], "<th></th>");
  let free = "";
  let at = 0;
  for (const m of body.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bdata-k="[^"]*"[^>]*>/g)) {
    if (m.index < at) continue;
    const end = body.indexOf(`</${m[1]}>`, m.index + m[0].length);
    free += body.slice(at, m.index) + "<marked>";
    at = end === -1 ? body.length : end + `</${m[1]}>`.length;
  }
  free += body.slice(at);
  const words = free
    .split(/<[^>]*>/)
    .map((t) => unescape(t).replace(/\s+/g, " ").trim())
    .filter((t) => t !== "");
  const expected = [
    "FLOP Observatory",
    "Read only. Snapshot",
    `, seq ${snapshot.seq}, observed_at`,
    ", trust",
    ". Blank grey cells mean unknown; none means known empty.",
    "Escrow state is settlement only. It says nothing about output quality.",
    "Network status",
    "Escrows",
    "Settlement only; says nothing about output quality. Only finalized events on the pinned genesis count. A gateway report is not chain proof.",
    ...(snapshot.escrows.length === 0 ? ["No escrows in this snapshot."] : []),
    "Census",
    "Spec drift",
  ];
  expectSame("the page's text outside the marked cells is its fixed words, in order", words, expected);
}

// 6. Census internal consistency.
if (snapshot.census) {
  const c = snapshot.census;
  expectEq("census complete only when no gaps", c.complete, c.gaps.length === 0);
  expectEq("census status matches complete", c.status, c.complete ? "complete" : "partial");
  expectEq("census totals_label matches status", c.totals_label, c.status);
}

console.log(JSON.stringify({ dir: basename(dir), checks, keys: cells.size, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
