#!/usr/bin/env python3
"""A settled receipt beside a ledger row still at sent must keep the reservation label."""
import json, os, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DISAGREE = "receipt and ledger disagree; reservation held, chain-final green blocked"

def load_lane():
    src = (ROOT / "build-lane.py").read_text()
    src = src.replace("\nmain()\n", "\n")
    ns = {"__name__": "lane_under_test", "__file__": str(ROOT / "build-lane.py")}
    exec(compile(src, str(ROOT / "build-lane.py"), "exec"), ns)
    return ns

IDENTITY = load_lane()["IDENTITY"]  # one Python copy lives in build-lane.py; checked against match.ts below

class DisagreeTests(unittest.TestCase):
    def test_settled_refresh_with_sent_ledger_keeps_reservation_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "unused"), exist_ok=True)
            ledger = {
                "job": "disagree-job", "request_id": "req-1", "seat": "1", "did": "did:key:z",
                "provider": "mock", "network": "devnet", "ts": "2026-11-10T00:00:00.000Z",
                "payer": "holder", "quote_padded": 0.186, "cap_charge": 0.186,
                "per_call_cap": 0.186, "daily_cap": 1, "state": "sent", "spend": None,
            }
            receipt = {
                "request_id": "req-1", "job": "disagree-job", "seat": "1", "did": "did:key:z",
                "state": "settled", "settled": 0.05, "stage": "gateway observed", "chain_final": False,
            }
            Path(tmp, "ledger.jsonl").write_text(json.dumps(ledger) + "\n")
            Path(tmp, "req-1.json").write_text(json.dumps(receipt))
            old = sys.argv
            sys.argv = ["build-lane.py", tmp]
            try:
                ns = load_lane()
                rows = ns["from_files"]()
                html = ns["render"](rows[0])
            finally:
                sys.argv = old
            self.assertIn(DISAGREE, html)
            self.assertIn('class="chip c-amber">' + DISAGREE, html)
            self.assertNotIn('class="chip c-green">' + DISAGREE, html)
            self.assertNotIn('class="chip c-grey">' + DISAGREE, html)
            self.assertIn("0.186", html)
            self.assertEqual(rows[0]["est"], 0.186)

    def test_foreign_settled_receipt_beside_sent_row_shows_identity_mismatch_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = {
                "job": "my-job", "request_id": "req-1", "seat": "1", "did": "did:key:z",
                "provider": "mock", "network": "devnet", "ts": "2026-11-10T00:00:00.000Z",
                "payer": "holder", "quote_padded": 0.186, "cap_charge": 0.186,
                "per_call_cap": 0.186, "daily_cap": 1, "state": "sent", "spend": None,
            }
            receipt = {
                "request_id": "req-1", "job": "someone-elses-job", "seat": "9", "did": "did:key:other",
                "state": "settled", "settled": 0.05, "stage": "gateway observed", "chain_final": True,
            }
            Path(tmp, "ledger.jsonl").write_text(json.dumps(ledger) + "\n")
            Path(tmp, "req-1.json").write_text(json.dumps(receipt))
            old = sys.argv
            sys.argv = ["build-lane.py", tmp]
            try:
                ns = load_lane()
                rows = ns["from_files"]()
                html = ns["render"](rows[0])
            finally:
                sys.argv = old
            self.assertIn('class="chip c-red">mismatch</span>', html)
            self.assertIn('<div class="flag">' + IDENTITY + '</div>', html)
            self.assertNotIn(DISAGREE, html)
            self.assertNotIn('class="chip c-green">chain final', html)
            self.assertEqual(html.count('class="chip c-green"'), 1)
            self.assertIn('class="chip c-green">linked', html)
            self.assertIn('<span class="k">match</span> mismatch', html)
            self.assertNotIn("0.05", html)
            self.assertIn("0.186", html)
            self.assertTrue(rows[0]["bad"])

    def test_identity_check_compares_request_id(self):
        ns = load_lane()
        e = {"job": "j", "seat": "1", "did": "d", "request_id": "req-1"}
        self.assertTrue(ns["identity_ok"]({"job": "j", "seat": "1", "did": "d", "request_id": "req-1"}, e))
        for rid in ("req-2", "", None, 1):
            self.assertFalse(ns["identity_ok"]({"job": "j", "seat": "1", "did": "d", "request_id": rid}, e))
        self.assertFalse(ns["identity_ok"]({"job": "j", "seat": "1", "did": "d", "request_id": None}, dict(e, request_id=None)))

    def _row(self, ledger, receipt, fname="req-1.json"):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "ledger.jsonl").write_text(json.dumps(ledger) + "\n")
            Path(tmp, fname).write_text(json.dumps(receipt))
            old = sys.argv
            sys.argv = ["build-lane.py", tmp]
            try:
                ns = load_lane(); rows = ns["from_files"](); return rows[0], ns["render"](rows[0])
            finally:
                sys.argv = old

    def test_foreign_request_id_settled_receipt_beside_sent_row_is_red_identity_only(self):
        ledger = {"job": "j", "request_id": "req-1", "seat": "1", "did": "did:key:z", "provider": "mock",
                  "network": "devnet", "ts": "2026-11-10T00:00:00.000Z", "payer": "holder", "quote_padded": 0.186,
                  "cap_charge": 0.186, "per_call_cap": 0.186, "daily_cap": 1, "state": "sent", "spend": None}
        receipt = {"request_id": "req-OTHER", "job": "j", "seat": "1", "did": "did:key:z", "state": "settled",
                   "settled": 0.05, "stage": "gateway observed", "chain_final": True}
        row, html = self._row(ledger, receipt)
        self.assertIn('class="chip c-red">mismatch</span>', html)
        self.assertIn('<div class="flag">' + IDENTITY + '</div>', html)
        self.assertNotIn(DISAGREE, html)
        self.assertEqual(html.count('class="chip c-green"'), 1)
        self.assertIn('class="chip c-green">linked', html)
        self.assertIn("0.186", html)
        self.assertNotIn("0.05", html)

    def test_viewer_identity_string_is_the_cli_string(self):
        ts = (ROOT.parent / "imd-flop" / "src" / "match.ts").read_text()
        import re
        m = re.search(r'RECEIPT_IDENTITY_STATUS\s*=\s*"([^"]+)"', ts)
        self.assertIsNotNone(m)
        self.assertEqual(IDENTITY, m.group(1))

    def test_legend_uses_shared_string_and_names_request_id(self):
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            viewer = Path(tmp, "viewer.html")
            shutil.copy(ROOT / "settlement-viewer-2026-11-09.html", viewer)
            old = sys.argv
            sys.argv = ["build-lane.py", str(ROOT / "mock-receipts")]
            try:
                ns = load_lane(); ns["VIEWER"] = str(viewer); ns["main"]()
            finally:
                sys.argv = old
            out = viewer.read_text()
        legend = out[out.index("<!-- lane:start -->"):].split("</p>")[0]
        self.assertIn(IDENTITY, legend)
        self.assertIn("request_id, job, seat or DID", legend)
        self.assertNotIn("Red mismatch means the receipt's job, seat or DID", legend)

    def test_committed_viewer_html_legend_matches(self):
        out = (ROOT / "settlement-viewer-2026-11-09.html").read_text()
        legend = out[out.index("<!-- lane:start -->"):].split("</p>")[0]
        self.assertIn(IDENTITY, legend)
        self.assertIn("request_id, job, seat or DID", legend)

if __name__ == "__main__":
    unittest.main(verbosity=2)
