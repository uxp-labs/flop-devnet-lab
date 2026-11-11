#!/usr/bin/env python3
"""Independent review 2 of the hold floor branch (third fix pass, 26cac18..5678633): viewer side. Standard library
only, never runs node, never needs imd-flop built. Each DEFECT test asserts today's wrong behavior, so it passes
now and fails once the defect is fixed; the right behavior is in its docstring. imd-flop's side of the same text
is in imd-flop/test/review-hold-2.test.ts under the same DEFECT number."""
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
    def test_DEFECT_6_two_rows_joined_by_a_bare_CR_should_be_one_unreadable_line_as_in_imd_flop(self):
        """imd-flop splits ledger.jsonl at \\n only: rowA + \\r + rowB is one line that is not valid JSON, and it
        names "ledger line 1 cannot be read" and refuses every call (exit 3). read_ledger opens the file in text
        mode, whose universal newlines split at the bare \\r, so the lane shows two good rows and no unreadable
        row. Right: the viewer frames lines as imd-flop does (open with newline="" and split at \\n), so this is
        one red unreadable row naming line 1."""
        text = json.dumps(row(1)) + "\r" + json.dumps(row(2)) + "\n"
        rows = lane_bytes(text.encode())
        self.assertEqual(unreadable_labels(rows), [])
        self.assertEqual(sorted(r["label"] for r in rows), ["j1", "j2"])
        # Each is an ordinary row with no receipt file yet (as imd-flop's own rows would be), not an unreadable one.
        self.assertTrue(all(r["chips"] == [["grey", "sent"], ["red", "unknown"]] for r in rows))

    def test_DEFECT_6b_a_CR_between_tokens_shifts_the_viewers_line_numbers(self):
        """A row with a bare \\r between two tokens is one good row to imd-flop, and the damaged line after it is
        "ledger line 2". The lane splits the row at the \\r into two unreadable halves and calls the damaged line
        line 3, so the holder is sent to the wrong line. Right: one good row, and one unreadable row naming
        ledger line 2."""
        text = json.dumps(row(1), separators=(",", ":")).replace(',"seat"', ',\r"seat"') + "\n" + "not json\n"
        rows = lane_bytes(text.encode())
        self.assertEqual(unreadable_labels(rows), ["ledger line 1", "ledger line 2", "ledger line 3"])

    def test_DEFECT_6c_a_line_of_only_a_unit_separator_should_be_unreadable_as_in_imd_flop(self):
        """imd-flop skips a line only when JavaScript's trim() leaves it empty; \\x1f is not JavaScript whitespace,
        so a line holding only it is "ledger line 2 cannot be read" and every call is refused. Python's
        str.strip() removes \\x1f (and \\x1c to \\x1e, \\x85), so read_ledger skips the line as blank and the lane
        shows nothing wrong. Right: the viewer's blank test is JavaScript's (or JSON's own whitespace)."""
        rows = lane_bytes(json.dumps(row(1)).encode() + b"\n\x1f\n")
        self.assertEqual(unreadable_labels(rows), [])
        self.assertEqual(len(rows), 1)

    def test_DEFECT_7_a_sent_line_under_a_request_id_with_a_space_should_be_flagged_unplaced(self):
        """imd-flop (ledger.ts isRequestId) keeps every line whose request id is not 1 to 128 printable ASCII
        characters as its own entry: the sent line "a b" (charge 0.186) cannot be placed, and the next call is
        refused naming ledger line 1. read_ledger groups by present() (any non empty string), keeps only the latest
        line, a refusal, and unplaced() lets a refusal through: no row says a line cannot be placed. Right: the
        lane groups by the same request id rule, so the sent line is its own row flagged
        "ledger row cannot be placed in a total (request_id)"."""
        sent = row(1, request_id="a b", state="sent")
        refused = dict(sent, state="refused_local", cap_charge=0, reason="nothing sent")
        rows, _ = lane([sent, refused], {})
        self.assertEqual(len(rows), 1)
        self.assertFalse(any(f.startswith(UNPLACED) for r in rows for f in r["spend_flags"]))

    def test_DEFECT_3_a_revived_row_booked_again_should_stay_flagged(self):
        """The ledger imd-flop writes for DEFECT 3: cap 0.3, A released by "nothing was sent", B admitted, a trusted
        read brings A's hold back (reason PAST_ADMITTED), then a later read settles A at 0.05 with no raise: the
        new latest row's reason is recomputed without the mark. The day is 0.396 of 0.3. The lane reads the latest
        row only, so A is no longer flagged and not bad. Right: once a request was booked past what the cap
        admitted, the lane keeps flagging it (imd-flop keeps the mark on later rows, or the lane reads the
        request's history)."""
        a = dict(LED, request_id="a", job="jA", daily_cap=0.3, per_call_cap=0.3)
        b = dict(LED, request_id="b", job="jB", daily_cap=0.3, per_call_cap=0.3)
        ledger = [a, dict(a, state="refused_local", cap_charge=0, reason="nothing sent: child key mint failed"),
                  b, dict(b, state="estimated"), dict(a, state="estimated", cap_charge=0.198, reason=PAST_ADMITTED),
                  dict(a, state="settled", spend=0.05, cap_charge=0.198, reason=None)]
        rows, _ = lane(ledger, {"a": dict(REC, request_id="a", job="jA", state="settled", settled=0.05),
                                "b": dict(REC, request_id="b", job="jB")})
        by = {r["label"]: r for r in rows}
        self.assertNotIn(PAST_ADMITTED, by["jA"]["spend_flags"])
        self.assertFalse(by["jA"]["bad"])

    def test_DEFECT_8_an_invalid_UTF8_byte_inside_a_string_aborts_the_whole_rebuild(self):
        """imd-flop reads ledger.jsonl with readFileSync(..., "utf8"), which replaces an invalid byte with U+FFFD:
        a row with such a byte inside its model string parses and counts (imd-flop/test/review-hold-2.test.ts,
        DEFECT 8). read_ledger decodes while it iterates, outside its try, so UnicodeDecodeError escapes from_files
        and no lane is built ("one bad entry never aborts the lane" is false). Right: the line is read (as
        imd-flop does) or shown as one unreadable row, and the rest of the lane is built."""
        good = json.dumps(row(1)).encode() + b"\n"
        bad = json.dumps(row(2, model="m-X")).encode().replace(b"m-X", b"m-\xff") + b"\n"
        with self.assertRaises(UnicodeDecodeError):
            lane_bytes(good + bad)


if __name__ == "__main__":
    unittest.main()
