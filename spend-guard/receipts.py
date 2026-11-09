#!/usr/bin/env python3
"""Read-only receipt tracker. Reads a gateway key from a file (never prints it),
lists receipts, and reports each state as given. Null spend stays unknown."""
import argparse, json, urllib.request, urllib.error
from guard import BASE, classify_receipt

def get(path, key):
    req = urllib.request.Request(BASE + path, headers={"Authorization": f"Bearer {key}", "User-Agent": "uxp-labs-flop-spend-guard/0 (+https://github.com/uxp-labs)"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try: body = json.load(e)
        except Exception: body = {}
        return e.code, body

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--key-file", required=True)
    ap.add_argument("--request-id"); ap.add_argument("--last-known", help="json file of last saved receipt")
    a = ap.parse_args(); raw = open(a.key_file).read().strip()
    try:
        j = json.loads(raw); key = next(v for k, v in j.items() if isinstance(v, str) and any(w in k.lower() for w in ("key", "token", "bearer")))
    except (ValueError, StopIteration, AttributeError): key = raw
    path = f"/keys/me/receipts/{a.request_id}" if a.request_id else "/keys/me/receipts"
    code, body = get(path, key)
    if code != 200:
        out = {"http": code, "error": body.get("error"), "state": "unknown"}
        if body.get("error") == "api_key_expired": out["flag"] = "key_expired"
        if a.last_known: out["last_known"] = json.load(open(a.last_known))
        print(json.dumps(out, indent=1)); return
    rows = body if isinstance(body, list) else body.get("receipts", body.get("data", [body]))
    for r in rows: print(json.dumps(classify_receipt(r)))

if __name__ == "__main__": main()
