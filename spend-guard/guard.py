#!/usr/bin/env python3
"""FLOP spend guard v0, dry run only. Calls just the free estimate endpoint."""
import argparse, json, math, sys, time, urllib.request
BASE = "https://api.flop.network/v1"
TEMPLATE_PAD = 20  # measured: Qwen chat wrap 23 tok vs 3 raw for "Be brief.\nHi"

def estimate(model, prompt, max_tokens):
    req = urllib.request.Request(f"{BASE}/models/estimate", method="POST",
        data=json.dumps({"model": model, "prompt": prompt, "max_tokens": max_tokens}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "uxp-labs-flop-spend-guard/0 (+https://github.com/uxp-labs)"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

def json_number(value):
    """Finite int or float. Booleans and other types are not amounts."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value

def nonnegative_count(value):
    """Finite nonnegative integer count. Rejects bools, fractions, and other types."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return False
    return value >= 0

def classify_receipt(r):
    """Report the receipt state as given. A null spend stays null (blank), never 0."""
    s = r.get("settled_spend")
    return {"request_id": r.get("request_id"), "state": r.get("state"),
            "reserved": r.get("reserved_spend"),
            "settled": s,  # None stays None: blank, never 0
            "stage": "gateway observed",
            "chain_final": False,  # terminal_event may be pooled; not proof of finality
            "terminal_event": r.get("terminal_event")}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen/qwen2.5-0.5b-instruct")
    ap.add_argument("--system", default="")
    ap.add_argument("--user", required=True)
    ap.add_argument("--max-tokens", type=int, default=8)
    ap.add_argument("--cap", type=float, required=True)
    a = ap.parse_args()
    prompt = (a.system + "\n" if a.system else "") + a.user
    try:
        e = estimate(a.model, prompt, a.max_tokens)
    except Exception as ex:  # fail closed: no quote, no send
        e = {"error": str(ex)}
    if not isinstance(e, dict):
        e = {}
    raw = json_number(e.get("estimated_cost_flop"))
    tin, tout = e.get("estimated_input_tokens"), e.get("estimated_output_tokens")
    padded = None
    # A usable quote is a finite cost above zero and two nonnegative integer counts.
    if raw is not None and raw > 0 and nonnegative_count(tin) and nonnegative_count(tout):
        total = int(tin) + int(tout)
        if total > 0:
            per_tok = raw / total
            candidate = round(raw + TEMPLATE_PAD * per_tok, 6)
            if json_number(candidate) is not None and candidate > 0:
                padded = candidate
    cap = json_number(a.cap)
    # A negative CLI max-tokens is not a send. Zero is not a separate refusal:
    # a valid padded quote can still would_send when max-tokens is 0.
    decision = "would_send" if a.max_tokens >= 0 and cap is not None and cap > 0 and padded is not None and padded <= cap else "refused_local"
    rec = {"ts": int(time.time()), "model": a.model, "max_tokens": a.max_tokens,
           "quote_raw": raw, "quote_padded": padded, "cap": cap,
           "decision": decision, "mode": "dry_run", "spend": 0 if decision == "refused_local" else "not_sent"}
    line = json.dumps(rec, allow_nan=False)
    with open("ledger.jsonl", "a") as f: f.write(line + "\n")
    print(json.dumps(rec, indent=1, allow_nan=False))

if __name__ == "__main__":
    main()
