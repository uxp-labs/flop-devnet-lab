#!/usr/bin/env python3
"""FLOP spend guard v0, dry run only. Calls just the free estimate endpoint."""
import argparse, json, math, re, sys, time, urllib.request
from fractions import Fraction
BASE = "https://api.flop.network/v1"
TEMPLATE_PAD = 20  # measured: Qwen chat wrap 23 tok vs 3 raw for "Be brief.\nHi"
MAX_TOKEN_COUNT = 10_000_000  # above any model context; a larger count is not a plausible quote
CAP_RE = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[+-]?(?:nan|inf|infinity)", re.ASCII | re.IGNORECASE)

def estimate(model, prompt, max_tokens):
    req = urllib.request.Request(f"{BASE}/models/estimate", method="POST",
        data=json.dumps({"model": model, "prompt": prompt, "max_tokens": max_tokens}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "uxp-labs-flop-spend-guard/0 (+https://github.com/uxp-labs)"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

def json_number(value):
    """Finite int or float. Booleans, non-numbers, and values too large for a float are not amounts."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, int):
        try:
            as_float = float(value)
        except OverflowError:
            return None
        if not math.isfinite(as_float):
            return None
        return value
    if not math.isfinite(value):
        return None
    return value

def nonnegative_count(value):
    """Finite nonnegative integer count. Rejects bools, fractions, and other types."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return False
    return value >= 0 and value <= MAX_TOKEN_COUNT

def ceil6(x):
    """Round up to 6 decimals; a value already on a 1e-6 boundary (within float noise) stays put."""
    scaled = x * 1e6
    nearest = round(scaled)
    if abs(scaled - nearest) <= 1e-6:
        return nearest / 1e6
    return math.ceil(scaled) / 1e6

def cap_arg(text):
    """--cap: an ASCII decimal amount only. Underscores, non-ASCII digits and whitespace are typos, not amounts.
    nan/inf spellings pass through to the existing refusal (cap null, refused_local)."""
    if not isinstance(text, str) or not CAP_RE.fullmatch(text):
        raise argparse.ArgumentTypeError(f"invalid cap {text!r}: use a plain decimal amount such as 0.25")
    return float(text)

def spend_amount(value):
    """A spend is a finite number >= 0 (not a bool). Anything else is unknown: None, never coerced."""
    n = json_number(value)
    return n if n is not None and n >= 0 else None

def classify_receipt(r):
    """Report the receipt state as given. A null or invalid spend stays null (blank), never 0."""
    if not isinstance(r, dict):
        return {"request_id": None, "state": None, "reserved": None, "settled": None, "stage": "gateway observed",
                "chain_final": False, "terminal_event": None, "error": "receipt is not an object"}
    s, rs = r.get("settled_spend"), r.get("reserved_spend")
    out = {"request_id": r.get("request_id"), "state": r.get("state"),
           "reserved": spend_amount(rs),
           "settled": spend_amount(s),  # None stays None: blank, never 0
           "stage": "gateway observed",
           "chain_final": False,  # terminal_event may be pooled; not proof of finality
           "terminal_event": r.get("terminal_event")}
    invalid = [k for k, v in (("settled_spend", s), ("reserved_spend", rs)) if v is not None and spend_amount(v) is None]
    if invalid:
        out["invalid"] = invalid  # the gateway sent a value that is not an amount
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen/qwen2.5-0.5b-instruct")
    ap.add_argument("--system", default="")
    ap.add_argument("--user", required=True)
    ap.add_argument("--max-tokens", type=int, default=8)
    ap.add_argument("--cap", type=cap_arg, required=True)
    a = ap.parse_args()
    prompt = (a.system + "\n" if a.system else "") + a.user
    cap = json_number(a.cap)
    # A negative max-tokens or a cap that is not a finite amount above 0 can never send, whatever the
    # quote says. Refuse before the estimate so the prompt does not leave the machine for nothing.
    if a.max_tokens < 0 or cap is None or cap <= 0:
        e = None
    else:
        try:
            e = estimate(a.model, prompt, a.max_tokens)
        except Exception as ex:  # fail closed: no quote, no send
            e = {"error": str(ex)}
    if not isinstance(e, dict):
        e = {}
    raw = json_number(e.get("estimated_cost_flop"))
    tin, tout = e.get("estimated_input_tokens"), e.get("estimated_output_tokens")
    padded = None
    unrounded = None
    # A usable quote is a finite cost above zero and two nonnegative integer counts.
    # The cap is compared to the unrounded pad so rounding cannot sneak a quote through.
    # Overflow or a non-finite result is a malformed quote: refuse and still write the ledger.
    # The quote must cover the whole request: at least max_tokens output tokens, and at least one
    # input token for a non-empty prompt. Counts above MAX_TOKEN_COUNT are not plausible.
    # The stored quote_padded is rounded UP, and is the value compared to the cap, so a would_send
    # row never shows a padded quote above its cap and a tiny positive quote never rounds to 0.
    try:
        if (raw is not None and raw > 0 and nonnegative_count(tin) and nonnegative_count(tout)
                and int(tout) >= max(a.max_tokens, 0) and (int(tin) >= 1 or not prompt)):
            total = int(tin) + int(tout)
            if total > 0:
                per_tok = raw / total
                unrounded = float(raw) + TEMPLATE_PAD * float(per_tok)
                # A pad that vanishes in float rounding is no pad: refuse rather than compare the bare quote.
                if math.isfinite(unrounded) and unrounded > 0 and unrounded > float(raw):
                    candidate = ceil6(unrounded)
                    if json_number(candidate) is not None and candidate > 0 and candidate >= unrounded - 1e-12:
                        padded = candidate
                    else:
                        unrounded = None
                else:
                    unrounded = None
    except (OverflowError, ValueError, ArithmeticError):
        padded = None
        unrounded = None
    # Exact check too: float(raw) can round an integer quote above 2**53 down to the cap.
    try:
        raw_within_cap = raw is not None and cap is not None and Fraction(raw) <= Fraction(cap)
    except (OverflowError, ValueError, ArithmeticError):
        raw_within_cap = False
    # A negative CLI max-tokens is not a send. Zero is not a separate refusal:
    # a valid padded quote can still would_send when max-tokens is 0.
    decision = "would_send" if a.max_tokens >= 0 and cap is not None and cap > 0 and padded is not None and unrounded is not None and unrounded <= cap and padded <= cap and raw_within_cap else "refused_local"
    rec = {"ts": int(time.time()), "model": a.model, "max_tokens": a.max_tokens,
           "quote_raw": raw, "quote_padded": padded, "cap": cap,
           "decision": decision, "mode": "dry_run", "spend": 0 if decision == "refused_local" else "not_sent"}
    line = json.dumps(rec, allow_nan=False)
    with open("ledger.jsonl", "a") as f: f.write(line + "\n")
    print(json.dumps(rec, indent=1, allow_nan=False))

if __name__ == "__main__":
    main()
