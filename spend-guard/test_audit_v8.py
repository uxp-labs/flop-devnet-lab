#!/usr/bin/env python3
"""Fail-first regression for v8 item 5 (Sonar Py-I11 partial, guard.py:91 at 716819c).

--max-tokens above MAX_TOKEN_COUNT (10,000,000) can never get a usable quote (tout must be >= max_tokens
and <= MAX_TOKEN_COUNT), and a cap below 1e-6 can never pass (the padded quote is rounded up to at least
1e-6). Both are locally decidable, so they must be refused before the estimate request, as v7d does for
negative max-tokens and caps <= 0. guard.py runs through test_guard_numeric.run_guard (stubbed urlopen).
"""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from test_guard_numeric import KEYS, run_guard, strict_load  # noqa: E402


def guard(body, args):
    proc, ledger, counts = run_guard(body, "1", ["--user", "Hi", *args])
    rec = strict_load(proc.stdout) if proc.stdout.strip() else None
    row = strict_load(ledger) if ledger.strip() else None
    return proc, rec, row, counts.get("urlopen", 0)


def best_quote(tout):
    return {"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": tout}


TINY = {"estimated_cost_flop": 1e-8, "estimated_input_tokens": 3, "estimated_output_tokens": 8}


class I11FollowUpTests(unittest.TestCase):
    def test_PY_V8_I11_max_tokens_above_10M_and_caps_below_1e6_skip_the_estimate(self):
        cases = [
            (best_quote(10_000_000), ["--max-tokens", "10000001", "--cap", "1"], 10_000_001, 1.0),
            (best_quote(10_000_001), ["--max-tokens", "10000001", "--cap", "1"], 10_000_001, 1.0),
            (best_quote(2 ** 40), ["--max-tokens", "10000001", "--cap", "1"], 10_000_001, 1.0),
            (best_quote(10 ** 12), ["--max-tokens", str(10 ** 12), "--cap", "1"], 10 ** 12, 1.0),
            (TINY, ["--max-tokens", "8", "--cap", "5e-7"], 8, 5e-7),
            (TINY, ["--max-tokens", "8", "--cap", "9.99e-7"], 8, 9.99e-7),
            (TINY, ["--max-tokens", "8", "--cap", "1e-7"], 8, 1e-7),
            (TINY, ["--max-tokens", "8", "--cap", "5e-324"], 8, 5e-324),
        ]
        for body, args, max_tokens, cap in cases:
            with self.subTest(args=" ".join(args), tout=body["estimated_output_tokens"]):
                proc, rec, row, n = guard(body, args)
                self.assertEqual(n, 0, "estimate must not be requested for a locally decidable refusal")
                self.assertEqual(proc.returncode, 3, proc.stderr)
                self.assertIsNotNone(rec, proc.stderr)
                self.assertEqual(list(rec), KEYS)
                self.assertEqual(row, rec, "the refused_local row is still written to the ledger")
                self.assertEqual(rec["decision"], "refused_local")
                self.assertEqual((rec["max_tokens"], rec["cap"]), (max_tokens, cap))
                self.assertIsNone(rec["quote_raw"])
                self.assertIsNone(rec["quote_padded"])
                self.assertEqual(rec["spend"], 0)

    def test_PY_V8_I11_boundary_controls_still_request_one_estimate(self):
        for body, args in ((best_quote(10_000_000), ["--max-tokens", "10000000", "--cap", "1"]),
                           (TINY, ["--max-tokens", "8", "--cap", "1e-6"])):
            with self.subTest(args=" ".join(args)):
                proc, rec, row, n = guard(body, args)
                self.assertEqual(n, 1)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(rec["decision"], "would_send")
                self.assertEqual(row, rec)


if __name__ == "__main__":
    unittest.main()
