#!/usr/bin/env python3
"""GUARD, not fail-first: passes at 70c5d4d and after [refactor: over_limit once + daily flag before dispatch].
Sonar's refused-row assertion (pr6-70c5d4d-delta-independent, probes/proposed_refused_assertion.py), adapted to the
shared viewer test lib: a refused row keeps the 'over the daily cap' spend flag, once, after its own flags
(row_refused prepends its flags now that the daily flag is added before dispatch), and nothing on it implies a
release or green. Offline."""
import unittest

from lane_harness import LED, greens, lane, visible


class RefusedKeepsDailyFlag(unittest.TestCase):
    def test_refused_row_keeps_daily_flag_fail_closed(self):
        led = dict(LED, state="refused_local", spend=None, cap_charge=0, reason="daily cap hit", daily_cap=0.1, spent_before=0.3)
        rows, page = lane([led], {})
        self.assertEqual(rows[0]["spend_flags"], ["cap hit = stop", "daily cap hit", "over the daily cap"])
        self.assertIsNone(rows[0]["chips"])
        self.assertTrue(rows[0]["bad"])
        self.assertEqual(greens(page), [])
        self.assertNotIn("matches", visible(page))
        self.assertNotIn("reservation", visible(page))
        self.assertEqual(visible(page).count("over the daily cap"), 1)


if __name__ == "__main__":
    unittest.main()
