#!/usr/bin/env python3
"""Independent review 2 of the hold floor branch (third fix pass, 26cac18..5678633): viewer side, fixed by review
fixes 4. Standard library only, never runs node, never needs imd-flop built. Each test asserts the decided
behavior; imd-flop's side of the same text is in imd-flop/test/review-hold-2.test.ts under the same item number,
and the general rule is pinned for both by contract/fixtures/ledger-text/ (test_ledger_text.py)."""
import json, sys, tempfile, unittest
from pathlib import Path

from lane_harness import LED, REC, lane, load_lane

PAST_ADMITTED = "booked past what the cap admitted; the day may end over its cap"
UNPLACED = "ledger row cannot be placed in a total"


def lane_bytes(data):
    """from_files() on a ledger.jsonl holding exactly these bytes, no receipt files."""
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, "ledger.jsonl").write_bytes(data)
        old = sys.argv
        sys.argv = ["build-lane.py", tmp]
        try:
            return load_lane()["from_files"]()
        finally:
            sys.argv = old


def unreadable_labels(rows):
    return [r["label"] for r in rows if "unreadable: not shown as OK" in r["flags"]]


def row(i, **extra):
    return {**LED, **dict(request_id=f"mock-9001-r{i}", job=f"j{i}", seat="9001", quote_padded=0.186, cap_charge=0.186,
                          per_call_cap=1, daily_cap=1, state="estimated"), **extra}


class ReviewHold2(unittest.TestCase):
    def test_two_rows_joined_by_a_bare_CR_are_one_unreadable_line_as_in_imd_flop(self):
        """Item 6 (review fixes 4, the ledger text contract): lines end at \n only, so rowA + \r + rowB is one line
        that is not valid JSON, in both parts: imd-flop names "ledger line 1 cannot be read" and refuses; the lane
        shows one red unreadable row naming line 1."""
        text = json.dumps(row(1)) + "\r" + json.dumps(row(2)) + "\n"
        rows = lane_bytes(text.encode())
        self.assertEqual(unreadable_labels(rows), ["ledger line 1"])
        self.assertEqual(len(rows), 1)

    def test_a_CR_between_tokens_keeps_the_line_numbers(self):
        """Item 6b: a \r between two tokens is JSON whitespace: one good row, and the damaged line after it is
        ledger line 2 in both parts."""
        text = json.dumps(row(1), separators=(",", ":")).replace(',"seat"', ',\r"seat"') + "\n" + "not json\n"
        rows = lane_bytes(text.encode())
        self.assertEqual(unreadable_labels(rows), ["ledger line 2"])
        self.assertEqual(sorted(r["label"] for r in rows), ["j1", "ledger line 2"])

    def test_a_line_of_only_a_unit_separator_is_unreadable_as_in_imd_flop(self):
        """Item 6c: \x1f is not in the blank set (rules.json LEDGER_TEXT, JavaScript trim()'s characters), so a
        line holding only it is unreadable line 2 in both parts."""
        rows = lane_bytes(json.dumps(row(1)).encode() + b"\n\x1f\n")
        self.assertEqual(unreadable_labels(rows), ["ledger line 2"])

    def test_a_sent_line_under_a_request_id_with_a_space_is_flagged_unplaced(self):
        """Item 7: rows group by REQUEST_ID in both parts. "a b" is not one, so each line is its own entry: the
        sent line (charge 0.186) cannot be placed, as imd-flop says naming line 1, and the refusal charged 0 is
        not flagged."""
        sent = row(1, request_id="a b", state="sent")
        refused = dict(sent, state="refused_local", cap_charge=0, reason="nothing sent")
        rows, _ = lane([sent, refused], {})
        self.assertEqual(len(rows), 2)
        flagged = [any(f == UNPLACED + " (request_id)" for f in r["spend_flags"]) for r in rows]
        self.assertEqual(flagged, [True, False])

    def test_a_revived_row_booked_again_stays_flagged(self):
        """Item 3 (review fixes 4): the ledger imd-flop writes now. Cap 0.3, A released by "nothing was sent", B
        admitted, a trusted read brings A's hold back (reason PAST_ADMITTED), then a later read settles A at 0.05
        with no raise. imd-flop's booking step is the one owner of the carry: the later row keeps PAST_ADMITTED
        in its reason (imd-flop/test/review-hold-2.test.ts, item 3). The lane reads the latest row, so A stays
        flagged and bad."""
        a = dict(LED, request_id="a", job="jA", daily_cap=0.3, per_call_cap=0.3)
        b = dict(LED, request_id="b", job="jB", daily_cap=0.3, per_call_cap=0.3)
        ledger = [a, dict(a, state="refused_local", cap_charge=0, reason="nothing sent: child key mint failed"),
                  b, dict(b, state="estimated"), dict(a, state="estimated", cap_charge=0.198, reason=PAST_ADMITTED),
                  dict(a, state="settled", spend=0.05, cap_charge=0.198, reason=PAST_ADMITTED)]
        rows, _ = lane(ledger, {"a": dict(REC, request_id="a", job="jA", state="settled", settled=0.05),
                                "b": dict(REC, request_id="b", job="jB")})
        by = {r["label"]: r for r in rows}
        self.assertIn(PAST_ADMITTED, by["jA"]["spend_flags"])
        self.assertTrue(by["jA"]["bad"])

    def test_an_invalid_UTF8_byte_inside_a_string_is_read_and_the_lane_is_built(self):
        """Item 8: an invalid byte becomes U+FFFD, as Node decodes it, and never aborts the file: the row with an
        invalid byte in its model string reads and counts in both parts, and the lane is built."""
        good = json.dumps(row(1)).encode() + b"\n"
        bad = json.dumps(row(2, model="m-X")).encode().replace(b"m-X", b"m-\xff") + b"\n"
        rows = lane_bytes(good + bad)
        self.assertEqual(sorted(r["label"] for r in rows), ["j1", "j2"])
        self.assertEqual(unreadable_labels(rows), [])


if __name__ == "__main__":
    unittest.main()
