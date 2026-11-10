#!/usr/bin/env node
// Output agreement on the real rendered snapshot, not a hand-built one.
// Compares <outputs>/index.html (data-k / data-v cells), the JSON feeds, and the MCP transcript
// written by mcp-transcript.mjs. They must agree on state, observed_at and trust for the status
// and for every escrow, MCP tool text must equal the feed files byte for byte, and every null in
// JSON must be a blank cell on the page.
// Prints {"checks": n, "failures": [...]}; exit 1 on any failure.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "out");
const read = (f) => readFileSync(join(dir, f), "utf8");
const snapshot = JSON.parse(read("snapshot.json"));
const feeds = {
  get_status: read("status.json"),
  list_escrows: read("escrows.json"),
  get_census: read("census.json"),
  get_drift: read("drift.json"),
};
const html = read("index.html");
const transcript = read("mcp-transcript.jsonl")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const unescape = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const page = new Map();
for (const m of html.matchAll(/<td\b([^>]*)>/g)) {
  const k = /data-k="([^"]*)"/.exec(m[1]);
  if (!k) continue;
  const v = /data-v="([^"]*)"/.exec(m[1]);
  page.set(unescape(k[1]), v ? unescape(v[1]) : null);
}

const mcpText = new Map();
for (const { request, response } of transcript) {
  if (request.method !== "tools/call" || !response?.result) continue;
  const name = request.params.name;
  const text = response.result.content?.[0]?.text ?? null;
  const key = name === "get_escrow_state" ? `escrow:${request.params.arguments.escrow_id}` : name;
  mcpText.set(key, text);
}

let checks = 0;
const failures = [];
const expectEq = (what, a, b) => {
  checks++;
  if (a !== b) failures.push({ what, a, b });
};

// 1. MCP tool text equals the feed files, byte for byte.
for (const [tool, text] of Object.entries(feeds)) expectEq(`mcp ${tool} equals feed file`, mcpText.get(tool), text);

// 2. Snapshot hash everywhere.
expectEq("page snapshot.hash", page.get("snapshot.hash"), snapshot.hash);
for (const [tool, text] of Object.entries(feeds)) expectEq(`${tool} snapshot_hash`, JSON.parse(text).snapshot_hash, snapshot.hash);

// 3. Status: observed_at, trust and health, page against feed against MCP.
const statusFeed = JSON.parse(feeds.get_status);
const statusMcp = JSON.parse(mcpText.get("get_status") ?? "null");
for (const [k, v] of [
  ["status.observed_at", snapshot.status.observed_at],
  ["status.trust", snapshot.status.trust],
  ["status.rpc.health", snapshot.status.rpc.health],
  ["status.gateway.health", snapshot.status.gateway.health],
  ["status.faucet.health", snapshot.status.faucet.health],
]) {
  expectEq(`page ${k}`, page.get(k), v);
}
expectEq("feed status observed_at", statusFeed.observed_at, snapshot.status.observed_at);
expectEq("feed status trust", statusFeed.trust, snapshot.status.trust);
expectEq("mcp status observed_at", statusMcp?.observed_at, snapshot.status.observed_at);
expectEq("mcp status trust", statusMcp?.trust, snapshot.status.trust);

// 4. Nulls are blank on the page.
for (const k of ["finalized_height", "finalized_hash", "best_height", "finality_lag", "runtime_version"]) {
  if (snapshot.status[k] === null) expectEq(`page status.${k} blank for null`, page.get(`status.${k}`), null);
  else expectEq(`page status.${k}`, page.get(`status.${k}`), String(snapshot.status[k]));
}
if (snapshot.status.genesis.rpc === null) expectEq("page status.genesis.rpc blank for null", page.get("status.genesis.rpc"), null);

// 5. Every escrow: state, observed_at, trust, scope agree on page, feed and MCP.
const escrowFeed = JSON.parse(feeds.list_escrows).escrows;
for (const e of snapshot.escrows) {
  const id = e.escrow_id;
  const fromFeed = escrowFeed.find((x) => x.escrow_id === id);
  const fromMcp = JSON.parse(mcpText.get(`escrow:${id}`) ?? "null");
  for (const f of ["state", "observed_at", "trust", "scope"]) {
    expectEq(`feed escrow ${id} ${f}`, fromFeed?.[f], e[f]);
    expectEq(`mcp escrow ${id} ${f}`, fromMcp?.[f], e[f]);
  }
  expectEq(`page escrow ${id} state`, page.get(`escrow.${id}.state`), e.state);
  expectEq(`page escrow ${id} observed_at`, page.get(`escrow.${id}.observed_at`), e.observed_at);
  expectEq(`page escrow ${id} trust`, page.get(`escrow.${id}.trust`), e.trust);
}

// 6. Census status: a partial census is never shown as complete anywhere.
if (snapshot.census) {
  expectEq("page census.status", page.get("census.status"), snapshot.census.status);
  expectEq("feed census status", JSON.parse(feeds.get_census).census?.status, snapshot.census.status);
}

console.log(JSON.stringify({ checks, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
