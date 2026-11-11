#!/usr/bin/env python3
"""Shared viewer test harness (test code only; not a test module).

load_lane() execs build-lane.py into a fresh namespace without running main(). lane() writes a ledger and
receipt files to a temp dir and returns (rows, html) as build-lane.py renders them. LED and REC are the
base ledger row and receipt the audit tests vary. visible() is an HTML page's visible text; greens() lists
the green chip texts. Offline."""
import json, re, sys, tempfile
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_lane():
    src = (ROOT / "build-lane.py").read_text()
    src = src.replace("\nmain()\n", "\n")
    ns = {"__name__": "lane_under_test", "__file__": str(ROOT / "build-lane.py")}
    exec(compile(src, str(ROOT / "build-lane.py"), "exec"), ns)
    return ns


LED = {"job": "j", "request_id": "req-1", "seat": "1234", "did": "did:key:z", "provider": "mock", "network": "devnet", "day": "2026-11-10",
       "ts": "2026-11-10T00:00:00.000Z", "payer": "holder", "quote_padded": 0.198, "cap_charge": 0.198, "per_call_cap": 0.25,
       "daily_cap": 0.5, "spent_before": 0, "state": "sent", "spend": None, "reason": None}
REC = {"request_id": "req-1", "job": "j", "seat": "1234", "did": "did:key:z", "state": "estimated", "settled": None,
       "stage": "gateway observed", "chain_final": False, "flag": None}


def lane(ledger_rows, receipts):
    """ledger_rows: list of dicts (or raw strings); receipts: {request_id: obj}. Returns (rows, html)."""
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "ledger.jsonl").write_text("".join((l if isinstance(l, str) else json.dumps(l)) + "\n" for l in ledger_rows))
        for rid, r in receipts.items():
            Path(tmp, f"{rid}.json").write_text(r if isinstance(r, str) else json.dumps(r))
        old = sys.argv
        sys.argv = ["build-lane.py", tmp]
        try:
            ns = load_lane()
            rows = ns["from_files"]()
            return rows, "".join(ns["render"](r) for r in rows)
        finally:
            sys.argv = old


class Visible(HTMLParser):
    """Visible text only: comments and <style>/<script> bodies are dropped."""
    def __init__(self):
        super().__init__(); self.out = []; self.skip = 0
    def handle_starttag(self, tag, attrs):
        if tag in ("style", "script"): self.skip += 1
    def handle_endtag(self, tag):
        if tag in ("style", "script") and self.skip: self.skip -= 1
    def handle_data(self, d):
        if not self.skip: self.out.append(d)


def visible(html):
    p = Visible(); p.feed(html); p.close(); return "".join(p.out)


def greens(html): return re.findall(r'c-green">([^<]+)', html)
