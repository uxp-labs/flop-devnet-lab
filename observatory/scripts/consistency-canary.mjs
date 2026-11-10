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
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/** Swaps two whole td cells, found by their data-k, so each shows up in the other's place. */
function swapCells(dir, keyA, keyB) {
  const p = join(dir, "index.html");
  const html = readFileSync(p, "utf8");
  const find = (key) => {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`<td\\b[^>]*\\bdata-k="${k}"[^>]*>[\\s\\S]*?</td>`).exec(html);
    if (!m) throw new Error(`page has no ${key} cell`);
    return m;
  };
  const a = find(keyA);
  const b = find(keyB);
  const [first, second] = a.index < b.index ? [a, b] : [b, a];
  const out =
    html.slice(0, first.index) + second[0] + html.slice(first.index + first[0].length, second.index) + first[0] + html.slice(second.index + second[0].length);
  writeFileSync(p, out);
}

/** Rewrites the page with fn; the tamper fails loudly when fn changes nothing. */
function editHtml(dir, fn) {
  const p = join(dir, "index.html");
  const html = readFileSync(p, "utf8");
  const out = fn(html);
  if (out === html) throw new Error("the edit changed nothing");
  writeFileSync(p, out);
}
/** The whole <tr> that holds the labeled row for one key. */
const rowOf = (html, key) => {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<tr><th[^>]*data-for="${k}"[^>]*>[\\s\\S]*?</tr>`).exec(html);
  if (!m) throw new Error(`page has no ${key} row`);
  return m[0];
};
const hasDriftItems = (d) => snap(d).drift !== null && snap(d).drift.items.length > 0;

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
  // The round 3 rerun's placement tampers: right values in the wrong row or card.
  {
    name: "reset-and-stale-value-cells-swapped",
    applies: (d) => snap(d).status.reset_detected !== null && snap(d).status.rpc.stale !== null,
    run: (d) => swapCells(d, "status.reset_detected", "status.rpc.stale"),
  },
  {
    name: "escrow-state-cells-swapped-between-cards",
    applies: (d) => new Set(snap(d).escrows.map((e) => e.state)).size > 1,
    run: (d) => {
      const es = snap(d).escrows;
      const a = es[0];
      const b = es.find((e) => e.state !== a.state);
      swapCells(d, `escrow.${a.escrow_id}.state`, `escrow.${b.escrow_id}.state`);
    },
  },
  {
    name: "row-label-renamed",
    applies: () => true,
    run: (d) => {
      const p = join(d, "index.html");
      const html = readFileSync(p, "utf8");
      const out = html.replace(/(<th[^>]*data-for="status\.reset_detected"[^>]*>)[^<]*/, "$1rpc stale");
      if (out === html) throw new Error("page has no reset row label");
      writeFileSync(p, out);
    },
  },
  // The IMD audit's finding 12: a value a reader cannot see must not pass as shown. Each of these
  // must be caught by the check named in "expect", not only by some other failure.
  {
    name: "reset-row-in-a-comment",
    expect: /no comment/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace(rowOf(h, "status.reset_detected"), (r) => `<!-- ${r} -->`)),
  },
  {
    name: "reset-row-with-the-hidden-attribute",
    expect: /only the attributes/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace(rowOf(h, "status.reset_detected"), (r) => r.replace("<tr>", "<tr hidden>"))),
  },
  {
    name: "reset-row-styled-display-none",
    expect: /only the attributes/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace(rowOf(h, "status.reset_detected"), (r) => r.replace("<tr>", '<tr style="display:none">'))),
  },
  {
    name: "a-stylesheet-rule-hides-the-reset-row",
    expect: /stylesheet is the renderer's own/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace("</style>", 'tr:has(th[data-for="status.reset_detected"]){visibility:hidden}</style>')),
  },
  {
    name: "status-section-folded-in-a-details-element",
    expect: /only the elements/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace('<div class="card"><table data-section="status">', '<details><div class="card"><table data-section="status">').replace("</table></div>\n<h2>Escrows</h2>", "</table></div></details>\n<h2>Escrows</h2>")),
  },
  {
    name: "a-script-rewrites-the-reset-cell-in-the-browser",
    expect: /only the elements/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace("</body>", `<script>document.querySelector('[data-k="status.reset_detected"]').textContent = "false";</script></body>`)),
  },
  // The third rerun's remaining placement gaps: a right value in the wrong section, under the
  // wrong heading, or under the wrong drift column.
  {
    name: "census-row-moved-into-the-status-table",
    expect: /a status table holds only status cells/,
    applies: (d) => snap(d).census !== null,
    run: (d) =>
      editHtml(d, (h) => {
        const r = rowOf(h, "census.malformed_dropped");
        return h.replace(r, "").replace(rowOf(h, "status.observed_at"), (x) => x + r);
      }),
  },
  {
    name: "census-and-drift-headings-swapped",
    expect: /section headings|sits under the/,
    applies: (d) => snap(d).census !== null && snap(d).drift !== null,
    run: (d) => editHtml(d, (h) => h.replace("<h2>Census</h2>", "<h2>@@</h2>").replace("<h2>Spec drift</h2>", "<h2>Census</h2>").replace("<h2>@@</h2>", "<h2>Spec drift</h2>")),
  },
  {
    name: "drift-spec-and-runtime-columns-swapped-in-the-header",
    expect: /column order/,
    applies: hasDriftItems,
    run: (d) => editHtml(d, (h) => h.replace('<th data-col="spec">spec</th><th data-col="runtime">runtime</th>', '<th data-col="runtime">runtime</th><th data-col="spec">spec</th>')),
  },
  {
    name: "drift-spec-column-labeled-runtime",
    expect: /drift column spec reads its field/,
    applies: hasDriftItems,
    run: (d) => editHtml(d, (h) => h.replace('<th data-col="spec">spec</th>', '<th data-col="spec">runtime</th>')),
  },
  {
    name: "drift-note-column-dropped-from-header-and-rows",
    expect: /shows every field as a column/,
    applies: hasDriftItems,
    run: (d) =>
      editHtml(d, (h) => h.replace('<th data-col="note">note</th>', "").replace(/<td data-k="drift\.\d+\.note"[^>]*>[^<]*<\/td>/g, "")),
  },
  // The IMD follow-up audit: text that states a value outside every compared cell.
  {
    name: "a-fabricated-label-row-of-two-th-cells",
    expect: /a row holds a td|every th is a row label/,
    applies: (d) => snap(d).status.reset_detected === true,
    run: (d) => editHtml(d, (h) => h.replace(rowOf(h, "status.reset_detected"), (r) => `<tr><th scope="row">reset detected</th><th>false</th></tr>${r}`)),
  },
  {
    name: "a-th-only-row-dressed-as-a-drift-column-in-the-status-table",
    expect: /every drift column header sits in the drift item table|no drift column headers/,
    applies: (d) => snap(d).status.reset_detected === true,
    run: (d) => editHtml(d, (h) => h.replace(rowOf(h, "status.reset_detected"), (r) => `<tr><th data-col="note">reset detected = false</th></tr>${r}`)),
  },
  {
    name: "a-free-paragraph-says-safe-to-spend",
    expect: /fixed words/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace("<h2>Network status</h2>", '<h2>Network status</h2><p class="note">reset detected: false. Chain is the pinned genesis; safe to spend.</p>')),
  },
  {
    name: "a-second-h1",
    expect: /fixed words/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace("<h1>FLOP Observatory</h1>", "<h1>FLOP Observatory</h1><h1>No reset detected</h1>")),
  },
  {
    name: "the-title-states-a-value",
    expect: /the page title/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace("<title>FLOP Observatory</title>", "<title>FLOP Observatory reset_detected=true</title>")),
  },
  {
    name: "code-outside-every-cell",
    expect: /fixed words/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace("<h2>Escrows</h2>", "<h2>Escrows</h2><code>reset_detected=false</code>")),
  },
  {
    name: "the-intro-seq-changed",
    expect: /fixed words/,
    applies: () => true,
    run: (d) => editHtml(d, (h) => h.replace(`, seq ${snap(d).seq}, observed_at`, `, seq ${snap(d).seq + 7}, observed_at`)),
  },
  {
    name: "aria-label-reads-false-on-the-reset-cell",
    expect: /aria-label only on a blank unknown cell/,
    applies: (d) => snap(d).status.reset_detected === true,
    run: (d) => editCell(d, "status.reset_detected", (a, t) => [`${a} aria-label="false"`, t]),
  },
  {
    name: "a-true-reset-cell-painted-unknown-grey",
    expect: /status\.reset_detected class/,
    applies: (d) => snap(d).status.reset_detected === true,
    run: (d) => editCell(d, "status.reset_detected", (a, t) => [`${a} class="unk"`, t]),
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
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "obs-consistency-")));
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
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "obs-consistency-")));
  cpSync(src, tmp, { recursive: true });
  let outcome;
  let failures = [];
  try {
    t.run(tmp);
    const r = check(tmp);
    outcome = r.exit === 0 ? "missed" : t.expect && !r.failures.some((w) => t.expect.test(w)) ? "caught-but-not-by-the-named-check" : "caught";
    failures = t.expect ? r.failures.filter((w) => t.expect.test(w)).slice(0, 3) : r.failures.slice(0, 3);
  } catch (e) {
    outcome = `tamper-failed: ${e.message}`;
  }
  rmSync(tmp, { recursive: true, force: true });
  if (outcome !== "caught") bad++;
  results.push({ tamper: t.name, outputs: basename(src), outcome, caught_by: failures });
}
console.log(JSON.stringify(results, null, 2));
process.exit(bad ? 1 : 0);
