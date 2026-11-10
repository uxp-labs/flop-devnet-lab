#!/usr/bin/env python3
"""Byte-identical row snapshots for Sonar's 24-case viewer matrix (fixtures/c7-matrix.json).

Each snapshot is the HTML build-lane.py renders today (3ae1cdf) for one ledger row and its receipt file.
Current behavior, not intent: cases marked known_defect (19-G6, KD-1) are pinned as they render today and
carry a target that is not asserted. KD-5 (reservation wording) labels every held row (see contract/rules.json known_defects). Offline: build-lane.py is exec'd on temp dirs via lane_harness.lane."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "testlib"))
import contract_vectors as cv  # noqa: E402
from lane_harness import lane  # noqa: E402

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

    def test_known_defect_snapshots_are_labelled(self):
        """A snapshot that pins a known defect says so: status known_defect, known defect ids, and a target.
        Every key_expired case pins KD-1 (build-lane.py's failed-read test skips key_expired), and every snapshot
        with today's 'reservation <amount>' line pins KD-5 (FIXER's wording is 'reservation held <amount>')."""
        defect_ids = {d["id"] for d in cv.rules()["known_defects"]}
        for case in load()["cases"]:
            with self.subTest(case["id"]):
                rf = case["receipt_file"]
                if rf is not None and "merge" in rf and rf["merge"].get("flag") == "key_expired":
                    self.assertIn("KD-1", case.get("defects", []), f"{case['id']} pins KD-1's output but is not labelled")
                if '<span class="k">reservation</span>' in (HERE / case["snapshot"]).read_text():
                    self.assertIn("KD-5", case.get("defects", []), f"{case['id']} pins KD-5's wording but is not labelled")
                if "status" not in case:
                    self.assertNotIn("defects", case)
                    continue
                self.assertEqual(case["status"], "known_defect")
                self.assertTrue(case["defects"] and set(case["defects"]) <= defect_ids, case.get("defects"))
                self.assertIsInstance(case.get("target"), dict)
                self.assertTrue(case["target"])

    def test_rows_render_byte_identical_to_snapshots(self):
        doc = load()
        for case in doc["cases"]:
            label = f" [known defect {', '.join(case['defects'])}: pins today's output]" if case.get("status") == "known_defect" else ""
            with self.subTest(case["id"] + label):
                want = (HERE / case["snapshot"]).read_bytes()
                self.assertEqual(render_case(doc, case).encode(), want, f"{case['id']} ({case['name']}){label} differs from {case['snapshot']}")


if __name__ == "__main__":
    unittest.main()
