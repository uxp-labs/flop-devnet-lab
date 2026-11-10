#!/usr/bin/env python3
"""viewer (build-lane.py) against the shared contract (contract/rules.json, contract/vectors/*.json).

Current behavior at 3ae1cdf, not intent. build-lane.py is exec'd into a namespace on temp dirs, as
test_audit_v7.lane does. Offline."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "contract"))
import contract_vectors as cv  # noqa: E402
from test_audit_v7 import LED, REC, greens, lane, visible  # noqa: E402
from test_lane_disagree import load_lane  # noqa: E402

PART = "viewer"
NS = load_lane()
RULES = cv.rules()
DISAGREE = RULES["constants"]["DISAGREE"]["value"]
FAILED_READ_FLAG = "receipt read failed, can't re-check"


def amount_json(i):
    return {"amount": NS["amount"](i["value"])}


def receipt_state(i):
    return {"settles": i["state"] in NS["SETTLES"]}


def identity(i):
    return {"diff": NS["identity_diff"](i["receipt"], i["ledger"])}


def read_failed(i):
    rec = dict(REC, http=i["http"], error=i["error"], flag=i["flag"])
    rows, _ = lane([dict(LED)], {"req-1": rec})
    return {"failed": FAILED_READ_FLAG in rows[0]["flags"]}


def label(i):
    rid = i["ledger"]["request_id"]
    rows, html = lane([i["ledger"]], {} if i["receipt"] is None else {rid: i["receipt"]})
    (row,) = rows
    chips = [[c, "DISAGREE" if t == DISAGREE else t] for c, t in (row["chips"] or [])]
    res = [v for k, v in row["flop"] if k == "reservation"]
    return {"chips": chips, "reservation": res[0] if res else "absent", "matches_shown": "matches" in visible(html),
            "greens": greens(html), "link": row["link"]}


ADAPTERS = {"amount.json": amount_json, "receipt.state": receipt_state, "identity": identity, "read.failed": read_failed, "viewer.label": label}


class ContractVectors(unittest.TestCase):
    def test_constants_match_rules_json(self):
        c = RULES["constants"]
        self.assertEqual(NS["DISAGREE"], c["DISAGREE"]["value"])
        self.assertEqual(NS["IDENTITY"], c["IDENTITY"]["value"])
        self.assertEqual(list(NS["SETTLES"]), c["SETTLES"]["value"])

    def test_contract_files_are_well_formed_and_every_quirk_is_pinned(self):
        cv.vectors()
        self.assertEqual(cv.unreferenced_quirks(), [])

    def test_vectors(self):
        applicable, skipped = cv.for_part(PART)
        self.assertGreater(len(applicable), 0)
        for v in applicable:
            with self.subTest(v["id"]):
                self.assertIn(v["rule"], ADAPTERS, f"{v['id']}: expectation for {PART} but no adapter for rule {v['rule']}")
                got = ADAPTERS[v["rule"]](cv.decode(v["input"]))
                want = cv.decode(v["expect"][PART])
                self.assertTrue(cv.same(got, want), f"{v['file']}:{v['id']}: got {got!r}, contract says {want!r}")
        # Vectors tagged not_applicable for this part carry their reason in the file (checked by cv.vectors()).
        self.assertEqual(len(applicable) + len(skipped), len(cv.vectors()))


if __name__ == "__main__":
    unittest.main()
