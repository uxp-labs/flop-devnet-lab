#!/usr/bin/env python3
"""Fail-first regression for v8 item 4 (Sonar Viewer-M1, build-lane.py:144/146 at 716819c).

A receipt whose last read failed (HTTP 500/503, or http 0 "fetch failed") rendered as a clean
`class="row"` with 'gateway observed' and 'match matches'. Spec (FIXER): the row shows the same labels
and markup as the key-expired example row: chips grey "sent" + red "unknown", the read error visible as
row text ("now  unreadable: <error>"), observed spend blank, the link column grey "not checked", and never
"matches" or green. The check runs before the identity-mismatch and disagree checks, because an unread
receipt can't be compared. Offline: build-lane.py is exec'd on temp dirs (as test_audit_v7.lane does).
"""
import unittest
from test_audit_v7 import LED, REC, lane, visible, greens

UNKNOWN_CHIPS = '<span class="chip c-grey">sent</span> <span class="chip c-red">unknown</span>'
LINK_GREY = '<span class="chip c-grey">not checked</span>'
FAILED = {
    # Realistic producer path: imd-flop `receipt --refresh` on a pending receipt got HTTP 500 / fetch failed.
    "refresh-pending-then-500": (dict(LED, state="estimated", http=200), dict(REC, http=500, error="HTTP 500 from gateway", last_known_at="2026-11-10T15:41:19.305Z"), "HTTP 500 from gateway"),
    "refresh-pending-then-network0": (dict(LED, state="estimated", http=200), dict(REC, http=0, error="fetch failed", last_known_at="2026-11-10T15:41:19.325Z"), "HTTP 0 fetch failed"),
    # The judge's hand-made inputs (5505b809 M1).
    "judge-case1-state-null-500": (dict(LED), dict(REC, state=None, http=500, error="HTTP 500"), "HTTP 500"),
    "judge-case2-settled-503": (dict(LED, state="settled", spend=0.198, cap_charge=0.198), dict(REC, state="settled", settled=0.198, http=503, error="HTTP 503", last_known_at="2026-11-10T15:41:19.288Z"), "HTTP 503"),
    # The read-failure check runs before the identity and disagree checks.
    "first-run-read-failed-empty-request_id": (dict(LED), dict(REC, request_id="", state=None, http=404, error="not_found"), "HTTP 404 not_found"),
    "failed-read-beside-ledger-settled": (dict(LED, state="settled", spend=0.05, cap_charge=0.05), dict(REC, http=503, error="HTTP 503"), "HTTP 503"),
}


class ViewerAuditV8(unittest.TestCase):
    def test_V8_M1_failed_receipt_read_renders_red_unknown_like_key_expired(self):
        for name, (led, rec, why) in FAILED.items():
            with self.subTest(name):
                rows, page = lane([led], {"req-1": rec})
                self.assertEqual(len(rows), 1)
                text = visible(page)
                self.assertTrue(rows[0]["bad"], f"{name}: row must be flagged")
                self.assertIn('class="row bad"', page)
                self.assertEqual(rows[0]["chips"], [["grey", "sent"], ["red", "unknown"]])
                self.assertIn(UNKNOWN_CHIPS, page)
                self.assertIn(f'<span class="k">now</span> unreadable: <span class="mono">{why}</span>', page)
                self.assertIn(f"unreadable: {why}", text)
                self.assertIn('<span class="k">observed spend</span> <span class="unk blank" title="unknown spend">&nbsp;</span>', page)
                self.assertIn("receipt read failed, can't re-check", text)
                self.assertEqual(rows[0]["link"], ["grey", "not checked", None])
                self.assertIn(LINK_GREY, page)
                self.assertNotIn("matches", text)
                self.assertNotIn("mismatch", text)
                self.assertNotIn("disagree", text)
                self.assertEqual(greens(page), [])

    def test_V8_M1_failed_read_error_text_is_escaped(self):
        rows, page = lane([dict(LED)], {"req-1": dict(REC, http=500, error="<b>x</b>")})
        self.assertIn("HTTP 500 &lt;b&gt;x&lt;/b&gt;", page)
        self.assertNotIn("<b>x</b>", page)

    def test_V8_M1_controls_fresh_pending_and_key_expired_are_unchanged(self):
        rows, page = lane([dict(LED, state="estimated")], {"req-1": dict(REC, http=200, error=None)})
        self.assertFalse(rows[0]["bad"])
        self.assertIn("matches", visible(page))
        self.assertNotIn("read failed", visible(page))
        rows, page = lane([dict(LED, state="estimated")], {"req-1": dict(REC, http=401, error="api_key_expired", flag="key_expired")})
        self.assertTrue(rows[0]["bad"])
        self.assertIn("key expired, can't re-check", visible(page))
        self.assertNotIn("read failed", visible(page))


if __name__ == "__main__":
    unittest.main()
