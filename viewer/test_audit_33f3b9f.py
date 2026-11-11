#!/usr/bin/env python3
"""The second swarm audit, of commit 33f3b9f (IMD job b4e8e103), the viewer's side. One class per finding,
named with its number and severity. The rules both parts follow live in contract/ (rules.json, vectors,
fixtures), so imd-flop/test/audit-33f3b9f.test.ts is pinned by the same data. Standard library only, never
runs node. Offline."""
import json
import random
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lane_harness import LED, load_lane  # noqa: E402

NS = load_lane()
CONTRACT = HERE.parent / "contract"
FIXTURES = CONTRACT / "fixtures" / "ledger-text"


class Finding2Low(unittest.TestCase):
    """Every row starts on a fresh line: the bytes the writer leaves after a torn last line read as the torn line
    (unreadable, under its own number) and the new row, whole, on the next line."""

    def test_torn_line_then_row(self):
        lines = NS["read_ledger_text"]((FIXTURES / "torn-line-then-row.jsonl").read_bytes())
        self.assertEqual([(n, kind) for n, kind, _ in lines], [(1, "row"), (2, "unreadable"), (3, "row")])
        self.assertEqual(lines[2][2]["request_id"], "r3")


class Finding4Medium(unittest.TestCase):
    """One spelling per seat: the viewer's seat rule is contract/rules.json SEAT_ID, as imd-flop's isSeatId is. The
    placement vectors placement-seat-* in contract/vectors/ledger-placement.json pin both parts on whole rows."""
    MAX = "9" * 63  # moved (review defect 9): the most digits a seat may have, was 2^256 - 1

    def test_canonical_seats_only(self):
        usable = NS["unplaced"]
        row = dict(request_id="req-1", day="2026-11-11", provider="mock", payer="holder", state="settled", cap_charge=0.1)
        for seat in ("unassigned", "0", "7", "42", self.MAX):
            self.assertEqual(usable(dict(row, seat=seat)), [], seat)
        for seat in ("042", "00", "0042", "", "-1", "4 2", "42\n", "1" + "0" * 63, str(2 ** 256 - 1), str(2 ** 256), "9" * 5000, 42, None):
            self.assertEqual(usable(dict(row, seat=seat)), ["seat"], repr(seat)[:20])

    def test_rule_is_read_from_rules_json(self):
        rule = json.loads((CONTRACT / "rules.json").read_text())["constants"]["SEAT_ID"]["value"]
        self.assertEqual(NS["SEAT_ID"].pattern, rule["digits"])
        self.assertEqual(NS["SEAT_MAX_DIGITS"], rule["max_digits"])
        self.assertEqual(NS["SEAT_PLACEHOLDER"], rule["placeholder"])


class Finding8Low(unittest.TestCase):
    """A nesting limit in the ledger text contract. The byte fixtures depth-*.jsonl are read by both parts
    (test_ledger_text.py here, test/ledger-text.test.ts in imd-flop); these are the audit's own cases."""

    @staticmethod
    def deep(levels):
        return ('{"request_id":"r1","cap_charge":1,"x":' + "[" * (levels - 1) + "]" * (levels - 1) + "}\n").encode()

    def test_the_audits_line_is_nested_too_deep(self):
        self.assertEqual(NS["read_ledger_text"](self.deep(9998)), [(1, "unreadable", "nested too deep")])

    def test_the_limit_is_read_from_rules_json(self):
        rules = json.loads((CONTRACT / "rules.json").read_text())["constants"]["LEDGER_TEXT"]["value"]
        self.assertEqual(NS["MAX_DEPTH"], rules["max_depth"])
        self.assertEqual(NS["read_ledger_text"](self.deep(32))[0][1], "row")
        self.assertEqual(NS["read_ledger_text"](self.deep(33)), [(1, "unreadable", "nested too deep")])

    def test_depth_is_counted_on_the_text(self):
        read = NS["read_ledger_text"]
        self.assertEqual(read(b"[" * 33 + b"\n"), [(1, "unreadable", "nested too deep")])
        self.assertEqual(read(b"[" * 32 + b"\n"), [(1, "unreadable", "not valid JSON")])
        self.assertEqual(read(('{"a":"' + "[" * 100 + '\\"' + "{" * 100 + '"}\n').encode())[0][1], "row")


class Finding5Low(unittest.TestCase):
    """AMOUNT_MAX is 1e9 FLOP: up to it every amount on the 6 decimal grid is its own double, and scaling by 1e6
    lands within 0.5 of the exact integer, so the grid survives the float."""

    def test_amount_max_is_1e9_from_rules_json(self):
        rules = json.loads((CONTRACT / "rules.json").read_text())["constants"]
        self.assertEqual(NS["AMOUNT_MAX"], 1_000_000_000)
        self.assertEqual(NS["AMOUNT_MAX"], rules["AMOUNT_MAX"]["value"])
        self.assertEqual(NS["amount"](1e9), 1e9)
        self.assertIsNone(NS["amount"](1000000000.000001))
        self.assertIsNone(NS["amount"](17179869184))

    def test_property_grid_survives_the_float(self):
        """For random integers k up to 1e15, the double nearest k / 1e6 scales back to k by rounding to nearest."""
        rng = random.Random(33)
        ks = [0, 1, 999_999, 1_000_000, 10 ** 15 - 1, 10 ** 15] + [rng.randint(0, 10 ** 15) for _ in range(200_000)]
        self.assertEqual([k for k in ks if round((k / 1e6) * 1e6) != k][:3], [])

    def test_integer_numerators(self):
        self.assertEqual(NS["ceil_micro"](0.186), 186000)
        self.assertEqual(NS["floor_micro"](0.1859999), 185999)
        rng = random.Random(5)
        for _ in range(10_000):
            n = rng.random() * 1e9
            self.assertEqual(NS["floor6"](n), NS["floor_micro"](n) / 1e6)

    def test_integers_above_amount_max_still_read_as_ints_up_to_2_53(self):
        """The ledger text reads a JSON integer as JavaScript does. Keeping it an int up to 2^53 - 1 is about what a
        double holds exactly, not about AMOUNT_MAX: the new bound does not change how numbers are read."""
        self.assertEqual(NS["loads"]("[5000000000, 9007199254740991]"), [5000000000, 9007199254740991])
        self.assertIsInstance(NS["loads"]("5000000000"), int)


class Finding9Low(unittest.TestCase):
    """The viewer decides a row's daily cap with imd-flop's expression: left = floor6(cap - spent), and the row is
    over when its cap charge is above left. The triples are in contract/vectors/cap-compare.json (cap.daily_left)."""

    def test_the_audits_triple(self):
        e = dict(LED, daily_cap=8197.132493, per_call_cap=8197.132493, spent_before=4169.158419, cap_charge=4027.974074, quote_padded=4027.974074)
        applied = NS["spend_limit"](e)
        self.assertEqual([left for _, left in applied], [0])
        self.assertNotIn(NS["OVER_DAILY"], NS["limit_flags"](e, applied))


if __name__ == "__main__":
    unittest.main()
