#!/usr/bin/env python3
"""receipts.py prints strict JSON rows and is never stopped by what strict JSON cannot carry (issue 18).

A receipt holding a number that is not finite (1e999 is valid JSON text and decodes to infinity), or a body
nested too deep to read, used to end the tracker with a traceback: no error row, and the receipts after the
bad one were never printed. The same held for the saved file given with --last-known.

Offline: one loopback server on 127.0.0.1 that answers with the raw bytes of each case, so the real parser
reads them. Nothing leaves the machine. The key is a made up string."""
import contextlib
import http.server
import io
import json
import runpy
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import guard  # noqa: E402

RECEIPTS = HERE / "receipts.py"
SECRET = "sk-SYNTHETIC-NOT-A-KEY"
GOOD = '{"request_id":"good-row","state":"settled","settled_spend":0.01,"reserved_spend":0.02}'
BAD = '{"request_id":"bad-row","state":"estimated","settled_spend":null,"terminal_event":{"value":1e999}}'


def server(status, raw):
    class Raw(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = raw.encode()
            self.send_response(status); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        def log_message(self, *a):
            pass
    srv = http.server.HTTPServer(("127.0.0.1", 0), Raw)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def run_receipts(status, raw, last_known=None):
    """Run the tool as a script against one raw answer. Returns (its stdout, the exception it ended with or None)."""
    srv = server(status, raw)
    try:
        with tempfile.TemporaryDirectory(prefix="receipts-output-") as tmp:
            kf = Path(tmp) / "key.json"
            kf.write_text(json.dumps({"api_key": SECRET}))
            argv = ["receipts.py", "--key-file", str(kf)]
            if last_known is not None:
                lk = Path(tmp) / "last.json"
                if last_known != "MISSING": lk.write_text(last_known)
                argv += ["--last-known", str(lk)]
            saved = (guard.BASE, sys.argv[:])
            guard.BASE, sys.argv = f"http://127.0.0.1:{srv.server_port}/v1", argv
            out, raised = io.StringIO(), None
            try:
                with contextlib.redirect_stdout(out):
                    runpy.run_path(str(RECEIPTS), run_name="__main__")
            except BaseException as e:  # a traceback or a sys.exit is exactly what must not happen
                raised = e
            finally:
                guard.BASE, sys.argv[:] = saved[0], saved[1]
                urllib.request.install_opener(None)
            return out.getvalue(), raised
    finally:
        srv.shutdown(); srv.server_close()


def strict_rows(text):
    """Each printed line as strict JSON: a constant such as Infinity or NaN fails the test."""
    def no_constant(name):
        raise AssertionError(f"the output holds {name}, which is not strict JSON")
    return [json.loads(line, parse_constant=no_constant) for line in text.splitlines()]


class ReceiptsStrictOutput(unittest.TestCase):
    def test_a_receipt_with_a_number_that_is_not_finite_is_one_error_row_and_the_rest_still_print(self):
        for raw, where in ((f"[{BAD},{GOOD}]", "first"), (f"[{GOOD},{BAD},{GOOD}]", "middle"), (f'{{"receipts":[{GOOD},{BAD}]}}', "last")):
            with self.subTest(where=where):
                out, raised = run_receipts(200, raw)
                self.assertIsNone(raised, f"the tracker ended with {raised!r}")
                rows = strict_rows(out)
                self.assertEqual(len(rows), raw.count("request_id"), "one row for each receipt, the bad one included")
                bad = [r for r in rows if r.get("error")]
                self.assertEqual(bad, [{"http": 200, "error": "non_finite_number", "state": None, "request_id": "bad-row"}])
                good = [r for r in rows if not r.get("error")]
                self.assertTrue(all(r["request_id"] == "good-row" and r["state"] == "settled" and r["settled"] == 0.01 for r in good))
                self.assertNotIn(SECRET, out)

    def test_the_error_row_never_reports_a_spend_and_never_zero(self):
        out, raised = run_receipts(200, '[{"request_id":"r","state":"settled","settled_spend":0.5,"terminal_event":[1e999]}]')
        self.assertIsNone(raised)
        (row,) = strict_rows(out)
        self.assertEqual(row, {"http": 200, "error": "non_finite_number", "state": None, "request_id": "r"})
        self.assertNotIn("settled", row)

    def test_a_receipt_id_that_is_not_a_string_is_not_copied_into_the_error_row(self):
        for rid in ("1e999", '{"a":1e999}', "[1,2]", "12"):
            with self.subTest(rid=rid):
                out, raised = run_receipts(200, f'[{{"request_id":{rid},"terminal_event":-1e999}}]')
                self.assertIsNone(raised)
                self.assertEqual(strict_rows(out), [{"http": 200, "error": "non_finite_number", "state": None, "request_id": None}])

    def test_a_non_finite_number_anywhere_in_what_a_row_copies(self):
        for field in ('"request_id":1e999', '"state":-1e999', '"terminal_event":{"a":{"b":[0,1e999]}}'):
            with self.subTest(field=field):
                out, raised = run_receipts(200, f"[{{{field}}},{GOOD}]")
                self.assertIsNone(raised)
                rows = strict_rows(out)
                self.assertEqual([r.get("error") for r in rows], ["non_finite_number", None])

    def test_a_spend_that_is_not_finite_stays_an_invalid_spend_as_before(self):
        out, raised = run_receipts(200, '[{"request_id":"r","state":"settled","settled_spend":1e999}]')
        self.assertIsNone(raised)
        (row,) = strict_rows(out)
        self.assertIsNone(row["settled"])
        self.assertEqual(row["invalid"], ["settled_spend"])
        self.assertNotIn("error", row)

    def test_a_body_nested_too_deep_to_read_is_one_error_row(self):
        out, raised = run_receipts(200, "[" * 200000 + "]" * 200000)
        self.assertIsNone(raised, f"the tracker ended with {raised!r}")
        row = json.loads(out, parse_constant=lambda name: self.fail(f"the output holds {name}"))  # this row is indented
        self.assertEqual(row, {"http": None, "error": "RecursionError", "state": None})

    def test_a_saved_file_that_cannot_be_used_is_named_and_the_row_still_prints(self):
        cases = (('{"request_id":"old","terminal_event":{"value":1e999}}', "non_finite_number"),
                 ("{not json", "JSONDecodeError"), ("MISSING", "FileNotFoundError"), ("[" * 200000, "RecursionError"))
        for saved, why in cases:
            with self.subTest(why=why):
                out, raised = run_receipts(401, '{"error":"api_key_expired"}', last_known=saved)
                self.assertIsNone(raised, f"the tracker ended with {raised!r}")
                row = json.loads(out, parse_constant=lambda name: self.fail(f"the output holds {name}"))
                self.assertEqual(row, {"http": 401, "error": "api_key_expired", "state": None, "flag": "key_expired", "last_known": None, "last_known_error": why})

    def test_control_a_good_saved_file_is_shown_as_before(self):
        out, raised = run_receipts(401, '{"error":"api_key_expired"}', last_known='{"request_id":"old","state":"settled","settled_spend":0.25}')
        self.assertIsNone(raised)
        row = json.loads(out)
        self.assertEqual(row["last_known"], {"request_id": "old", "state": "settled", "settled_spend": 0.25})
        self.assertNotIn("last_known_error", row)

    def test_control_large_integers_and_unicode_are_untouched(self):
        raw = '[{"request_id":"r-\\u00e9-\\ud83d\\ude00","state":"settled","settled_spend":0.01,"terminal_event":{"block":123456789012345678901234567890,"n":1e308}}]'
        out, raised = run_receipts(200, raw)
        self.assertIsNone(raised)
        (row,) = strict_rows(out)
        self.assertNotIn("error", row)
        self.assertEqual(row["terminal_event"], {"block": 123456789012345678901234567890, "n": 1e308})
        self.assertEqual(row["request_id"], "r-é-\U0001F600")


if __name__ == "__main__":
    unittest.main()
