#!/usr/bin/env python3
"""Independent review of the hold floor branch (b839bf3..bf9087c): viewer findings, fixed by review fixes 3.
Standard library only, never runs node. Each test asserts the decided behavior; its docstring says what imd-flop
says for the same files (imd-flop's side is pinned by imd-flop/test/review-hold.test.ts)."""
import unittest

from pathlib import Path

from lane_harness import LED, REC, lane, visible

FIXTURE = Path(__file__).resolve().parent.parent / "contract" / "fixtures" / "ledger-text" / "json-constants.jsonl"

PAST_ADMITTED = "booked past what the cap admitted; the day may end over its cap"


class ReviewHold(unittest.TestCase):
    def test_a_row_booked_past_what_the_cap_admitted_is_flagged_and_never_green(self):
        """Item 6 (review fixes 3): the ledger of review-fixes R3. Cap 0.3. A is sent (0.198), released by "nothing
        was sent", B is admitted against the freed room, then a trusted read brings A's hold back with reason
        PAST_ADMITTED; imd-flop status says the day is 0.396 of 0.3, OVER CAP. The lane works out each row's
        'daily cap left' from the row's own spent_before, so it cannot see the day. It reads the row's reason:
        a row whose reason carries PAST_ADMITTED (rules.json) carries that text as a spend flag, is bad and never
        green. B's row says nothing of the day. Shared vectors: viewer-labels.json past-admitted-*."""
        a = dict(LED, request_id="a", job="jA", daily_cap=0.3, per_call_cap=0.3)
        b = dict(LED, request_id="b", job="jB", daily_cap=0.3, per_call_cap=0.3)
        ledger = [a, dict(a, state="refused_local", cap_charge=0, reason="nothing sent: child key mint failed"),
                  b, dict(b, state="estimated"), dict(a, state="estimated", cap_charge=0.198, reason=PAST_ADMITTED)]
        rows, page = lane(ledger, {"a": dict(REC, request_id="a", job="jA"), "b": dict(REC, request_id="b", job="jB")})
        by = {r["label"]: r for r in rows}
        self.assertTrue(by["jA"]["bad"])
        self.assertIn(PAST_ADMITTED, by["jA"]["spend_flags"])
        self.assertIn(PAST_ADMITTED, visible(page))
        self.assertFalse(by["jB"]["bad"])

    def test_a_ledger_line_with_NaN_or_Infinity_is_unreadable_as_it_is_to_imd_flop(self):
        """Item 7 (review fixes 3): Python's json reads NaN, Infinity and -Infinity; JavaScript's JSON.parse does
        not, so imd-flop names such a line "ledger line 1 cannot be read: not valid JSON". The lane reads ledger
        and receipt lines with the same grammar (build-lane.py loads), so each line of
        contract/fixtures/ledger-text/json-constants.jsonl is an unreadable red row naming line 1. imd-flop's side reads the
        same file (imd-flop/test/review-hold.test.ts, item 7)."""
        for line in FIXTURE.read_text().splitlines():
            with self.subTest(line=line[150:200]):
                rows, page = lane([line], {"req-1": REC})
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["flags"], ["unreadable: not shown as OK"])
                self.assertTrue(rows[0]["bad"])
                self.assertIn("ledger line 1", visible(page))

    def test_a_receipt_file_with_NaN_is_unreadable(self):
        """Item 7: the same grammar for a receipt file: settled NaN makes the file unreadable, never a number."""
        rows, _ = lane([dict(LED, state="settled", spend=0.05)], {"req-1": '{"request_id":"req-1","state":"settled","settled":NaN}'})
        self.assertEqual(rows[0]["chips"], [["grey", "sent"], ["red", "unreadable"]])

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

    def test_a_row_from_elsewhere_with_a_limit_above_AMOUNT_MAX_is_an_unreadable_row(self):
        """Item 10 (review fixes 3): imd-flop refuses a limit above AMOUNT_MAX when it is set (exit 2) and treats a
        config holding one as no usable cap (exit 3), so no row this tool writes records one
        (imd-flop/test/review-hold.test.ts, item 10). A row from elsewhere that does is not a row the lane can
        check: it reads 1e16 as not an amount and shows a red unreadable row, for the daily cap and a job budget
        alike. This is the lane's stated behavior, not a disagreement between the parts."""
        for row in (dict(LED, daily_cap=1e16), dict(LED, payer="requester", job_budget=1e16, job_spent_before=0)):
            rows, _ = lane([row], {"req-1": REC})
            self.assertEqual(rows[0]["chips"], [["red", "unreadable"]])
            self.assertEqual(rows[0]["flags"], ["unreadable: not shown as OK"])


if __name__ == "__main__":
    unittest.main()
