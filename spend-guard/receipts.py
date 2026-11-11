#!/usr/bin/env python3
"""Read-only receipt tracker. Reads a gateway key from a file (never prints it),
lists receipts, and reports each state as given. Null spend stays null (blank), never 0.
Every outcome, including a malformed body or a network error, is one JSON row and exit 0.
A row is strict JSON. What the gateway or a saved file holds that strict JSON cannot carry (a number that is
not finite, such as 1e999, or nesting too deep to write) never stops the tracker: that receipt, or that saved
file, is reported as an error row or field of its own, and the rows after it are still printed (issue 18).
Redirects are never followed: the gateway key would go to whatever host the Location names, so a 3xx is
reported as an error row (http 3xx, state null)."""
import argparse, json, sys, urllib.request, urllib.error
from guard import BASE, classify_receipt

KEY_FIELDS = ("api_key", "key", "token")  # exact names, in priority order

class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect; urllib then raises HTTPError with the 3xx code, which get() reports."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def get(path, key):
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {key}", "User-Agent": "uxp-labs-flop-spend-guard/0 (+https://github.com/uxp-labs)"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r: return r.status, json.load(r), None
    except urllib.error.HTTPError as e:
        try: body = json.load(e)
        except Exception: body = {}
        return e.code, body, None
    except (urllib.error.URLError, OSError, ValueError, RecursionError) as e:  # timeout, DNS, reset, unparsable or too deeply nested 200 body
        return None, {}, type(e).__name__

def read_key(path):
    """A plain-text key file is the key. A JSON key file must be an object with one of KEY_FIELDS."""
    raw = open(path).read().strip()
    try:
        j = json.loads(raw)
    except ValueError:
        return raw
    if isinstance(j, dict):
        for name in KEY_FIELDS:
            if isinstance(j.get(name), str) and j[name]:
                return j[name]
    sys.exit(f"receipts.py: key file is JSON but has no {'/'.join(KEY_FIELDS)} string field; nothing sent")

NOT_STRICT_JSON = {ValueError: "non_finite_number", RecursionError: "nested_too_deep"}

def strict_text(obj, **kw):
    """The row as strict JSON, or (None, why) when strict JSON cannot carry it. The serializer is the one
    judge, so what is printed and what is refused can never disagree."""
    try:
        return json.dumps(obj, allow_nan=False, **kw), None
    except (ValueError, RecursionError) as e:
        return None, NOT_STRICT_JSON[RecursionError if isinstance(e, RecursionError) else ValueError]

def dump(obj, fallback, **kw):
    """Print one row. When it cannot be written as strict JSON, print fallback(why) in its place: a row made
    only of values this tool wrote itself, so it always prints."""
    text, why = strict_text(obj, **kw)
    print(text if text is not None else json.dumps(fallback(why), allow_nan=False, **kw))

def unwritable_receipt(r):
    """The error row for a receipt that cannot be written. It names the receipt when its id is a string and
    carries nothing else the gateway sent. Its spend is unknown, never 0."""
    rid = r.get("request_id") if isinstance(r, dict) else None
    return lambda why: {"http": 200, "error": why, "state": None, "request_id": rid if isinstance(rid, str) else None}

def read_last_known(path):
    """The saved receipt and None, or None and why it could not be used. A file that is missing, is not JSON
    or holds what strict JSON cannot carry never stops the tracker."""
    try:
        with open(path) as f: saved = json.load(f)
    except (OSError, ValueError, RecursionError) as e:
        return None, type(e).__name__
    _, why = strict_text(saved)
    return (saved, None) if why is None else (None, why)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--key-file", required=True)
    ap.add_argument("--request-id"); ap.add_argument("--last-known", help="json file of last saved receipt")
    a = ap.parse_args(); key = read_key(a.key_file)
    urllib.request.install_opener(urllib.request.build_opener(NoRedirect))  # this CLI's HTTP policy, set once
    path = f"/keys/me/receipts/{a.request_id}" if a.request_id else "/keys/me/receipts"
    code, body, neterr = get(path, key)
    if code != 200:
        b = body if isinstance(body, dict) else {}
        err = b.get("error") if isinstance(b.get("error"), str) else None
        out = {"http": code, "error": err if code is not None else neterr, "state": None}
        if err == "api_key_expired": out["flag"] = "key_expired"
        if a.last_known:
            out["last_known"], why = read_last_known(a.last_known)
            if why is not None: out["last_known_error"] = why
        # http, error and flag are a number, a string from a strict parse, or values written here.
        dump(out, lambda why: {"http": code, "error": why, "state": None}, indent=1); return
    if isinstance(body, list): rows = body
    elif isinstance(body, dict):
        rows = body.get("receipts", body.get("data", [body]))
        if not isinstance(rows, list): rows = [rows]
    else: rows = [body]
    if not rows: return
    for r in rows:
        if isinstance(r, dict): dump(classify_receipt(r), unwritable_receipt(r))
        else: dump({"http": 200, "error": "receipt is not an object", "state": None}, unwritable_receipt(r))

if __name__ == "__main__": main()
