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
    """review defect 1 (medium), fixed: an amount on the grid has its exact count of millionths
    (floor(x * 1e6 + 0.5) when that gives back the same double), and the viewer decides over in integers with
    imd-flop's expression. Rows imd-flop admitted at their cap show left 0 and no flag. The other two triples
    came from a random run of 20000 triples, where 43 used to split."""

    TRIPLES = [(16385.147313, 0, 16385.147313), (586607958.833559, 517124896.785768, 69483062.047791),
               (929138013.233559, 372990546.663973, 556147466.569586)]

    def test_review_defect_1_fixed_grid_amounts_have_their_exact_numerator(self):
        self.assertEqual(NS["ceil_micro"](16385.147313), 16385147313)
        self.assertEqual(NS["floor_micro"](16385.147313), 16385147313)

    def test_review_defect_1_fixed_rows_imd_flop_admitted_are_not_flagged(self):
        for cap, spent, charge in self.TRIPLES:
            with self.subTest(cap=cap, spent=spent, charge=charge):
                e = dict(LED, daily_cap=cap, per_call_cap=cap, spent_before=spent, cap_charge=charge, quote_padded=charge)
                applied = NS["spend_limit"](e)
                self.assertNotIn(NS["OVER_DAILY"], NS["limit_flags"](e, applied))
                self.assertEqual([left for lim, left in applied if lim["key"] == "daily_left"], [0])


class Defect1Properties(unittest.TestCase):
    """review defect 1, fixed: every random triple in contract/fixtures/cap-triples gets the shared answer, the same
    file imd-flop/test/review-audit2.test.ts checks, so the two readers agree on every one."""

    def test_review_defect_1_fixed_random_triples(self):
        doc = json.loads((HERE.parent / "contract" / "fixtures" / "cap-triples" / "triples.json").read_text())
        self.assertEqual(len(doc["triples"]), 2000)
        bad = []
        for cap, spent, charge, over, left, _room in doc["triples"]:
            e = dict(LED, daily_cap=cap, per_call_cap=cap, spent_before=spent, cap_charge=charge, quote_padded=charge)
            applied = NS["spend_limit"](e)
            got = ([l for lim, l in applied if lim["key"] == "daily_left"][0], NS["OVER_DAILY"] in NS["limit_flags"](e, applied))
            if got != (left, over): bad.append((cap, spent, charge, got))
        self.assertEqual(bad[:3], [])

    def test_review_defect_1_fixed_no_round_half_to_even(self):
        """0.5 millionths sits half way: floor(x * 1e6 + 0.5) and Python's round() differ there. It is off the grid
        either way, and rounds to the next step outward."""
        self.assertEqual((NS["ceil_micro"](2.5e-06), NS["floor_micro"](2.5e-06)), (3, 2))
        self.assertEqual(NS["grid_micro"](2.5e-06), None)


class Defect8(unittest.TestCase):
    """review defect 8 (info), fixed: receipt files follow the depth rule. Every file in
    contract/fixtures/receipt-text is read as the lane reads receipts; imd-flop checks the same files."""

    def test_review_defect_8_fixed_receipt_fixtures(self):
        import shutil, tempfile
        d = HERE.parent / "contract" / "fixtures" / "receipt-text"
        files = json.loads((d / "expectations.json").read_text())["files"]
        self.assertEqual(sorted(p.name for p in d.iterdir() if p.name != "expectations.json"), sorted(files))
        for name, want in files.items():
            with self.subTest(name):
                with tempfile.TemporaryDirectory() as tmp:
                    shutil.copy(d / name, Path(tmp, "r1.json"))
                    old = sys.argv
                    sys.argv = ["build-lane.py", tmp]
                    try:
                        got = load_lane()["read_receipts"]()["r1"]
                    finally:
                        sys.argv = old
                self.assertEqual(not got.get("_unreadable", False), want["readable"])

    def test_review_defect_8_fixed_a_deep_receipt_is_unreadable_and_a_shallow_one_is_read(self):
        deep = '{"request_id":"req-1","job":"j","seat":"1234","did":"did:key:z","state":"settled","settled":0.198,"x":' + "[" * 10000 + "]" * 10000 + "}"
        shallow = deep.replace("[" * 10000 + "]" * 10000, "[[1]]")
        chips = lambda receipt: lane([dict(LED, state="settled", spend=0.198)], {"req-1": receipt})[0][0]["chips"]
        self.assertNotIn(["red", "unreadable"], chips(shallow))
        self.assertIn(["red", "unreadable"], chips(deep))


class Defect11(unittest.TestCase):
    """review defect 11 (low), fixed: the viewer reads a lone surrogate escape as U+FFFD, so its page builds, and it
    writes the page to a temporary file in the same folder and renames it, so the old page is never emptied."""

    def build(self, line):
        import shutil, tempfile
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "ledger.jsonl").write_text(line + "\n")
            page = Path(tmp, "index.html")
            shutil.copy(NS["VIEWER"], page)
            old = sys.argv
            sys.argv = ["build-lane.py", tmp]
            try:
                ns = load_lane()
                ns["VIEWER"] = str(page)
                ns["main"]()
                return page.read_text(encoding="utf-8"), sorted(p.name for p in Path(tmp).iterdir())
            finally:
                sys.argv = old

    def test_review_defect_11_fixed_a_lone_surrogate_in_a_reason_shows_ufffd_and_the_page_builds(self):
        reason = "nothing sent: eth_chainId error: " + "z" * 199 + "\\ud83d[cut]"
        line = json.dumps(dict(LED, state="refused_local", request_id=None, cap_charge=0, reason=None))[:-1] + ', "reason": "' + reason + '"}'
        self.assertEqual(NS["read_ledger_text"](line.encode())[0][2]["reason"], reason.replace("\\ud83d", "\ufffd"))
        page, files = self.build(line)
        self.assertIn("z\ufffd[cut]", page)
        self.assertEqual(files, ["index.html", "ledger.jsonl"])

    def test_review_defect_11_fixed_a_failed_write_leaves_the_old_page_whole(self):
        import shutil, tempfile
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "ledger.jsonl").write_text(json.dumps(LED) + "\n")
            page = Path(tmp, "index.html")
            shutil.copy(NS["VIEWER"], page)
            before = page.read_bytes()
            old = sys.argv
            sys.argv = ["build-lane.py", tmp]
            try:
                ns = load_lane()
                ns["VIEWER"] = str(page)
                real_replace = ns["os"].replace
                def failing(*a):
                    raise OSError("disk full")
                ns["os"].replace = failing
                try:
                    with self.assertRaises(OSError):
                        ns["main"]()
                finally:
                    ns["os"].replace = real_replace
            finally:
                sys.argv = old
            self.assertEqual(page.read_bytes(), before)
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), ["index.html", "ledger.jsonl"])


if __name__ == "__main__":
    unittest.main()
