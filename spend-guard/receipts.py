#!/usr/bin/env python3
"""Read-only receipt tracker. Reads a gateway key from a file (never prints it),
lists receipts, and reports each state as given. Null spend stays null (blank), never 0.
Every outcome, including a malformed body or a network error, is one JSON row and exit 0."""
import argparse, json, sys, urllib.request, urllib.error
from guard import BASE, classify_receipt

KEY_FIELDS = ("api_key", "key", "token")  # exact names, in priority order

def get(path, key):
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {key}", "User-Agent": "uxp-labs-flop-spend-guard/0 (+https://github.com/uxp-labs)"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r: return r.status, json.load(r), None
    except urllib.error.HTTPError as e:
        try: body = json.load(e)
        except Exception: body = {}
        return e.code, body, None
    except (urllib.error.URLError, OSError, ValueError) as e:  # timeout, DNS, reset, unparsable 200 body
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

def dump(obj, **kw):
    print(json.dumps(obj, allow_nan=False, **kw))

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--key-file", required=True)
    ap.add_argument("--request-id"); ap.add_argument("--last-known", help="json file of last saved receipt")
    a = ap.parse_args(); key = read_key(a.key_file)
    path = f"/keys/me/receipts/{a.request_id}" if a.request_id else "/keys/me/receipts"
    code, body, neterr = get(path, key)
    if code != 200:
        b = body if isinstance(body, dict) else {}
        err = b.get("error") if isinstance(b.get("error"), str) else None
        out = {"http": code, "error": err if code is not None else neterr, "state": None}
        if err == "api_key_expired": out["flag"] = "key_expired"
        if a.last_known: out["last_known"] = json.load(open(a.last_known))
        dump(out, indent=1); return
    if isinstance(body, list): rows = body
    elif isinstance(body, dict):
        rows = body.get("receipts", body.get("data", [body]))
        if not isinstance(rows, list): rows = [rows]
    else: rows = [body]
    if not rows: return
    for r in rows:
        if isinstance(r, dict): dump(classify_receipt(r))
        else: dump({"http": 200, "error": "receipt is not an object", "state": None})

if __name__ == "__main__": main()
