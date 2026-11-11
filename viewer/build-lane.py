#!/usr/bin/env python3
"""Rebuild the imd handoff lane in the settlement viewer from local files only.
Inputs:  mock-receipts/ledger.jsonl + mock-receipts/*.json  (written by imd-flop, mock provider)
         lane-examples.json                                  (example data for kinds the demo lacks)
Output:  rewrites the block between <!-- lane:start --> and <!-- lane:end --> in the viewer HTML.
No network. Unknown spend renders as an empty slot, never 0."""
import json, glob, math, os, re, sys, html
from datetime import datetime
from zoneinfo import ZoneInfo
D = os.path.dirname(os.path.abspath(__file__))
VIEWER = os.path.join(D, "settlement-viewer-2026-11-09.html")
RDIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(D, "mock-receipts")
BLANK = '<span class="unk blank" title="unknown spend">&nbsp;</span>'

def load_rules(start=__file__):
    """contract/rules.json from the nearest ancestor folder of this file (symlinks resolved), so the build works
    from any cwd. Fails closed: no rules file means no rebuild, never built-in labels."""
    d = os.path.dirname(os.path.realpath(start))
    while True:
        p = os.path.join(d, "contract", "rules.json")
        if os.path.isfile(p):
            with open(p) as fh: return json.load(fh)
        up = os.path.dirname(d)
        if up == d: raise RuntimeError(f"contract/rules.json not found in any parent of {os.path.realpath(start)}; refusing to build without the shared rules")
        d = up
_C = load_rules()["constants"]
DISAGREE = _C["DISAGREE"]["value"]
IDENTITY = _C["IDENTITY"]["value"]
SETTLES = tuple(_C["SETTLES"]["value"])
LEDGER_PROVIDERS = tuple(_C["LEDGER_PROVIDERS"]["value"])
PAST_ADMITTED = _C["PAST_ADMITTED"]["value"]
STAGE_GATEWAY = _C["STAGE_GATEWAY"]["value"]
ET = ZoneInfo("America/New_York")

def num(v): return BLANK if v is None else f'<span class="mono">{v}</span>'
SCALE = 1e6
NOISE = 1e-6  # in scaled units, so 1e-12 FLOP
def floor6(n):
    """Room left rounds down to 6 decimals, the twin of imd-flop's rounding.ts floor6; pinned for both by
    contract/vectors/rounding.json. A value within 1e-12 of a 1e-6 boundary counts as on it, so float noise
    does not move a 6 decimal amount below 8192 FLOP. Rounding adds no room beyond that tolerance, so a row over
    its limit by more than 1e-12 FLOP and less than 1e-6 FLOP is still over it. A row over by at most 1e-12 FLOP
    (only an amount off the 6 decimal grid makes one) reads as on its limit: residual R-g in rules.json."""
    scaled = n * SCALE
    nearest = round(scaled)
    return (nearest if abs(scaled - nearest) <= NOISE else math.floor(scaled)) / SCALE
def esc(v): return html.escape("" if v is None else str(v), quote=True)
AMOUNT_MAX = _C["AMOUNT_MAX"]["value"]  # 2^53 - 1, the largest integer a double holds exactly
def amount(v):
    """A file value used as an amount: a finite int/float that is not negative, not above AMOUNT_MAX and not a
    bool, else None (blank, never 0). The twin of imd-flop's amount.ts knownAmount. A negative number is not an
    amount, as in imd-flop and spend-guard: it is unknown, so nothing shows it or subtracts it. Above AMOUNT_MAX
    Python keeps a JSON integer exact while JavaScript rounds it, so the two parts would read the same text as
    different amounts: it is unknown in both (review fixes 2, R10)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")) or v < 0 or v > AMOUNT_MAX: return None
    return v
EXACT_BOUND = int(_C["EXACT_AMOUNT_BOUND"]["value"])  # 2^128: per FLOP's own sources (read 2026-11-11) the chain holds money in a u128
EXACT_DIGITS = len(str(EXACT_BOUND - 1))  # 39
FLOP_DECIMALS = _C["FLOP_DECIMALS"]["value"]  # 10^18 base units per FLOP
DIGITS = re.compile(r"[0-9]+")
def exact(v):
    """The exact amount rule (money stage 1), the twin of imd-flop's amount.ts exactAmount; pinned for both by
    contract/vectors/exact-amount.json. An exact amount is a string of ASCII decimal digits only (full match,
    so a trailing newline is refused) whose value is below 2^128, returned in canonical form: no leading
    zeros, "0" for zero. Anything else is None (unknown, never 0). The zeros go before int(), so a long run of
    them never meets Python's limit on digits."""
    if not isinstance(v, str) or not DIGITS.fullmatch(v): return None
    digits = v.lstrip("0") or "0"
    return digits if len(digits) <= EXACT_DIGITS and int(digits) < EXACT_BOUND else None
def short(s, n=10):
    """Head and tail of an id, so distinct random tails stay distinct. The full id goes in a title attribute."""
    return s if len(s) <= n + 2 else s[:6] + "…" + s[-(n - 6):]
def present(v): return isinstance(v, str) and v != ""
def identity_ok(r, e):
    """Exact, uncoerced match on request_id, job, seat and DID, each a non-empty string on both sides (as match.ts)."""
    return all(present(r.get(k)) and present(e.get(k)) and r.get(k) == e.get(k) for k in ("request_id", "job", "seat", "did"))
def identity_diff(r, e): return [k for k in ("request_id", "job", "seat", "did") if not (present(r.get(k)) and present(e.get(k)) and r.get(k) == e.get(k))]
def when(ts): return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(ET).strftime("%b %-d, %-I:%M %p ET")

def unreadable(what, why):
    """A red row for an item that could not be read, instead of aborting the whole rebuild."""
    return dict(label=esc(what), sub=[esc(why)], payer="unknown", flags=["unreadable: not shown as OK"], spend_flags=[], flop=[["observed spend", None]],
                est=None, per_call=None, daily_left=None, chips=[["red", "unreadable"]], outcome=["grey", "not read", None],
                link=["grey", "not checked", None], bad=True)

def read_ledger(led):
    """One entry per attempt: the latest line per request_id wins (as imd-flop's ledger). Lines without a
    request_id (local refusals) are each their own entry. Unreadable lines become unreadable rows."""
    order, latest, bad = [], {}, []
    with open(led) as fh:
        for n, line in enumerate(fh, 1):
            if not line.strip(): continue
            try:
                e = json.loads(line)
                if not isinstance(e, dict): raise ValueError("not an object")
            except ValueError as ex:
                bad.append(unreadable(f"ledger line {n}", f"ledger.jsonl line {n}: {type(ex).__name__}")); continue
            rid = e.get("request_id")
            key = ("req", rid) if present(rid) else ("line", n)
            if key not in latest: order.append(key)
            latest[key] = e
    return [latest[k] for k in order], bad

def read_receipts():
    receipts = {}
    for f in glob.glob(os.path.join(RDIR, "*.json")):
        try:
            with open(f) as fh: r = json.load(fh)
        except ValueError:
            r = None
        receipts[os.path.splitext(os.path.basename(f))[0]] = r if isinstance(r, dict) else {"_unreadable": True}
    return receipts  # file name is the ledger's request_id; contents are checked by identity_ok

def from_files():
    led = os.path.join(RDIR, "ledger.jsonl")
    if not os.path.exists(led): return []
    entries, rows = read_ledger(led)
    receipts = read_receipts()
    for e in entries:
        try:
            rows.append(build_row(e, receipts.get(e.get("request_id")) if present(e.get("request_id")) else None))
        except Exception as ex:  # one bad entry never aborts the lane
            rows.append(unreadable(f"job {e.get('job')}", f"ledger entry for {e.get('request_id') or 'none'}: {type(ex).__name__}"))
    return rows

def unresolved(e): return e.get("state") in ("timeout_unknown", "error")

OVER_PER_CALL = "over the per-call cap"
OVER_DAILY = "over the daily cap"
OVER_JOB = "over the job budget"
OVER_RESERVATION = "over the reservation"
PAYER_UNKNOWN = "payer unknown"
BELOW_HOLD = "charged below its hold"
# A spend limit: the ledger field that holds the cap, the field that holds its own running total before the
# call, the row key and page label of what is left, the 'over' wording, and the wording for a row it could
# not be worked out for.
DAILY_CAP = dict(field="daily_cap", spent="spent_before", key="daily_left", label="daily cap left", over=OVER_DAILY,
                 unchecked="daily cap not checked")
JOB_BUDGET = dict(field="job_budget", spent="job_spent_before", key="job_left", label="job budget left", over=OVER_JOB,
                  unchecked="job budget not checked")
# The spend limits that apply to a row, in the order imd-flop checks them (policy.ts). The seat's key pays for
# every call, so the seat's daily cap applies to every row, whatever its payer. The job budget applies to a
# requester row as well.
EVERY_ROW = [DAILY_CAP]
SPEND_LIMITS = {"holder": EVERY_ROW, "requester": EVERY_ROW + [JOB_BUDGET]}
# Every limit once, in checked order. The page shows one line per limit a row carries.
LIMIT_LINES = list({lim["key"]: lim for limits in SPEND_LIMITS.values() for lim in limits}.values())

def known_payer(e):
    payer = e.get("payer")
    return isinstance(payer, str) and payer in SPEND_LIMITS

def before_two_totals(e):
    """A requester row with no job_spent_before key. It was written before the daily cap bounded requester calls
    (swarm audit of 8ddc5d2, finding 13). Its spent_before is the job's spend, not the seat's. So its job budget
    left is exact, and its daily cap cannot be checked."""
    return e.get("payer") == "requester" and "job_spent_before" not in e

def running_total(e, lim):
    """What the row counted against this limit before the call, or None when the row does not say."""
    if before_two_totals(e): return amount(e.get("spent_before")) if lim is JOB_BUDGET else None
    return amount(e.get(lim["spent"]))

def spend_limit(e):
    """The spend limits that apply to this row, each with what is left of it after the row's cap_charge, as a
    list of (limit, left) in checked order (cap math uses cap_charge). left rounds down (floor6). A payer that is neither holder nor
    requester is checked against the daily cap, its spent_before read as the seat's total. left is None when
    the limit could not be worked out: an input is unknown, or the row does not hold that limit's running
    total (before_two_totals). Never a guess."""
    limits = SPEND_LIMITS[e["payer"]] if known_payer(e) else EVERY_ROW
    cap_charge, applied = amount(e.get("cap_charge")), []
    for lim in limits:
        cap, spent = amount(e.get(lim["field"])), running_total(e, lim)
        if e.get(lim["field"]) is not None and cap is None: raise ValueError(f'{lim["field"]} is not an amount')
        applied.append((lim, floor6(cap - spent - cap_charge) if None not in (cap, spent, cap_charge) else None))
    return applied

def below_zero(applied):
    """The 'over' wording of each applied limit with less than nothing left, in checked order."""
    return [lim["over"] for lim, left in applied if left is not None and left < 0]

def unchecked(applied):
    """The 'not checked' wording of each applied limit that could not be worked out, in checked order."""
    return [lim["unchecked"] for lim, left in applied if left is None]

def limit_flags(e, applied):
    """What the row has to say about its limits, in checked order: 'over' for a limit with less than nothing
    left, 'not checked' for one that could not be worked out. Then 'payer unknown' for a payer that is neither
    holder nor requester."""
    flags = [lim["over"] if left is not None else lim["unchecked"] for lim, left in applied if left is None or left < 0]
    return flags if known_payer(e) else flags + [PAYER_UNKNOWN]

def below_hold(e):
    """The hold floor (contract/rules.json KD-12): from the moment a call is sent, its cap charge is never below
    the padded quote it was admitted with, the cap of the single use child key the gateway minted for it. True
    for a row the call was sent for (any state but refused_local, "nothing was sent") whose cap charge is a known
    amount below its known padded quote. imd-flop no longer books such a row, and rows an older version booked
    are not migrated, so the lane flags them and never shows them as fine. Unknown on either side is not
    flagged: never a guess."""
    cap_charge, quote = amount(e.get("cap_charge")), amount(e.get("quote_padded"))
    return e.get("state") != "refused_local" and None not in (cap_charge, quote) and cap_charge < quote

UNPLACED = "ledger row cannot be placed in a total"
SEAT_ID = re.compile(r"[0-9]{1,78}")
JOB_ID = re.compile(r"[\x21-\x7e]{1,120}")
REQUEST_ID = re.compile(r"[\x21-\x7e]{1,128}")
def usable_day(v):
    """A UTC day as imd-flop writes it: YYYY-MM-DD, and a real calendar date."""
    if not isinstance(v, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", v): return False
    try: datetime.strptime(v, "%Y-%m-%d")
    except ValueError: return False
    return True
def unplaced(e):
    """The fields that keep this row out of the totals it belongs to (review fixes 2, R6), in this order: request_id
    (review fixes 3: a row with no usable request id, unless it is a refusal written before one exists,
    refused_local charged 0), day, seat, provider, and job on a requester row. imd-flop refuses the next call when such a row would count toward its
    total (ledger.ts placed), so the lane never shows the row as fine. The twin of ledger.ts isUtcDay, isSeatId,
    PROVIDERS and isJobId; pinned for both by contract/vectors/ledger-placement.json. A payer that is neither
    holder nor requester already carries 'payer unknown'."""
    rid = e.get("request_id")
    refusal = e.get("state") == "refused_local" and e.get("cap_charge") == 0 and not isinstance(e.get("cap_charge"), bool)
    checks = [("request_id", (isinstance(rid, str) and bool(REQUEST_ID.fullmatch(rid))) or refusal),
              ("day", usable_day(e.get("day"))),
              ("seat", isinstance(e.get("seat"), str) and (e["seat"] == "unassigned" or bool(SEAT_ID.fullmatch(e["seat"])))),
              ("provider", e.get("provider") in LEDGER_PROVIDERS)]
    if e.get("payer") == "requester": checks.append(("job", isinstance(e.get("job"), str) and bool(JOB_ID.fullmatch(e["job"]))))
    return [field for field, ok in checks if not ok]

def past_admitted(e):
    """The row's reason carries PAST_ADMITTED (contract/rules.json): imd-flop booked it past what the cap admitted.
    Pinned by contract/vectors/viewer-labels.json past-admitted-*."""
    reason = e.get("reason")
    return isinstance(reason, str) and PAST_ADMITTED in reason

def over_limit(e, r):
    """The first limit a settled receipt breaks, or None (KD-2, FIXER's order): the per-call cap, then the row's
    spend limits in checked order (the daily cap, then for a requester the job budget; left below 0), then the
    reservation (quote_padded)."""
    settled = amount(r.get("settled"))
    if settled is None or r.get("state") not in SETTLES: return None
    per_call, quote = amount(e.get("per_call_cap")), amount(e.get("quote_padded"))
    if per_call is not None and settled > per_call: return OVER_PER_CALL
    broken = below_zero(spend_limit(e))
    if broken: return broken[0]
    if quote is not None and settled > quote: return OVER_RESERVATION
    return None

def disagrees(e, r):
    """Receipt and ledger can't both be right. Only asked once the receipt was read and its identity matches."""
    st, receipt_state, settled = e.get("state"), r.get("state"), amount(r.get("settled"))
    if receipt_state in SETTLES:
        # The ledger must be settled too, with the same settlement amount. One side knowing an amount the
        # other lacks is a disagreement. Unknown on both sides is not: see settled_unknown().
        d = st not in SETTLES or amount(e.get("spend")) != settled
    else:
        # Pending receipt: the ledger must not claim a settlement, and nothing is chain-final yet.
        d = st in SETTLES or r.get("chain_final") is True
    return d or unresolved(e)

SETTLED_UNKNOWN = "settled, amount unknown; reservation held"

def settled_unknown(e, r):
    """Receipt and ledger both say the call settled and neither knows the amount. They agree: it is the row
    imd-flop books for a settled receipt with no usable amount (settled, spend null, the hold kept)."""
    return (e.get("state") in SETTLES and r.get("state") in SETTLES
            and amount(e.get("spend")) is None and amount(r.get("settled")) is None)

def classify(e, r):
    """The one ordered decision for a ledger row e and its receipt file r (None if there is no file), as
    (kind, limit). First match wins: refused, no receipt, unreadable file, key expired, failed read, identity
    mismatch, disagree, settled with an unknown amount, over limit, matches. limit is the first limit broken
    (over_limit), set only for kind over_limit, so over_limit() runs once per row. Rendering per kind is in
    ROW_KINDS."""
    if e.get("state") == "refused_local": return "refused", None
    if r is None: return "no_receipt", None
    if r.get("_unreadable"): return "unreadable", None
    # The last receipt read failed (key expired, an HTTP error, or http 0 for a dropped connection). The file
    # holds the last known state, not a fresh read, so it can't be compared: runs before the identity and
    # disagree checks. A key-expired read is a failed read with its own wording.
    if r.get("flag") == "key_expired": return "key_expired", None
    if r.get("http") not in (None, 200) or present(r.get("error")): return "read_failed", None
    if not identity_ok(r, e): return "mismatch", None
    if disagrees(e, r): return "disagree", None
    if settled_unknown(e, r): return "settled_unknown", None
    limit = over_limit(e, r)
    if limit: return "over_limit", limit
    return "matches", None

def unresolved_flag(e):
    return "timeout: spend unknown, not retried" if e.get("state") == "timeout_unknown" else esc(e.get("reason") or e.get("state"))

def row_refused(row, e, r, reservation, limit):
    row.update(chips=None, bad=True); row["flop"] = [["", "refused before the call, no FLOP chips"]]
    row["spend_flags"] = ["cap hit = stop", esc(e.get("reason") or "")] + row["spend_flags"]

def unknown_chips():
    """One status chip per row: red 'unknown' (precedence: unreadable, unknown, identity mismatch, disagree).
    A timeout_unknown or error ledger row shows only this; its mismatch or disagree stays in the row text."""
    return [["grey", "sent"], ["red", "unknown"]]

def row_no_receipt(row, e, r, reservation, limit):
    row["chips"] = unknown_chips(); row["bad"] = True
    # No receipt file yet (a timeout): the reservation is still held, so it is shown (residual d).
    row["flop"] = [["last seen", "sent"], ["reservation", reservation], ["observed spend", None]]
    row["flags"] = [unresolved_flag(e)]

def row_unreadable(row, e, r, reservation, limit):
    row["chips"] = [["grey", "sent"], ["red", "unreadable"]]; row["bad"] = True
    row["flags"] = ["receipt file unreadable: not shown as OK"]
    row["flop"] = [["reservation", reservation], ["observed spend", None]]

def row_read_failed(row, e, r, reservation, limit, flag="receipt read failed, can't re-check"):
    # A key-expired read uses the same labels and markup with its own flag; the link column stays grey "not checked".
    err = r.get("error") if present(r.get("error")) else ""
    why = esc(err) if err.startswith("HTTP ") else esc(f"HTTP {r.get('http')} {err}".strip())
    row["chips"] = unknown_chips(); row["bad"] = True
    # Keep the reservation label, as the unreadable-file branch does: a failed read must not drop it.
    row["flop"] = [["last seen", esc(r.get("state") or "unknown")], ["now", f'unreadable: <span class="mono">{why}</span>'], ["reservation", reservation], ["observed spend", None]]
    row["flags"] = [flag] + ([unresolved_flag(e)] if unresolved(e) else [])

def row_mismatch(row, e, r, reservation, limit):
    chips = unknown_chips() if unresolved(e) else [["grey", "sent"], ["red", "mismatch"]]; row["bad"] = True
    row["flags"].append(IDENTITY)  # visible row text, not hover-only
    row["flags"].append("receipt's request_id, job, seat or DID doesn't match this row")
    for k in identity_diff(r, e):
        row["flop"].append([f"receipt {k}", f"{esc(r.get(k))} (row says {esc(e.get(k))})"])
    row["flop"].append(["reservation", reservation])
    row["flop"].append(["match", "mismatch"])
    row["flop"].append(["observed spend", None])
    if unresolved(e): row["flags"].append(unresolved_flag(e))
    row["chips"] = chips

def row_disagree(row, e, r, reservation, limit, label=DISAGREE):
    # A settled row with an unknown amount uses the same chip, flag and held reservation with its own label.
    row["chips"] = unknown_chips() if unresolved(e) else [["amber", label]]
    row["bad"] = True
    row["flags"].append(label)
    if unresolved(e): row["flags"].append(unresolved_flag(e))
    row["flop"].append(["reservation", reservation])
    row["flop"].append(["observed spend", None])

def cap_charge_line(e):
    """The 'cap charge' line of a settled row whose cap charge is a known amount that is not its settled spend,
    with the ledger reason beside it when there is one. An empty list for any other row. imd-flop books such a
    row whenever the receipt settles below the hold: the cap charge keeps the padded quote (the hold floor,
    contract/rules.json KD-12), or a higher reported cost (reason 'cap charge raised to reported cost'). So the
    line shows what counts against the cap beside the observed spend. The limit figures already use it."""
    spend, cap_charge, reason = amount(e.get("spend")), amount(e.get("cap_charge")), e.get("reason")
    if e.get("state") not in SETTLES or None in (spend, cap_charge) or spend == cap_charge: return []
    return [["cap charge", f'{num(cap_charge)} <span class="note">({esc(reason)})</span>' if present(reason) else cap_charge]]

def row_over_limit(row, e, r, reservation, limit):
    # Receipt and ledger agree, but the settlement breaks a limit: amber, the hold stays, never green (KD-2).
    # On a settled row imd-flop books cap_charge as the hold floor, raised by the settled amount or a reported
    # cost (cap_charge_line), so it can be above the hold. The held reservation shown is quote_padded first (FIXER).
    quote = amount(e.get("quote_padded"))
    row["chips"] = [["amber", limit]]; row["bad"] = True
    row["flop"] += [["reservation", reservation if quote is None else quote], ["settled", amount(r.get("settled"))]] + cap_charge_line(e)

def row_matches(row, e, r, reservation, limit):
    chain_final = r.get("chain_final") is True
    chips = [["grey", "sent"]]
    if r.get("stage") == STAGE_GATEWAY:
        chips.append(["amber", STAGE_GATEWAY])
    # A limit that applies and could not be worked out bars the green chip. One amber chip stands in its place
    # and names the first such limit. Receipt and ledger still agree, so the row keeps 'matches'.
    not_checked = unchecked(spend_limit(e))
    if chain_final and not_checked: chips.append(["amber", not_checked[0]]); row["bad"] = True
    elif chain_final and not row["bad"]: chips.append(["green", "chain final"])
    row["chips"] = chips
    if not chain_final: row["flop"].append(["chain final", '<span class="unk">not checked yet</span>'])
    # A pending match still holds its reservation until it settles or is released.
    if e.get("state") not in SETTLES: row["flop"].append(["reservation", reservation])
    row["flop"].append(["match", "matches"])
    row["flop"].append(["observed spend", amount(r.get("settled"))])
    row["flop"] += cap_charge_line(e)

EXACT_DIFFERS = "exact amount differs from the receipt"
# The kinds where the receipt was read and its identity matches the row, so the two files are compared.
COMPARED_KINDS = ("disagree", "settled_unknown", "over_limit", "matches")

def exact_flop(digits):
    """An exact amount in base units (canonical digits) as FLOP text: all FLOP_DECIMALS decimals significant,
    trailing zeros trimmed, no decimal point for a whole amount. Integer arithmetic only, never a float."""
    whole, frac = divmod(int(digits), 10 ** FLOP_DECIMALS)
    frac = str(frac).rjust(FLOP_DECIMALS, "0").rstrip("0")
    return f"{whole}.{frac}" if frac else str(whole)

def exact_spend(row, e, r, kind):
    """Money stage 1. A settled row whose ledger spend_raw is an exact amount shows it on its own line as FLOP,
    and carries the base unit digits as row["spend_raw"]. When the receipt was compared (COMPARED_KINDS) and its
    settled_raw is an exact amount that differs, the row carries the EXACT_DIFFERS flag. Nothing else on the
    row changes: the float figures and the exact one are not compared yet, as the right tolerance needs a
    live receipt."""
    raw = exact(e.get("spend_raw"))
    if e.get("state") not in SETTLES or raw is None: return
    row["spend_raw"] = raw
    row["flop"].append(["exact spend", f'<span class="mono" title="{raw} base units">{exact_flop(raw)}</span> FLOP'])
    receipt_raw = exact(r.get("settled_raw")) if kind in COMPARED_KINDS else None
    if receipt_raw is not None and receipt_raw != raw: row["flags"].append(EXACT_DIFFERS)

# Each kind renders from (row, e, r, reservation, limit); limit is set only for over_limit.
ROW_KINDS = {"refused": row_refused, "no_receipt": row_no_receipt, "unreadable": row_unreadable, "read_failed": row_read_failed,
             "mismatch": row_mismatch, "disagree": row_disagree, "over_limit": row_over_limit, "matches": row_matches,
             "key_expired": lambda row, e, r, reservation, limit: row_read_failed(row, e, r, reservation, limit, flag="key expired, can't re-check"),
             "settled_unknown": lambda row, e, r, reservation, limit: row_disagree(row, e, r, reservation, limit, label=SETTLED_UNKNOWN)}

def build_row(e, r):
    rid = e.get("request_id")
    rid_label = f'<span title="{esc(rid)}">{esc(short(rid, 14))}</span>' if present(rid) else "none"
    sub = [f"req {rid_label}", f"seat #{esc(e.get('seat'))} · node {BLANK_NODE}",
           f"{esc(e.get('provider'))} · {esc(e.get('network'))} · {esc(when(e['ts']))}"]
    # Link column: no link evidence is recorded in the ledger, so it is always grey "not checked" (link_bypassed too).
    # A row without a payer is tagged unknown, not holder. It is still checked against the daily cap (spend_limit).
    row = dict(label=esc(e.get("job")), sub=sub, payer=esc(e.get("payer") or "unknown"), flags=[], spend_flags=[], flop=[],
               est=amount(e.get("quote_padded")), per_call=amount(e.get("per_call_cap")),
               outcome=["grey", "not read", "mock job, no imd lookup"], link=["grey", "not checked", None], bad=False)
    # The row carries what is left of each limit that applies to it, under that limit's key (daily_left, job_left).
    # None is a limit that could not be worked out: a blank figure.
    applied = spend_limit(e)
    for lim, left in applied: row[lim["key"]] = left
    kind, limit = classify(e, r)
    row["spend_flags"] += limit_flags(e, applied)
    # Set before the kind renders, so a row charged below its hold, or one that cannot be placed in a total, never gets the green chip.
    if below_hold(e): row["spend_flags"].append(BELOW_HOLD); row["bad"] = True
    missing = unplaced(e)
    if missing: row["spend_flags"].append(f"{UNPLACED} ({', '.join(missing)})"); row["bad"] = True
    # Review fixes 3, item 6: imd-flop records PAST_ADMITTED in the reason of a booking that raised a known booked
    # charge, so its day may be over its cap. The lane cannot see the day; it says so on the row, never green.
    if past_admitted(e): row["spend_flags"].append(PAST_ADMITTED); row["bad"] = True
    cap_charge = amount(e.get("cap_charge"))
    reservation = cap_charge if cap_charge is not None else amount(e.get("quote_padded"))
    ROW_KINDS[kind](row, e, r, reservation, limit)
    exact_spend(row, e, r, kind)
    # Say it once per row: a limit a chip already names gets no spend flag repeating it.
    named = [text for _, text in row["chips"] or []]
    row["spend_flags"] = [f for f in row["spend_flags"] if f not in named]
    return row
BLANK_NODE = '<span class="unk">unknown</span>'
HELD_NOTE = '<span class="note">(held)</span>'

def render(row):
    lbl = f'{row["label"]}' + "".join(f"<small>{s}</small>" for s in row["sub"]) + f'<span class="tag">payer: {row["payer"]}</span>'
    if row["chips"] is None: flop = '<span class="chip c-empty">empty</span>'
    else: flop = " ".join(f'<span class="chip c-{c}">{t}</span>' for c, t in row["chips"])
    for k, v in row["flop"]:
        v = num(v) if (v is None or isinstance(v, (int, float))) else v
        # The lane shows a reservation line only while the reservation is held, so it always carries the note.
        if k == "reservation": v += f" {HELD_NOTE}"
        flop += f'<div><span class="k">{k}</span> {v}</div>' if k else f'<div class="k">{v}</div>'
    flop += "".join(f'<div class="flag">{f}</div>' for f in row["flags"])
    # One line per spend limit the row carries, in checked order: 'daily cap left', then 'job budget left' on a
    # requester row. A limit that could not be worked out is a blank figure.
    spend = (f'<div><span class="k">est.</span> {num(row["est"])}</div><div><span class="k">per-call cap</span> {num(row["per_call"])}</div>'
             + "".join(f'<div><span class="k">{lim["label"]}</span> {num(row[lim["key"]])}</div>' for lim in LIMIT_LINES if lim["key"] in row)
             + "".join(f'<div class="flag">{f}</div>' for f in row["spend_flags"]))
    oc, ot, on = row["outcome"]
    out = f'<span class="chip c-{oc}">{ot}</span>' + (f'<div class="k">{on}</div>' if on else "") + (f'<div class="flag">{row["outcome_flag"]}</div>' if row.get("outcome_flag") else "")
    lc, lt, lf = row["link"]
    link = f'<span class="chip c-{lc}">{lt}</span>' + (f'<div class="flag">{lf}</div>' if lf else "")
    return (f'<div class="row{" bad" if row["bad"] else ""}">\n <div class="lbl">{lbl}</div>\n <div class="col">{flop}</div>\n'
            f' <div class="col">{spend}</div>\n <div class="col">{out}</div>\n <div class="col">{link}</div>\n</div>\n')

HDR = '<div class="hdr"><div>imd job</div><div>FLOP call</div><div>Spend (est. · caps)</div><div>Job outcome (imd)</div><div>Link check</div></div>\n'
def main():
    demo = from_files()
    ex = json.load(open(os.path.join(D, "lane-examples.json")))["rows"]
    out = ['<h2>imd handoff lane</h2>\n<p class="sub">One row per imd job that used FLOP, rebuilt by <span class="mono">build-lane.py</span> from local files only, never fetched live. '
           'Job outcome is shown as imd\'s public <span class="mono">GET /jobs/:id</span> reports it, grey until read, green only for accepted. '
           f'A red <span class="mono">mismatch</span> chip with the row note <span class="mono">{IDENTITY}</span> means the receipt\'s request_id, job, seat or DID doesn\'t match the row; that row can never go green. A blank slot is unknown spend, never 0.</p>\n']
    out.append(f'<h3 class="lanesub">From <span class="mono">imd-flop</span> receipts <span class="ex">mock provider · nothing spent</span></h3>\n<div class="lane">\n{HDR}')
    out += [render(r) for r in demo] or ['<p class="k">No receipts found.</p>\n']
    out.append('</div>\n')
    out.append(f'<h3 class="lanesub">Reference rows <span class="ex">example data</span></h3>\n<div class="lane">\n{HDR}')
    out += [render(r) for r in ex]
    out.append('</div>\n')
    s = open(VIEWER).read()
    a, b = s.index("<!-- lane:start -->"), s.index("<!-- lane:end -->")
    s = s[:a] + "<!-- lane:start -->\n" + "".join(out) + s[b:]
    open(VIEWER, "w").write(s)
    print(f"lane rebuilt: {len(demo)} receipt rows, {len(ex)} example rows")
if __name__ == "__main__":
    main()
