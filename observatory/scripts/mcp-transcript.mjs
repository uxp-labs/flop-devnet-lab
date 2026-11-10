#!/usr/bin/env node
// Drives the real MCP binary (dist/mcp-bin.js) over stdio against <outputs>/snapshot.json and
// prints one JSON line per exchange: {"request": ..., "response": ...}.
// Calls every tool, every escrow id in the snapshot, one unknown tool and one malformed id.
// Exit 1 if a response is missing, or an expected success is an error, or an expected error is not.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? "out");
const snapshot = JSON.parse(readFileSync(join(outDir, "snapshot.json"), "utf8"));

let id = 0;
const requests = [];
const add = (method, params, expectError = false) => {
  const req = { jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) };
  requests.push({ req, expectError });
};
add("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "observatory-check", version: "0" } });
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
add("tools/list");
for (const name of ["get_status", "list_escrows", "get_census", "get_drift", "get_snapshot_meta"]) {
  add("tools/call", { name, arguments: {} });
}
for (const e of snapshot.escrows ?? []) add("tools/call", { name: "get_escrow_state", arguments: { escrow_id: e.escrow_id } });
add("tools/call", { name: "sign_transaction", arguments: {} }, true);
add("tools/call", { name: "get_escrow_state", arguments: { escrow_id: "not-an-id" } }, true);

const child = spawn("node", [join(pkg, "dist", "mcp-bin.js"), join(outDir, "snapshot.json")], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const responses = new Map();
let stderr = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) {
      const msg = JSON.parse(line);
      responses.set(msg.id, msg);
    }
  }
});
child.stderr.on("data", (d) => (stderr += d));
child.stdin.write(JSON.stringify(requests[0].req) + "\n");
child.stdin.write(JSON.stringify(initialized) + "\n");
for (const { req } of requests.slice(1)) child.stdin.write(JSON.stringify(req) + "\n");
child.stdin.end();

child.on("close", (code) => {
  let bad = 0;
  if (code !== 0) {
    bad++;
    process.stderr.write(`mcp-bin exited ${code}: ${stderr}\n`);
  }
  for (const { req, expectError } of requests) {
    const res = responses.get(req.id) ?? null;
    const isError = !res || "error" in res || res?.result?.isError === true;
    if (!res || isError !== expectError) bad++;
    process.stdout.write(JSON.stringify({ request: req, expect_error: expectError, response: res }) + "\n");
  }
  if (responses.has(undefined)) bad++;
  process.exit(bad ? 1 : 0);
});
