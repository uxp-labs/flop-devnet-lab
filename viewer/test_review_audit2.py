#!/usr/bin/env python3
"""Independent review of the fixes for the swarm audit of 33f3b9f, the viewer's side. Each test is named DEFECT
<n> (<severity>) and asserts today's wrong behavior: it passes now and fails once the defect is fixed. The imd-flop
side of each shared rule is imd-flop/test/review-audit2.test.ts. Standard library only, never runs node. Offline."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lane_harness import LED, lane, load_lane  # noqa: E402

NS = load_lane()


class Defect1(unittest.TestCase):
    """DEFECT 1 (medium): the viewer flags 'over the daily cap' on rows imd-flop admitted. left_after takes
    floor_micro(cap - spent) - ceil_micro(cap_charge), and above 16384 FLOP ceil_micro of a grid amount can be one
    step above its numerator, so a row admitted with no room to spare shows -0.000001 left and is flagged over.
    The other two triples come from a random run of 20000 triples, where 43 split this way."""

    TRIPLES = [(16385.147313, 0, 16385.147313), (586607958.833559, 517124896.785768, 69483062.047791),
               (929138013.233559, 372990546.663973, 556147466.569586)]

    def test_DEFECT_1_medium_ceil_micro_is_one_step_above_the_numerator(self):
        self.assertEqual(NS["ceil_micro"](16385.147313), 16385147314)
        self.assertEqual(NS["floor_micro"](16385.147313), 16385147313)

    def test_DEFECT_1_medium_rows_imd_flop_admitted_are_flagged_over_the_daily_cap(self):
        for cap, spent, charge in self.TRIPLES:
            with self.subTest(cap=cap, spent=spent, charge=charge):
                # imd-flop's own expression (policy.ts checkBudget): admitted.
                self.assertFalse(charge > NS["floor6"](cap - spent))
                e = dict(LED, daily_cap=cap, per_call_cap=cap, spent_before=spent, cap_charge=charge, quote_padded=charge)
                applied = NS["spend_limit"](e)
                self.assertIn(NS["OVER_DAILY"], NS["limit_flags"](e, applied))
                self.assertEqual([left for lim, left in applied if lim["key"] == "daily_left"], [-1e-06])


class Defect8(unittest.TestCase):
    """DEFECT 8 (info): receipt files are outside the depth rule. A receipt nested 10000 deep is read by imd-flop
    (JSON.parse) and is unreadable to the viewer (json raises RecursionError, turned into ValueError)."""

    def test_DEFECT_8_info_a_deep_receipt_is_unreadable_to_the_viewer(self):
        deep = '{"request_id":"req-1","job":"j","seat":"1234","did":"did:key:z","state":"settled","settled":0.198,"x":' + "[" * 10000 + "]" * 10000 + "}"
        shallow = deep.replace("[" * 10000 + "]" * 10000, "[[1]]")
        chips = lambda receipt: lane([dict(LED, state="settled", spend=0.198)], {"req-1": receipt})[0][0]["chips"]
        self.assertNotIn(["red", "unreadable"], chips(shallow))
        self.assertIn(["red", "unreadable"], chips(deep))


if __name__ == "__main__":
    unittest.main()
