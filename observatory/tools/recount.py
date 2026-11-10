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
    pass


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


def is_regular_file(path):
    # lstat does not follow links, so a symlink is never a regular file.
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def load_pages(scenario_dir):
    if not os.path.isdir(scenario_dir):
        raise Unreadable("scenario dir not found: %s" % scenario_dir)
    pages = []
    pages_dir = os.path.join(scenario_dir, "event-pages")
    names = []
    try:
        mode = os.lstat(pages_dir).st_mode
    except FileNotFoundError:
        mode = None  # no event-pages folder means no pages
    except OSError as exc:
        raise Unreadable("cannot stat %s: %s" % (pages_dir, exc))
    if mode is not None:
        # event-pages must be a real folder, not a file or a link (lstat does not follow links).
        if not stat.S_ISDIR(mode):
            raise Unreadable("event-pages is not a folder: %s" % pages_dir)
        try:
            names = sorted(os.listdir(pages_dir))
        except OSError as exc:
            raise Unreadable("cannot list %s: %s" % (pages_dir, exc))
    for entry in names:
        path = os.path.join(pages_dir, entry)
        # Every entry must be a page file: regular, ends in .json, no leading dot.
        if entry.startswith(".") or not entry.endswith(".json") or not is_regular_file(path):
            raise Unreadable("event-pages entry is not a page file: %s" % entry)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                page = json.load(fh, parse_constant=_reject_constant)
        except (OSError, ValueError) as exc:
            raise Unreadable("cannot read %s: %s" % (path, exc))
        name = os.path.basename(path)
        if not isinstance(page, dict):
            raise Unreadable("%s: page is not an object" % name)
        if not isinstance(page.get("genesis"), str):
            raise Unreadable("%s: genesis missing or not a string" % name)
        for f in ("from_block", "to_block", "page"):
            if not is_int(page.get(f)):
                raise Unreadable("%s: %s missing or not an integer" % (name, f))
        # Block numbers start at 0: a range that starts below 0 describes no real blocks.
        if page["page"] < 0 or page["from_block"] < 0 or page["from_block"] > page["to_block"]:
            raise Unreadable("%s: bad page number or block range" % name)
        if "next_page" not in page or not (page["next_page"] is None or is_int(page["next_page"])):
            raise Unreadable("%s: next_page missing or not an integer or null" % name)
        for f in ("from_block", "to_block", "page"):
            page[f] = as_int(page[f])
        if page["next_page"] is not None:
            page["next_page"] = as_int(page["next_page"])
        if not isinstance(page.get("events"), list):
            raise Unreadable("%s: events missing or not a list" % name)
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


def main(argv=None):
    ap = argparse.ArgumentParser(description="Independent census recount")
    ap.add_argument("--dir", required=True)
    ap.add_argument("--genesis", required=True)
    ap.add_argument("--from", dest="lo", required=True, type=int)
    ap.add_argument("--to", dest="hi", required=True, type=int)
    try:
        args = ap.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    try:
        if as_int(args.lo) is None or as_int(args.hi) is None or args.lo < 0 or args.lo > args.hi:
            raise Unreadable("bad requested range %d..%d" % (args.lo, args.hi))
        result = recount(args.dir, args.genesis, args.lo, args.hi)
    except Unreadable as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
