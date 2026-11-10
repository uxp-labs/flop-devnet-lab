#!/usr/bin/env python3
"""Shared spend-guard test harness (test code only; not a test module).

run_guard(body, cap, extra_args) runs guard.py as __main__ in a child process whose
urllib.request.urlopen returns `body` as the estimate and whose socket connects are counted and
blocked. It returns (proc, ledger_text, counts). strict_load parses JSON and rejects NaN/Infinity.
KEYS is the guard's record key order. The child re-executes this file with GUARD_TEST_CHILD=1."""
import json
import os
import runpy
import socket
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

GUARD = Path(__file__).resolve().parent / "guard.py"
HERE = Path(__file__).resolve()
KEYS = ["ts", "model", "max_tokens", "quote_raw", "quote_padded", "cap", "decision", "mode", "spend"]


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


if os.environ.get("GUARD_TEST_CHILD") == "1" and __name__ == "__main__":
    child_main()
