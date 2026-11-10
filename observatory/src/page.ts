// One self-contained HTML page. No external assets. Unknown values render as empty cells.
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

function row(label: string, td: string): string {
  return `<tr><th scope="row">${esc(label)}</th>${td}</tr>`;
}

const CSS = `
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
  out.push(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>FLOP Observatory</title><style>${CSS}</style></head><body>`);
  out.push(`<h1>FLOP Observatory</h1>`);
  out.push(`<p class="note">Read only. Snapshot <code data-k="snapshot.hash">${esc(s.hash)}</code>, seq ${esc(s.seq)}, observed_at <span data-k="snapshot.observed_at">${esc(s.observed_at)}</span>, trust <span data-k="snapshot.trust">${esc(s.trust)}</span>. Blank grey cells mean unknown; none means known empty.</p>`);
  out.push(`<p class="banner">Escrow state is settlement only. It says nothing about output quality.</p>`);

  // Status
  out.push(`<h2>Network status</h2><div class="card"><table>`);
  out.push(row("observed_at", cell("status.observed_at", st.observed_at)));
  out.push(row("trust", cell("status.trust", st.trust)));
  out.push(row("pinned genesis", cell("status.genesis.pinned", st.genesis.pinned)));
  out.push(row("faucet genesis", cell("status.genesis.faucet", st.genesis.faucet)));
  out.push(row("rpc genesis", cell("status.genesis.rpc", st.genesis.rpc)));
  out.push(row("reset detected", cell("status.reset_detected", st.reset_detected)));
  out.push(row("conflicts", listCell("status.conflicts", st.conflicts)));
  out.push(row("finalized height", cell("status.finalized_height", st.finalized_height)));
  out.push(row("finalized hash", cell("status.finalized_hash", st.finalized_hash)));
  out.push(row("best height", cell("status.best_height", st.best_height)));
  out.push(row("finality lag", cell("status.finality_lag", st.finality_lag)));
  out.push(row("runtime version", cell("status.runtime_version", st.runtime_version)));
  for (const svc of ["rpc", "gateway", "faucet"] as const) {
    const x = st[svc];
    out.push(row(`${svc} health`, healthCell(`status.${svc}.health`, x.health)));
    out.push(row(`${svc} http`, cell(`status.${svc}.http`, x.http)));
    out.push(row(`${svc} detail`, cell(`status.${svc}.detail`, x.detail)));
    out.push(row(`${svc} observed_at`, cell(`status.${svc}.observed_at`, x.observed_at)));
  }
  out.push(row("rpc stale", cell("status.rpc.stale", st.rpc.stale)));
  out.push(row("faucet ready", cell("status.faucet.ready", st.faucet.ready)));
  out.push(`</table></div>`);

  // Escrows
  out.push(`<h2>Escrows</h2><p class="note">Settlement only; says nothing about output quality. Only finalized events on the pinned genesis count. A gateway report is not chain proof.</p>`);
  if (s.escrows.length === 0) out.push(`<p class="note">No escrows in this snapshot.</p>`);
  for (const e of s.escrows) {
    const id = e.escrow_id;
    out.push(`<div class="card"><table>`);
    out.push(row("escrow id", `<td data-k="escrow.${esc(id)}.escrow_id" data-v="${esc(id)}"><code>${esc(id)}</code></td>`));
    out.push(row("state", `<td data-k="escrow.${esc(id)}.state" data-v="${esc(e.state)}" class="s-${esc(e.state)}">${esc(e.state)}</td>`));
    out.push(row("observed_at", cell(`escrow.${id}.observed_at`, e.observed_at)));
    out.push(row("trust", cell(`escrow.${id}.trust`, e.trust)));
    out.push(row("finalized height", cell(`escrow.${id}.finalized_height`, e.finalized_height)));
    out.push(row("evidence", listCell(`escrow.${id}.evidence`, e.evidence.map((v) => `${v.event} @ ${v.block_number ?? "?"} ${v.block_hash} #${v.event_index}`))));
    out.push(row("notes", listCell(`escrow.${id}.notes`, e.notes)));
    out.push(row("scope", cell(`escrow.${id}.scope`, e.scope)));
    out.push(`</table></div>`);
  }

  // Census
  out.push(`<h2>Census</h2>`);
  const c = s.census;
  if (c === null) {
    out.push(`<div class="card"><table>${row("census", cell("census", null))}</table></div>`);
  } else {
    const partial = c.status !== "complete" || !c.complete;
    out.push(`<p data-k="census.status" data-v="${esc(c.status)}" class="${partial ? "partial" : "note"}">${partial ? "PARTIAL: these totals cover only part of the requested range and are not complete." : "Complete: the whole requested range is covered."}</p>`);
    out.push(`<div class="card"><table>`);
    out.push(row("observed_at", cell("census.observed_at", c.observed_at)));
    out.push(row("trust", cell("census.trust", c.trust)));
    out.push(row("requested", cell("census.requested", `${c.requested.from_block} to ${c.requested.to_block}`)));
    out.push(row("covered", rangeCell("census.covered", c.covered)));
    out.push(row("gaps", rangeCell("census.gaps", c.gaps)));
    for (const k of COUNT_KEYS) {
      out.push(row(`${partial ? "partial " : ""}${k}`, cell(`census.totals.${k}`, c.totals[k] ?? null)));
    }
    out.push(row("totals label", cell("census.totals_label", c.totals_label)));
    out.push(row("requested blocks", cell("census.requested_blocks", c.requested_blocks)));
    out.push(row("covered blocks", cell("census.covered_blocks", c.covered_blocks)));
    out.push(row("census reset detected", cell("census.reset_detected", c.reset_detected)));
    out.push(row("census notes", listCell("census.notes", c.notes ?? [])));
    out.push(row("pending unfinalized", cell("census.pending_unfinalized", c.pending_unfinalized)));
    out.push(row("duplicates dropped", cell("census.duplicates_dropped", c.duplicates_dropped)));
    out.push(row("excluded other genesis", cell("census.excluded_other_genesis", c.excluded_other_genesis)));
    out.push(row("malformed dropped", cell("census.malformed_dropped", c.malformed_dropped)));
    out.push(`</table></div>`);
  }

  // Drift
  out.push(`<h2>Spec drift</h2>`);
  const d = s.drift;
  if (d === null) {
    out.push(`<div class="card"><table>${row("drift", cell("drift", null))}</table></div>`);
  } else {
    out.push(`<div class="card"><table>`);
    out.push(row("observed_at", cell("drift.observed_at", d.observed_at)));
    out.push(row("trust", cell("drift.trust", d.trust)));
    out.push(row("genesis", cell("drift.genesis", d.genesis)));
    out.push(row("finalized height", cell("drift.finalized_height", d.finalized_height)));
    out.push(row("runtime version", cell("drift.runtime_version", d.runtime_version)));
    out.push(row("spec source", cell("drift.spec_source", d.spec_source)));
    out.push(row("runtime observed_at", cell("drift.runtime_observed_at", d.runtime_observed_at)));
    out.push(row("matches", cell("drift.matches", d.matches)));
    out.push(row("mismatches", cell("drift.mismatches", d.mismatches)));
    out.push(row("unknown", cell("drift.unknown", d.unknown)));
    out.push(`</table></div>`);
    out.push(`<div class="card"><table><tr><th>param</th><th>spec</th><th>runtime</th><th>status</th><th>note</th><th>mapping</th><th>unit</th><th>expected</th><th>runtime path</th></tr>`);
    d.items.forEach((it, i) => {
      const st2 = it.status === "unknown" ? `<td data-k="drift.${i}.status" data-v="unknown" class="unk" aria-label="unknown"></td>` : cell(`drift.${i}.status`, it.status);
      out.push(`<tr>${cell(`drift.${i}.param`, it.param)}${cell(`drift.${i}.spec`, jsonValue(it.spec))}${cell(`drift.${i}.runtime`, jsonValue(it.runtime))}${st2}${cell(`drift.${i}.note`, it.note)}${cell(`drift.${i}.mapping`, it.mapping)}${cell(`drift.${i}.unit`, it.unit)}${cell(`drift.${i}.expected`, it.expected)}${cell(`drift.${i}.runtime_path`, it.runtime_path)}</tr>`);
    });
    out.push(`</table></div>`);
  }
  out.push(`</body></html>`);
  return out.join("\n") + "\n";
}
