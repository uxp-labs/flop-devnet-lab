#!/usr/bin/env python3
"""[fix: KD-2] a negative 'daily cap left' is flagged in visible text, not just shown as a negative number. Offline."""
import unittest

from lane_harness import LED, REC, lane, visible

FLAG = "over the daily cap"


class DailyCapLeft(unittest.TestCase):
    def test_negative_daily_cap_left_is_flagged(self):
        rows, page = lane([dict(LED, spent_before=0.4)], {"req-1": dict(REC)})  # 0.5 - 0.4 - 0.198 = -0.098
        self.assertEqual(rows[0]["daily_left"], -0.098)
        self.assertIn(FLAG, rows[0]["spend_flags"])
        self.assertIn(FLAG, visible(page))

    def test_zero_or_positive_daily_cap_left_is_not_flagged(self):
        for before in (0, 0.302):  # 0.302 left, then exactly 0
            with self.subTest(spent_before=before):
                rows, page = lane([dict(LED, spent_before=before)], {"req-1": dict(REC)})
                self.assertGreaterEqual(rows[0]["daily_left"], 0)
                self.assertNotIn(FLAG, visible(page))

    def test_unknown_daily_cap_left_is_not_flagged(self):
        rows, page = lane([dict(LED, spent_before=None)], {"req-1": dict(REC)})
        self.assertIsNone(rows[0]["daily_left"])
        self.assertNotIn(FLAG, visible(page))


if __name__ == "__main__":
    unittest.main()
