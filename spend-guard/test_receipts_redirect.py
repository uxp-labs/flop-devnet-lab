#!/usr/bin/env python3
"""[fix: py-low-7] receipts.py never follows a redirect, so the gateway key is never forwarded to the host a
Location names (IMD 1ad85c03 low 7). Offline: two loopback servers on 127.0.0.1, as in the finding's repro;
server A answers 302 to server B, and B records any request it gets. Nothing leaves the machine."""
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
SECRET = "sk-SECRET-123"


def serve(handler):
    srv = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Collector(http.server.BaseHTTPRequestHandler):
    seen = []

    def do_GET(self):
        Collector.seen.append({"path": self.path, "authorization": self.headers.get("Authorization")})
        body = json.dumps([{"request_id": "r1", "state": "settled", "settled_spend": 0.1, "reserved_spend": 0.1}]).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a):
        pass


def redirector(target):
    class Redirect(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302); self.send_header("Location", target); self.send_header("Content-Length", "0"); self.end_headers()

        def log_message(self, *a):
            pass
    return Redirect


def run_receipts(base):
    with tempfile.TemporaryDirectory(prefix="receipts-redirect-") as tmp:
        kf = Path(tmp) / "key.json"
        kf.write_text(json.dumps({"api_key": SECRET}))
        saved = (guard.BASE, sys.argv[:])
        guard.BASE, sys.argv = base, ["receipts.py", "--key-file", str(kf)]
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                runpy.run_path(str(RECEIPTS), run_name="__main__")
        finally:
            guard.BASE, sys.argv[:] = saved[0], saved[1]
            urllib.request.install_opener(None)  # undo the CLI's process-wide opener for later tests
        return out.getvalue()


class ReceiptsRedirect(unittest.TestCase):
    def setUp(self):
        Collector.seen = []
        self.b = serve(Collector)
        self.a = serve(redirector(f"http://localhost:{self.b.server_port}/collect"))

    def tearDown(self):
        for s in (self.a, self.b):
            s.shutdown(); s.server_close()

    def test_redirect_is_not_followed_and_the_key_is_not_forwarded(self):
        out = run_receipts(f"http://127.0.0.1:{self.a.server_port}/v1")
        self.assertEqual(Collector.seen, [], "the redirect target must receive nothing, least of all the key")
        self.assertNotIn(SECRET, out)
        row = json.loads(out)
        self.assertEqual(row["http"], 302)
        self.assertIsNone(row["state"])
        self.assertNotIn("settled", out)

    def test_control_direct_200_still_reads(self):
        out = run_receipts(f"http://127.0.0.1:{self.b.server_port}/v1")
        self.assertEqual(len(Collector.seen), 1)
        self.assertEqual(Collector.seen[0]["authorization"], f"Bearer {SECRET}")
        self.assertIn('"state": "settled"', out)


if __name__ == "__main__":
    unittest.main()
