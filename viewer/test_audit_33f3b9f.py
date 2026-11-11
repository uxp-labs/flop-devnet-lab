#!/usr/bin/env python3
"""The second swarm audit, of commit 33f3b9f (IMD job b4e8e103), the viewer's side. One class per finding,
named with its number and severity. The rules both parts follow live in contract/ (rules.json, vectors,
fixtures), so imd-flop/test/audit-33f3b9f.test.ts is pinned by the same data. Standard library only, never
runs node. Offline."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lane_harness import load_lane  # noqa: E402

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


if __name__ == "__main__":
    unittest.main()
