#!/usr/bin/env python3
"""[fix: KD-5] FIXER's form: a held reservation keeps its key and amount spans exactly and adds one trailing
<span class="note">(held)</span>. rows[].flop keeps the pair ["reservation", amount]. A pending matched row (G5)
is held until it settles or is released; a settled matched row shows no reservation line. Offline."""
import unittest

from lane_harness import LED, REC, lane, visible

HELD = '<span class="k">reservation</span> <span class="mono">0.198</span> <span class="note">(held)</span>'


class ReservationHeld(unittest.TestCase):
    def test_failed_read_row_marks_reservation_held(self):
        rows, page = lane([dict(LED)], {"req-1": dict(REC, http=503, error="HTTP 503")})
        self.assertIn(["reservation", 0.198], rows[0]["flop"])
        self.assertIn(HELD, page)
        self.assertIn("reservation 0.198 (held)", visible(page))

    def test_pending_matched_row_is_held(self):
        rows, page = lane([dict(LED)], {"req-1": dict(REC)})  # ledger sent, receipt estimated: matches, pending
        self.assertIn("matches", visible(page))
        self.assertIn(["reservation", 0.198], rows[0]["flop"])
        self.assertIn(HELD, page)

    def test_settled_matched_row_shows_no_reservation_line(self):
        led = dict(LED, state="settled", spend=0.05, cap_charge=0.05)
        rows, page = lane([led], {"req-1": dict(REC, state="settled", settled=0.05, chain_final=True)})
        self.assertNotIn("reservation", [k for k, _ in rows[0]["flop"]])
        self.assertNotIn("(held)", visible(page))

    def test_held_note_appears_once_per_row(self):
        rows, page = lane([dict(LED)], {"req-1": dict(REC, http=503, error="HTTP 503")})
        self.assertEqual(page.count('<span class="note">(held)</span>'), 1)


if __name__ == "__main__":
    unittest.main()
