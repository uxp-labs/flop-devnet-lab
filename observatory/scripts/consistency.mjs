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
//    label (data-for) or a drift column (data-col) and is read by the checks above, every row but
//    the drift header holds a td, the head is the renderer's fixed head, and every piece of text
//    outside a marked cell and a th is one of the page's fixed words, in order, built here from the
//    snapshot (the intro's seq included). Tags are lower case, every < opens one, aria-label
//    appears only as "unknown" on a blank unknown cell, each cell's class is the one its value
//    calls for, and the census banner is one of its two fixed sentences.
// 10. Every file is exactly what the code writes for this snapshot: index.html is what src/page.ts
//    renders, and each feed and snapshot.json what src/feed.ts writes. With --semantic-only this
//    section is skipped; the canary uses that to prove sections 1 to 9 catch each tamper alone.
// Every file is read as strict UTF-8, and every JSON file and transcript line strictly: a file that
// is not JSON ends the check at once with that failure, a key that appears twice in one object
// fails (RULES.md 3.1 clause 12), and each JSON output must be in its own written format.
// Prints {"dir", "checks", "keys", "failures"}; exit 1 on any failure.
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { censusFeed, driftFeed, escrowsFeed, feedText as writtenFeed, snapshotMeta, statusFeed } from "../dist/feed.js";
import { TOOLS, handleMcp } from "../dist/mcp.js";
import { PAGE_CSS, renderPage } from "../dist/page.js";
import { canonicalJson, hashSnapshot, verifyChain } from "../dist/store.js";
import { duplicateKey } from "../dist/strict.js";
import { exchangesFor, unseenEscrowId } from "./mcp-exchanges.mjs";

const args = process.argv.slice(2);
const semanticOnly = args.includes("--semantic-only");
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? "out");
let checks = 0;
const failures = [];
// The number of marked page cells, once the page has been read.
let keysShown = null;
/**
 * Prints the report and exits: 1 on any failure. The report is written to fd 1 synchronously and
 * whole: console.log to a pipe is asynchronous, and process.exit would cut a long report short,
 * which a caller reading the pipe could not parse (round 8).
 */
function report() {
  const text = Buffer.from(JSON.stringify({ dir: basename(dir), semantic_only: semanticOnly, checks, keys: keysShown, failures }, null, 2) + "\n");
  for (let off = 0; off < text.length; ) {
    try {
      off += writeSync(1, text, off);
    } catch (e) {
      if (e?.code !== "EAGAIN") throw e;
    }
  }
  process.exit(failures.length ? 1 : 0);
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** A file's text, read as strict UTF-8; a file that cannot be read so ends the check. */
const read = (f) => {
  try {
    return utf8.decode(readFileSync(join(dir, f)));
  } catch (e) {
    checks++;
    failures.push({ what: `${f} can be read as UTF-8`, detail: String(e?.message ?? e) });
    report();
  }
};
const expectEq = (what, a, b) => {
  checks++;
  if (a !== b) failures.push({ what, got: a, want: b });
};
const expectSame = (what, a, b) => expectEq(what, canonicalJson(a ?? null), canonicalJson(b ?? null));
const fail = (what, detail) => {
  checks++;
  failures.push({ what, detail });
};
/**
 * JSON.parse, failing the check when one object holds a key twice (the parser keeps one copy).
 * The text is parsed first, so the repeated key reader only ever reads JSON, and text that is not
 * JSON ends the check with that failure (round 8 review L3).
 */
const strictJson = (what, text) => {
  checks++;
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    failures.push({ what: `${what} is JSON`, detail: String(e?.message ?? e) });
    report();
  }
  const twice = duplicateKey(text);
  if (twice !== null) failures.push({ what: `${what} holds no repeated key`, detail: twice });
  return value;
};
// The feed format, written here rather than imported, so the semantic checks do not rest on
// src/feed.ts: keys sorted, two-space indent, one trailing newline.
const sortDeep = (v) =>
  Array.isArray(v)
    ? v.map(sortDeep)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sortDeep(v[k])]))
      : v;
const formatted = (v) => JSON.stringify(sortDeep(v), null, 2) + "\n";
const sameKeys = (o, keys) => o !== null && typeof o === "object" && !Array.isArray(o) && canonicalJson(Object.keys(o).sort()) === canonicalJson([...keys].sort());

// 0. The folder holds exactly the files the snapshot command and the transcript script write, so
//    no other file can sit beside them and say something else (round 7 review L7).
const FILES = ["census.json", "drift.json", "escrows.json", "index.html", "mcp-transcript.jsonl", "pin.json", "snapshot.json", "snapshots.jsonl", "status.json"];
expectSame("the outputs folder holds exactly the nine files the commands write", readdirSync(dir).sort(), FILES);

// 1. Snapshot integrity.
const snapshotText = read("snapshot.json");
const snapshot = strictJson("snapshot.json", snapshotText);
{
  const { hash, ...rest } = snapshot;
  expectEq("snapshot.json hash verifies", hashSnapshot(rest), hash);
  expectEq("snapshot.json is in the feed format", snapshotText, formatted(snapshot));
  // The whole log, not only its last line: its hash chain verifies, every line in canonical form,
  // and the last line's seq is its position, so seq and prev_hash stand on something.
  const logPath = join(dir, "snapshots.jsonl");
  expectEq("the snapshot log's hash chain verifies, every line in its written form", verifyChain(logPath), null);
  const lines = read("snapshots.jsonl").split("\n").filter(Boolean);
  const last = lines.at(-1) ?? "null";
  expectSame("snapshot.json equals the last line of the snapshot log", strictJson("the snapshot log's last line", last), snapshot);
  expectEq("the snapshot log's last line is snapshot.json in canonical form, byte for byte", last, canonicalJson(snapshot));
  expectEq("snapshot.json's seq is the last line's position in the log", snapshot.seq, lines.length - 1);
  const pinText = read("pin.json");
  expectSame("pin.json equals snapshot.pin", strictJson("pin.json", pinText), snapshot.pin);
  expectEq("pin.json is in the feed format", pinText, formatted(snapshot.pin));
}

// 2. Feeds against the snapshot.
const feedText = {
  get_status: read("status.json"),
  list_escrows: read("escrows.json"),
  get_census: read("census.json"),
  get_drift: read("drift.json"),
};
const FEED_FILE = { get_status: "status.json", list_escrows: "escrows.json", get_census: "census.json", get_drift: "drift.json" };
const feed = Object.fromEntries(Object.entries(feedText).map(([k, t]) => [k, strictJson(FEED_FILE[k], t)]));
const wrappers = [
  ["status.json", feed.get_status, "status", snapshot.status, snapshot.status.observed_at, snapshot.status.trust],
  ["escrows.json", feed.list_escrows, "escrows", snapshot.escrows, snapshot.observed_at, snapshot.trust],
  ["census.json", feed.get_census, "census", snapshot.census, snapshot.census?.observed_at ?? snapshot.observed_at, snapshot.census?.trust ?? snapshot.trust],
  ["drift.json", feed.get_drift, "drift", snapshot.drift, snapshot.drift?.observed_at ?? snapshot.observed_at, snapshot.drift?.trust ?? snapshot.trust],
];
for (const [name, f, key, part, observedAt, trust] of wrappers) {
  expectEq(`${name} holds exactly schema, snapshot_hash, observed_at, trust and ${key}`, sameKeys(f, ["schema", "snapshot_hash", "observed_at", "trust", key]), true);
  expectEq(`${name} schema`, f.schema, `flop-observatory/feed-${key}@0`);
  expectSame(`${name} ${key} equals snapshot.${key}, every field`, f[key], part);
  expectEq(`${name} snapshot_hash`, f.snapshot_hash, snapshot.hash);
  expectEq(`${name} observed_at`, f.observed_at, observedAt);
  expectEq(`${name} trust`, f.trust, trust);
  expectEq(`${name} is in the feed format`, feedText[Object.keys(FEED_FILE).find((t) => FEED_FILE[t] === name)], formatted(f));
}

// 3. MCP against the feeds and the snapshot. The transcript is exactly the exchanges
//    scripts/mcp-transcript.mjs makes (scripts/mcp-exchanges.mjs), in order, so nothing a client is
//    shown can be added, dropped or edited. Each answer is read as the server wrote its line, and
//    is exactly what the rules say: the initialize answer and the tool list as the server declares
//    them, a tool answer as exactly one text item (no isError, no structuredContent and no second
//    item, any of which a client could read instead), and each refusal with its own code and words.
const INSTRUCTIONS = "Read-only observatory for FLOP devnet. Escrow state is settlement only and says nothing about output quality. null means unknown.";
const TOOL_NAMES = ["get_status", "get_escrow_state", "list_escrows", "get_census", "get_drift", "get_snapshot_meta"];
const expectedExchanges = exchangesFor(snapshot);
const unseen = unseenEscrowId(snapshot);
const REFUSALS = {
  sign_transaction: { code: -32602, message: "unknown tool: sign_transaction" },
  "get_escrow_state:not-an-id": { code: -32602, message: "escrow_id must be 0x plus 64 hex" },
};
const transcriptText = read("mcp-transcript.jsonl");
// Blank lines and line ends other than \n are left to the written format check below.
const transcript = transcriptText
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l, i) => strictJson(`mcp transcript line ${i}`, l));
expectSame(
  "the transcript holds exactly the exchanges the transcript script makes, in order",
  transcript.map((x) => [x.request, x.expect_error]),
  expectedExchanges.map((x) => [x.req, x.expectError]),
);
// The transcript's written format (round 8 review L4): one line per exchange, ended by a newline,
// nothing else in the file, each line its four keys in the script's order with the request as the
// script sends it and the response spelled as the server's own line, which is one compact line.
for (const [i, x] of transcript.entries()) {
  if (typeof x.response_line !== "string") continue;
  let compact = false;
  try {
    compact = JSON.stringify(JSON.parse(x.response_line)) === x.response_line;
  } catch {
    compact = false;
  }
  expectEq(`mcp transcript line ${i} response_line is one compact JSON line, as the server writes`, compact, true);
}
{
  const spelled = (x, i) => {
    let response = x.response;
    try {
      response = typeof x.response_line === "string" ? JSON.parse(x.response_line) : x.response;
    } catch {
      response = x.response;
    }
    const e = expectedExchanges.at(i);
    return JSON.stringify({ request: e ? e.req : x.request, expect_error: e ? e.expectError : x.expect_error, response, response_line: x.response_line }) + "\n";
  };
  expectEq("mcp-transcript.jsonl is in its written format: one line per exchange, as the transcript script writes it", transcriptText, transcript.map(spelled).join(""));
}
const mcpText = new Map();
for (const [i, x] of transcript.entries()) {
  expectEq(`mcp transcript line ${i} holds exactly request, expect_error, response and response_line`, sameKeys(x, ["request", "expect_error", "response", "response_line"]), true);
  const { request, response, expect_error: expectError } = x;
  if (typeof x.response_line !== "string") fail(`mcp transcript line ${i} records the server's own line`, "no response_line");
  else expectSame(`mcp transcript line ${i} response is the server's line`, strictJson(`mcp response line ${i}`, x.response_line), response);
  const base = response !== null && typeof response === "object" && response.jsonrpc === "2.0" && response.id === request?.id;
  const label = request?.params?.name ?? request?.method;
  if (expectError === true) {
    const e = response?.error;
    expectEq(`mcp request ${request?.id} (${label}) is refused with an error and nothing else`, base && sameKeys(response, ["jsonrpc", "id", "error"]) && sameKeys(e, ["code", "message"]), true);
    const which = label === "get_escrow_state" ? `get_escrow_state:${request?.params?.arguments?.escrow_id}` : label;
    expectSame(`mcp request ${request?.id} (${label}) is refused with its own code and words`, e, REFUSALS[which] ?? "an unexpected refusal");
    continue;
  }
  expectEq(`mcp request ${request?.id} (${request?.method}) has a result and no error`, base && sameKeys(response, ["jsonrpc", "id", "result"]), true);
  if (request?.method === "initialize") {
    const want = { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "flop-observatory", version: "0.0.1" }, instructions: INSTRUCTIONS };
    expectSame("mcp initialize answer is exactly the server's: its name, version and read-only instructions", response?.result, want);
  }
  if (request?.method === "tools/list") {
    const tools = response?.result?.tools ?? [];
    expectSame("mcp tools/list names exactly the six read-only tools", tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    for (const t of tools) expectEq(`mcp tool ${t.name} is marked read only and not destructive`, t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false, true);
    expectSame("mcp tools/list is exactly the server's declared tools: names, descriptions, input schemas and annotations", response?.result, { tools: TOOLS });
  }
  if (request?.method !== "tools/call") continue;
  const name = request.params.name;
  const key = name === "get_escrow_state" ? `escrow:${request.params.arguments.escrow_id}` : name;
  const result = response?.result;
  const item = Array.isArray(result?.content) ? result.content[0] : undefined;
  const exact = sameKeys(result, ["content"]) && result.content.length === 1 && sameKeys(item, ["type", "text"]) && item.type === "text" && typeof item.text === "string";
  expectEq(`mcp ${key} answer is exactly one text item`, exact, true);
  if (mcpText.has(key)) fail(`mcp ${key} answered once`, "the transcript holds two answers");
  mcpText.set(key, exact ? item.text : null);
  if (exact) strictJson(`mcp ${key} text`, item.text);
}
for (const [tool, text] of Object.entries(feedText)) {
  if (!mcpText.has(tool)) fail(`mcp ${tool} was called`, "no result in the transcript");
  else expectEq(`mcp ${tool} equals the feed file byte for byte`, mcpText.get(tool), text);
}
for (const e of snapshot.escrows) {
  const text = mcpText.get(`escrow:${e.escrow_id}`);
  if (text === undefined) fail(`mcp get_escrow_state ${e.escrow_id} was called`, "no result in the transcript");
  else {
    expectSame(`mcp get_escrow_state ${e.escrow_id} equals the snapshot escrow`, JSON.parse(text ?? "null"), e);
    expectEq(`mcp get_escrow_state ${e.escrow_id} is that escrow in the feed format, byte for byte`, text, formatted(e));
  }
}
{
  // RULES.md section 5: an escrow id the snapshot does not hold is unverified, with no height.
  const want = {
    schema: "flop-observatory/escrow-state@0",
    escrow_id: unseen,
    state: "unverified",
    evidence: [],
    notes: ["escrow id not present in this snapshot; no finalized evidence seen"],
    finalized_height: null,
    observed_at: snapshot.observed_at,
    trust: snapshot.trust,
    scope: "settlement only; says nothing about output quality",
  };
  const text = mcpText.get(`escrow:${unseen}`);
  if (text === undefined) fail("mcp get_escrow_state for an unseen escrow id was called", "no result in the transcript");
  else expectEq("mcp get_escrow_state for an unseen escrow id is unverified with no height, in the feed format", text, formatted(want));
}
{
  const text = mcpText.get("get_snapshot_meta") ?? null;
  const meta = JSON.parse(text ?? "null");
  if (!meta) fail("mcp get_snapshot_meta was called", "no result in the transcript");
  else {
    expectEq("mcp get_snapshot_meta snapshot_hash", meta.snapshot_hash, snapshot.hash);
    for (const k of ["seq", "prev_hash", "observed_at", "trust", "pin"]) expectSame(`mcp get_snapshot_meta ${k}`, meta[k], snapshot[k]);
    const want = { schema: "flop-observatory/feed-snapshot-meta@0", snapshot_hash: snapshot.hash, seq: snapshot.seq, prev_hash: snapshot.prev_hash, observed_at: snapshot.observed_at, trust: snapshot.trust, pin: snapshot.pin };
    expectEq("mcp get_snapshot_meta is the snapshot's meta in the feed format, byte for byte", text, formatted(want));
  }
}

// 4. The page. Each marked element: data-k, data-v, data-n, class and its visible text.
const html = read("index.html");
// Row labels and drift column headers read by sections 5 and 8; section 9 checks every th was one.
let labelsRead = 0;
let columnsRead = 0;
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
  // A marked cell holds its value as text, and the renderer nests one thing only: a bare <code>
  // around an escrow id. Any other tag inside, a span with a class say, could paint the value as
  // something else while its words stay right (round 7 review L8).
  const nested = [...inner.matchAll(/<[^>]*>/g)].map((t) => t[0]).filter((t) => t !== "<code>" && t !== "</code>");
  checks++;
  if (nested.length > 0) failures.push({ what: `page ${k} holds no markup but a bare code element`, detail: nested.slice(0, 3).join(" ") });
  cells.set(k, {
    tag,
    v: attr(m[2], "data-v"),
    n: attr(m[2], "data-n"),
    cls: attr(m[2], "class") ?? "",
    aria: attr(m[2], "aria-label"),
    text: unescape(inner.replace(/<[^>]*>/g, "")),
  });
}
// Every key the renderer writes for this snapshot, in its order (src/page.ts), so a row dropped,
// added or moved and escrow cards in another order all fail, without the byte comparison.
function pageKeys(s) {
  const k = ["snapshot.hash", "snapshot.observed_at", "snapshot.trust"];
  for (const f of ["observed_at", "trust", "genesis.pinned", "genesis.faucet", "genesis.rpc", "reset_detected", "conflicts", "finalized_height", "finalized_hash", "best_height", "finality_lag", "runtime_version"]) k.push(`status.${f}`);
  for (const svc of ["rpc", "gateway", "faucet"]) for (const f of ["health", "http", "detail", "observed_at"]) k.push(`status.${svc}.${f}`);
  k.push("status.rpc.stale", "status.faucet.ready");
  for (const e of s.escrows) for (const f of ["escrow_id", "state", "observed_at", "trust", "finalized_height", "evidence", "notes", "scope"]) k.push(`escrow.${e.escrow_id}.${f}`);
  if (s.census === null) k.push("census");
  else {
    k.push("census.status", "census.observed_at", "census.trust", "census.requested", "census.covered", "census.gaps");
    for (const t of ["escrows_opened", "escrows_released", "escrows_refunded", "channels_opened", "channels_settled"]) k.push(`census.totals.${t}`);
    k.push("census.totals_label", "census.requested_blocks", "census.covered_blocks", "census.reset_detected", "census.notes", "census.pending_unfinalized", "census.duplicates_dropped", "census.excluded_other_genesis", "census.malformed_dropped");
  }
  if (s.drift === null) k.push("drift");
  else {
    for (const f of ["observed_at", "trust", "genesis", "finalized_height", "runtime_version", "spec_source", "runtime_observed_at", "matches", "mismatches", "unknown"]) k.push(`drift.${f}`);
    s.drift.items.forEach((_, i) => {
      for (const f of ["param", "spec", "runtime", "status", "note", "mapping", "unit", "expected", "runtime_path"]) k.push(`drift.${i}.${f}`);
    });
  }
  return k;
}
expectSame("the page shows exactly the renderer's keys, in its order", [...cells.keys()], pageKeys(snapshot));

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
      // An item row holds cells only. A th here would be read by no check below.
      checks++;
      if (/<th\b/i.test(body)) failures.push({ what: `row ${dataRow} holds no th`, detail: body.replace(/\s+/g, " ").slice(0, 160) });
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
    labelsRead++;
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
    // A banner, not a cell: its value is in data-v and its words are one of two fixed sentences,
    // read whole, so no words after the first can say the opposite.
    expectEq(`page ${key}`, cell.v, value);
    const complete = value === "complete" && snapshot.census?.complete === true;
    expectEq(
      `page ${key} banner reads its whole fixed ${complete ? "complete" : "partial"} sentence`,
      cell.text,
      complete ? "Complete: the whole requested range is covered." : "PARTIAL: these totals cover only part of the requested range and are not complete.",
    );
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
  // Every value shows as itself, in its text and in data-v, which the renderer writes on every cell
  // but the intro line's (round 8 review A7).
  expectEq(`page ${key} data-v`, cell.v, key.startsWith("snapshot.") ? null : want);
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
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  expectEq("the page has one stylesheet", styles.length, 1);
  if (styles.length === 1) expectEq("the stylesheet is the renderer's own, which hides nothing", styles[0][1], PAGE_CSS);
  // The head is fixed text: its charset, viewport, colour scheme, title and stylesheet are the
  // renderer's, so no meta or title can carry a value or change how the page is decoded.
  const HEAD =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="color-scheme" content="light dark"><title>FLOP Observatory</title><style>${PAGE_CSS}</style></head><body>\n`;
  expectEq("the page head is the renderer's fixed head", html.slice(0, HEAD.length), HEAD);
  expectEq("the page ends with the body and html closing tags", html.slice(-15), "</body></html>\n");
  const body = html.slice(HEAD.length, html.length - 15);
  // Tag and attribute names are matched exactly as the renderer writes them, in lower case: a
  // browser reads <TR> as <tr>, so a check that only knew lower case would not see it.
  const TAGS = new Set(["h1", "h2", "p", "code", "span", "div", "table", "tr", "th", "td"]);
  const ATTRS = new Set(["class", "scope", "aria-label", "data-k", "data-v", "data-n", "data-for", "data-row", "data-section", "data-col", "data-escrow"]);
  // A browser shows "< x >" or "<1" as text, so a < that opens no tag would hide its words from
  // every check that strips tags.
  expectSame("every < in the body opens a lower case tag", [...body.matchAll(/<(?!\/?[a-z])/g)].map((m) => body.slice(m.index, m.index + 60)), []);
  const opened = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>/g)) {
    checks++;
    const tag = m[2];
    if (!TAGS.has(tag)) {
      failures.push({ what: "the body uses only the elements the renderer writes", detail: m[0].slice(0, 120) });
      continue;
    }
    if (m[1] === "/") {
      if (m[3] !== "") failures.push({ what: "a closing tag holds nothing but its name", detail: m[0].slice(0, 120) });
      continue;
    }
    opened.push({ tag, attrs: m[3], text: m[0] });
    const rest = m[3].replace(/\s+([a-z][a-z-]*)="[^"]*"/g, (_all, name) => {
      if (!ATTRS.has(name)) failures.push({ what: "the body uses only the attributes the renderer writes", detail: `${name} on <${tag}>` });
      return "";
    });
    if (rest.trim() !== "") failures.push({ what: "the body uses only the attributes the renderer writes", detail: `<${tag}> ${rest.trim().slice(0, 80)}` });
  }
  // Every element's class is the one the renderer writes for it (round 8 review L5), so nothing
  // paints a cell from outside it: a marked element's class is its value's (checked with its
  // cell), the fixed paragraphs are note and banner in their order, every div is a card, and no
  // other element has a class. The page holds exactly the renderer's paragraphs, cards and
  // tables, so an empty one cannot add a mark of its own.
  const unmarked = opened.filter((o) => attr(o.attrs, "data-k") === null);
  for (const o of unmarked) {
    if (o.tag === "p" || o.tag === "div") continue;
    checks++;
    if (attr(o.attrs, "class") !== null) failures.push({ what: `a ${o.tag} that is no marked cell carries no class`, detail: o.text.slice(0, 120) });
  }
  expectSame(
    "the paragraphs outside the marked cells are the renderer's, with their classes, in order",
    unmarked.filter((o) => o.tag === "p").map((o) => attr(o.attrs, "class")),
    ["note", "banner", "note", ...(snapshot.escrows.length === 0 ? ["note"] : [])],
  );
  const cards = 1 + snapshot.escrows.length + 1 + (snapshot.drift === null ? 1 : 2);
  expectSame("every div is a card, and the page holds the renderer's cards", unmarked.filter((o) => o.tag === "div").map((o) => attr(o.attrs, "class")), Array(cards).fill("card"));
  expectEq("the page holds the renderer's tables, one in each card", opened.filter((o) => o.tag === "table").length, cards);
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
      columnsRead = cols.length;
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
  // Section 9 sets th text aside below, so each th must have had its words read: as the label of
  // a labeled row (section 5) or as a column of the drift item table's header (section 8). A th
  // outside a row, or a second th in a row, is read by neither.
  expectEq("every th on the page is a row label or drift column whose words were read", [...html.matchAll(/<th\b/gi)].length, labelsRead + columnsRead);
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

// 10. Every file is exactly what the code writes for this snapshot. Sections 1 to 9 judge the
//     outputs against the snapshot on their own; this closes whatever they do not model.
if (!semanticOnly) {
  expectEq("index.html is exactly the page src/page.ts renders for this snapshot", html, renderPage(snapshot));
  for (const [file, writer] of [
    ["status.json", statusFeed],
    ["escrows.json", escrowsFeed],
    ["census.json", censusFeed],
    ["drift.json", driftFeed],
  ]) {
    expectEq(`${file} is exactly what src/feed.ts writes for this snapshot`, read(file), writtenFeed(writer(snapshot)));
  }
  expectEq("snapshot.json is exactly what src/feed.ts writes for this snapshot", snapshotText, writtenFeed(snapshot));
  expectEq("mcp get_snapshot_meta is exactly what src/feed.ts writes for this snapshot", mcpText.get("get_snapshot_meta") ?? null, writtenFeed(snapshotMeta(snapshot)));
  for (const [i, x] of transcript.entries()) {
    const want = handleMcp(x.request, { snapshot });
    expectEq(`mcp transcript line ${i} is exactly the line src/mcp.ts answers`, x.response_line, want === null ? null : JSON.stringify(want));
  }
  // The whole file, as scripts/mcp-transcript.mjs writes it from the server's answers.
  const written = expectedExchanges
    .map(({ req, expectError }) => {
      const line = JSON.stringify(handleMcp(req, { snapshot }));
      return JSON.stringify({ request: req, expect_error: expectError, response: JSON.parse(line), response_line: line }) + "\n";
    })
    .join("");
  expectEq("mcp-transcript.jsonl is exactly what scripts/mcp-transcript.mjs writes from src/mcp.ts's answers", transcriptText, written);
}

keysShown = cells.size;
report();
