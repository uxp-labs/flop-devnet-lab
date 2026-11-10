#!/usr/bin/env node
// Proves the output check bites: tampered copies of real outputs directories must each fail
// scripts/consistency.mjs, and an untampered copy must pass.
//
// Usage: node scripts/consistency-canary.mjs <outputs dir> [<outputs dir> ...]
// Each tamper runs on the first given dir where it applies (for example a reset flip needs a
// snapshot with reset_detected true). A tamper that applies nowhere counts as a failure, so none
// can be skipped silently. Tampers that edit a feed also edit the MCP text to the same bytes, so
// the feed itself, not the MCP comparison, has to be what catches them.
// Exit 0 only when the control passes and every tamper is caught.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = process.argv.slice(2).map((d) => resolve(d));
if (dirs.length === 0) {
  console.error("usage: consistency-canary.mjs <outputs dir> [...]");
  process.exit(2);
}

// The feed text format from src/feed.ts: sorted keys, two-space indent, trailing newline.
const sortDeep = (v) =>
  Array.isArray(v)
    ? v.map(sortDeep)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sortDeep(v[k])]))
      : v;
const feedText = (v) => JSON.stringify(sortDeep(v), null, 2) + "\n";

const readJson = (dir, f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const snap = (dir) => readJson(dir, "snapshot.json");

/** Edits a feed file and the matching MCP tool text so both stay byte-identical. */
function editFeed(dir, file, tool, edit) {
  const obj = readJson(dir, file);
  edit(obj);
  const text = feedText(obj);
  writeFileSync(join(dir, file), text);
  const p = join(dir, "mcp-transcript.jsonl");
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const x = lines.find((l) => l.request?.params?.name === tool && l.response?.result);
  if (!x) throw new Error(`transcript has no ${tool} result`);
  x.response.result.content[0].text = text;
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Replaces the attributes and text of one page cell, found by its data-k. */
function editCell(dir, key, edit) {
  const p = join(dir, "index.html");
  const html = readFileSync(p, "utf8");
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(<[a-z][a-z0-9]*)(\\b[^>]*\\bdata-k="${k}"[^>]*)>([^<]*)`);
  const m = re.exec(html);
  if (!m) throw new Error(`page has no ${key} cell`);
  const [attrs, text] = edit(m[2], m[3]);
  const out = html.replace(re, `${m[1]}${attrs}>${text}`);
  if (out === html) throw new Error(`editing ${key} changed nothing`);
  writeFileSync(p, out);
}

const hasEmptyListCell = (dir) => /data-k="[^"]*" data-n="0"/.test(readFileSync(join(dir, "index.html"), "utf8"));

const tampers = [
  {
    name: "escrow-state-in-feed-only",
    applies: (d) => snap(d).escrows.length > 0,
    run: (d) => {
      const p = join(d, "escrows.json");
      const feed = JSON.parse(readFileSync(p, "utf8"));
      feed.escrows[0].state = feed.escrows[0].state === "claimed" ? "refunded" : "claimed";
      writeFileSync(p, feedText(feed));
    },
  },
  {
    name: "faucet-health-on-page",
    applies: () => true,
    run: (d) =>
      editCell(d, "status.faucet.health", (a) => {
        const v = /data-v="([^"]*)"/.exec(a)?.[1];
        const to = v === "ok" ? "down" : "ok";
        return [a.replace(/data-v="[^"]*"/, `data-v="${to}"`).replace(/class="[^"]*"/, `class="h-${to}"`), to];
      }),
  },
  {
    name: "trust-in-mcp-only",
    applies: () => true,
    run: (d) => {
      const p = join(d, "mcp-transcript.jsonl");
      const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const x = lines.find((l) => l.request?.params?.name === "get_status" && l.response?.result);
      const obj = JSON.parse(x.response.result.content[0].text);
      obj.trust = obj.trust === "fixture" ? "trusted RPC" : "fixture";
      x.response.result.content[0].text = feedText(obj);
      writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    },
  },
  {
    name: "reset-true-shown-false-on-page",
    applies: (d) => snap(d).status.reset_detected === true,
    run: (d) => editCell(d, "status.reset_detected", (a) => [a.replace('data-v="true"', 'data-v="false"'), "false"]),
  },
  {
    name: "reset-true-written-false-in-feed-and-mcp",
    applies: (d) => snap(d).status.reset_detected === true,
    run: (d) => editFeed(d, "status.json", "get_status", (f) => (f.status.reset_detected = false)),
  },
  {
    name: "reset-null-written-false-in-feed-and-mcp",
    applies: (d) => snap(d).status.reset_detected === null,
    run: (d) => editFeed(d, "status.json", "get_status", (f) => (f.status.reset_detected = false)),
  },
  {
    name: "stale-flipped-in-feed-and-mcp",
    applies: (d) => typeof snap(d).status.rpc.stale === "boolean",
    run: (d) => editFeed(d, "status.json", "get_status", (f) => (f.status.rpc.stale = !f.status.rpc.stale)),
  },
  {
    name: "conflict-dropped-or-added-in-feed-and-mcp",
    applies: () => true,
    run: (d) =>
      editFeed(d, "status.json", "get_status", (f) => {
        if (f.status.conflicts.length) f.status.conflicts.pop();
        else f.status.conflicts.push("a conflict that the snapshot does not have");
      }),
  },
  {
    name: "finalized-hash-on-page",
    applies: (d) => snap(d).status.finalized_hash !== null,
    run: (d) => editCell(d, "status.finalized_hash", (a) => [a.replace(/data-v="0x[0-9a-f]/, 'data-v="0xf'), "0xf"]),
  },
  {
    name: "census-total-in-feed-and-mcp",
    applies: (d) => snap(d).census !== null,
    run: (d) => editFeed(d, "census.json", "get_census", (f) => (f.census.totals.escrows_opened += 1)),
  },
  {
    name: "empty-list-shown-blank-on-page",
    applies: hasEmptyListCell,
    run: (d) => {
      const p = join(d, "index.html");
      const html = readFileSync(p, "utf8");
      writeFileSync(p, html.replace(/(<td data-k="[^"]*") data-n="0">none/, '$1 class="unk">'));
    },
  },
  {
    name: "reset-key-dropped-from-page",
    applies: () => true,
    run: (d) => editCell(d, "status.reset_detected", (a, t) => [a.replace('data-k="status.reset_detected"', 'data-x="status.reset_detected"'), t]),
  },
  {
    name: "unknown-key-added-to-page",
    applies: () => true,
    run: (d) => {
      const p = join(d, "index.html");
      writeFileSync(p, readFileSync(p, "utf8").replace("</body>", '<table><tr><td data-k="status.made_up" data-v="ok">ok</td></tr></table></body>'));
    },
  },
  // The round 2 rerun's page tampers: a wrong value hidden in nested markup, or shown in a cell
  // with no data-k, must not slip past the comparison.
  {
    name: "reset-word-flipped-inside-a-nested-span",
    applies: (d) => snap(d).status.reset_detected === true,
    run: (d) => editCell(d, "status.reset_detected", (a) => [a, "<span>false</span>"]),
  },
  {
    name: "rpc-health-shown-down-inside-a-span",
    applies: (d) => snap(d).status.rpc.health === "ok",
    run: (d) => editCell(d, "status.rpc.health", (a) => [a, "<span>down</span>"]),
  },
  {
    name: "null-best-height-shows-a-number-inside-a-span",
    applies: (d) => snap(d).status.best_height === null,
    run: (d) => editCell(d, "status.best_height", (a) => [a, "<span>3341577</span>"]),
  },
  {
    name: "pending-count-in-a-cell-without-data-k",
    applies: (d) => snap(d).census !== null && snap(d).census.pending_unfinalized > 0,
    run: (d) => editCell(d, "census.pending_unfinalized", () => ["", "0"]),
  },
  {
    name: "escrow-height-in-a-cell-without-data-k",
    applies: (d) => snap(d).escrows.some((e) => e.finalized_height !== null),
    run: (d) => {
      const e = snap(d).escrows.find((x) => x.finalized_height !== null);
      editCell(d, `escrow.${e.escrow_id}.finalized_height`, () => ["", String(e.finalized_height + 1)]);
    },
  },
  {
    name: "a-value-in-a-new-span-outside-every-cell",
    applies: () => true,
    run: (d) => {
      const p = join(d, "index.html");
      writeFileSync(p, readFileSync(p, "utf8").replace("</h1>", "</h1><p>reset detected: <span>false</span></p>"));
    },
  },
  {
    // Everything agrees, but the snapshot was changed after it was hashed: only the hash and
    // the log can catch this.
    name: "snapshot-edited-after-hashing-everywhere",
    applies: (d) => typeof snap(d).status.reset_detected === "boolean",
    run: (d) => {
      const flip = (v) => !v;
      const s = snap(d);
      s.status.reset_detected = flip(s.status.reset_detected);
      writeFileSync(join(d, "snapshot.json"), feedText(s));
      editFeed(d, "status.json", "get_status", (f) => (f.status.reset_detected = s.status.reset_detected));
      editCell(d, "status.reset_detected", (a) => [a.replace(/data-v="(true|false)"/, `data-v="${s.status.reset_detected}"`), String(s.status.reset_detected)]);
    },
  },
];

function check(dir) {
  const r = spawnSync("node", [join(pkg, "scripts", "consistency.mjs"), dir], { encoding: "utf8" });
  let failures = [];
  try {
    failures = JSON.parse(r.stdout).failures.map((f) => f.what);
  } catch {
    failures = ["no report"];
  }
  return { exit: r.status, failures };
}

const results = [];
let bad = 0;
for (const src of dirs) {
  const tmp = mkdtempSync(join(tmpdir(), "obs-consistency-"));
  cpSync(src, tmp, { recursive: true });
  const r = check(tmp);
  rmSync(tmp, { recursive: true, force: true });
  const outcome = r.exit === 0 ? "control-pass" : "control-fail";
  if (outcome !== "control-pass") bad++;
  results.push({ tamper: "none (control)", outputs: basename(src), outcome, failures: r.failures.slice(0, 3) });
}
for (const t of tampers) {
  const src = dirs.find((d) => {
    try {
      return t.applies(d);
    } catch {
      return false;
    }
  });
  if (!src) {
    bad++;
    results.push({ tamper: t.name, outputs: null, outcome: "not-applicable", failures: [] });
    continue;
  }
  const tmp = mkdtempSync(join(tmpdir(), "obs-consistency-"));
  cpSync(src, tmp, { recursive: true });
  let outcome;
  let failures = [];
  try {
    t.run(tmp);
    const r = check(tmp);
    outcome = r.exit !== 0 ? "caught" : "missed";
    failures = r.failures.slice(0, 3);
  } catch (e) {
    outcome = `tamper-failed: ${e.message}`;
  }
  rmSync(tmp, { recursive: true, force: true });
  if (outcome !== "caught") bad++;
  results.push({ tamper: t.name, outputs: basename(src), outcome, caught_by: failures });
}
console.log(JSON.stringify(results, null, 2));
process.exit(bad ? 1 : 0);
