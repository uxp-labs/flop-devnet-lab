#!/usr/bin/env python3
"""[fix: G3-single-chip + stale-text] a row says 'over the daily cap' once: as its amber chip when the row is
over the daily cap (the first limit broken), else as a spend flag. Sonar's G3 shape (settled, stage 'gateway
observed', chain_final) over the daily cap: one status chip, no green. Cap math uses cap_charge. Offline."""
import unittest

from lane_harness import LED, REC, greens, lane, visible

OVER = "over the daily cap"
# Settled 0.05 within the per-call cap (0.25) and the reservation (0.198); daily cap 0.1 - 0.3 - 0.05 < 0.
G3_LED = dict(LED, state="settled", spend=0.05, cap_charge=0.05, daily_cap=0.1, spent_before=0.3)
G3_REC = dict(REC, state="settled", settled=0.05, chain_final=True, stage="gateway observed")


class SingleOverDaily(unittest.TestCase):
    def test_g3_over_daily_says_it_once_on_the_chip(self):
        rows, page = lane([G3_LED], {"req-1": G3_REC})
        self.assertEqual(rows[0]["chips"], [["amber", OVER]])
        self.assertNotIn(OVER, rows[0]["spend_flags"])
        self.assertEqual(visible(page).count(OVER), 1)

    def test_g3_over_daily_has_no_green(self):
        rows, page = lane([G3_LED], {"req-1": G3_REC})
        self.assertEqual(greens(page), [])
        self.assertNotIn('c-green">chain final', page)

    def test_g3_over_daily_has_one_status_chip(self):
        rows, _ = lane([G3_LED], {"req-1": G3_REC})
        status = [c for c in rows[0]["chips"] if c != ["grey", "sent"]]
        self.assertEqual(len(status), 1)

    def test_per_call_chip_keeps_the_daily_spend_flag(self):
        led = dict(G3_LED, spend=0.3, cap_charge=0.3)  # over the per-call cap first, and over the daily cap
        rows, page = lane([led], {"req-1": dict(G3_REC, settled=0.3)})
        self.assertEqual(rows[0]["chips"], [["amber", "over the per-call cap"]])
        self.assertIn(OVER, rows[0]["spend_flags"])
        self.assertEqual(visible(page).count(OVER), 1)

    def test_pending_row_keeps_the_daily_spend_flag(self):
        rows, page = lane([dict(LED, spent_before=0.4)], {"req-1": dict(REC)})
        self.assertIn(OVER, rows[0]["spend_flags"])
        self.assertEqual(visible(page).count(OVER), 1)


if __name__ == "__main__":
    unittest.main()
