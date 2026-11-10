#!/usr/bin/env python3
"""Byte-identical row snapshots for Sonar's 24-case viewer matrix (fixtures/c7-matrix.json).

Each snapshot is the HTML build-lane.py renders today (3ae1cdf) for one ledger row and its receipt file.
Current behavior, not intent: cases marked known_defect are pinned as they render today (see
contract/rules.json known_defects). Offline: build-lane.py is exec'd on temp dirs via test_audit_v7.lane."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from test_audit_v7 import lane  # noqa: E402

FIXTURE = HERE / "fixtures" / "c7-matrix.json"
SNAPDIR = HERE / "snapshots" / "c7-matrix"


def load():
    return json.loads(FIXTURE.read_text())


def render_case(doc, case):
    """The rendered row HTML for one case (exactly what build-lane.py writes into the lane)."""
    led = dict(doc["base_ledger"], **case["ledger"])
    rf = case["receipt_file"]
    receipts = {} if rf is None else {led["request_id"]: rf["raw"] if "raw" in rf else dict(doc["base_receipt"], **rf["merge"])}
    rows, html = lane([led], receipts)
    assert len(rows) == 1, case["id"]
    return html


class C7MatrixSnapshot(unittest.TestCase):
    def test_fixture_has_the_24_cases_and_one_snapshot_each(self):
        doc = load()
        ids = [c["id"] for c in doc["cases"]]
        self.assertEqual(len(ids), 24)
        self.assertEqual(len(set(ids)), 24)
        self.assertEqual(sorted(p.name for p in SNAPDIR.glob("*.html")), sorted(f"{i}.html" for i in ids))

    def test_rows_render_byte_identical_to_snapshots(self):
        doc = load()
        for case in doc["cases"]:
            with self.subTest(case["id"]):
                want = (HERE / case["snapshot"]).read_bytes()
                self.assertEqual(render_case(doc, case).encode(), want, f"{case['id']} ({case['name']}) differs from {case['snapshot']}")


if __name__ == "__main__":
    unittest.main()
