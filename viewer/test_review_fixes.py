#!/usr/bin/env python3
"""Independent review of the review fixes at 7f57b4b: viewer findings. Each expectedFailure test fails at
7f57b4b and is marked so the suite stays green; when the defect is fixed it starts to pass and unittest
reports an unexpected success, and the marker must be removed.

R10 (low): the viewer and imd-flop read the same ledger and receipt text differently when an amount is an
integer above 2^53. Python's json keeps such an integer exact; JavaScript's JSON.parse rounds it to the
nearest double. So spend 9007199254740993 beside settled 9007199254740992 is a disagreement in the viewer
(classify kind disagree) and an agreement in imd-flop (reconcile agree, both parse to 9007199254740992).
The imd-flop verdict is computed by running node on imd-flop/dist/settlement.js (built by npm test), on
the very same text. Offline."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lane_harness import load_lane  # noqa: E402

NS = load_lane()
IMD = HERE.parent / "imd-flop"
COMPARED = {"disagree": "disagree", "settled_unknown": "settled_unknown", "matches": "agree", "over_limit": "agree"}

ROW = ('{"ts":"2026-11-11T15:00:00Z","request_id":"req-1","job":"j1","seat":"9001","did":"did:key:zA","provider":"mock",'
       '"network":"devnet","payer":"holder","state":"settled","spend":9007199254740993,"cap_charge":9007199254740993,'
       '"quote_padded":0.186,"per_call_cap":1,"daily_cap":5,"spent_before":0}')
RECEIPT = ('{"request_id":"req-1","job":"j1","seat":"9001","did":"did:key:zA","state":"settled","settled":9007199254740992,'
           '"stage":"gateway observed","chain_final":false,"flag":null,"http":200,"error":null}')


def viewer_verdict(row_text, receipt_text):
    kind, _ = NS["classify"](json.loads(row_text), json.loads(receipt_text))
    return COMPARED.get(kind, "not_compared")


def imd_flop_verdict(row_text, receipt_text):
    dist = IMD / "dist" / "settlement.js"
    if not dist.exists():
        subprocess.run(["npx", "tsc", "-p", "tsconfig.json"], cwd=IMD, check=True)
    js = ("const { reconcile } = await import(process.argv[1]);"
          "process.stdout.write(reconcile(JSON.parse(process.argv[2]), JSON.parse(process.argv[3])));")
    out = subprocess.run(["node", "--input-type=module", "-e", js, dist.as_uri(), row_text, receipt_text],
                         check=True, capture_output=True, text=True, env={**os.environ})
    return out.stdout


class ReviewFixes(unittest.TestCase):
    def test_control_same_verdict_for_ordinary_amounts(self):
        row = ROW.replace("9007199254740993", "0.07")
        receipt = RECEIPT.replace("9007199254740992", "0.05")
        self.assertEqual((viewer_verdict(row, receipt), imd_flop_verdict(row, receipt)), ("disagree", "disagree"))

    @unittest.expectedFailure
    def test_r10_integer_amounts_above_2_53_get_the_same_verdict_in_both_parts(self):
        self.assertEqual(viewer_verdict(ROW, RECEIPT), imd_flop_verdict(ROW, RECEIPT))


if __name__ == "__main__":
    unittest.main()
