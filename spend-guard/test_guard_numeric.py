#!/usr/bin/env python3
"""Offline regressions for guard.py's dry-run entrypoint.

Each case runs spend-guard/guard.py as __main__. The estimate body is returned
from a replaced urllib.request.urlopen. socket connects are counted and blocked.
netAttempts is that urlopen count only; it is not an OS-wide network proof.
receipts.py is not under test.
"""
import json
import os
import runpy
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

GUARD = Path(__file__).resolve().parent / "guard.py"
HERE = Path(__file__).resolve()
KEYS = ["ts", "model", "max_tokens", "quote_raw", "quote_padded", "cap", "decision", "mode", "spend"]
NET = {"urlopen": 0, "create_connection": 0, "socket_connect": 0}


def strict_load(text):
    return json.loads(text, parse_constant=lambda name: (_ for _ in ()).throw(ValueError(name)))


def child_main():
    counts = {"urlopen": 0, "create_connection": 0, "socket_connect": 0, "urls": []}

    def urlopen(req, timeout=None, *args, **kwargs):
        counts["urlopen"] += 1
        counts["urls"].append(getattr(req, "full_url", str(req)))
        body = os.environ["PROBE_BODY"].encode()

        class Response:
            status = 200

            def read(self, n=-1):
                return body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return Response()

    def create_connection(*args, **kwargs):
        counts["create_connection"] += 1
        raise OSError("blocked socket.create_connection")

    def connect(self, *args, **kwargs):
        counts["socket_connect"] += 1
        raise OSError("blocked socket.socket.connect")

    urllib.request.urlopen = urlopen
    socket.create_connection = create_connection
    socket.socket.connect = connect

    def dump():
        Path(os.environ["PROBE_COUNTS"]).write_text(json.dumps(counts))

    import atexit

    atexit.register(dump)
    sys.argv = [str(GUARD), *sys.argv[1:]]
    runpy.run_path(str(GUARD), run_name="__main__")


def run_guard(body, cap, extra_args=None):
    with tempfile.TemporaryDirectory(prefix="guard-reg-") as tmp:
        cwd = Path(tmp)
        counts_path = cwd / "counts.json"
        env = os.environ.copy()
        env["GUARD_TEST_CHILD"] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PROBE_BODY"] = json.dumps(body)
        env["PROBE_COUNTS"] = str(counts_path)
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            env.pop(key, None)
        args = ["--user", "Hi", "--max-tokens", "8", "--cap", cap]
        if extra_args:
            args = extra_args
        proc = subprocess.run(
            [sys.executable, "-B", str(HERE), *args],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        counts = json.loads(counts_path.read_text()) if counts_path.exists() else {}
        ledger_path = cwd / "ledger.jsonl"
        ledger_text = ledger_path.read_text() if ledger_path.exists() else ""
        return proc, ledger_text, counts


class GuardEntrypointTests(unittest.TestCase):
    def tally(self, counts, urlopen):
        NET["urlopen"] += counts.get("urlopen", 0)
        NET["create_connection"] += counts.get("create_connection", 0)
        NET["socket_connect"] += counts.get("socket_connect", 0)
        self.assertEqual(counts.get("urlopen", 0), urlopen)
        self.assertEqual(counts.get("create_connection", 0), 0)
        self.assertEqual(counts.get("socket_connect", 0), 0)
        if urlopen:
            self.assertEqual(counts.get("urls"), ["https://api.flop.network/v1/models/estimate"])
        else:
            self.assertEqual(counts.get("urls", []), [])

    def run_case(self, body, cap="1", extra_args=None):
        proc, ledger_text, counts = run_guard(body, cap, extra_args)
        self.tally(counts, 1)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        stdout = strict_load(proc.stdout)
        self.assertTrue(ledger_text.endswith("\n") and ledger_text.count("\n") == 1)
        ledger = strict_load(ledger_text)
        self.assertEqual(list(stdout), KEYS)
        self.assertEqual(list(ledger), KEYS)
        self.assertEqual(stdout["mode"], "dry_run")
        self.assertEqual(ledger, stdout)
        return stdout

    def assert_refused(self, rec, quote_raw, quote_padded, cap):
        self.assertEqual(rec["decision"], "refused_local")
        self.assertEqual(rec["spend"], 0)
        self.assertEqual(rec["quote_raw"], quote_raw)
        self.assertEqual(rec["quote_padded"], quote_padded)
        self.assertEqual(rec["cap"], cap)

    def test_finite_under_cap_would_send(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8}, "1")
        self.assertEqual(rec["decision"], "would_send")
        self.assertEqual(rec["spend"], "not_sent")
        self.assertEqual(rec["quote_raw"], 0.066)
        self.assertEqual(rec["quote_padded"], 0.186)
        self.assertEqual(rec["cap"], 1.0)

    def test_finite_over_cap_refuses(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8}, "0.05")
        self.assert_refused(rec, 0.066, 0.186, 0.05)

    def test_zero_cost_refuses(self):
        rec = self.run_case({"estimated_cost_flop": 0, "estimated_input_tokens": 3, "estimated_output_tokens": 8})
        self.assert_refused(rec, 0, None, 1.0)

    def test_missing_cost_refuses(self):
        rec = self.run_case({"estimated_input_tokens": 3, "estimated_output_tokens": 8})
        self.assert_refused(rec, None, None, 1.0)

    def test_negative_cost_refuses(self):
        rec = self.run_case({"estimated_cost_flop": -0.06, "estimated_input_tokens": 3, "estimated_output_tokens": 8}, "0.05")
        self.assert_refused(rec, -0.06, None, 0.05)

    def test_nan_cost_refuses_strict_json(self):
        rec = self.run_case({"estimated_cost_flop": float("nan"), "estimated_input_tokens": 3, "estimated_output_tokens": 8})
        self.assert_refused(rec, None, None, 1.0)

    def test_positive_infinity_cost_refuses_strict_json(self):
        rec = self.run_case({"estimated_cost_flop": float("inf"), "estimated_input_tokens": 3, "estimated_output_tokens": 8})
        self.assert_refused(rec, None, None, 1.0)

    def test_negative_infinity_cost_refuses_strict_json(self):
        rec = self.run_case({"estimated_cost_flop": float("-inf"), "estimated_input_tokens": 3, "estimated_output_tokens": 8})
        self.assert_refused(rec, None, None, 1.0)

    def test_string_cost_refuses_without_coercion(self):
        rec = self.run_case({"estimated_cost_flop": "0.066", "estimated_input_tokens": 3, "estimated_output_tokens": 8})
        self.assert_refused(rec, None, None, 1.0)

    def test_object_cost_refuses_without_coercion(self):
        rec = self.run_case({"estimated_cost_flop": {"n": 1}, "estimated_input_tokens": 3, "estimated_output_tokens": 8})
        self.assert_refused(rec, None, None, 1.0)

    def test_bool_true_cost_not_coerced(self):
        rec = self.run_case({"estimated_cost_flop": True, "estimated_input_tokens": 3, "estimated_output_tokens": 8}, "10")
        self.assert_refused(rec, None, None, 10.0)

    def test_bool_false_cost_not_stored_as_false(self):
        rec = self.run_case({"estimated_cost_flop": False, "estimated_input_tokens": 3, "estimated_output_tokens": 8})
        self.assert_refused(rec, None, None, 1.0)

    def test_negative_token_counts_refuse(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": -3, "estimated_output_tokens": -8}, "0.05")
        self.assert_refused(rec, 0.066, None, 0.05)

    def test_bool_token_not_coerced(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": True, "estimated_output_tokens": 8})
        self.assert_refused(rec, 0.066, None, 1.0)

    def test_bool_false_token_not_coerced(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": False})
        self.assert_refused(rec, 0.066, None, 1.0)

    def test_fractional_tokens_refuse(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": 1.5, "estimated_output_tokens": 8})
        self.assert_refused(rec, 0.066, None, 1.0)

    def test_string_tokens_not_coerced(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": "3", "estimated_output_tokens": 8})
        self.assert_refused(rec, 0.066, None, 1.0)

    def test_missing_input_tokens_refuse(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_output_tokens": 8})
        self.assert_refused(rec, 0.066, None, 1.0)

    def test_zero_token_counts_refuse(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": 0, "estimated_output_tokens": 0})
        self.assert_refused(rec, 0.066, None, 1.0)

    def test_nested_token_object_refuses(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": {"n": 3}, "estimated_output_tokens": 8})
        self.assert_refused(rec, 0.066, None, 1.0)

    def test_list_body_refuses(self):
        rec = self.run_case([{"estimated_cost_flop": 0.066}])
        self.assert_refused(rec, None, None, 1.0)

    def test_nan_cap_refuses_strict_json(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8}, "nan")
        self.assert_refused(rec, 0.066, 0.186, None)

    def test_inf_cap_refuses_strict_json(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8}, "inf")
        self.assert_refused(rec, 0.066, 0.186, None)

    def test_negative_cap_refuses(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8}, "-1")
        self.assert_refused(rec, 0.066, 0.186, -1.0)

    def test_empty_string_cost_refuses(self):
        rec = self.run_case({"estimated_cost_flop": "", "estimated_input_tokens": 3, "estimated_output_tokens": 8})
        self.assert_refused(rec, None, None, 1.0)

    def test_negative_cli_max_tokens_refuses(self):
        rec = self.run_case(
            {"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8},
            extra_args=["--user", "Hi", "--max-tokens", "-1", "--cap", "1"],
        )
        self.assertEqual(rec["max_tokens"], -1)
        self.assert_refused(rec, 0.066, 0.186, 1.0)

    def test_cli_max_tokens_zero_follows_the_quote(self):
        # Zero is not given a separate refusal. A valid quote can still would_send.
        rec = self.run_case(
            {"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8},
            extra_args=["--user", "Hi", "--max-tokens", "0", "--cap", "1"],
        )
        self.assertEqual(rec["max_tokens"], 0)
        self.assertEqual(rec["decision"], "would_send")
        self.assertEqual(rec["spend"], "not_sent")
        self.assertEqual(rec["quote_padded"], 0.186)

    # IMD 355a3703 finding 6: a non-empty prompt cannot cost 0 input tokens. These two cases used to
    # assert would_send (locking the defect in); they now assert the refusal.
    def test_one_sided_zero_count_refuses(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": 0, "estimated_output_tokens": 8})
        self.assert_refused(rec, 0.066, None, 1.0)

    def test_negative_zero_count_refuses(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": -0.0, "estimated_output_tokens": 8})
        self.assert_refused(rec, 0.066, None, 1.0)

    def test_integer_valued_float_counts_would_send(self):
        rec = self.run_case({"estimated_cost_flop": 0.066, "estimated_input_tokens": 3.0, "estimated_output_tokens": 8.0})
        self.assertEqual(rec["decision"], "would_send")
        self.assertEqual(rec["spend"], "not_sent")
        self.assertEqual(rec["quote_raw"], 0.066)
        self.assertEqual(rec["quote_padded"], 0.186)

    def test_malformed_cap_exits_2_without_estimate(self):
        proc, ledger_text, counts = run_guard({}, "1", ["--user", "Hi", "--max-tokens", "8", "--cap", "abc"])
        self.tally(counts, 0)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(ledger_text, "")
        self.assertIn("cap", proc.stderr)

    def test_missing_cap_exits_2_without_estimate(self):
        proc, ledger_text, counts = run_guard({}, "1", ["--user", "Hi", "--max-tokens", "8"])
        self.tally(counts, 0)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(ledger_text, "")
        self.assertIn("--cap", proc.stderr)


if os.environ.get("GUARD_TEST_CHILD") == "1":
    child_main()
elif __name__ == "__main__":
    names = sys.argv[1:]
    loader = unittest.defaultTestLoader
    suite = loader.loadTestsFromNames(names, sys.modules[__name__]) if names else loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(f"netAttempts {NET['urlopen']}")
    print(f"socketCreateConnectionAttempts {NET['create_connection']}")
    print(f"socketConnectAttempts {NET['socket_connect']}")
    print("netAttempts counts replaced urllib.request.urlopen calls in these test children only")
    print("socket counters cover socket.create_connection and socket.socket.connect in those same children")
    print("neither counter is an OS-wide network proof")
    sys.exit(0 if result.wasSuccessful() else 1)
