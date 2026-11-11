#!/usr/bin/env python3
"""viewer (build-lane.py) against the shared contract (contract/rules.json, contract/vectors/*.json).

Current behavior at 3ae1cdf, not intent. build-lane.py is exec'd into a namespace on temp dirs, as
test_audit_v7.lane does. Offline."""
import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "testlib"))
import contract_vectors as cv  # noqa: E402
from lane_harness import LED, REC, greens, lane, load_lane, visible  # noqa: E402

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


RESERVATION_LINE = re.compile(r'<div><span class="k">(reservation[^<]*)</span> (.*?)</div>')
CAP_CHARGE_LINE = re.compile(r'<div><span class="k">(cap charge)</span> (.*?)</div>')


def line_text(i, pattern):
    """The visible text of the row's first line whose key matches pattern, or "absent"."""
    rid = i["ledger"]["request_id"]
    _, html = lane([i["ledger"]], {} if i["receipt"] is None else {rid: i["receipt"]})
    m = pattern.findall(html)
    return {"line": f"{m[0][0]} {visible(m[0][1])}" if m else "absent"}


def reservation_line(i):
    """The visible text of the row's reservation line ("reservation 0.186 (held)"), or "absent"."""
    return line_text(i, RESERVATION_LINE)


def cap_charge_line(i):
    """The visible text of the row's cap charge line ("cap charge 0.3 (<ledger reason>)"), or "absent"."""
    return line_text(i, CAP_CHARGE_LINE)


# classify() kinds in the four words reconcile.json uses. Every kind decided before the comparison is "not_compared".
COMPARED = {"disagree": "disagree", "settled_unknown": "settled_unknown", "matches": "agree", "over_limit": "agree"}


def reconcile(i):
    """What the viewer decides for a ledger row and its receipt file (None: no file). For a compared pair,
    disagrees() and settled_unknown() are also asked directly and must give the same verdict."""
    e, r = i["ledger"], i["receipt"]
    kind, _ = NS["classify"](e, r)
    verdict = COMPARED.get(kind, "not_compared")
    if kind in COMPARED:
        direct = "disagree" if NS["disagrees"](e, r) else "settled_unknown" if NS["settled_unknown"](e, r) else "agree"
        assert direct == verdict, f"classify says {kind}, disagrees()/settled_unknown() say {direct}"
    return {"verdict": verdict}


ADAPTERS = {"amount.json": amount_json, "receipt.state": receipt_state, "identity": identity, "read.failed": read_failed, "viewer.label": label,
            "viewer.reservation_line": reservation_line, "viewer.cap_charge_line": cap_charge_line, "reconcile": reconcile}


class ContractVectors(unittest.TestCase):
    def test_constants_match_rules_json(self):
        c = RULES["constants"]
        self.assertEqual(NS["DISAGREE"], c["DISAGREE"]["value"])
        self.assertEqual(NS["IDENTITY"], c["IDENTITY"]["value"])
        self.assertEqual(list(NS["SETTLES"]), c["SETTLES"]["value"])
        # unresolved() holds its own literal. It must name exactly the states rules.json lists.
        for state in c["UNRESOLVED"]["value"]:
            self.assertTrue(NS["unresolved"]({"state": state}), state)
        for state in ["sent", "refused_local", *c["RECEIPT_STATES"]["value"]]:
            self.assertFalse(NS["unresolved"]({"state": state}), state)

    def test_reconcile_vectors_expect_the_same_verdict_from_imd_flop_and_the_viewer(self):
        """Except where a quirk says why not: then the two expectations must differ."""
        shared = [v for v in cv.vectors() if v["rule"] == "reconcile"]
        self.assertGreater(len(shared), 0)
        for v in shared:
            with self.subTest(v["id"]):
                if v.get("quirks"):
                    self.assertNotEqual(v["expect"][PART], v["expect"]["imd-flop"])
                else:
                    self.assertEqual(v["expect"][PART], v["expect"]["imd-flop"])

    def test_contract_files_are_well_formed_and_every_quirk_is_pinned(self):
        cv.vectors()
        self.assertEqual(cv.unreferenced_quirks(), [])

    def test_every_fixer_label_rule_is_referenced_by_a_vector(self):
        self.assertEqual(cv.unreferenced_label_rules(), [])

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
