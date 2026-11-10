#!/usr/bin/env node
// Proves the consistency check bites: three tampered copies of a real outputs directory must
// each fail scripts/consistency.mjs. Exit 0 only when all three are caught.
//   1. an escrow state changed in escrows.json only
//   2. a health value changed on the page only
//   3. the trust label changed in one MCP response only
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(process.argv[2] ?? "out");

const tampers = {
  "escrow-state-in-feed": (dir) => {
    const p = join(dir, "escrows.json");
    const feed = JSON.parse(readFileSync(p, "utf8"));
    const e = feed.escrows[0];
    e.state = e.state === "claimed" ? "refunded" : "claimed";
    writeFileSync(p, JSON.stringify(feed, null, 2) + "\n");
  },
  "health-on-page": (dir) => {
    const p = join(dir, "index.html");
    const html = readFileSync(p, "utf8");
    const out = html.replace(/(data-k="status\.faucet\.health" data-v=")([^"]*)"/, (_, head, v) => `${head}${v === "ok" ? "down" : "ok"}"`);
    if (out === html) throw new Error("page has no faucet health cell to tamper");
    writeFileSync(p, out);
  },
  "trust-in-mcp": (dir) => {
    const p = join(dir, "mcp-transcript.jsonl");
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const x = lines.find((l) => l.request?.params?.name === "get_status" && l.response?.result);
    if (!x) throw new Error("transcript has no get_status result to tamper");
    const before = x.response.result.content[0].text;
    x.response.result.content[0].text = before.replace(/"trust": "(fixture|trusted RPC)"/, (_, t) => `"trust": "${t === "fixture" ? "trusted RPC" : "fixture"}"`);
    if (x.response.result.content[0].text === before) throw new Error("no trust label in get_status text");
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  },
};

const results = [];
let bad = 0;
for (const [name, tamper] of Object.entries(tampers)) {
  const dir = mkdtempSync(join(tmpdir(), "obs-consistency-"));
  cpSync(src, dir, { recursive: true });
  let outcome;
  try {
    tamper(dir);
    const r = spawnSync("node", [join(pkg, "scripts", "consistency.mjs"), dir], { encoding: "utf8" });
    outcome = r.status !== 0 ? "caught" : "missed";
  } catch (e) {
    outcome = `tamper-failed: ${e.message}`;
  }
  rmSync(dir, { recursive: true, force: true });
  if (outcome !== "caught") bad++;
  results.push({ tamper: name, outcome });
}
console.log(JSON.stringify(results, null, 2));
process.exit(bad ? 1 : 0);
