#!/usr/bin/env python3
"""Fail-first regressions for IMD re-audit 355a3703 (spend-guard at 288a03e).

Each test asserts the SAFE outcome, so it fails on 288a03e and passes after fix-v7.
Names start with the judge's finding number (PY_M1 medium, PY_L2..PY_L10 low).
guard.py runs through test_guard_numeric.run_guard (stubbed urlopen, sockets blocked).
receipts.py runs in-process with urllib.request.urlopen replaced; nothing reaches the network.
"""
import contextlib
import io
import json
import os
import runpy
import socket
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from test_guard_numeric import run_guard, strict_load  # noqa: E402

RECEIPTS = HERE / "receipts.py"
Q = {"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8}


def guard(body, *args):
    """Run guard.py with explicit CLI args. Returns (proc, record or None, ledger text, urlopen count)."""
    proc, ledger, counts = run_guard(body, "1", list(args))
    rec = strict_load(proc.stdout) if proc.returncode == 0 and proc.stdout.strip() else None
    return proc, rec, ledger, counts.get("urlopen", 0)


def run_receipts(urlopen, key_text='{"api_key": "sk_synthetic_not_a_key"}', extra=()):
    """Run receipts.py as __main__ with a replaced urlopen. Returns (exit code, stdout, stderr, exception)."""
    with tempfile.TemporaryDirectory(prefix="receipts-v7-") as tmp:
        kf = Path(tmp) / "key.json"
        kf.write_text(key_text)
        saved = (urllib.request.urlopen, socket.create_connection, sys.argv[:])
        urllib.request.urlopen = urlopen
        socket.create_connection = lambda *a, **k: (_ for _ in ()).throw(OSError("blocked"))
        sys.argv = ["receipts.py", "--key-file", str(kf), *extra]
        out, err = io.StringIO(), io.StringIO()
        code, exc = 0, None
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                runpy.run_path(str(RECEIPTS), run_name="__main__")
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
        except Exception as e:  # noqa: BLE001 - the test asserts there is none
            code, exc = 1, e
        finally:
            urllib.request.urlopen, socket.create_connection, sys.argv[:] = saved[0], saved[1], saved[2]
        return code, out.getvalue(), err.getvalue(), exc


class Resp(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def ok_body(text):
    return lambda req, timeout=None: Resp(text.encode())


class SpendGuardAuditV7(unittest.TestCase):
    # ---- medium -------------------------------------------------------------------------
    def test_PY_M1_quote_with_fewer_output_tokens_than_max_tokens_refuses(self):
        cases = [
            ({"estimated_cost_flop": 0.004, "estimated_input_tokens": 3, "estimated_output_tokens": 1}, "1000", "0.05"),
            ({"estimated_cost_flop": 0.0001, "estimated_input_tokens": 3, "estimated_output_tokens": 1}, "1000000", "0.05"),
            ({"estimated_cost_flop": 0.0001, "estimated_input_tokens": 3, "estimated_output_tokens": 0}, "8", "0.05"),
        ]
        for body, mt, cap in cases:
            with self.subTest(body=body, max_tokens=mt):
                proc, rec, _ledger, n = guard(body, "--user", "Hi", "--max-tokens", mt, "--cap", cap)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(rec["decision"], "refused_local")

    def test_PY_M1_control_quote_covering_max_tokens_still_sends(self):
        _proc, rec, _ledger, _n = guard(Q, "--user", "Hi", "--max-tokens", "8", "--cap", "1")
        self.assertEqual(rec["decision"], "would_send")
        self.assertEqual(rec["quote_padded"], 0.186)

    # ---- low ----------------------------------------------------------------------------
    def test_PY_L2_integer_quote_above_2_53_cannot_pass_a_smaller_cap(self):
        cases = [
            ({"estimated_cost_flop": 9007199254740993, "estimated_input_tokens": 0, "estimated_output_tokens": 10**30}, "9007199254740992"),
            ({"estimated_cost_flop": 100000000000000008000, "estimated_input_tokens": 3, "estimated_output_tokens": 10**30}, "1e20"),
        ]
        for body, cap in cases:
            with self.subTest(cap=cap):
                proc, rec, _l, _n = guard(body, "--user", "Hi", "--max-tokens", "8", "--cap", cap)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(rec["decision"], "refused_local")

    def test_PY_L3_huge_token_counts_cannot_erase_the_pad(self):
        cases = [
            ({"estimated_cost_flop": 0.05, "estimated_input_tokens": 3, "estimated_output_tokens": 10**18}, "0.05"),
            ({"estimated_cost_flop": 0.05, "estimated_input_tokens": 1e300, "estimated_output_tokens": 8}, "0.05"),
            ({"estimated_cost_flop": 1, "estimated_input_tokens": 10**400, "estimated_output_tokens": 0}, "1"),
        ]
        for body, cap in cases:
            with self.subTest(body=str(body)[:80]):
                proc, rec, _l, _n = guard(body, "--user", "Hi", "--max-tokens", "8", "--cap", cap)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(rec["decision"], "refused_local")

    def test_PY_L4_would_send_row_never_records_quote_padded_above_cap(self):
        cases = [
            ({"estimated_cost_flop": 0.0177418, "estimated_input_tokens": 3, "estimated_output_tokens": 8}, "0.0499997"),
            ({"estimated_cost_flop": 0.06599996451612902, "estimated_input_tokens": 3, "estimated_output_tokens": 8}, "0.1859999"),
        ]
        for body, cap in cases:
            with self.subTest(cap=cap):
                proc, rec, ledger, _n = guard(body, "--user", "Hi", "--max-tokens", "8", "--cap", cap)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(strict_load(ledger), rec)
                if rec["decision"] == "would_send":
                    self.assertLessEqual(rec["quote_padded"], rec["cap"])

    def test_PY_L5_positive_quote_below_rounding_resolution_is_not_falsely_refused(self):
        body = {"estimated_cost_flop": 1e-07, "estimated_input_tokens": 3, "estimated_output_tokens": 8}
        proc, rec, _l, _n = guard(body, "--user", "Hi", "--max-tokens", "8", "--cap", "1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(rec["decision"], "would_send")
        self.assertIsNotNone(rec["quote_padded"])
        self.assertGreater(rec["quote_padded"], 0)

    def test_PY_L6_zero_input_tokens_for_a_nonempty_prompt_refuses(self):
        body = {"estimated_cost_flop": 0.004, "estimated_input_tokens": 0, "estimated_output_tokens": 1}
        proc, rec, _l, _n = guard(body, "--system", "x " * 5000, "--user", "Hi", "--max-tokens", "1", "--cap", "0.1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(rec["decision"], "refused_local")

    def test_PY_L7_cap_spellings_outside_ascii_decimal_exit_2_without_estimate(self):
        for cap in ("0_5", "1_0", "\u0661", " 1 "):
            with self.subTest(cap=cap):
                proc, rec, ledger, n = guard(Q, "--user", "Hi", "--max-tokens", "8", "--cap", cap)
                self.assertEqual((proc.returncode, n, ledger), (2, 0, ""), proc.stdout)
                self.assertIn("cap", proc.stderr)

    def test_PY_L7_control_plain_decimal_caps_still_work(self):
        for cap, expected in (("0.25", 0.25), ("1", 1.0), ("5.0", 5.0), (".5", 0.5)):
            with self.subTest(cap=cap):
                proc, rec, _l, _n = guard(Q, "--user", "Hi", "--max-tokens", "8", "--cap", cap)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(rec["cap"], expected)

    def test_PY_L8_receipts_non_object_bodies_and_network_errors_give_a_structured_row(self):
        def http_err(body):
            def f(req, timeout=None):
                raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(body))
            return f

        def url_err(req, timeout=None):
            raise urllib.error.URLError("timed out")

        cases = {
            "401 array body": http_err(b'["not","a","dict"]'),
            "200 string body": ok_body('"ok"'),
            "200 list of ints": ok_body("[1,2]"),
            "200 receipts not a list": ok_body('{"receipts":"x"}'),
            "URLError": url_err,
        }
        for name, opener in cases.items():
            with self.subTest(case=name):
                code, out, err, exc = run_receipts(opener)
                self.assertIsNone(exc, f"{name}: {exc!r}")
                self.assertEqual(code, 0, err)
                rows = [strict_load(l) for l in out.split("\n") if l.strip()] if not out.lstrip().startswith("{\n") else [strict_load(out)]
                self.assertTrue(rows, name)
                for row in rows:
                    self.assertIn("state", row)
                    self.assertIsNone(row["state"])
                    self.assertIn("error", row)

    def test_PY_L9_receipts_selects_the_api_key_field_not_key_id(self):
        seen = []

        def capture(req, timeout=None):
            seen.append(req.get_header("Authorization"))
            return Resp(b"[]")

        code, _out, err, exc = run_receipts(capture, '{"key_id": "k_123", "api_key": "sk_secret"}')
        self.assertIsNone(exc)
        self.assertEqual(code, 0, err)
        self.assertEqual(seen, ["Bearer sk_secret"])

    def test_PY_L9_receipts_refuses_a_json_array_key_file_without_sending(self):
        seen = []

        def capture(req, timeout=None):
            seen.append(req.get_header("Authorization"))
            return Resp(b"[]")

        code, _out, err, exc = run_receipts(capture, '["sk_a"]')
        self.assertIsNone(exc)
        self.assertNotEqual(code, 0)
        self.assertEqual(seen, [])
        self.assertNotIn("sk_a", err)

    def test_PY_L10_classify_receipt_rejects_nan_bool_negative_and_string_spends(self):
        from guard import classify_receipt
        for raw, field in (('{"settled_spend": NaN}', "settled"), ('{"settled_spend": false}', "settled"),
                           ('{"settled_spend": -0.432}', "settled"), ('{"reserved_spend": "0.05"}', "reserved")):
            with self.subTest(raw=raw):
                c = classify_receipt(json.loads(raw))
                self.assertIsNone(c[field])
                strict_load(json.dumps(c))  # valid strict JSON

    def test_PY_L10_receipts_output_is_strict_json_for_a_nan_spend(self):
        code, out, err, exc = run_receipts(ok_body('[{"request_id": "r1", "state": "settled", "settled_spend": NaN}]'))
        self.assertIsNone(exc)
        self.assertEqual(code, 0, err)
        row = strict_load(out.strip())
        self.assertIsNone(row["settled"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
