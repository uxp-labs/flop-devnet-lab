#!/usr/bin/env python3
"""spend-guard against the shared contract (contract/rules.json, contract/vectors/*.json).

Current behavior at 3ae1cdf, not intent. guard.py runs through guard_harness.run_guard (stubbed
urlopen, sockets blocked); receipts.py runs in-process with get() replaced. Offline."""
import argparse
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "testlib"))
import contract_vectors as cv  # noqa: E402
import guard  # noqa: E402
import receipts  # noqa: E402
from guard_harness import run_guard, strict_load  # noqa: E402

PART = "spend-guard"


def guard_cli(estimate, args):
    proc, ledger, counts = run_guard(estimate, "1", ["--user", "Hi", *args])
    rec = strict_load(proc.stdout) if proc.stdout.strip() else None
    return proc.returncode, rec, counts.get("urlopen", 0)


def quote_pad(i):
    code, rec, _ = guard_cli(i["estimate"], ["--max-tokens", str(i["max_tokens"]), "--cap", "1000"])
    return {"decision": rec["decision"], "quote_padded": rec["quote_padded"]}


def cap_compare(i):
    code, rec, _ = guard_cli(i["estimate"], ["--max-tokens", str(i["max_tokens"]), "--cap", i["cap"]])
    return {"decision": rec["decision"]}


def amount_text(i):
    try:
        return {"accepted": True, "value": guard.cap_arg(i["text"])}
    except argparse.ArgumentTypeError:
        return {"accepted": False}


def amount_json(i):
    return {"spend_amount": guard.spend_amount(i["value"]), "json_number": guard.json_number(i["value"])}


def amount_reserved(i):
    out = guard.classify_receipt({"request_id": "r", "reserved_spend": i["value"]})
    return {"reserved": out["reserved"], "invalid": "reserved_spend" in out.get("invalid", [])}


def max_tokens(i):
    code, rec, estimates = guard_cli({"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8},
                                     [f"--max-tokens={i['text']}", "--cap", "1"])
    if code == 2:
        return {"outcome": "usage_error"}
    if estimates == 0:
        assert code == 3 and rec["decision"] == "refused_local", (code, rec)
        return {"outcome": "refused_before_estimate"}
    return {"outcome": "estimate_requested"}


def receipt_state(i):
    return {"state": guard.classify_receipt({"request_id": "r", "state": i["state"]})["state"]}


def read_failed(i):
    http, error = i["http"], i["error"]
    body = None if i["body"] == "null" else {"request_id": "r", "state": "estimated"}
    if http is None:
        reply = (None, {}, error)
    elif http == 200:
        reply = (200, body, None)
    else:
        reply = (http, {"error": error}, None)
    with tempfile.TemporaryDirectory() as tmp:
        kf = Path(tmp, "key")
        kf.write_text("sk_synthetic_not_a_key")
        out = io.StringIO()
        with mock.patch.object(receipts, "get", return_value=reply), mock.patch.object(sys, "argv", ["receipts.py", "--key-file", str(kf), "--request-id", "r"]), contextlib.redirect_stdout(out):
            receipts.main()
    row, _ = json.JSONDecoder().raw_decode(out.getvalue().strip())  # the first printed row (failure rows are indented)
    return {"failed": "http" in row}


ADAPTERS = {"quote.pad": quote_pad, "cap.compare": cap_compare, "amount.text": amount_text, "amount.json": amount_json,
            "amount.reserved": amount_reserved, "max_tokens": max_tokens, "receipt.state": receipt_state, "read.failed": read_failed}


class ContractVectors(unittest.TestCase):
    def test_constants_match_rules_json(self):
        c = cv.rules()["constants"]
        self.assertEqual(guard.TEMPLATE_PAD, c["TEMPLATE_PAD"]["value"])
        self.assertEqual(guard.MAX_TOKEN_COUNT, c["MAX_TOKEN_COUNT"]["value"])
        self.assertEqual(guard.MIN_CAP, c["MIN_CAP"]["value"])
        self.assertEqual(guard.EXIT_REFUSED, c["EXIT"][PART]["refused_local"])
        self.assertEqual(guard.classify_receipt({})["stage"], c["STAGE_GATEWAY"]["value"])
        self.assertEqual(c["MAX_TOKENS_RANGE"][PART], [0, guard.MAX_TOKEN_COUNT])

    def test_contract_files_are_well_formed_and_every_quirk_is_pinned(self):
        cv.vectors()  # raises on a malformed file
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
