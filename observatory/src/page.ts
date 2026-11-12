// One self-contained HTML page. No external assets. Unknown values render as empty cells.
import { own } from "./own.js";
import type { CensusCounts, Snapshot } from "./types.js";

export function esc(v: unknown): string {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Page cells. data-k is the path of the value in the snapshot. Rules (RULES section 5):
 * null is a blank grey cell with no data-v; an empty string shows (empty); true and false show as
 * words; a list carries data-n and an empty list shows none.
 */
function cell(k: string, v: unknown): string {
  if (v === null || v === undefined) return `<td data-k="${esc(k)}" class="unk"></td>`;
  if (v === "") return `<td data-k="${esc(k)}" data-v="">(empty)</td>`;
  return `<td data-k="${esc(k)}" data-v="${esc(v)}">${esc(v)}</td>`;
}

/** A list cell: data-n is the length, an empty list reads none (known empty, never blank). */
function listCell(k: string, items: string[]): string {
  if (items.length === 0) return `<td data-k="${esc(k)}" data-n="0">none</td>`;
  const t = items.join("; ");
  return `<td data-k="${esc(k)}" data-n="${items.length}" data-v="${esc(t)}">${esc(t)}</td>`;
}

function rangeCell(k: string, rs: { from_block: number; to_block: number }[]): string {
  if (rs.length === 0) return `<td data-k="${esc(k)}" data-n="0">none</td>`;
  const t = rs.map((r) => `${r.from_block}-${r.to_block}`).join(", ");
  return `<td data-k="${esc(k)}" data-n="${rs.length}" data-v="${esc(t)}">${esc(t)}</td>`;
}

/** Health cell: unknown is a blank grey cell with data-v="unknown", never ok. */
function healthCell(k: string, h: string | null): string {
  if (h === null || h === "unknown") return `<td data-k="${esc(k)}" data-v="unknown" class="unk" aria-label="unknown"></td>`;
  return `<td data-k="${esc(k)}" data-v="${esc(h)}" class="h-${esc(h)}">${esc(h)}</td>`;
}

/** Arbitrary JSON value (drift spec and runtime): null is blank, strings as written, others as JSON. */
function jsonValue(x: unknown): unknown {
  return x === null || x === undefined ? null : typeof x === "string" || typeof x === "boolean" || typeof x === "number" ? x : JSON.stringify(x);
}

/**
 * A labeled row: one th and one td. The th carries data-for, equal to the td's data-k, and its text is the
 * key without its prefix, dots and underscores read as spaces (RULES section 5). A bare key reads as itself.
 */
function row(key: string, td: string, prefix = "", partial = false): string {
  const label = (partial ? "partial " : "") + key.slice(prefix.length).replace(/[._]/g, " ");
  return `<tr><th scope="row" data-for="${esc(key)}">${esc(label)}</th>${td}</tr>`;
}

/** The one stylesheet. scripts/consistency.mjs fails a page that carries any other. */
export const PAGE_CSS = `
:root{--bg:#fbfbf8;--fg:#1c1d1f;--mut:#62666d;--line:#d9d9d2;--card:#fff;--ok:#1b7f4b;--bad:#b42318;--warn:#9a6700;--unk:#e9e9e4}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--fg:#e8e8e6;--mut:#9a9fa8;--line:#34363b;--card:#1c1e21;--ok:#4cc38a;--bad:#ff7b72;--warn:#e3b341;--unk:#2a2c30}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:980px;margin-inline:auto}
h1{font-size:1.4rem;margin:.2em 0}h2{font-size:1.1rem;margin:1.6em 0 .4em}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top;word-break:break-word}
th[scope=row]{color:var(--mut);font-weight:500;width:34%}code{font:13px ui-monospace,monospace}
td.unk{background:var(--unk)}.h-ok,.s-claimed,.s-funded{color:var(--ok)}.h-down,.s-refunded{color:var(--bad)}.h-degraded,.s-unverified{color:var(--warn)}
.note{color:var(--mut);font-size:.9rem}.banner{border-left:4px solid var(--warn);padding:6px 10px;background:var(--card)}
.partial{color:var(--warn);font-weight:600}
`;

const COUNT_KEYS: (keyof CensusCounts)[] = ["escrows_opened", "escrows_released", "escrows_refunded", "channels_opened", "channels_settled"];

export function renderPage(s: Snapshot): string {
  const st = s.status;
  const out: string[] = [];
  out.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>FLOP Observatory</title><style>${PAGE_CSS}</style></head><body>`);
  out.push(`<h1>FLOP Observatory</h1>`);
  out.push(`<p class="note">Read only. Snapshot <code data-k="snapshot.hash">${esc(s.hash)}</code>, seq ${esc(s.seq)}, observed_at <span data-k="snapshot.observed_at">${esc(s.observed_at)}</span>, trust <span data-k="snapshot.trust">${esc(s.trust)}</span>. Blank grey cells mean unknown; none means known empty.</p>`);
  out.push(`<p class="banner">Escrow state is settlement only. It says nothing about output quality.</p>`);

  // Status
  out.push(`<h2>Network status</h2><div class="card"><table data-section="status">`);
  out.push(row("status.observed_at", cell("status.observed_at", st.observed_at), "status."));
  out.push(row("status.trust", cell("status.trust", st.trust), "status."));
  out.push(row("status.genesis.pinned", cell("status.genesis.pinned", st.genesis.pinned), "status."));
  out.push(row("status.genesis.faucet", cell("status.genesis.faucet", st.genesis.faucet), "status."));
  out.push(row("status.genesis.rpc", cell("status.genesis.rpc", st.genesis.rpc), "status."));
  out.push(row("status.reset_detected", cell("status.reset_detected", st.reset_detected), "status."));
  out.push(row("status.conflicts", listCell("status.conflicts", st.conflicts), "status."));
  out.push(row("status.finalized_height", cell("status.finalized_height", st.finalized_height), "status."));
  out.push(row("status.finalized_hash", cell("status.finalized_hash", st.finalized_hash), "status."));
  out.push(row("status.best_height", cell("status.best_height", st.best_height), "status."));
  out.push(row("status.finality_lag", cell("status.finality_lag", st.finality_lag), "status."));
  out.push(row("status.runtime_version", cell("status.runtime_version", st.runtime_version), "status."));
  for (const [svc, x] of [["rpc", st.rpc], ["gateway", st.gateway], ["faucet", st.faucet]] as const) {
    out.push(row(`status.${svc}.health`, healthCell(`status.${svc}.health`, x.health), "status."));
    out.push(row(`status.${svc}.http`, cell(`status.${svc}.http`, x.http), "status."));
    out.push(row(`status.${svc}.detail`, cell(`status.${svc}.detail`, x.detail), "status."));
    out.push(row(`status.${svc}.observed_at`, cell(`status.${svc}.observed_at`, x.observed_at), "status."));
  }
  out.push(row("status.rpc.stale", cell("status.rpc.stale", st.rpc.stale), "status."));
  out.push(row("status.faucet.ready", cell("status.faucet.ready", st.faucet.ready), "status."));
  out.push(`</table></div>`);

  // Runtime upgrade (RULES.md 7.2): its states read as words, and unknown is blank, never absent.
  out.push(`<h2>Runtime upgrade</h2>`);
  const u = s.upgrade ?? null;
  if (u === null) {
    out.push(`<div class="card"><table data-section="upgrade">${row("upgrade", cell("upgrade", null))}</table></div>`);
  } else {
    const state = (k: string, v: string) => (v === "unknown" ? `<td data-k="${esc(k)}" data-v="unknown" class="unk" aria-label="unknown"></td>` : cell(k, v));
    out.push(`<div class="card"><table data-section="upgrade">`);
    out.push(row("upgrade.observed_at", cell("upgrade.observed_at", u.observed_at), "upgrade."));
    out.push(row("upgrade.trust", cell("upgrade.trust", u.trust), "upgrade."));
    out.push(row("upgrade.at.hash", cell("upgrade.at.hash", u.at.hash), "upgrade."));
    out.push(row("upgrade.at.number", cell("upgrade.at.number", u.at.number), "upgrade."));
    out.push(row("upgrade.executing.state", state("upgrade.executing.state", u.executing.state), "upgrade."));
    out.push(row("upgrade.executing.spec_name", cell("upgrade.executing.spec_name", u.executing.spec_name), "upgrade."));
    out.push(row("upgrade.executing.spec_version", cell("upgrade.executing.spec_version", u.executing.spec_version), "upgrade."));
    out.push(row("upgrade.executing.detail", cell("upgrade.executing.detail", u.executing.detail), "upgrade."));
    out.push(row("upgrade.authorized.state", state("upgrade.authorized.state", u.authorized.state), "upgrade."));
    out.push(row("upgrade.authorized.bytes", cell("upgrade.authorized.bytes", u.authorized.bytes), "upgrade."));
    out.push(row("upgrade.authorized.length", cell("upgrade.authorized.length", u.authorized.length), "upgrade."));
    out.push(row("upgrade.authorized.sha256", cell("upgrade.authorized.sha256", u.authorized.sha256), "upgrade."));
    out.push(row("upgrade.authorized.detail", cell("upgrade.authorized.detail", u.authorized.detail), "upgrade."));
    out.push(row("upgrade.compared_with", cell("upgrade.compared_with", u.compared_with), "upgrade."));
    out.push(row("upgrade.executing_changed", cell("upgrade.executing_changed", u.executing_changed), "upgrade."));
    out.push(row("upgrade.authorization_appeared", cell("upgrade.authorization_appeared", u.authorization_appeared), "upgrade."));
    out.push(`</table></div>`);
  }

  // Escrows
  out.push(`<h2>Escrows</h2><p class="note">Settlement only; says nothing about output quality. Only finalized events on the pinned genesis count. A gateway report is not chain proof.</p>`);
  if (s.escrows.length === 0) out.push(`<p class="note">No escrows in this snapshot.</p>`);
  for (const e of s.escrows) {
    const id = e.escrow_id;
    const ep = `escrow.${id}.`;
    out.push(`<div class="card" data-escrow="${esc(id)}"><table data-section="escrow">`);
    out.push(row(`escrow.${id}.escrow_id`, `<td data-k="escrow.${esc(id)}.escrow_id" data-v="${esc(id)}"><code>${esc(id)}</code></td>`, ep));
    out.push(row(`escrow.${id}.state`, `<td data-k="escrow.${esc(id)}.state" data-v="${esc(e.state)}" class="s-${esc(e.state)}">${esc(e.state)}</td>`, ep));
    out.push(row(`escrow.${id}.observed_at`, cell(`escrow.${id}.observed_at`, e.observed_at), ep));
    out.push(row(`escrow.${id}.trust`, cell(`escrow.${id}.trust`, e.trust), ep));
    out.push(row(`escrow.${id}.finalized_height`, cell(`escrow.${id}.finalized_height`, e.finalized_height), ep));
    out.push(row(`escrow.${id}.evidence`, listCell(`escrow.${id}.evidence`, e.evidence.map((v) => `${v.event} @ ${v.block_number ?? "?"} ${v.block_hash} #${v.event_index}`)), ep));
    out.push(row(`escrow.${id}.notes`, listCell(`escrow.${id}.notes`, e.notes), ep));
    out.push(row(`escrow.${id}.scope`, cell(`escrow.${id}.scope`, e.scope), ep));
    out.push(`</table></div>`);
  }

  // Census
  out.push(`<h2>Census</h2>`);
  const c = s.census;
  if (c === null) {
    out.push(`<div class="card"><table data-section="census">${row("census", cell("census", null))}</table></div>`);
  } else {
    const partial = c.status !== "complete" || !c.complete;
    out.push(`<p data-k="census.status" data-v="${esc(c.status)}" class="${partial ? "partial" : "note"}">${partial ? "PARTIAL: these totals cover only part of the requested range and are not complete." : "Complete: the whole requested range is covered."}</p>`);
    out.push(`<div class="card"><table data-section="census">`);
    out.push(row("census.observed_at", cell("census.observed_at", c.observed_at), "census."));
    out.push(row("census.trust", cell("census.trust", c.trust), "census."));
    out.push(row("census.requested", cell("census.requested", `${c.requested.from_block} to ${c.requested.to_block}`), "census."));
    out.push(row("census.covered", rangeCell("census.covered", c.covered), "census."));
    out.push(row("census.gaps", rangeCell("census.gaps", c.gaps), "census."));
    for (const k of COUNT_KEYS) {
      out.push(row(`census.totals.${k}`, cell(`census.totals.${k}`, own(c.totals, k) ?? null), "census.", partial));
    }
    out.push(row("census.totals_label", cell("census.totals_label", c.totals_label), "census."));
    out.push(row("census.requested_blocks", cell("census.requested_blocks", c.requested_blocks), "census."));
    out.push(row("census.covered_blocks", cell("census.covered_blocks", c.covered_blocks), "census."));
    out.push(row("census.reset_detected", cell("census.reset_detected", c.reset_detected), "census."));
    out.push(row("census.notes", listCell("census.notes", c.notes ?? []), "census."));
    out.push(row("census.pending_unfinalized", cell("census.pending_unfinalized", c.pending_unfinalized), "census."));
    out.push(row("census.duplicates_dropped", cell("census.duplicates_dropped", c.duplicates_dropped), "census."));
    out.push(row("census.excluded_other_genesis", cell("census.excluded_other_genesis", c.excluded_other_genesis), "census."));
    out.push(row("census.malformed_dropped", cell("census.malformed_dropped", c.malformed_dropped), "census."));
    out.push(`</table></div>`);
  }

  // Drift
  out.push(`<h2>Spec drift</h2>`);
  const d = s.drift;
  if (d === null) {
    out.push(`<div class="card"><table data-section="drift">${row("drift", cell("drift", null))}</table></div>`);
  } else {
    out.push(`<div class="card"><table data-section="drift">`);
    out.push(row("drift.observed_at", cell("drift.observed_at", d.observed_at), "drift."));
    out.push(row("drift.trust", cell("drift.trust", d.trust), "drift."));
    out.push(row("drift.genesis", cell("drift.genesis", d.genesis), "drift."));
    out.push(row("drift.finalized_height", cell("drift.finalized_height", d.finalized_height), "drift."));
    out.push(row("drift.runtime_version", cell("drift.runtime_version", d.runtime_version), "drift."));
    out.push(row("drift.spec_source", cell("drift.spec_source", d.spec_source), "drift."));
    out.push(row("drift.runtime_observed_at", cell("drift.runtime_observed_at", d.runtime_observed_at), "drift."));
    out.push(row("drift.matches", cell("drift.matches", d.matches), "drift."));
    out.push(row("drift.mismatches", cell("drift.mismatches", d.mismatches), "drift."));
    out.push(row("drift.unknown", cell("drift.unknown", d.unknown), "drift."));
    out.push(`</table></div>`);
    out.push(`<div class="card"><table data-section="drift"><tr><th data-col="param">param</th><th data-col="spec">spec</th><th data-col="runtime">runtime</th><th data-col="status">status</th><th data-col="note">note</th><th data-col="mapping">mapping</th><th data-col="unit">unit</th><th data-col="expected">expected</th><th data-col="runtime_path">runtime path</th></tr>`);
    d.items.forEach((it, i) => {
      const st2 = it.status === "unknown" ? `<td data-k="drift.${i}.status" data-v="unknown" class="unk" aria-label="unknown"></td>` : cell(`drift.${i}.status`, it.status);
      out.push(`<tr data-row="drift.${i}">${cell(`drift.${i}.param`, it.param)}${cell(`drift.${i}.spec`, jsonValue(it.spec))}${cell(`drift.${i}.runtime`, jsonValue(it.runtime))}${st2}${cell(`drift.${i}.note`, it.note)}${cell(`drift.${i}.mapping`, it.mapping)}${cell(`drift.${i}.unit`, it.unit)}${cell(`drift.${i}.expected`, it.expected)}${cell(`drift.${i}.runtime_path`, it.runtime_path)}</tr>`);
    });
    out.push(`</table></div>`);
  }
  out.push(`</body></html>`);
  return out.join("\n") + "\n";
}
