#!/usr/bin/env python3
"""The ledger text contract (review fixes 4, items 6 to 8), the viewer's side. Every byte fixture in
contract/fixtures/ledger-text/ is read as the lane reads ledger.jsonl (build-lane.py read_ledger_text and
group_key, which read_ledger uses), and checked against expectations.json: the line count, the blank lines, the
unreadable lines with why, the groups, and each readable row's cap_charge as an amount. imd-flop's side is
imd-flop/test/ledger-text.test.ts on the same files. Standard library only, never runs node. Offline."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lane_harness import LED, load_lane  # noqa: E402

NS = load_lane()
DIR = HERE.parent / "contract" / "fixtures" / "ledger-text"
EXPECT = json.loads((DIR / "expectations.json").read_text())["fixtures"]
RULES = json.loads((HERE.parent / "contract" / "rules.json").read_text())["constants"]


def observe(name):
    """What the viewer reads in one fixture, in the expectation file's shape."""
    lines = NS["read_ledger_text"]((DIR / name).read_bytes())
    groups = {}
    for n, kind, value in lines:
        if kind == "row":
            groups.setdefault(NS["group_key"](value, n), []).append(n)
    return {"lines": len(lines),
            "blank": [n for n, kind, _ in lines if kind == "blank"],
            "unreadable": [{"line": n, "why": value} for n, kind, value in lines if kind == "unreadable"],
            "groups": [[k, v] for k, v in groups.items()],
            "charges": {str(n): NS["amount"](value.get("cap_charge")) for n, kind, value in lines if kind == "row"}}


class LedgerText(unittest.TestCase):
    def test_every_fixture_file_has_an_expectation(self):
        files = sorted(p.name for p in DIR.iterdir() if p.name != "expectations.json")
        self.assertEqual(files, sorted(EXPECT))
        self.assertGreaterEqual(len(files), 22)

    def test_the_blank_set_and_request_id_are_read_from_rules_json(self):
        self.assertEqual(sorted(ord(c) for c in NS["BLANK_CHARS"]), sorted(RULES["LEDGER_TEXT"]["value"]["blank"]))
        self.assertEqual(NS["REQUEST_ID_RULE"].pattern, RULES["REQUEST_ID"]["value"])

    def test_every_fixture(self):
        for name, want in EXPECT.items():
            with self.subTest(name):
                expected = {k: v for k, v in want.items() if k != "note"}
                self.assertEqual(observe(name), expected)

    def test_the_lane_uses_the_reader(self):
        """read_ledger goes through read_ledger_text: an invalid UTF-8 byte inside a string no longer aborts the
        rebuild (finding 8), and the unreadable row names the line the contract gives it."""
        good = json.dumps(LED).encode() + b"\n"
        bad = json.dumps(dict(LED, request_id="req-2", model="m-X")).encode().replace(b"m-X", b"m-\xff") + b"\n"
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "ledger.jsonl").write_bytes(good + bad + b"not json\n")
            old, sys.argv = sys.argv, ["build-lane.py", tmp]
            try:
                rows = load_lane()["from_files"]()
            finally:
                sys.argv = old
        self.assertEqual(len(rows), 3)
        self.assertEqual([r["label"] for r in rows if "unreadable: not shown as OK" in r["flags"]], ["ledger line 3"])


if __name__ == "__main__":
    unittest.main()
