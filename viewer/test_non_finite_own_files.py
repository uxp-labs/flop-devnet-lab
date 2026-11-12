#!/usr/bin/env python3
"""Non-finite numbers in the files imd-flop wrote (brief 2026-11-11, non-finite reads, step 3), the viewer's side:
what read_ledger_text and read_receipts do with 1e999 and -1e999, and with the bare words NaN, Infinity and
-Infinity (Python's json accepts those, JavaScript's JSON.parse does not). imd-flop's side is
imd-flop/test/non-finite-own-files.test.ts on the same bytes. Both readers agree today, so these tests pin what
both do and nothing was changed. Standard library only, never runs node. Offline."""
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lane_harness import load_lane  # noqa: E402

NS = load_lane()
WORDS = ["1e999", "-1e999", "NaN", "Infinity", "-Infinity"]
# The same five lines as imd-flop/test/non-finite-own-files.test.ts LINES.
LINES = [f'{{"request_id":"r{i}","seat":"9001","state":"estimated","cap_charge":{n}}}' for i, n in enumerate(WORDS, 1)]
# The same receipt files as imd-flop/test/non-finite-own-files.test.ts RECEIPTS.
RECEIPTS = {f"r{i}": f'{{"request_id":"r{i}","seat":"9001","job":"j","state":"settled","settled":{n}}}' for i, n in enumerate(WORDS, 1)}


class NonFiniteOwnFiles(unittest.TestCase):
    def setUp(self):
        self.lines = NS["read_ledger_text"](("\n".join(LINES) + "\n").encode())

    def test_a_ledger_line_with_1e999_is_a_readable_row_whose_number_is_not_a_known_amount(self):
        self.assertEqual([kind for _, kind, _ in self.lines[:2]], ["row", "row"])
        self.assertEqual([NS["amount"](row["cap_charge"]) for _, _, row in self.lines[:2]], [None, None])

    def test_a_ledger_line_with_the_bare_word_nan_or_infinity_is_unreadable_not_valid_json(self):
        self.assertEqual(self.lines[2:], [(3, "unreadable", "not valid JSON"), (4, "unreadable", "not valid JSON"), (5, "unreadable", "not valid JSON")])

    def test_a_receipt_file_with_1e999_is_readable_and_one_with_nan_or_infinity_is_unreadable(self):
        with tempfile.TemporaryDirectory() as tmp:
            for rid, text in RECEIPTS.items():
                Path(tmp, f"{rid}.json").write_text(text)
            old = sys.argv
            sys.argv = ["build-lane.py", tmp]
            try:
                got = load_lane()["read_receipts"]()
            finally:
                sys.argv = old
        readable = sorted(rid for rid, r in got.items() if not r.get("_unreadable"))
        self.assertEqual(readable, ["r1", "r2"])
        self.assertEqual([NS["amount"](got[rid]["settled"]) for rid in readable], [None, None])
        self.assertEqual(sorted(rid for rid, r in got.items() if r.get("_unreadable")), ["r3", "r4", "r5"])


if __name__ == "__main__":
    unittest.main()
