#!/usr/bin/env python3
"""Fail-first regressions for the open infos of IMD audit 355a3703 (spend-guard at 288a03e).

Each test asserts the SAFE outcome, so it fails on 87130f8 and passes after the fix.
guard.py runs through guard_harness.run_guard (stubbed urlopen, sockets blocked).
"""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from guard_harness import KEYS, run_guard, strict_load  # noqa: E402

Q = {"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8}


def guard(*args):
    """Returns (proc, stdout record or None, ledger record or None, urlopen count)."""
    proc, ledger, counts = run_guard(Q, "1", list(args))
    rec = strict_load(proc.stdout) if proc.stdout.strip() else None
    row = strict_load(ledger) if ledger.strip() else None
    return proc, rec, row, counts.get("urlopen", 0)


class OpenInfoTests(unittest.TestCase):
    # 355a3703 info #11: inputs that can never send are refused before the estimate request.
    def test_PY_I11_locally_decidable_refusals_skip_the_estimate(self):
        cases = [
            (["--max-tokens", "-5", "--cap", "1"], -5, 1.0),
            (["--max-tokens", "-1", "--cap", "1"], -1, 1.0),
            (["--max-tokens", "8", "--cap", "0"], 8, 0.0),
            (["--max-tokens", "8", "--cap", "-1"], 8, -1.0),
            (["--max-tokens", "8", "--cap", "nan"], 8, None),
            (["--max-tokens", "8", "--cap", "inf"], 8, None),
            (["--max-tokens", "8", "--cap", "1e400"], 8, None),
        ]
        for args, max_tokens, cap in cases:
            with self.subTest(args=" ".join(args)):
                proc, rec, row, n = guard("--user", "Hi", *args)
                self.assertEqual(n, 0, "estimate must not be requested for a locally decidable refusal")
                self.assertIsNotNone(rec, proc.stderr)
                self.assertEqual(list(rec), KEYS)
                self.assertEqual(row, rec, "the refused_local row is still written to the ledger")
                self.assertEqual(rec["decision"], "refused_local")
                self.assertEqual((rec["max_tokens"], rec["cap"]), (max_tokens, cap))
                self.assertIsNone(rec["quote_raw"])
                self.assertIsNone(rec["quote_padded"])
                self.assertEqual(rec["mode"], "dry_run")

    def test_PY_I11_control_valid_inputs_still_request_one_estimate(self):
        for args, decision in ((["--max-tokens", "8", "--cap", "1"], "would_send"),
                               (["--max-tokens", "0", "--cap", "1"], "would_send"),
                               (["--max-tokens", "8", "--cap", "0.05"], "refused_local")):
            with self.subTest(args=" ".join(args)):
                proc, rec, row, n = guard("--user", "Hi", *args)
                self.assertEqual(n, 1)
                self.assertEqual(rec["decision"], decision)
                self.assertEqual(rec["quote_raw"], 0.066)
                self.assertEqual(rec["quote_padded"], 0.186)
                self.assertEqual(row, rec)

    # 355a3703 info #12: a refusal must be visible in the exit status, and spend must stay numeric.
    def test_PY_I12_refused_local_exits_3_and_would_send_exits_0(self):
        cases = [
            (["--max-tokens", "8", "--cap", "0.05"], "refused_local", 3),   # over cap after the estimate
            (["--max-tokens", "-5", "--cap", "1"], "refused_local", 3),     # refused before the estimate
            (["--max-tokens", "8", "--cap", "nan"], "refused_local", 3),
            (["--max-tokens", "8", "--cap", "1"], "would_send", 0),
        ]
        for args, decision, code in cases:
            with self.subTest(args=" ".join(args)):
                proc, rec, row, _n = guard("--user", "Hi", *args)
                self.assertEqual(rec["decision"], decision)
                self.assertEqual(row, rec)
                self.assertEqual(proc.returncode, code, proc.stderr)

    def test_PY_I12_unusable_estimate_refusal_exits_3(self):
        proc, ledger, counts = run_guard("not a quote", "1")
        self.assertEqual(counts.get("urlopen"), 1)
        rec = strict_load(proc.stdout)
        self.assertEqual(rec["decision"], "refused_local")
        self.assertEqual(proc.returncode, 3, proc.stderr)

    def test_PY_I12_spend_is_the_same_numeric_type_on_every_row(self):
        for cap in ("1", "0.05", "0"):
            with self.subTest(cap=cap):
                proc, rec, row, _n = guard("--user", "Hi", "--max-tokens", "8", "--cap", cap)
                self.assertIs(type(rec["spend"]), int)
                self.assertEqual(rec["spend"], 0, "dry run: nothing is sent, so spend is 0 on every row")
                self.assertEqual(row["spend"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
