#!/usr/bin/env python3
"""Rebuild the imd handoff lane in the settlement viewer from local files only.
Inputs:  mock-receipts/ledger.jsonl + mock-receipts/*.json  (written by imd-flop, mock provider)
         lane-examples.json                                  (example data for kinds the demo lacks)
Output:  rewrites the block between <!-- lane:start --> and <!-- lane:end --> in the viewer HTML.
No network. Unknown spend renders as an empty slot, never 0."""
import json, glob, os, sys, html
from datetime import datetime
from zoneinfo import ZoneInfo
D = os.path.dirname(os.path.abspath(__file__))
VIEWER = os.path.join(D, "settlement-viewer-2026-11-09.html")
RDIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(D, "mock-receipts")
BLANK = '<span class="unk blank" title="unknown spend">&nbsp;</span>'

def load_rules(start=__file__):
    """contract/rules.json from the nearest ancestor folder of this file (symlinks resolved), so the build works
    from any cwd. Fails closed: no rules file means no rebuild, never built-in labels."""
    d = os.path.dirname(os.path.realpath(start))
    while True:
        p = os.path.join(d, "contract", "rules.json")
        if os.path.isfile(p):
            with open(p) as fh: return json.load(fh)
        up = os.path.dirname(d)
        if up == d: raise RuntimeError(f"contract/rules.json not found in any parent of {os.path.realpath(start)}; refusing to build without the shared rules")
        d = up
_C = load_rules()["constants"]
DISAGREE = _C["DISAGREE"]["value"]
IDENTITY = _C["IDENTITY"]["value"]
SETTLES = tuple(_C["SETTLES"]["value"])
STAGE_GATEWAY = _C["STAGE_GATEWAY"]["value"]
ET = ZoneInfo("America/New_York")

def num(v): return BLANK if v is None else f'<span class="mono">{v}</span>'
def r6(x): return float(f"{x:.6f}")
def esc(v): return html.escape("" if v is None else str(v), quote=True)
def amount(v):
    """A file value used as an amount: a finite int/float (not a bool), else None (blank, never 0)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")): return None
    return v
def short(s, n=10):
    """Head and tail of an id, so distinct random tails stay distinct. The full id goes in a title attribute."""
    return s if len(s) <= n + 2 else s[:6] + "…" + s[-(n - 6):]
def present(v): return isinstance(v, str) and v != ""
def identity_ok(r, e):
    """Exact, uncoerced match on request_id, job, seat and DID, each a non-empty string on both sides (as match.ts)."""
    return all(present(r.get(k)) and present(e.get(k)) and r.get(k) == e.get(k) for k in ("request_id", "job", "seat", "did"))
def identity_diff(r, e): return [k for k in ("request_id", "job", "seat", "did") if not (present(r.get(k)) and present(e.get(k)) and r.get(k) == e.get(k))]
def when(ts): return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(ET).strftime("%b %-d, %-I:%M %p ET")

def unreadable(what, why):
    """A red row for an item that could not be read, instead of aborting the whole rebuild."""
    return dict(label=esc(what), sub=[esc(why)], payer="unknown", flags=["unreadable: not shown as OK"], spend_flags=[], flop=[["observed spend", None]],
                est=None, per_call=None, daily_left=None, chips=[["red", "unreadable"]], outcome=["grey", "not read", None],
                link=["grey", "not checked", None], bad=True)

def read_ledger(led):
    """One entry per attempt: the latest line per request_id wins (as imd-flop's ledger). Lines without a
    request_id (local refusals) are each their own entry. Unreadable lines become unreadable rows."""
    order, latest, bad = [], {}, []
    with open(led) as fh:
        for n, line in enumerate(fh, 1):
            if not line.strip(): continue
            try:
                e = json.loads(line)
                if not isinstance(e, dict): raise ValueError("not an object")
            except ValueError as ex:
                bad.append(unreadable(f"ledger line {n}", f"ledger.jsonl line {n}: {type(ex).__name__}")); continue
            rid = e.get("request_id")
            key = ("req", rid) if present(rid) else ("line", n)
            if key not in latest: order.append(key)
            latest[key] = e
    return [latest[k] for k in order], bad

def read_receipts():
    receipts = {}
    for f in glob.glob(os.path.join(RDIR, "*.json")):
        try:
            with open(f) as fh: r = json.load(fh)
        except ValueError:
            r = None
        receipts[os.path.splitext(os.path.basename(f))[0]] = r if isinstance(r, dict) else {"_unreadable": True}
    return receipts  # file name is the ledger's request_id; contents are checked by identity_ok

def from_files():
    led = os.path.join(RDIR, "ledger.jsonl")
    if not os.path.exists(led): return []
    entries, rows = read_ledger(led)
    receipts = read_receipts()
    for e in entries:
        try:
            rows.append(build_row(e, receipts.get(e.get("request_id")) if present(e.get("request_id")) else None))
        except Exception as ex:  # one bad entry never aborts the lane
            rows.append(unreadable(f"job {e.get('job')}", f"ledger entry for {e.get('request_id') or 'none'}: {type(ex).__name__}"))
    return rows

def unresolved(e): return e.get("state") in ("timeout_unknown", "error")

OVER_PER_CALL = "over the per-call cap"
OVER_DAILY = "over the daily cap"
OVER_JOB = "over the job budget"
OVER_RESERVATION = "over the reservation"
# The spend limit that applied to a row, by payer (as imd-flop checkBudget). A holder paid row counts against
# the seat's daily cap. A requester paid row counts against the job budget, never the daily cap. Each entry is
# the ledger field that holds the limit, the row key and page label of what is left, and the 'over' wording.
SPEND_LIMITS = {"holder": dict(field="daily_cap", key="daily_left", label="daily cap left", over=OVER_DAILY),
                "requester": dict(field="job_budget", key="job_left", label="job budget left", over=OVER_JOB)}

def spend_limit(e):
    """The spend limit that applied to this row and what is left of it after the row's cap_charge, as
    (limit, left). left is None when any input is unknown (cap math uses cap_charge). A row whose payer is
    neither holder nor requester gives (None, None): which limit applied is unknown, never a guess."""
    payer = e.get("payer")
    limit = SPEND_LIMITS.get(payer) if isinstance(payer, str) else None
    if limit is None: return None, None
    spent_before, cap_charge, cap = amount(e.get("spent_before")), amount(e.get("cap_charge")), amount(e.get(limit["field"]))
    if e.get(limit["field"]) is not None and cap is None: raise ValueError(f'{limit["field"]} is not a number')
    return limit, (r6(cap - spent_before - cap_charge) if None not in (cap, spent_before, cap_charge) else None)

def over_limit(e, r):
    """The first limit a settled receipt breaks, or None (KD-2, FIXER's order): the per-call cap, then the row's
    spend limit (daily cap or job budget left below 0), then the reservation (quote_padded)."""
    settled = amount(r.get("settled"))
    if settled is None or r.get("state") not in SETTLES: return None
    per_call, quote, (applied, left) = amount(e.get("per_call_cap")), amount(e.get("quote_padded")), spend_limit(e)
    if per_call is not None and settled > per_call: return OVER_PER_CALL
    if left is not None and left < 0: return applied["over"]
    if quote is not None and settled > quote: return OVER_RESERVATION
    return None

def disagrees(e, r):
    """Receipt and ledger can't both be right. Only asked once the receipt was read and its identity matches."""
    st, receipt_state, settled = e.get("state"), r.get("state"), amount(r.get("settled"))
    if receipt_state in SETTLES:
        # The ledger must be settled too, with the same settlement amount. One side knowing an amount the
        # other lacks is a disagreement. Unknown on both sides is not: see settled_unknown().
        d = st not in SETTLES or amount(e.get("spend")) != settled
    else:
        # Pending receipt: the ledger must not claim a settlement, and nothing is chain-final yet.
        d = st in SETTLES or r.get("chain_final") is True
    return d or unresolved(e)

SETTLED_UNKNOWN = "settled, amount unknown; reservation held"

def settled_unknown(e, r):
    """Receipt and ledger both say the call settled and neither knows the amount. They agree: it is the row
    imd-flop books for a settled receipt with no usable amount (settled, spend null, the hold kept)."""
    return (e.get("state") in SETTLES and r.get("state") in SETTLES
            and amount(e.get("spend")) is None and amount(r.get("settled")) is None)

def classify(e, r):
    """The one ordered decision for a ledger row e and its receipt file r (None if there is no file), as
    (kind, limit). First match wins: refused, no receipt, unreadable file, key expired, failed read, identity
    mismatch, disagree, settled with an unknown amount, over limit, matches. limit is the first limit broken
    (over_limit), set only for kind over_limit, so over_limit() runs once per row. Rendering per kind is in
    ROW_KINDS."""
    if e.get("state") == "refused_local": return "refused", None
    if r is None: return "no_receipt", None
    if r.get("_unreadable"): return "unreadable", None
    # The last receipt read failed (key expired, an HTTP error, or http 0 for a dropped connection). The file
    # holds the last known state, not a fresh read, so it can't be compared: runs before the identity and
    # disagree checks. A key-expired read is a failed read with its own wording.
    if r.get("flag") == "key_expired": return "key_expired", None
    if r.get("http") not in (None, 200) or present(r.get("error")): return "read_failed", None
    if not identity_ok(r, e): return "mismatch", None
    if disagrees(e, r): return "disagree", None
    if settled_unknown(e, r): return "settled_unknown", None
    limit = over_limit(e, r)
    if limit: return "over_limit", limit
    return "matches", None

def unresolved_flag(e):
    return "timeout: spend unknown, not retried" if e.get("state") == "timeout_unknown" else esc(e.get("reason") or e.get("state"))

def row_refused(row, e, r, reservation, limit):
    row.update(chips=None, bad=True); row["flop"] = [["", "refused before the call, no FLOP chips"]]
    row["spend_flags"] = ["cap hit = stop", esc(e.get("reason") or "")] + row["spend_flags"]

def unknown_chips():
    """One status chip per row: red 'unknown' (precedence: unreadable, unknown, identity mismatch, disagree).
    A timeout_unknown or error ledger row shows only this; its mismatch or disagree stays in the row text."""
    return [["grey", "sent"], ["red", "unknown"]]

def row_no_receipt(row, e, r, reservation, limit):
    row["chips"] = unknown_chips(); row["bad"] = True
    # No receipt file yet (a timeout): the reservation is still held, so it is shown (residual d).
    row["flop"] = [["last seen", "sent"], ["reservation", reservation], ["observed spend", None]]
    row["flags"] = [unresolved_flag(e)]

def row_unreadable(row, e, r, reservation, limit):
    row["chips"] = [["grey", "sent"], ["red", "unreadable"]]; row["bad"] = True
    row["flags"] = ["receipt file unreadable: not shown as OK"]
    row["flop"] = [["reservation", reservation], ["observed spend", None]]

def row_read_failed(row, e, r, reservation, limit, flag="receipt read failed, can't re-check"):
    # A key-expired read uses the same labels and markup with its own flag; the link column stays grey "not checked".
    err = r.get("error") if present(r.get("error")) else ""
    why = esc(err) if err.startswith("HTTP ") else esc(f"HTTP {r.get('http')} {err}".strip())
    row["chips"] = unknown_chips(); row["bad"] = True
    # Keep the reservation label, as the unreadable-file branch does: a failed read must not drop it.
    row["flop"] = [["last seen", esc(r.get("state") or "unknown")], ["now", f'unreadable: <span class="mono">{why}</span>'], ["reservation", reservation], ["observed spend", None]]
    row["flags"] = [flag] + ([unresolved_flag(e)] if unresolved(e) else [])

def row_mismatch(row, e, r, reservation, limit):
    chips = unknown_chips() if unresolved(e) else [["grey", "sent"], ["red", "mismatch"]]; row["bad"] = True
    row["flags"].append(IDENTITY)  # visible row text, not hover-only
    row["flags"].append("receipt's request_id, job, seat or DID doesn't match this row")
    for k in identity_diff(r, e):
        row["flop"].append([f"receipt {k}", f"{esc(r.get(k))} (row says {esc(e.get(k))})"])
    row["flop"].append(["reservation", reservation])
    row["flop"].append(["match", "mismatch"])
    row["flop"].append(["observed spend", None])
    if unresolved(e): row["flags"].append(unresolved_flag(e))
    row["chips"] = chips

def row_disagree(row, e, r, reservation, limit, label=DISAGREE):
    # A settled row with an unknown amount uses the same chip, flag and held reservation with its own label.
    row["chips"] = unknown_chips() if unresolved(e) else [["amber", label]]
    row["bad"] = True
    row["flags"].append(label)
    if unresolved(e): row["flags"].append(unresolved_flag(e))
    row["flop"].append(["reservation", reservation])
    row["flop"].append(["observed spend", None])

def row_over_limit(row, e, r, reservation, limit):
    # Receipt and ledger agree, but the settlement breaks a limit: amber, the hold stays, never green (KD-2).
    # Here cap_charge is the settled amount, so the held reservation shown is quote_padded first (FIXER).
    quote = amount(e.get("quote_padded"))
    row["chips"] = [["amber", limit]]; row["bad"] = True
    row["flop"] += [["reservation", reservation if quote is None else quote], ["settled", amount(r.get("settled"))]]

def row_matches(row, e, r, reservation, limit):
    chain_final = r.get("chain_final") is True
    chips = [["grey", "sent"]]
    if r.get("stage") == STAGE_GATEWAY:
        chips.append(["amber", STAGE_GATEWAY])
    if chain_final and not row["bad"]: chips.append(["green", "chain final"])
    row["chips"] = chips
    if not chain_final: row["flop"].append(["chain final", '<span class="unk">not checked yet</span>'])
    # A pending match still holds its reservation until it settles or is released.
    if e.get("state") not in SETTLES: row["flop"].append(["reservation", reservation])
    row["flop"].append(["match", "matches"])
    row["flop"].append(["observed spend", amount(r.get("settled"))])

# Each kind renders from (row, e, r, reservation, limit); limit is set only for over_limit.
ROW_KINDS = {"refused": row_refused, "no_receipt": row_no_receipt, "unreadable": row_unreadable, "read_failed": row_read_failed,
             "mismatch": row_mismatch, "disagree": row_disagree, "over_limit": row_over_limit, "matches": row_matches,
             "key_expired": lambda row, e, r, reservation, limit: row_read_failed(row, e, r, reservation, limit, flag="key expired, can't re-check"),
             "settled_unknown": lambda row, e, r, reservation, limit: row_disagree(row, e, r, reservation, limit, label=SETTLED_UNKNOWN)}

def build_row(e, r):
    rid = e.get("request_id")
    rid_label = f'<span title="{esc(rid)}">{esc(short(rid, 14))}</span>' if present(rid) else "none"
    sub = [f"req {rid_label}", f"seat #{esc(e.get('seat'))} · node {BLANK_NODE}",
           f"{esc(e.get('provider'))} · {esc(e.get('network'))} · {esc(when(e['ts']))}"]
    # Link column: no link evidence is recorded in the ledger, so it is always grey "not checked" (link_bypassed too).
    # A row without a payer is tagged unknown, not holder: no limit is shown for it either (spend_limit).
    row = dict(label=esc(e.get("job")), sub=sub, payer=esc(e.get("payer") or "unknown"), flags=[], spend_flags=[], flop=[],
               est=amount(e.get("quote_padded")), per_call=amount(e.get("per_call_cap")),
               outcome=["grey", "not read", "mock job, no imd lookup"], link=["grey", "not checked", None], bad=False)
    # The row carries what is left of the limit that applied, under that limit's key (daily_left or job_left).
    applied, left = spend_limit(e)
    if applied: row[applied["key"]] = left
    kind, limit = classify(e, r)
    # Say it once per row: a row whose chip already names its spend limit gets no spend flag repeating it.
    if left is not None and left < 0 and limit != applied["over"]:
        row["spend_flags"].append(applied["over"])
    cap_charge = amount(e.get("cap_charge"))
    reservation = cap_charge if cap_charge is not None else amount(e.get("quote_padded"))
    ROW_KINDS[kind](row, e, r, reservation, limit)
    return row
BLANK_NODE = '<span class="unk">unknown</span>'
HELD_NOTE = '<span class="note">(held)</span>'

def render(row):
    lbl = f'{row["label"]}' + "".join(f"<small>{s}</small>" for s in row["sub"]) + f'<span class="tag">payer: {row["payer"]}</span>'
    if row["chips"] is None: flop = '<span class="chip c-empty">empty</span>'
    else: flop = " ".join(f'<span class="chip c-{c}">{t}</span>' for c, t in row["chips"])
    for k, v in row["flop"]:
        v = num(v) if (v is None or isinstance(v, (int, float))) else v
        # The lane shows a reservation line only while the reservation is held, so it always carries the note.
        if k == "reservation": v += f" {HELD_NOTE}"
        flop += f'<div><span class="k">{k}</span> {v}</div>' if k else f'<div class="k">{v}</div>'
    flop += "".join(f'<div class="flag">{f}</div>' for f in row["flags"])
    # One line per spend limit the row carries: 'daily cap left' or 'job budget left', neither for an unknown payer.
    spend = (f'<div><span class="k">est.</span> {num(row["est"])}</div><div><span class="k">per-call cap</span> {num(row["per_call"])}</div>'
             + "".join(f'<div><span class="k">{lim["label"]}</span> {num(row[lim["key"]])}</div>' for lim in SPEND_LIMITS.values() if lim["key"] in row)
             + "".join(f'<div class="flag">{f}</div>' for f in row["spend_flags"]))
    oc, ot, on = row["outcome"]
    out = f'<span class="chip c-{oc}">{ot}</span>' + (f'<div class="k">{on}</div>' if on else "") + (f'<div class="flag">{row["outcome_flag"]}</div>' if row.get("outcome_flag") else "")
    lc, lt, lf = row["link"]
    link = f'<span class="chip c-{lc}">{lt}</span>' + (f'<div class="flag">{lf}</div>' if lf else "")
    return (f'<div class="row{" bad" if row["bad"] else ""}">\n <div class="lbl">{lbl}</div>\n <div class="col">{flop}</div>\n'
            f' <div class="col">{spend}</div>\n <div class="col">{out}</div>\n <div class="col">{link}</div>\n</div>\n')

HDR = '<div class="hdr"><div>imd job</div><div>FLOP call</div><div>Spend (est. · caps)</div><div>Job outcome (imd)</div><div>Link check</div></div>\n'
def main():
    demo = from_files()
    ex = json.load(open(os.path.join(D, "lane-examples.json")))["rows"]
    out = ['<h2>imd handoff lane</h2>\n<p class="sub">One row per imd job that used FLOP, rebuilt by <span class="mono">build-lane.py</span> from local files only, never fetched live. '
           'Job outcome is shown as imd\'s public <span class="mono">GET /jobs/:id</span> reports it, grey until read, green only for accepted. '
           f'A red <span class="mono">mismatch</span> chip with the row note <span class="mono">{IDENTITY}</span> means the receipt\'s request_id, job, seat or DID doesn\'t match the row; that row can never go green. A blank slot is unknown spend, never 0.</p>\n']
    out.append(f'<h3 class="lanesub">From <span class="mono">imd-flop</span> receipts <span class="ex">mock provider · nothing spent</span></h3>\n<div class="lane">\n{HDR}')
    out += [render(r) for r in demo] or ['<p class="k">No receipts found.</p>\n']
    out.append('</div>\n')
    out.append(f'<h3 class="lanesub">Reference rows <span class="ex">example data</span></h3>\n<div class="lane">\n{HDR}')
    out += [render(r) for r in ex]
    out.append('</div>\n')
    s = open(VIEWER).read()
    a, b = s.index("<!-- lane:start -->"), s.index("<!-- lane:end -->")
    s = s[:a] + "<!-- lane:start -->\n" + "".join(out) + s[b:]
    open(VIEWER, "w").write(s)
    print(f"lane rebuilt: {len(demo)} receipt rows, {len(ex)} example rows")
if __name__ == "__main__":
    main()
