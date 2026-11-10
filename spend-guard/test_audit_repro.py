#!/usr/bin/env python3
"""Reproduce-only probes for guard.py on the PR6 head. Stubbed urlopen, sockets blocked."""
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


def run_guard(body, cap):
    with tempfile.TemporaryDirectory(prefix="guard-audit-") as tmp:
        cwd = Path(tmp)
        counts_path = cwd / "counts.json"
        env = os.environ.copy()
        env["GUARD_AUDIT_CHILD"] = "1"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PROBE_BODY"] = json.dumps(body)
        env["PROBE_COUNTS"] = str(counts_path)
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            env.pop(key, None)
        proc = subprocess.run(
            [sys.executable, "-B", str(HERE), "--user", "Hi", "--max-tokens", "8", "--cap", cap],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
        )
        counts = json.loads(counts_path.read_text()) if counts_path.exists() else {}
        ledger = (cwd / "ledger.jsonl").read_text() if (cwd / "ledger.jsonl").exists() else ""
        NET["urlopen"] += counts.get("urlopen", 0)
        NET["create_connection"] += counts.get("create_connection", 0)
        NET["socket_connect"] += counts.get("socket_connect", 0)
        return proc, ledger, counts


class GuardAuditTests(unittest.TestCase):
    def test_rounding_cannot_pass_a_quote_above_the_cap(self):
        proc, ledger, counts = run_guard(
            {"estimated_cost_flop": 0.017742, "estimated_input_tokens": 3, "estimated_output_tokens": 8},
            "0.05",
        )
        self.assertEqual(counts.get("urlopen"), 1)
        self.assertEqual(counts.get("socket_connect"), 0)
        self.assertEqual(proc.returncode, 3, proc.stderr)
        rec = strict_load(proc.stdout)
        self.assertEqual(strict_load(ledger), rec)
        self.assertEqual(rec["decision"], "refused_local")
        self.assertEqual(rec["spend"], 0)
        nudged, nudged_ledger, _counts = run_guard(
            {"estimated_cost_flop": 0.0660001, "estimated_input_tokens": 3, "estimated_output_tokens": 8},
            "0.186",
        )
        self.assertEqual(nudged.returncode, 3, nudged.stderr)
        nudged_rec = strict_load(nudged.stdout)
        self.assertEqual(strict_load(nudged_ledger), nudged_rec)
        self.assertEqual(nudged_rec["decision"], "refused_local")
        self.assertEqual(nudged_rec["spend"], 0)

    def test_over_cap_finite_quote_refuses(self):
        proc, ledger, counts = run_guard(
            {"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8},
            "0.05",
        )
        self.assertEqual(counts.get("urlopen"), 1)
        self.assertEqual(proc.returncode, 3, proc.stderr)
        rec = strict_load(proc.stdout)
        self.assertEqual(rec["decision"], "refused_local")
        self.assertEqual(rec["quote_padded"], 0.186)
        self.assertTrue(ledger.strip())

    def test_large_finite_values_do_not_crash_without_a_ledger(self):
        for cost in (10**309, 10**400):
            proc, ledger, counts = run_guard(
                {"estimated_cost_flop": cost, "estimated_input_tokens": 1e308, "estimated_output_tokens": 1e308},
                "1",
            )
            self.assertEqual(counts.get("urlopen"), 1)
            self.assertEqual(counts.get("create_connection"), 0)
            self.assertEqual(counts.get("socket_connect"), 0)
            self.assertEqual(proc.returncode, 3, proc.stderr)
            self.assertNotIn("OverflowError", proc.stderr)
            self.assertTrue(ledger.endswith("\n"), "refusal must write ledger.jsonl")
            rec = strict_load(ledger)
            self.assertEqual(strict_load(proc.stdout), rec)
            self.assertEqual(rec["decision"], "refused_local")
            self.assertEqual(rec["spend"], 0)
            self.assertIsNone(rec["quote_raw"])
            self.assertIsNone(rec["quote_padded"])

    def test_ordinary_finite_quote_writes_a_ledger_row(self):
        proc, ledger, counts = run_guard(
            {"estimated_cost_flop": 0.066, "estimated_input_tokens": 3, "estimated_output_tokens": 8},
            "1",
        )
        self.assertEqual(counts.get("urlopen"), 1)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rec = strict_load(ledger)
        self.assertEqual(rec["decision"], "would_send")
        self.assertEqual(rec["spend"], 0)
        self.assertEqual(rec["quote_padded"], 0.186)


if os.environ.get("GUARD_AUDIT_CHILD") == "1":
    child_main()
elif __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(f"netAttempts {NET['urlopen']}")
    print(f"socketCreateConnectionAttempts {NET['create_connection']}")
    print(f"socketConnectAttempts {NET['socket_connect']}")
    print("counters cover this process's replaced urlopen and socket calls only, not the OS")
    sys.exit(0 if result.wasSuccessful() else 1)
