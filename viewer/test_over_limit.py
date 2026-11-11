#!/usr/bin/env python3
"""[fix: FIXER-viewer-rulings] (supersedes the [fix: KD-2 follow-up] assertions) a settlement that breaks a limit
shows one amber chip naming the first limit broken, in order 'over the per-call cap', 'over the daily cap',
'over the reservation'; the held reservation line uses quote_padded first, then cap_charge; then a separate
'settled <amount>' line; never 'matches', no green. Cap math (daily cap left) keeps using cap_charge. Offline."""
import re
import unittest

from lane_harness import LED, REC, greens, lane, visible

SETTLED = dict(REC, state="settled", chain_final=True)
VIEWER = __import__("pathlib").Path(__file__).resolve().parent / "settlement-viewer-2026-11-09.html"


def over(settled, **led):
    base = dict(LED, state="settled", spend=settled, cap_charge=settled)  # quote_padded 0.198, per_call_cap 0.25, daily_cap 0.5
    return lane([dict(base, **led)], {"req-1": dict(SETTLED, settled=settled)})


class OverLimit(unittest.TestCase):
    def test_above_per_call_cap(self):
        rows, page = over(0.3, daily_cap=5)
        self.assertEqual(rows[0]["chips"], [["amber", "over the per-call cap"]])
        self.assertIn('<span class="k">reservation</span> <span class="mono">0.198</span> <span class="note">(held)</span></div>'
                      '<div><span class="k">settled</span> <span class="mono">0.3</span></div>', page)
        self.assertNotIn("matches", visible(page))
        self.assertEqual(greens(page), [])
        self.assertTrue(rows[0]["bad"])

    def test_above_reservation_only(self):
        rows, page = over(0.2, daily_cap=5)
        self.assertEqual(rows[0]["chips"], [["amber", "over the reservation"]])
        self.assertIn(["reservation", 0.198], rows[0]["flop"])
        self.assertIn(["settled", 0.2], rows[0]["flop"])
        self.assertEqual(greens(page), [])

    def test_over_the_daily_cap_uses_cap_charge(self):
        rows, page = over(0.2, daily_cap=0.3, spent_before=0.15)  # 0.3 - 0.15 - 0.2 = -0.05; also over the reservation
        self.assertEqual(rows[0]["daily_left"], -0.05)
        self.assertEqual(rows[0]["chips"], [["amber", "over the daily cap"]])

    def test_per_call_wins_over_daily_and_reservation(self):
        rows, page = over(0.3, daily_cap=0.3, spent_before=0.1)  # breaks all three
        self.assertEqual(rows[0]["chips"], [["amber", "over the per-call cap"]])

    def test_daily_cap_alone(self):
        rows, page = over(0.1, daily_cap=0.3, spent_before=0.25)  # within per-call and reservation; 0.3-0.25-0.1 < 0
        self.assertEqual(rows[0]["chips"], [["amber", "over the daily cap"]])
        self.assertEqual(greens(page), [])

    def test_reservation_falls_back_to_cap_charge(self):
        rows, page = over(0.3, quote_padded=None, daily_cap=5)
        self.assertIn(["reservation", 0.3], rows[0]["flop"])

    def test_within_limits_still_matches(self):
        # Hold floor: a settlement charged at its own 0.05 is a row imd-flop writes only when 0.05 was its padded
        # quote. Below the base row's 0.198 the lane would flag it 'charged below its hold'.
        rows, page = over(0.05, daily_cap=5, quote_padded=0.05)
        self.assertIn("matches", visible(page))
        self.assertIn("chain final", greens(page))

    def test_ledger_disagreement_keeps_the_disagree_chip(self):
        led = dict(LED, state="settled", spend=0.05, cap_charge=0.05)
        rows, page = lane([led], {"req-1": dict(SETTLED, settled=0.3)})
        self.assertEqual(len(rows[0]["chips"]), 1)
        self.assertEqual(rows[0]["chips"][0][0], "amber")
        self.assertNotIn(rows[0]["chips"][0][1], ("over the per-call cap", "over the daily cap", "over the reservation"))

    def test_note_is_muted_like_k(self):
        css = VIEWER.read_text()
        k = re.search(r"\.k\{([^}]*)\}", css).group(1)
        note = re.search(r"\.note\{([^}]*)\}", css)
        self.assertIsNotNone(note, ".note needs a rule")
        self.assertEqual(note.group(1), k)
        self.assertNotIn("bold", note.group(1))


if __name__ == "__main__":
    unittest.main()
