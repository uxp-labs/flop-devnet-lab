#!/usr/bin/env python3
"""Fail-first regressions for the swarm audit of 8ddc5d2 (viewer findings, build-lane.py).

Finding 5 (low): the viewer applied the seat's daily cap to requester paid rows. imd-flop counts only holder
paid rows against the daily cap. On a requester row spent_before is that job's requester spend and the limit
that applied was job_budget. Rule: the limit shown is the limit that applied. A holder row shows 'daily cap
left'. A requester row shows 'job budget left' (job_budget - spent_before - cap_charge), no daily cap chip or
flag, and 'over the job budget' when that figure is negative. Any other payer shows neither figure.

Finding 6 (low): a settled receipt with an unknown amount beside a ledger row that is settled with an unknown
spend was labelled 'receipt and ledger disagree'. imd-flop books exactly that row for such a receipt (contract
vector run-settled-null-spend), so the two agree. Rule: both in a settling state and both amounts unknown is
agreement on an unknown amount. The row shows amber 'settled, amount unknown; reservation held' as chip and
flag, keeps the reservation line and keeps chain final green blocked. Every other disagreement stays one.

Finding 7 (low): amount() accepted negative numbers, so a negative cap_charge or spent_before became extra
headroom ('daily cap left 0.8' under a 0.5 cap) and 'reservation -0.3 (held)'. imd-flop refuses the next call
on such a row and spend-guard treats negatives as unknown. Rule: a negative amount is not an amount. amount()
returns unknown (None), so every place that shows or subtracts it shows blank.

Each test asserts the fixed outcome, so it fails on 8ddc5d2 and passes after the fix. Controls say so.
Offline: build-lane.py is exec'd on temp dirs (lane_harness.lane).
"""
import unittest

from lane_harness import LED, REC, greens, lane, load_lane, visible

NS = load_lane()
DISAGREE = NS["DISAGREE"]
SETTLED_UNKNOWN = "settled, amount unknown; reservation held"
BLANK = '<span class="unk blank" title="unknown spend">&nbsp;</span>'
OVER_DAILY = "over the daily cap"
OVER_JOB = "over the job budget"
# A requester paid row. The seat's daily cap (1) is the holder's limit. This row's limit is the job budget (5).
REQ = dict(LED, payer="requester", job_budget=5, daily_cap=1)
SETTLED = dict(REC, state="settled", chain_final=True, http=200, error=None)


def settled_row(amount, **led):
    """A requester row settled at amount, with a reservation that covers it, beside its settled receipt."""
    base = dict(REQ, state="settled", spend=amount, cap_charge=amount, quote_padded=amount)
    return lane([dict(base, **led)], {"req-1": dict(SETTLED, settled=amount)})


class Finding5RequesterRowsUseTheJobBudget(unittest.TestCase):
    def test_F5_requester_row_shows_job_budget_left_and_no_daily_cap_flag(self):
        """The audit's repro: 1 - 0.93 - 0.186 = -0.116 against the daily cap, but the job budget has 3.884 left."""
        led = dict(REQ, spent_before=0.93, cap_charge=0.186, state="sent")
        rows, page = lane([led], {"req-1": dict(REC, state="estimated", http=200)})
        row, text = rows[0], visible(page)
        self.assertEqual(row["spend_flags"], [])
        self.assertNotIn("daily_left", row)
        self.assertEqual(row.get("job_left"), 3.884)
        self.assertIn('<div><span class="k">job budget left</span> <span class="mono">3.884</span></div>', page)
        self.assertNotIn("daily cap", text)
        self.assertNotIn("-0.116", text)
        self.assertFalse(row["bad"])
        self.assertIn("matches", text)

    def test_F5_requester_settlement_over_the_job_budget_is_one_amber_chip(self):
        """The audit's control: job spend 4.9 + 0.2 = 5.1 is over the budget 5. The daily cap (100) is not."""
        rows, page = settled_row(0.2, daily_cap=100, spent_before=4.9)
        row, text = rows[0], visible(page)
        self.assertEqual(row["chips"], [["amber", OVER_JOB]])
        self.assertEqual(row.get("job_left"), -0.1)
        self.assertNotIn(OVER_JOB, row["spend_flags"])  # said once, on the chip
        self.assertEqual(text.count(OVER_JOB), 1)
        self.assertIn(["reservation", 0.2], row["flop"])
        self.assertIn(["settled", 0.2], row["flop"])
        self.assertTrue(row["bad"])
        self.assertEqual(greens(page), [])
        self.assertNotIn("matches", text)
        self.assertNotIn("daily cap", text)

    def test_F5_requester_settlement_inside_the_job_budget_ignores_the_daily_cap(self):
        """Settled 0.05 with 0.98 already spent on the job: over a daily cap of 1, well inside the budget of 5."""
        rows, page = settled_row(0.05, spent_before=0.98)
        self.assertEqual(rows[0]["chips"], [["grey", "sent"], ["amber", "gateway observed"], ["green", "chain final"]])
        self.assertEqual(rows[0].get("job_left"), 3.97)
        self.assertEqual(rows[0]["spend_flags"], [])
        self.assertFalse(rows[0]["bad"])
        self.assertNotIn("daily cap", visible(page))

    def test_F5_pending_requester_row_over_the_job_budget_keeps_a_spend_flag(self):
        rows, page = lane([dict(REQ, job_budget=1, daily_cap=100, spent_before=0.9)], {"req-1": dict(REC)})  # 1 - 0.9 - 0.198
        self.assertEqual(rows[0]["spend_flags"], [OVER_JOB])
        self.assertEqual(rows[0].get("job_left"), -0.098)
        self.assertEqual(visible(page).count(OVER_JOB), 1)
        self.assertNotIn(OVER_DAILY, visible(page))

    def test_F5_first_limit_order_is_per_call_cap_then_job_budget_then_reservation(self):
        # Over all three: the per-call cap is named on the chip and the job budget keeps its spend flag.
        rows, page = settled_row(0.3, quote_padded=0.198, job_budget=1, spent_before=0.9)
        self.assertEqual(rows[0]["chips"], [["amber", "over the per-call cap"]])
        self.assertEqual(rows[0]["spend_flags"], [OVER_JOB])
        self.assertEqual(visible(page).count(OVER_JOB), 1)
        # Over the job budget and the reservation: the job budget comes first, as the daily cap does.
        rows, page = settled_row(0.2, quote_padded=0.198, job_budget=1, spent_before=0.9)
        self.assertEqual(rows[0]["chips"], [["amber", OVER_JOB]])
        self.assertEqual(rows[0]["spend_flags"], [])
        # Over the reservation only.
        rows, page = settled_row(0.2, quote_padded=0.198)
        self.assertEqual(rows[0]["chips"], [["amber", "over the reservation"]])

    def test_F5_refused_requester_row_keeps_the_job_budget_flag(self):
        led = dict(REQ, request_id=None, state="refused_local", cap_charge=0, reason="job budget hit", job_budget=0.1, spent_before=0.3)
        rows, page = lane([led], {})
        self.assertEqual(rows[0]["spend_flags"], ["cap hit = stop", "job budget hit", OVER_JOB])
        self.assertEqual(visible(page).count(OVER_JOB), 1)
        self.assertNotIn(OVER_DAILY, visible(page))
        self.assertEqual(greens(page), [])

    def test_F5_unknown_job_budget_input_leaves_the_figure_blank(self):
        for name, change in (("no job_budget", dict(job_budget=None)), ("unknown spent_before", dict(spent_before=None)),
                             ("unknown cap_charge", dict(cap_charge=None))):
            with self.subTest(name):
                rows, page = lane([dict(REQ, **change)], {"req-1": dict(REC)})
                self.assertIn("job_left", rows[0])
                self.assertIsNone(rows[0]["job_left"])
                self.assertIn(f'<div><span class="k">job budget left</span> {BLANK}</div>', page)
                self.assertEqual(rows[0]["spend_flags"], [])
                self.assertNotIn("daily cap", visible(page))

    def test_F5_job_budget_that_is_not_a_number_is_an_unreadable_row(self):
        """Same handling as a daily_cap that is not a number on a holder row (test_audit_v7 V_L9)."""
        rows, page = lane([dict(REQ, job_budget="5")], {"req-1": dict(REC)})
        self.assertEqual(rows[0]["chips"], [["red", "unreadable"]])
        self.assertTrue(rows[0]["bad"])
        self.assertEqual(greens(page), [])

    def test_F5_any_other_payer_shows_neither_figure(self):
        """Which limit applied is unknown, so no figure, no flag and no limit chip: never a guess."""
        for payer, tag in (("someone", "payer: someone"), ("Holder", "payer: Holder"), (None, "payer: unknown"), ("", "payer: unknown")):
            with self.subTest(payer=payer):
                # As a holder row this is over the daily cap (0.5 - 0.4 - 0.198). As a requester row it is over the job budget.
                rows, page = lane([dict(LED, payer=payer, job_budget=0.5, spent_before=0.4)], {"req-1": dict(REC)})
                row, text = rows[0], visible(page)
                self.assertNotIn("daily_left", row)
                self.assertNotIn("job_left", row)
                self.assertEqual(row["spend_flags"], [])
                self.assertNotIn("daily cap", text)
                self.assertNotIn("job budget", text)
                self.assertIn(tag, text)
                self.assertNotIn("payer: holder", text)

    def test_F5_any_other_payer_gets_no_limit_chip(self):
        led = dict(LED, payer="someone", job_budget=0.1, daily_cap=0.1, spent_before=0.3, state="settled", spend=0.05, cap_charge=0.05)
        rows, page = lane([led], {"req-1": dict(SETTLED, settled=0.05)})
        self.assertNotIn(["amber", OVER_DAILY], rows[0]["chips"])
        self.assertNotIn(["amber", OVER_JOB], rows[0]["chips"])
        self.assertNotIn("over the", visible(page))

    def test_F5_control_holder_row_is_unchanged(self):
        """Passes before and after: a holder row keeps the daily cap figure, flag and chip. job_budget is not its limit."""
        rows, page = lane([dict(LED, spent_before=0.4, job_budget=5)], {"req-1": dict(REC)})  # 0.5 - 0.4 - 0.198 = -0.098
        self.assertEqual(rows[0]["daily_left"], -0.098)
        self.assertNotIn("job_left", rows[0])
        self.assertEqual(rows[0]["spend_flags"], [OVER_DAILY])
        self.assertIn('<div><span class="k">daily cap left</span> <span class="mono">-0.098</span></div>', page)
        self.assertNotIn("job budget", visible(page))
        led = dict(LED, state="settled", spend=0.05, cap_charge=0.05, daily_cap=0.1, spent_before=0.3, job_budget=5)
        rows, page = lane([led], {"req-1": dict(SETTLED, settled=0.05)})
        self.assertEqual(rows[0]["chips"], [["amber", OVER_DAILY]])
        self.assertEqual(rows[0]["spend_flags"], [])


# The row imd-flop books for a settled receipt with no usable amount: settled, spend null, the hold kept.
HELD_LED = dict(LED, state="settled", spend=None, cap_charge=0.186)
NO_AMOUNT = dict(REC, state="settled", settled=None, http=200, error=None)


class Finding6SettledAmountUnknown(unittest.TestCase):
    def test_F6_settled_on_both_sides_with_unknown_amounts_is_not_a_disagreement(self):
        """The audit's repro."""
        rows, page = lane([HELD_LED], {"req-1": NO_AMOUNT})
        row, text = rows[0], visible(page)
        self.assertEqual(row["chips"], [["amber", SETTLED_UNKNOWN]])
        self.assertEqual(row["flags"], [SETTLED_UNKNOWN])
        self.assertIn(f'<span class="chip c-amber">{SETTLED_UNKNOWN}</span>', page)
        self.assertIn(f'<div class="flag">{SETTLED_UNKNOWN}</div>', page)
        self.assertNotIn("disagree", text)

    def test_F6_reservation_stays_held_and_spend_stays_blank(self):
        rows, page = lane([HELD_LED], {"req-1": NO_AMOUNT})
        self.assertIn(["reservation", 0.186], rows[0]["flop"])
        self.assertIn('<span class="k">reservation</span> <span class="mono">0.186</span> <span class="note">(held)</span>', page)
        self.assertIn(["observed spend", None], rows[0]["flop"])
        self.assertIn(f'<span class="k">observed spend</span> {BLANK}', page)
        self.assertNotIn("disagree", visible(page))
        # No cap_charge on the row: the reservation shown is the padded quote, as on every other held row.
        rows, _ = lane([dict(HELD_LED, cap_charge=None)], {"req-1": NO_AMOUNT})
        self.assertIn(["reservation", 0.198], rows[0]["flop"])

    def test_F6_chain_final_green_stays_blocked(self):
        for name, rec in (("chain_final false", NO_AMOUNT), ("chain_final true", dict(NO_AMOUNT, chain_final=True))):
            with self.subTest(name):
                rows, page = lane([HELD_LED], {"req-1": rec})
                self.assertEqual(rows[0]["chips"], [["amber", SETTLED_UNKNOWN]])
                self.assertTrue(rows[0]["bad"])
                self.assertIn('class="row bad"', page)
                self.assertEqual(greens(page), [])
                self.assertNotIn("matches", visible(page))

    def test_F6_any_two_settling_states_with_unknown_amounts_agree(self):
        for led_state, rec_state in (("released", "released"), ("settled", "released"), ("released", "settled")):
            with self.subTest(ledger=led_state, receipt=rec_state):
                rows, page = lane([dict(HELD_LED, state=led_state)], {"req-1": dict(NO_AMOUNT, state=rec_state)})
                self.assertEqual(rows[0]["chips"], [["amber", SETTLED_UNKNOWN]])
                self.assertEqual(greens(page), [])

    def test_F6_control_every_other_disagreement_stays_one(self):
        """Passes before and after."""
        cases = {
            "ledger has an amount, receipt has none": (dict(HELD_LED, spend=0.05, cap_charge=0.05), NO_AMOUNT),
            "receipt has an amount, ledger has none": (HELD_LED, dict(NO_AMOUNT, settled=0.05)),
            "amounts differ": (dict(HELD_LED, spend=0.05, cap_charge=0.05), dict(NO_AMOUNT, settled=0.07)),
            "ledger not settled, receipt settled without an amount": (dict(LED, state="estimated"), NO_AMOUNT),
            "ledger still sent, receipt settled without an amount": (dict(LED), NO_AMOUNT),
            "ledger settled without an amount, receipt still pending": (HELD_LED, dict(REC, http=200, error=None)),
        }
        for name, (led, rec) in cases.items():
            with self.subTest(name):
                rows, page = lane([led], {"req-1": dict(rec, chain_final=True)})
                self.assertEqual(rows[0]["chips"], [["amber", DISAGREE]])
                self.assertIn(DISAGREE, rows[0]["flags"])
                self.assertNotIn(SETTLED_UNKNOWN, visible(page))
                self.assertEqual(greens(page), [])

    def test_F6_control_known_equal_amounts_still_match(self):
        """Passes before and after."""
        rows, page = lane([dict(HELD_LED, spend=0.05, cap_charge=0.05)], {"req-1": dict(NO_AMOUNT, settled=0.05, chain_final=True)})
        self.assertFalse(rows[0]["bad"])
        self.assertIn("matches", visible(page))
        self.assertIn("chain final", greens(page))


def spend_line(label, value=BLANK):
    return f'<div><span class="k">{label}</span> {value}</div>'


NEGATIVE_FIGURE = 'class="mono">-'  # any number the page prints that starts with a minus sign


class Finding7NegativeAmountsAreUnknown(unittest.TestCase):
    def test_F7_amount_gives_unknown_for_a_negative_number(self):
        amount = NS["amount"]
        for v in (-0.3, -1, -0.000001, -1e308):
            with self.subTest(value=v):
                self.assertIsNone(amount(v))
        for v in (0, 0.05, 7, 1e308):  # control: zero and positive amounts are still amounts
            with self.subTest(value=v):
                self.assertEqual(amount(v), v)

    def test_F7_negative_cap_charge_is_not_extra_headroom(self):
        """The audit's repro: cap_charge -0.3 under a 0.5 daily cap showed 'daily cap left 0.8', no flag."""
        rows, page = lane([dict(LED, cap_charge=-0.3)], {"req-1": dict(REC, http=200)})
        row, text = rows[0], visible(page)
        self.assertIsNone(row["daily_left"])
        self.assertIn(spend_line("daily cap left"), page)
        self.assertNotIn("0.8", text)
        self.assertNotIn(NEGATIVE_FIGURE, page)

    def test_F7_negative_cap_charge_is_never_shown_as_the_reservation(self):
        """It showed 'reservation -0.3 (held)'. An unknown cap_charge shows the padded quote, as a null one does."""
        rows, page = lane([dict(LED, cap_charge=-0.3)], {"req-1": dict(REC, http=200)})
        self.assertEqual([v for k, v in rows[0]["flop"] if k == "reservation"], [0.198])
        self.assertIn("reservation 0.198 (held)", visible(page))
        # No usable quote either: the reservation line stays, blank.
        rows, page = lane([dict(LED, cap_charge=-0.3, quote_padded=-0.2)], {"req-1": dict(REC, http=200)})
        self.assertEqual([v for k, v in rows[0]["flop"] if k == "reservation"], [None])
        self.assertIn(f'<span class="k">reservation</span> {BLANK} <span class="note">(held)</span>', page)
        self.assertNotIn(NEGATIVE_FIGURE, page)

    def test_F7_negative_spent_before_is_not_extra_headroom(self):
        """The audit's repro: spent_before -1 showed 'daily cap left 1.302'."""
        rows, page = lane([dict(LED, spent_before=-1)], {"req-1": dict(REC, http=200)})
        self.assertIsNone(rows[0]["daily_left"])
        self.assertIn(spend_line("daily cap left"), page)
        self.assertNotIn("1.302", visible(page))

    def test_F7_negative_inputs_leave_the_job_budget_figure_blank_too(self):
        for name, change in (("cap_charge", dict(cap_charge=-0.3)), ("spent_before", dict(spent_before=-1))):
            with self.subTest(name):
                rows, page = lane([dict(REQ, **change)], {"req-1": dict(REC, http=200)})
                self.assertIsNone(rows[0]["job_left"])
                self.assertIn(spend_line("job budget left"), page)
                self.assertEqual(rows[0]["spend_flags"], [])

    def test_F7_negative_quote_and_per_call_cap_show_blank(self):
        rows, page = lane([dict(LED, quote_padded=-0.2, per_call_cap=-1)], {"req-1": dict(REC, http=200)})
        self.assertIsNone(rows[0]["est"])
        self.assertIsNone(rows[0]["per_call"])
        self.assertIn(spend_line("est.") + spend_line("per-call cap"), page)
        self.assertNotIn(NEGATIVE_FIGURE, page)

    def test_F7_negative_limit_is_an_unreadable_row(self):
        """A cap that is present but not an amount makes the row unreadable, as a cap that is a string does."""
        for name, led in (("daily_cap", dict(LED, daily_cap=-1)), ("job_budget", dict(REQ, job_budget=-5))):
            with self.subTest(name):
                rows, page = lane([led], {"req-1": dict(REC, http=200)})
                self.assertEqual(rows[0]["chips"], [["red", "unreadable"]])
                self.assertTrue(rows[0]["bad"])
                self.assertEqual(greens(page), [])

    def test_F7_negative_settlement_on_both_sides_never_matches_or_goes_green(self):
        """Equal negative amounts used to pass as a match: 'observed spend -0.05' and green chain final."""
        led = dict(LED, state="settled", spend=-0.05, cap_charge=0.198)
        rows, page = lane([led], {"req-1": dict(REC, state="settled", settled=-0.05, chain_final=True, http=200, error=None)})
        self.assertEqual(rows[0]["chips"], [["amber", SETTLED_UNKNOWN]])
        self.assertEqual(greens(page), [])
        self.assertNotIn("matches", visible(page))
        self.assertNotIn(NEGATIVE_FIGURE, page)
        self.assertIn(["reservation", 0.198], rows[0]["flop"])

    def test_F7_negative_receipt_amount_beside_the_row_imd_flop_books_is_amount_unknown(self):
        """imd-flop books a settled_spend of -1 as settled, spend null, hold kept (contract vector run-settled-negative)."""
        rows, page = lane([HELD_LED], {"req-1": dict(NO_AMOUNT, settled=-1, chain_final=True)})
        self.assertEqual(rows[0]["chips"], [["amber", SETTLED_UNKNOWN]])
        self.assertNotIn("disagree", visible(page))
        self.assertNotIn(NEGATIVE_FIGURE, page)
        self.assertEqual(greens(page), [])

    def test_F7_control_known_amount_beside_a_negative_one_still_disagrees(self):
        """Passes before and after: one side knows the amount, the other does not."""
        for name, led, rec in (("receipt negative", dict(HELD_LED, spend=0.05, cap_charge=0.05), dict(NO_AMOUNT, settled=-0.05)),
                               ("ledger negative", dict(HELD_LED, spend=-0.05), dict(NO_AMOUNT, settled=0.05))):
            with self.subTest(name):
                rows, page = lane([led], {"req-1": dict(rec, chain_final=True)})
                self.assertEqual(rows[0]["chips"], [["amber", DISAGREE]])
                self.assertEqual(greens(page), [])


if __name__ == "__main__":
    unittest.main()
