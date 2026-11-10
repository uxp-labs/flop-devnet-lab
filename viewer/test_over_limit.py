#!/usr/bin/env python3
"""[fix: KD-2 follow-up] FIXER's form for a settlement above its reservation or per-call cap: an amber chip
naming the limit ('over the per-call cap' first, else 'over the daily cap'), the held reservation line
(cap_charge, else quote_padded), then a separate 'settled <amount>' line; never 'matches', no green. Offline."""
import unittest

from lane_harness import LED, REC, greens, lane, visible

SETTLED = dict(REC, state="settled", chain_final=True)


def over(settled, **led):
    base = dict(LED, state="settled", spend=settled, cap_charge=settled)  # quote_padded 0.198, per_call_cap 0.25
    return lane([dict(base, **led)], {"req-1": dict(SETTLED, settled=settled)})


class OverLimit(unittest.TestCase):
    def test_above_per_call_cap(self):
        rows, page = over(0.3, daily_cap=5)
        self.assertEqual(rows[0]["chips"], [["amber", "over the per-call cap"]])
        self.assertIn('<span class="k">reservation</span> <span class="mono">0.3</span> <span class="note">(held)</span></div>'
                      '<div><span class="k">settled</span> <span class="mono">0.3</span></div>', page)
        self.assertNotIn("matches", visible(page))
        self.assertEqual(greens(page), [])
        self.assertTrue(rows[0]["bad"])

    def test_above_reservation_within_per_call_cap(self):
        rows, page = over(0.2, daily_cap=5)
        self.assertEqual(rows[0]["chips"], [["amber", "over the daily cap"]])
        self.assertIn(["settled", 0.2], rows[0]["flop"])
        self.assertEqual(greens(page), [])

    def test_reservation_falls_back_to_quote_padded(self):
        rows, page = over(0.2, cap_charge=None, daily_cap=5)
        self.assertIn(["reservation", 0.198], rows[0]["flop"])

    def test_within_limits_still_matches(self):
        rows, page = over(0.05, daily_cap=5)
        self.assertIn("matches", visible(page))
        self.assertIn("chain final", greens(page))

    def test_ledger_disagreement_keeps_the_disagree_chip(self):
        led = dict(LED, state="settled", spend=0.05, cap_charge=0.05)
        rows, page = lane([led], {"req-1": dict(SETTLED, settled=0.3)})
        self.assertEqual(len(rows[0]["chips"]), 1)
        self.assertEqual(rows[0]["chips"][0][0], "amber")
        self.assertNotIn(rows[0]["chips"][0][1], ("over the per-call cap", "over the daily cap"))


if __name__ == "__main__":
    unittest.main()
