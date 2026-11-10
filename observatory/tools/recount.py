#!/usr/bin/env python3
"""Independent recount of the FLOP Observatory census, written from RULES.md section 3.

Usage: python3 -I tools/recount.py --dir <scenario dir> --genesis <0x..> --from <n> --to <n>
Prints one JSON object. Exit 2 on unreadable input (reason on stderr).
Standard library only.
"""
import argparse
import json
import re
import stat
import os
import sys

KINDS = [
    ("escrows_opened", "hasStation", "EscrowOpened"),
    ("escrows_released", "hasStation", "EscrowReleased"),
    ("escrows_refunded", "hasStation", "EscrowRefunded"),
    ("channels_opened", "computeChannel", "ChannelOpened"),
    ("channels_settled", "computeChannel", "ChannelSettled"),
]
KIND_BY_EVENT = {(s, m): k for k, s, m in KINDS}
BLOCK_HASH = re.compile(r"0x[0-9a-f]{64}")
ACCOUNT_FIELDS = ("who", "owner", "agent", "payer")


class Unreadable(Exception):
    """The input cannot give a census. kind names why (clause 16), as the TypeScript census does:
    request, page-file, page-structure or input."""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


MAX_SAFE = 2 ** 53 - 1


def as_int(v):
    """Integer by value (RULES.md 3.1 clause 14): 1.0 is 1, 1.5 is not, a boolean never is."""
    if isinstance(v, bool):
        return None
    if isinstance(v, float) and v == v and v not in (float("inf"), float("-inf")) and v.is_integer():
        v = int(v)
    if isinstance(v, int) and -MAX_SAFE <= v <= MAX_SAFE:
        return v
    return None


def is_int(v):
    return as_int(v) is not None


def _reject_constant(name):
    # NaN, Infinity and -Infinity are not JSON (RFC 8259), so the file cannot be parsed.
    raise ValueError("%s is not valid JSON" % name)


MAX_NESTING = 64


def _shown(raw):
    # A file name byte for byte: printable ASCII as itself, every other byte (and %) as %XX, the
    # same way the TypeScript loader shows it.
    return "".join(chr(b) if 0x20 <= b < 0x7F and b != 0x25 else "%%%02X" % b for b in raw)


def _nesting(text):
    # How deep the arrays and objects nest, reading strings so a bracket inside one does not count.
    # Checked before parsing (clause 12), so Python's own recursion limit never decides.
    depth = deepest = 0
    in_string = escaped = False
    for ch in text:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch in "[{":
            depth += 1
            deepest = max(deepest, depth)
        elif ch in "]}":
            depth -= 1
    return deepest


def _parse_int(text):
    # A JSON integer far past 2^53 is no safe integer whatever its exact value (clause 14), and
    # Python refuses to convert one longer than 4300 digits. JSON.parse reads one this long as
    # Infinity, so both call it unsafe.
    if len(text.lstrip("-")) > 400:
        return float("-inf") if text.startswith("-") else float("inf")
    return int(text)


def _one_value_per_key(pairs):
    # A key that appears twice in one object has no one meaning: parsers differ on which copy
    # wins, so the file cannot be read (clause 12). Keys compare after their escapes are read.
    keys = [k for k, _ in pairs]
    for k in keys:
        if keys.count(k) > 1:
            raise ValueError("the key %s appears twice in one object" % json.dumps(k))
    return dict(pairs)


def is_regular_file(path):
    # lstat does not follow links, so a symlink is never a regular file.
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def load_pages(scenario_dir):
    if not os.path.isdir(scenario_dir):
        raise Unreadable("input", "scenario dir not found: %s" % scenario_dir)
    pages = []
    pages_dir = os.path.join(scenario_dir, "event-pages")
    names = []
    try:
        mode = os.lstat(pages_dir).st_mode
    except FileNotFoundError:
        mode = None  # no event-pages folder means no pages
    except OSError as exc:
        raise Unreadable("page-file", "event-pages: cannot stat: %s" % exc)
    if mode is not None:
        # event-pages must be a real folder, not a file or a link (lstat does not follow links).
        if not stat.S_ISDIR(mode):
            raise Unreadable("page-file", "event-pages: not a folder (%s)" % pages_dir)
        try:
            # Sorted by bytes, as the TypeScript census sorts them (clause 16 names the first).
            names = sorted(os.listdir(pages_dir), key=os.fsencode)
        except OSError as exc:
            raise Unreadable("page-file", "event-pages: cannot list: %s" % exc)
    # Clause 16: every page file problem is found before any page structure problem, so the
    # reason named is the same as the TypeScript census names. The first entry in name order with
    # a problem is the one named.
    loaded = []
    for entry in names:
        path = os.path.join(pages_dir, entry)
        raw = os.fsencode(entry)
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            raise Unreadable("page-file", "event-pages/%s: not a page file (its name is not valid UTF-8)" % _shown(raw))
        # Every entry must be a page file: regular, ends in .json, no leading dot.
        if entry.startswith(".") or not entry.endswith(".json") or not is_regular_file(path):
            raise Unreadable("page-file", "event-pages/%s: not a page file" % entry)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
            if _nesting(text) > MAX_NESTING:
                raise ValueError("nested deeper than %d levels" % MAX_NESTING)
            page = json.loads(text, parse_constant=_reject_constant, parse_int=_parse_int,
                              object_pairs_hook=_one_value_per_key)
        except (OSError, ValueError, RecursionError) as exc:
            raise Unreadable("page-file", "event-pages/%s: cannot read: %s" % (entry, exc))
        loaded.append((entry, page))
    for name, page in loaded:
        if not isinstance(page, dict):
            raise Unreadable("page-structure", "%s: page is not an object" % name)
        if not isinstance(page.get("genesis"), str):
            raise Unreadable("page-structure", "%s: genesis missing or not a string" % name)
        for f in ("from_block", "to_block", "page"):
            if not is_int(page.get(f)):
                raise Unreadable("page-structure", "%s: %s missing or not an integer" % (name, f))
        # Block numbers start at 0: a range that starts below 0 describes no real blocks.
        if page["page"] < 0 or page["from_block"] < 0 or page["from_block"] > page["to_block"]:
            raise Unreadable("page-structure", "%s: bad page number or block range" % name)
        if "next_page" not in page or not (page["next_page"] is None or is_int(page["next_page"])):
            raise Unreadable("page-structure", "%s: next_page missing or not an integer or null" % name)
        for f in ("from_block", "to_block", "page"):
            page[f] = as_int(page[f])
        if page["next_page"] is not None:
            page["next_page"] = as_int(page["next_page"])
        if not isinstance(page.get("events"), list):
            raise Unreadable("page-structure", "%s: events missing or not a list" % name)
        pages.append(page)
    return pages


def complete_chains(pages):
    """Return list of (from, to, [pages in chain order]) for chains that reach next_page null."""
    groups = {}
    for p in pages:
        groups.setdefault((p["from_block"], p["to_block"]), {}).setdefault(p["page"], []).append(p)
    out = []
    for (lo, hi), by_num in sorted(groups.items()):
        # Two copies of one page number that disagree on next_page break the chain.
        if any(len({c["next_page"] for c in copies}) > 1 for copies in by_num.values()):
            continue
        chain, seen, num, ok = [], set(), 0, True
        while True:
            if num not in by_num or num in seen:
                ok = False
                break
            seen.add(num)
            chain.extend(by_num[num])
            nxt = by_num[num][0]["next_page"]
            if nxt is None:
                break
            num = nxt
        if ok:
            out.append((lo, hi, chain))
    return out


def merge_ranges(ranges):
    merged = []
    for lo, hi in sorted(ranges):
        if merged and lo <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return merged


def subtract(req_lo, req_hi, covered):
    gaps, cur = [], req_lo
    for lo, hi in covered:
        if lo > cur:
            gaps.append([cur, lo - 1])
        cur = max(cur, hi + 1)
    if cur <= req_hi:
        gaps.append([cur, req_hi])
    return gaps


def account_of(data):
    if not isinstance(data, dict):
        return None
    for f in ACCOUNT_FIELDS:
        v = data.get(f)
        if isinstance(v, str) and v != "":
            return v
    return None


def parse_event(ev):
    """Return (key_tuple, signature) for a well formed event, else None."""
    if not isinstance(ev, dict):
        return None
    for f in ("section", "method", "block_hash"):
        if not isinstance(ev.get(f), str) or ev[f] == "":
            return None
    if BLOCK_HASH.fullmatch(ev["block_hash"]) is None:
        return None
    index = as_int(ev.get("index"))
    if index is None or index < 0:
        return None
    if "block_number" not in ev:
        return None
    if ev["block_number"] is not None and as_int(ev["block_number"]) is None:
        return None
    return dict(ev, index=index)


def recount(scenario_dir, genesis, req_lo, req_hi):
    pages = load_pages(scenario_dir)
    pinned = [p for p in pages if p["genesis"] == genesis]
    other = [p for p in pages if p["genesis"] != genesis]
    excluded = sum(len(p["events"]) for p in other)

    chains = complete_chains(pinned)
    covered = merge_ranges(
        (max(lo, req_lo), min(hi, req_hi)) for lo, hi, _ in chains if hi >= req_lo and lo <= req_hi
    )
    gaps = subtract(req_lo, req_hi, covered)
    complete = len(gaps) == 0

    malformed = 0
    groups = {}  # key -> list of (finalized_ok, signature)
    for lo, hi, chain in chains:
        if hi < req_lo or lo > req_hi:
            continue
        a, b = max(lo, req_lo), min(hi, req_hi)
        for page in chain:
            for raw in page["events"]:
                bn = as_int(raw.get("block_number")) if isinstance(raw, dict) else None
                inside = bn is None or (a <= bn <= b)
                ev = parse_event(raw)
                if ev is None:
                    # Malformed with an out of range integer block_number is skipped, not malformed.
                    if inside:
                        malformed += 1
                    continue
                key = (genesis, ev["block_hash"], ev["index"])
                sig = (ev["section"], ev["method"], account_of(ev.get("data")))
                groups.setdefault(key, []).append((ev.get("finalized") is True, sig, inside))

    totals = {k: 0 for k, _, _ in KINDS}
    by_account = {}
    pending = dups = 0
    for key in sorted(groups, key=lambda k: (k[1], k[2])):
        copies = groups[key]
        where = {inside for _, _, inside in copies}
        if where == {False}:
            continue  # every copy lies outside: counts nowhere, not even in duplicates
        dups += len(copies) - 1
        if where == {True, False}:
            malformed += 1  # copies partly inside and partly outside are inconsistent
            continue
        if len({sig for _, sig, _ in copies}) > 1:
            malformed += 1  # one key claiming different events: not usable evidence
            continue
        if not all(fin for fin, _, _ in copies):
            pending += 1
            continue
        section, method, account = copies[0][1]
        kind = KIND_BY_EVENT.get((section, method))
        if kind is None:
            continue
        totals[kind] += 1
        if account is not None:
            row = by_account.setdefault(account, {})
            row[kind] = row.get(kind, 0) + 1

    order = [k for k, _, _ in KINDS]
    return {
        "complete": complete,
        "status": "complete" if complete else "partial",
        "covered": [{"from_block": a, "to_block": b} for a, b in covered],
        "gaps": [{"from_block": a, "to_block": b} for a, b in gaps],
        "totals": {k: totals[k] for k in order},
        "by_account": {
            acct: {k: by_account[acct][k] for k in order if k in by_account[acct]}
            for acct in sorted(by_account)
        },
        "pending_unfinalized": pending,
        "duplicates_dropped": dups,
        "excluded_other_genesis": excluded,
        "malformed_dropped": malformed,
    }


def request_int(flag, text):
    """A request number read as the TypeScript command reads it: ASCII digits only. Python's int()
    would also take " 0", "+5", "1_0" and other scripts' digits, which the other side refuses.
    More than 16 significant digits is past 2^53 - 1 whatever they are, and Python would refuse
    to convert one past 4300 digits, so such a number is a request problem here too."""
    if re.fullmatch(r"[0-9]+", text) is None:
        raise Unreadable("request", "%s must be a non-negative integer" % flag)
    digits = text.lstrip("0") or "0"
    if len(digits) > 16:
        raise Unreadable("request", "%s is too large to be a safe integer" % flag)
    return int(digits)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Independent census recount")
    ap.add_argument("--dir", required=True)
    ap.add_argument("--genesis", required=True)
    ap.add_argument("--from", dest="lo", required=True)
    ap.add_argument("--to", dest="hi", required=True)
    try:
        args = ap.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    try:
        lo = request_int("--from", args.lo)
        hi = request_int("--to", args.hi)
        if as_int(lo) is None or as_int(hi) is None or lo > hi:
            raise Unreadable("request", "bad requested range %d..%d" % (lo, hi))
        # Clause 16, input: a census needs a pinned genesis to count against.
        if args.genesis == "":
            raise Unreadable("input", "no pinned genesis")
        result = recount(args.dir, args.genesis, lo, hi)
    except Unreadable as exc:
        print("census refused (%s): %s" % (exc.kind, exc), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
