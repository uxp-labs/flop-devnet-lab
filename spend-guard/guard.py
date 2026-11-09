#!/usr/bin/env python3
"""FLOP spend guard v0, dry run only. Calls just the free estimate endpoint."""
import argparse, json, sys, time, urllib.request
BASE = "https://api.flop.network/v1"
TEMPLATE_PAD = 20  # measured: Qwen chat wrap 23 tok vs 3 raw for "Be brief.\nHi"

def estimate(model, prompt, max_tokens):
    req = urllib.request.Request(f"{BASE}/models/estimate", method="POST",
        data=json.dumps({"model": model, "prompt": prompt, "max_tokens": max_tokens}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "uxp-labs-flop-spend-guard/0 (+https://github.com/uxp-labs)"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

def classify_receipt(r):
    """Report the receipt state as given. A null spend stays unknown."""
    s = r.get("settled_spend")
    return {"request_id": r.get("request_id"), "state": r.get("state"),
            "reserved": r.get("reserved_spend"),
            "settled": "unknown" if s is None else s,
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
    raw = e.get("estimated_cost_flop")
    tin, tout = e.get("estimated_input_tokens", 0), e.get("estimated_output_tokens", 0)
    per_tok = raw / (tin + tout) if raw and (tin + tout) else None
    padded = round(raw + TEMPLATE_PAD * per_tok, 6) if per_tok else None
    decision = "refused_local" if padded is None or padded > a.cap else "would_send"
    rec = {"ts": int(time.time()), "model": a.model, "max_tokens": a.max_tokens,
           "quote_raw": raw, "quote_padded": padded, "cap": a.cap,
           "decision": decision, "mode": "dry_run", "spend": 0 if decision == "refused_local" else "not_sent"}
    with open("ledger.jsonl", "a") as f: f.write(json.dumps(rec) + "\n")
    print(json.dumps(rec, indent=1))

if __name__ == "__main__":
    main()
