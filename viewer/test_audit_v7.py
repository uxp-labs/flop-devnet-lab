#!/usr/bin/env python3
"""Fail-first regressions for IMD re-audit 114b644c (viewer at 288a03e).

Each test asserts the SAFE outcome, so it fails on 288a03e and passes after fix-v7.
Names start with the judge's finding number (V_M1..V_M5 medium, V_L6..V_L9 low, V_I10/I11/I13 info).
Offline: build-lane.py is exec'd into a namespace (as test_lane_disagree.load_lane does) on temp dirs.
"""
import json, re, shutil, sys, tempfile, unittest
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from test_lane_disagree import load_lane  # noqa: E402

NS = load_lane()
IDENTITY, DISAGREE = NS["IDENTITY"], NS["DISAGREE"]
LED = {"job": "j", "request_id": "req-1", "seat": "1234", "did": "did:key:z", "provider": "mock", "network": "devnet",
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


class ViewerAuditV7(unittest.TestCase):
    # ---- medium -------------------------------------------------------------------------
    def test_V_M1_later_line_for_same_job_keeps_earlier_mismatch_row(self):
        foreign = dict(REC, job="OTHER", did="did:key:other", state="settled", settled=0.05, chain_final=True)
        refusal = dict(LED, request_id=None, state="refused_local", cap_charge=0, quote_padded=0.9, reason="over cap", ts="2026-11-10T00:01:00.000Z")
        rows, html = lane([LED, refusal], {"req-1": foreign})
        self.assertEqual(len(rows), 2)
        self.assertIn(IDENTITY, visible(html))
        self.assertIn("req-1", html)

    def test_V_M1_earlier_timeout_attempt_stays_visible(self):
        rows, html = lane([dict(LED, state="timeout_unknown", reason="TimeoutError"), dict(LED, request_id="req-2", state="estimated", spent_before=0.198)],
                          {"req-2": dict(REC, request_id="req-2")})
        self.assertEqual(len(rows), 2)
        self.assertIn("timeout", html)
        self.assertTrue(any(r["bad"] for r in rows))

    def test_V_M2_no_green_link_chip_without_link_evidence_or_on_a_bad_row(self):
        foreign = dict(REC, job="OTHER", did="did:key:other", state="settled", settled=0.05, chain_final=True)
        rows, html = lane([LED], {"req-1": foreign})
        self.assertTrue(rows[0]["bad"])
        self.assertEqual(greens(html), [])
        _rows, html2 = lane([LED], {"req-1": REC})  # an ordinary pending row: no link field in the ledger
        self.assertNotIn('c-green">linked', html2)

    def test_V_M3_markup_in_file_fields_is_escaped_and_cannot_hide_labels(self):
        foreign = dict(REC, request_id="req-2", job="OTHER")
        for bad_led, bad_rec in ((dict(LED, request_id="<!--x"), dict(REC, request_id="<!--x")),
                                 (dict(LED, seat="<!--"), dict(REC, seat="<!--"))):
            with self.subTest(led=bad_led["request_id"], seat=bad_led["seat"]):
                rows, html = lane([bad_led, dict(LED, job="k", request_id="req-2")], {bad_led["request_id"] if bad_led["request_id"] != "<!--x" else "<!--x": bad_rec, "req-2": foreign})
                self.assertNotIn("<!--", html)
                self.assertIn(IDENTITY, visible(html))
                self.assertIn("mismatch", visible(html))
        style = "<style>.flag,.c-red{display:none}</style>"
        rows, html = lane([dict(LED, state="settled", spend=0.198), dict(LED, job="k", request_id="req-2")],
                          {"req-1": dict(REC, state="settled", settled=style), "req-2": foreign})
        self.assertNotIn("<style", html)

    def test_V_M4_non_settled_receipt_with_chain_final_never_goes_green(self):
        cases = [
            (dict(LED, state="settled", spend=0.198), dict(REC, state="reserved", chain_final=True)),
            (LED, dict(REC, chain_final=True)),
            (dict(LED, state="estimated"), dict(REC, state="settled", settled=None, chain_final=True)),
        ]
        for led, rec in cases:
            with self.subTest(ledger=led["state"], receipt=rec["state"]):
                rows, html = lane([led], {"req-1": rec})
                self.assertEqual(greens(html), [])
                self.assertIn(DISAGREE, html)
                self.assertNotIn("> matches", html.replace("</span> matches", "> matches"))

    def test_V_M4_control_matching_settled_receipt_with_verified_chain_final_is_green(self):
        rows, html = lane([dict(LED, state="settled", spend=0.198)], {"req-1": dict(REC, state="settled", settled=0.198, chain_final=True)})
        self.assertFalse(rows[0]["bad"])
        self.assertIn("chain final", greens(html))

    def test_V_M5_identity_is_exact_and_needs_present_job_seat_did(self):
        ok = NS["identity_ok"]
        e = {"job": "j", "seat": "1234", "did": "did:key:z", "request_id": "req-1"}
        self.assertTrue(ok(dict(e), e))
        self.assertFalse(ok(dict(e, seat=1234), e))
        self.assertFalse(ok(dict(e, did=None), dict(e, did=None)))
        self.assertFalse(ok({k: v for k, v in e.items() if k != "did"}, dict(e, did=None)))
        self.assertFalse(ok(dict(e, job=None), dict(e, job=None)))
        rows, html = lane([dict(LED, did=None, state="settled", spend=0.198)],
                          {"req-1": {k: v for k, v in dict(REC, state="settled", settled=0.198, chain_final=True).items() if k != "did"}})
        self.assertTrue(rows[0]["bad"])
        self.assertEqual(greens(html), [])

    # ---- low ----------------------------------------------------------------------------
    def test_V_L6_chain_final_must_be_boolean_true(self):
        rows, html = lane([dict(LED, state="settled", spend=0.198)], {"req-1": dict(REC, state="settled", settled=0.198, chain_final="false")})
        self.assertNotIn("chain final", greens(html))
        self.assertIn("not checked yet", html)

    def test_V_L7_unknown_spent_before_leaves_daily_cap_left_blank(self):
        rows, html = lane([dict(LED, request_id=None, state="refused_local", spent_before=None, cap_charge=0, reason="ledger charge unusable")], {})
        self.assertIsNone(rows[0]["daily_left"])
        self.assertNotRegex(html, r"daily cap left</span> <span class=\"mono\">0\.5")

    def test_V_L8_timeout_or_error_ledger_state_stays_red_beside_a_receipt(self):
        for st, reason, text in (("timeout_unknown", "TimeoutError: no answer; spend unknown, not retried", "timeout"), ("error", "HTTP 500", "HTTP 500")):
            with self.subTest(state=st):
                rows, html = lane([dict(LED, state=st, reason=reason)], {"req-1": REC})
                self.assertTrue(rows[0]["bad"])
                self.assertIn('c-red">unknown', html)
                self.assertIn(text, html)

    def test_V_L9_one_malformed_item_does_not_abort_the_rebuild(self):
        for name, ledger, receipts in (("receipt is a list", [LED], {"req-1": [1, 2]}),
                                       ("daily_cap is a string", [dict(LED, daily_cap="0.5")], {"req-1": REC}),
                                       ("ledger line is not JSON", ["{not json", LED], {"req-1": REC})):
            with self.subTest(case=name), tempfile.TemporaryDirectory() as tmp:
                d = Path(tmp, "r"); d.mkdir()
                Path(d, "ledger.jsonl").write_text("".join((l if isinstance(l, str) else json.dumps(l)) + "\n" for l in ledger))
                for rid, r in receipts.items(): Path(d, f"{rid}.json").write_text(json.dumps(r))
                viewer = Path(tmp, "viewer.html"); shutil.copy(ROOT / "settlement-viewer-2026-11-09.html", viewer)
                before = viewer.read_text()
                old = sys.argv; sys.argv = ["build-lane.py", str(d)]
                try:
                    ns = load_lane(); ns["VIEWER"] = str(viewer); ns["main"]()
                finally:
                    sys.argv = old
                after = viewer.read_text()
                self.assertNotEqual(before, after)
                self.assertIn("unreadable", after)

    # ---- info (trivial, done) -----------------------------------------------------------
    def test_V_I10_distinct_request_ids_get_distinct_labels(self):
        short = NS["short"]
        ids = ["mock-1234-5614aaaaaaaaaa", "mock-1234-5614bbbbbbbbbb"]
        rows, html = lane([dict(LED, request_id=ids[0]), dict(LED, request_id=ids[1], job="j2")], {})
        self.assertIn(ids[0], html); self.assertIn(ids[1], html)

    def test_V_I11_identity_mismatch_names_fields_and_receipt_values(self):
        rows, html = lane([LED], {"req-1": dict(REC, job="SOMEONE-ELSE", did="did:key:zOTHER")})
        self.assertIn("SOMEONE-ELSE", html)
        self.assertIn("did:key:zOTHER", html)

    def test_V_I13_example_mismatch_row_uses_shared_identity_string(self):
        ex = json.loads((ROOT / "lane-examples.json").read_text())["rows"]
        mismatch_rows = [r for r in ex if any(c == ["red", "mismatch"] for c in (r.get("chips") or []))]
        self.assertTrue(mismatch_rows)
        for r in mismatch_rows:
            self.assertIn(IDENTITY, r["flags"])


    def test_V_I13b_example_rows_never_show_a_green_linked_chip(self):
        ex = {r["label"]: r for r in json.loads((ROOT / "lane-examples.json").read_text())["rows"]}
        for label in ("Example happy path", "Example stuck", "Example key expired", "Example cap hit"):
            with self.subTest(label=label):
                self.assertEqual(ex[label]["link"], ["grey", "not checked", None])
        self.assertFalse([l for l, r in ex.items() if r["link"][:2] == ["green", "linked"]])
        committed = (ROOT / "settlement-viewer-2026-11-09.html").read_text()
        self.assertNotIn('c-green">linked', committed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
