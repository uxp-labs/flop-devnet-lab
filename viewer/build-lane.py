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
DISAGREE = "receipt and ledger disagree; reservation held, chain-final green blocked"
IDENTITY = "receipt identity mismatch; chain-final green blocked"
ET = ZoneInfo("America/New_York")

def num(v): return BLANK if v is None else f'<span class="mono">{v}</span>'
def r6(x): return float(f"{x:.6f}")
def short(s, n=10): return s if len(s) <= n + 2 else s[:n] + "…"
def identity_ok(r, e):
    rid = r.get("request_id")
    return (isinstance(rid, str) and rid != "" and rid == e.get("request_id")
            and r.get("job") == e["job"] and str(r.get("seat")) == str(e["seat"]) and r.get("did") == e["did"])
def when(ts): return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(ET).strftime("%b %-d, %-I:%M %p ET")

def from_files():
    led = os.path.join(RDIR, "ledger.jsonl")
    if not os.path.exists(led): return []
    last = {}
    for line in open(led):
        if line.strip():
            e = json.loads(line); last[e["job"]] = e
    receipts = {}
    for f in glob.glob(os.path.join(RDIR, "*.json")):
        r = json.load(open(f))
        receipts[os.path.splitext(os.path.basename(f))[0]] = r  # file name is the ledger's request_id; contents are checked by identity_ok
    rows = []
    for job, e in last.items():
        r = receipts.get(e.get("request_id"))
        sub = [f"req {short(e['request_id'] or 'none', 14)}", f"seat #{e['seat']} · node {BLANK_NODE}",
               f"{e['provider']} · {e['network']} · {when(e['ts'])}"]
        row = dict(label=html.escape(job), sub=sub, payer=e.get("payer") or "holder", flags=[], spend_flags=[], flop=[],
                   est=e.get("quote_padded"), per_call=e.get("per_call_cap"),
                   outcome=["grey", "not read", "mock job, no imd lookup"], link=["green", "linked", None], bad=False)
        if e.get("link_bypassed"): row["link"] = ["grey", "bypassed (mock)", None]
        spent = (e.get("spent_before") or 0) + (e.get("cap_charge") or 0)
        row["daily_left"] = r6(e["daily_cap"] - spent) if e.get("daily_cap") is not None else None
        st = e["state"]
        if st == "refused_local":
            row.update(chips=None, bad=True); row["flop"] = [["", "refused before the call, no FLOP chips"]]
            row["spend_flags"] = ["cap hit = stop", html.escape(e.get("reason") or "")]
        elif r is None:
            row["chips"] = [["grey", "sent"], ["red", "unknown"]]; row["bad"] = True
            row["flop"] = [["last seen", "sent"], ["observed spend", None]]
            row["flags"] = ["timeout: spend unknown, not retried" if st == "timeout_unknown" else html.escape(e.get("reason") or st)]
        else:
            chips = [["grey", "sent"]]
            ok = identity_ok(r, e)
            if not ok:
                chips.append(["red", "mismatch"]); row["bad"] = True
                row["flags"].append(IDENTITY)  # visible row text, not hover-only
                row["flags"].append("receipt's request_id, job, seat or DID doesn't match this row")
                row["flop"].append(["reservation", e.get("cap_charge") if e.get("cap_charge") is not None else e.get("quote_padded")])
                row["flop"].append(["match", "mismatch"])
                row["flop"].append(["observed spend", None])
                row["chips"] = chips
                rows.append(row)
                continue
            receipt_state = r.get("state")
            disagree = receipt_state in ("settled", "released") and (st == "sent" or e.get("spend") != r.get("settled"))
            if disagree:
                chips = [["amber", DISAGREE]]
                row["bad"] = True
                row["flags"].append(DISAGREE)
                row["flop"].append(["reservation", e.get("cap_charge") if e.get("cap_charge") is not None else e.get("quote_padded")])
                row["flop"].append(["observed spend", None])
                row["chips"] = chips
                rows.append(row)
                continue
            if r.get("flag") == "key_expired":
                chips.append(["red", "unknown"]); row["bad"] = True; row["flags"].append("key expired, can't re-check")
            elif r.get("stage") == "gateway observed":
                chips.append(["amber", "gateway observed"])
            if ok and r.get("chain_final") and not row["bad"]: chips.append(["green", "chain final"])
            row["chips"] = chips
            if not r.get("chain_final"): row["flop"].append(["chain final", '<span class="unk">not checked yet</span>'])
            row["flop"].append(["match", "matches" if ok else "mismatch"])
            row["flop"].append(["observed spend", r.get("settled")])
        rows.append(row)
    return rows
BLANK_NODE = '<span class="unk">unknown</span>'

def render(row):
    lbl = f'{row["label"]}' + "".join(f"<small>{s}</small>" for s in row["sub"]) + f'<span class="tag">payer: {row["payer"]}</span>'
    if row["chips"] is None: flop = '<span class="chip c-empty">empty</span>'
    else: flop = " ".join(f'<span class="chip c-{c}">{t}</span>' for c, t in row["chips"])
    for k, v in row["flop"]:
        v = num(v) if (v is None or isinstance(v, (int, float))) else v
        flop += f'<div><span class="k">{k}</span> {v}</div>' if k else f'<div class="k">{v}</div>'
    flop += "".join(f'<div class="flag">{f}</div>' for f in row["flags"])
    spend = (f'<div><span class="k">est.</span> {num(row["est"])}</div><div><span class="k">per-call cap</span> {num(row["per_call"])}</div>'
             f'<div><span class="k">daily cap left</span> {num(row["daily_left"])}</div>' + "".join(f'<div class="flag">{f}</div>' for f in row["spend_flags"]))
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
