#!/usr/bin/env python3
"""Independent review of the hold floor branch (b839bf3..bf9087c): viewer findings. Standard library only, never
runs node. Each DEFECT test asserts what the viewer does today, which is wrong, so it passes at bf9087c and
fails once the defect is fixed; its docstring says what the right behavior is and what imd-flop says for the
same files (imd-flop's side is pinned by imd-flop/test/review-hold.test.ts and review-fixes.test.ts R3)."""
import unittest

from lane_harness import LED, REC, lane, visible

PAST_ADMITTED = "booked past what the cap admitted; the day may end over its cap"


class ReviewHold(unittest.TestCase):
    def test_DEFECT_6_the_lane_flags_a_day_imd_flop_marks_OVER_CAP(self):
        """DEFECT 6: the lane flags a day imd-flop marks OVER CAP. Today: the ledger of review-fixes R3. Cap 0.3. A is sent (0.198), released by "nothing was sent",
        B is admitted against the freed room (spent_before 0), then a trusted read brings A's hold back with
        reason PAST_ADMITTED. imd-flop status says the day is 0.396 of 0.3, OVER CAP. The lane works out each
        row's 'daily cap left' from the row's own spent_before, so both rows show 0.102 left, neither is bad,
        and the PAST_ADMITTED reason is not on the page. Right: the lane flags a row whose reason carries
        PAST_ADMITTED (or a day whose latest rows total above the cap) and never shows it as fine."""
        a = dict(LED, request_id="a", job="jA", daily_cap=0.3, per_call_cap=0.3)
        b = dict(LED, request_id="b", job="jB", daily_cap=0.3, per_call_cap=0.3)
        ledger = [a, dict(a, state="refused_local", cap_charge=0, reason="nothing sent: child key mint failed"),
                  b, dict(b, state="estimated"), dict(a, state="estimated", cap_charge=0.198, reason=PAST_ADMITTED)]
        rows, page = lane(ledger, {"a": dict(REC, request_id="a", job="jA"), "b": dict(REC, request_id="b", job="jB")})
        latest = {e["request_id"]: e for e in ledger}
        self.assertGreater(round(sum(e["cap_charge"] for e in latest.values()), 6), 0.3)  # what imd-flop counts
        self.assertEqual([(r["label"], r["daily_left"], r["bad"]) for r in rows], [("jA", 0.102, False), ("jB", 0.102, False)])
        self.assertNotIn("over the daily cap", visible(page))
        self.assertNotIn(PAST_ADMITTED, visible(page))

    def test_DEFECT_7_a_ledger_line_imd_flop_cannot_read_is_an_unreadable_row_in_the_lane(self):
        """DEFECT 7: a ledger line imd-flop cannot read is an unreadable row in the lane. Today: Python's json reads NaN, Infinity and -Infinity; JavaScript's JSON.parse does not. A ledger
        line with "cap_charge": NaN is, for imd-flop, "ledger line 1 cannot be read: not valid JSON": status
        exits 1 and every run is refused with exit 3. The lane reads it as an ordinary row: not unreadable, not
        bad, only 'daily cap not checked'. Right: the viewer parses ledger lines with the same grammar as
        imd-flop (json.loads with parse_constant raising), so the line is an unreadable red row naming line 1."""
        line = ('{"job":"j","request_id":"req-1","seat":"1234","did":"did:key:z","provider":"mock","network":"devnet",'
                '"day":"2026-11-10","ts":"2026-11-10T00:00:00.000Z","payer":"holder","quote_padded":0.198,"cap_charge":NaN,'
                '"per_call_cap":0.25,"daily_cap":0.5,"spent_before":0,"state":"sent","spend":null,"reason":null}')
        rows, page = lane([line], {"req-1": REC})
        self.assertEqual(len(rows), 1)
        self.assertNotIn("unreadable: not shown as OK", rows[0]["flags"])
        self.assertNotIn("ledger line 1", visible(page))
        self.assertFalse(rows[0]["bad"])
        self.assertEqual(rows[0]["spend_flags"], ["daily cap not checked"])

    def test_a_held_row_with_no_request_id_cannot_be_placed(self):
        """Item 3 (review fixes 3): a held row whose request_id was lost is a row that cannot be placed, in both
        parts: imd-flop refuses the next call and names the line (imd-flop/test/review-hold.test.ts, item 3),
        and the lane flags it 'ledger row cannot be placed in a total (request_id)', red, never green. A
        refusal written before a request id exists (refused_local, charge 0) is not such a row. Shared vectors:
        contract/vectors/ledger-placement.json placement-request-id-*."""
        rows, _ = lane([dict(LED, request_id=None, state="estimated")], {})
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["bad"])
        self.assertIn("ledger row cannot be placed in a total (request_id)", rows[0]["spend_flags"])
        rows, _ = lane([dict(LED, request_id=None, state="refused_local", cap_charge=0)], {})
        self.assertFalse(any("cannot be placed" in f for f in rows[0]["spend_flags"]))

    def test_DEFECT_10_a_row_imd_flop_admitted_under_its_cap_is_not_an_unreadable_row(self):
        """DEFECT 10: a row imd-flop admitted under its cap is not an unreadable row in the lane. Today: `cap set
        1e16` is accepted by imd-flop, which admits calls and records daily_cap 1e16 on each row
        (imd-flop/test/review-hold.test.ts DEFECT 10). The lane reads 1e16 as not an amount (above AMOUNT_MAX)
        and shows the row as a red unreadable row, for the daily cap and for a job budget alike. Right: neither
        part accepts a limit above AMOUNT_MAX, so the two never disagree on such a row."""
        for row in (dict(LED, daily_cap=1e16), dict(LED, payer="requester", job_budget=1e16, job_spent_before=0)):
            rows, _ = lane([row], {"req-1": REC})
            self.assertEqual(rows[0]["chips"], [["red", "unreadable"]])
            self.assertEqual(rows[0]["flags"], ["unreadable: not shown as OK"])


if __name__ == "__main__":
    unittest.main()
