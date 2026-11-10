"""Tests for tools/recount.py. Run from the package root:
python3 -I -m unittest tools/test_recount.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RECOUNT = os.path.join(HERE, "recount.py")
DATA = os.path.join(HERE, "testdata")
G = "0x" + "a1" * 32
ZERO = {"escrows_opened": 0, "escrows_released": 0, "escrows_refunded": 0,
        "channels_opened": 0, "channels_settled": 0}


def run(dir_, lo, hi, genesis=G):
    p = subprocess.run(
        [sys.executable, "-I", RECOUNT, "--dir", dir_, "--genesis", genesis,
         "--from", str(lo), "--to", str(hi)],
        capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


def census(scn, lo, hi, genesis=G):
    code, out, err = run(os.path.join(DATA, scn), lo, hi, genesis)
    assert code == 0, err
    return json.loads(out)


def totals(**kw):
    t = dict(ZERO)
    t.update(kw)
    return t


class RecountTests(unittest.TestCase):
    def test_complete_range_over_three_pages(self):
        r = census("complete", 1, 30)
        self.assertTrue(r["complete"])
        self.assertEqual(r["status"], "complete")
        self.assertEqual(r["covered"], [{"from_block": 1, "to_block": 30}])
        self.assertEqual(r["gaps"], [])
        self.assertEqual(r["totals"], totals(escrows_opened=2, escrows_released=1,
                                             escrows_refunded=1, channels_opened=1, channels_settled=1))
        self.assertEqual(r["by_account"], {
            "alice": {"escrows_opened": 1, "escrows_released": 1},
            "bob": {"escrows_opened": 1, "escrows_refunded": 1},
            "carol": {"channels_opened": 1}})
        self.assertEqual((r["pending_unfinalized"], r["duplicates_dropped"],
                          r["excluded_other_genesis"], r["malformed_dropped"]), (0, 0, 0, 0))

    def test_key_order_and_exact_keys(self):
        r = census("complete", 1, 30)
        self.assertEqual(list(r), ["complete", "status", "covered", "gaps", "totals", "by_account",
                                   "pending_unfinalized", "duplicates_dropped",
                                   "excluded_other_genesis", "malformed_dropped"])
        self.assertEqual(list(r["totals"]), list(ZERO))
        self.assertEqual(list(r["by_account"]["alice"]), ["escrows_opened", "escrows_released"])

    def test_duplicates_across_and_within_pages(self):
        r = census("dups", 1, 10)
        self.assertEqual(r["duplicates_dropped"], 2)
        self.assertEqual(r["totals"], totals(escrows_opened=2, escrows_released=1))

    def test_missing_page_is_partial(self):
        r = census("gap", 1, 30)
        self.assertFalse(r["complete"])
        self.assertEqual(r["status"], "partial")
        self.assertEqual(r["covered"], [{"from_block": 1, "to_block": 10}, {"from_block": 21, "to_block": 30}])
        self.assertEqual(r["gaps"], [{"from_block": 11, "to_block": 20}])
        # The event on the broken chain (bob, block 12) is not counted.
        self.assertEqual(r["totals"], totals(escrows_opened=1, escrows_refunded=1))
        self.assertNotIn("bob", r["by_account"])

    def test_no_pages_at_all_is_one_big_gap(self):
        with tempfile.TemporaryDirectory() as d:
            code, out, _ = run(d, 5, 9)
            r = json.loads(out)
            self.assertEqual(code, 0)
            self.assertFalse(r["complete"])
            self.assertEqual(r["gaps"], [{"from_block": 5, "to_block": 9}])
            self.assertEqual(r["covered"], [])

    def test_other_genesis_excluded_and_counted(self):
        r = census("othergen", 1, 10)
        self.assertEqual(r["excluded_other_genesis"], 2)
        self.assertEqual(r["totals"], totals(escrows_opened=1))
        self.assertNotIn("mallory", r["by_account"])
        self.assertTrue(r["complete"])

    def test_other_genesis_cannot_cover_a_range(self):
        # Pinning the other genesis flips the roles: the pinned-genesis page is now the stranger.
        r = census("othergen", 1, 10, genesis="0x" + "b2" * 32)
        self.assertEqual(r["excluded_other_genesis"], 1)
        self.assertEqual(r["totals"], totals(escrows_opened=1, escrows_released=1))

    def test_wrong_genesis_everywhere_is_partial(self):
        r = census("complete", 1, 30, genesis="0x" + "c3" * 32)
        self.assertFalse(r["complete"])
        self.assertEqual(r["excluded_other_genesis"], 7)
        self.assertEqual(r["totals"], totals())

    def test_unfinalized_go_to_pending(self):
        r = census("unfinal", 1, 10)
        self.assertEqual(r["pending_unfinalized"], 2)
        self.assertEqual(r["totals"], totals(escrows_opened=1))
        self.assertNotIn("bob", r["by_account"])

    def test_malformed_dropped(self):
        r = census("malformed", 1, 10)
        self.assertEqual(r["malformed_dropped"], 6)
        self.assertEqual(r["totals"], totals(escrows_opened=2))

    def test_account_field_order_and_totals_only(self):
        r = census("noaccount", 1, 10)
        self.assertEqual(r["totals"], totals(escrows_opened=2, channels_settled=1))
        self.assertEqual(r["by_account"], {"w": {"escrows_opened": 1}})

    def test_requested_range_clips_coverage(self):
        r = census("complete", 5, 10)
        self.assertTrue(r["complete"])
        self.assertEqual(r["covered"], [{"from_block": 5, "to_block": 10}])
        # Only blocks 5..10 count: release at 5, refund at 6, channel open at 7, transfer at 9 (ignored kind).
        self.assertEqual(r["totals"], totals(escrows_released=1, escrows_refunded=1, channels_opened=1))

    def test_request_beyond_chain_leaves_gap(self):
        r = census("complete", 1, 40)
        self.assertEqual(r["gaps"], [{"from_block": 31, "to_block": 40}])
        self.assertEqual(r["status"], "partial")

    def test_adjacent_chains_merge(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "event-pages"))
            for i, (lo, hi) in enumerate([(1, 5), (6, 10)]):
                with open(os.path.join(d, "event-pages", "%d.json" % i), "w") as f:
                    json.dump({"genesis": G, "from_block": lo, "to_block": hi, "page": 0,
                               "next_page": None, "events": []}, f)
            code, out, _ = run(d, 1, 10)
            r = json.loads(out)
            self.assertTrue(r["complete"])
            self.assertEqual(r["covered"], [{"from_block": 1, "to_block": 10}])

    def test_cyclic_chain_is_not_covered(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "event-pages"))
            for n, nxt in ((0, 1), (1, 0)):
                with open(os.path.join(d, "event-pages", "%d.json" % n), "w") as f:
                    json.dump({"genesis": G, "from_block": 1, "to_block": 5, "page": n,
                               "next_page": nxt, "events": []}, f)
            code, out, _ = run(d, 1, 5)
            self.assertFalse(json.loads(out)["complete"])

    def test_chain_without_page_zero_is_not_covered(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "event-pages"))
            with open(os.path.join(d, "event-pages", "1.json"), "w") as f:
                json.dump({"genesis": G, "from_block": 1, "to_block": 5, "page": 1,
                           "next_page": None, "events": []}, f)
            code, out, _ = run(d, 1, 5)
            self.assertFalse(json.loads(out)["complete"])

    def test_unreadable_input_exits_2(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "event-pages"))
            with open(os.path.join(d, "event-pages", "bad.json"), "w") as f:
                f.write("{not json")
            code, out, err = run(d, 1, 5)
            self.assertEqual(code, 2)
            self.assertEqual(out, "")
            self.assertIn("bad.json", err)
        code, _, err = run(os.path.join(DATA, "does-not-exist"), 1, 5)
        self.assertEqual(code, 2)
        self.assertTrue(err)

    def test_bad_range_exits_2(self):
        code, _, _ = run(os.path.join(DATA, "complete"), 9, 3)
        self.assertEqual(code, 2)

    def test_block_number_key_missing_is_malformed_but_null_is_kept(self):
        r = census("bnmissing", 1, 10)
        self.assertEqual(r["malformed_dropped"], 1)
        self.assertEqual(r["totals"], totals(escrows_opened=2))
        self.assertEqual(r["by_account"], {"bob": {"escrows_opened": 1}, "carol": {"escrows_opened": 1}})
        self.assertNotIn("alice", r["by_account"])

    def test_integers_are_judged_by_value(self):
        # page 0.0, next_page 1.0, block_number 1.0 and index 1.0 are integers; index 1.5 is not.
        r = census("floatint", 1, 10)
        self.assertTrue(r["complete"])
        self.assertEqual(r["duplicates_dropped"], 1)  # index 1.0 and index 1 are one event
        self.assertEqual(r["malformed_dropped"], 1)   # index 1.5
        self.assertEqual(r["totals"], totals(escrows_opened=2))
        self.assertEqual(r["by_account"], {"alice": {"escrows_opened": 1}, "bob": {"escrows_opened": 1}})

    def test_fractional_or_boolean_page_fields_refuse(self):
        for field, value in (("page", 0.5), ("page", True), ("from_block", 1.5), ("to_block", True)):
            with tempfile.TemporaryDirectory() as d:
                os.makedirs(os.path.join(d, "event-pages"))
                page = {"genesis": G, "from_block": 1, "to_block": 5, "page": 0, "next_page": None, "events": []}
                page[field] = value
                with open(os.path.join(d, "event-pages", "x.json"), "w") as f:
                    json.dump(page, f)
                self.assertEqual(run(d, 1, 5)[0], 2, (field, value))

    def test_next_page_false_or_fractional_refuses(self):
        for value in (False, 1.5):
            with tempfile.TemporaryDirectory() as d:
                os.makedirs(os.path.join(d, "event-pages"))
                with open(os.path.join(d, "event-pages", "x.json"), "w") as f:
                    json.dump({"genesis": G, "from_block": 1, "to_block": 5, "page": 0,
                               "next_page": value, "events": []}, f)
                self.assertEqual(run(d, 1, 5)[0], 2, value)

    def test_non_standard_json_constants_refuse(self):
        event = ('{"block_number": 1, "block_hash": "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", "finalized": true, "index": %s,'
                 ' "section": "hasStation", "method": "EscrowOpened", "data": {}}')
        texts = {
            "nan-index": '{"genesis": "%s", "from_block": 1, "to_block": 5, "page": 0, "next_page": null,'
                         ' "events": [%s]}' % (G, event % "NaN"),
            "infinity-page-field": '{"genesis": "%s", "from_block": 1, "to_block": Infinity, "page": 0,'
                                   ' "next_page": null, "events": []}' % G,
            "neg-infinity": '{"genesis": "%s", "from_block": -Infinity, "to_block": 5, "page": 0,'
                            ' "next_page": null, "events": []}' % G,
        }
        for name, text in texts.items():
            with tempfile.TemporaryDirectory() as d:
                os.makedirs(os.path.join(d, "event-pages"))
                with open(os.path.join(d, "event-pages", "x.json"), "w") as f:
                    f.write(text)
                code, out, err = run(d, 1, 5)
                self.assertEqual(code, 2, name)
                self.assertEqual(out, "", name)
                self.assertIn("x.json", err, name)

    def _page_dir(self, d, name="x.json", text=None, **over):
        os.makedirs(os.path.join(d, "event-pages"), exist_ok=True)
        page = {"genesis": G, "from_block": 1, "to_block": 5, "page": 0, "next_page": None, "events": []}
        page.update(over)
        with open(os.path.join(d, "event-pages", name), "w") as f:
            f.write(text if text is not None else json.dumps(page))

    def test_unsafe_integers(self):
        big = 2 ** 53
        for over in ({"to_block": big}, {"from_block": -big}, {"page": big}, {"next_page": big},
                     {"to_block": 1e20}):
            with tempfile.TemporaryDirectory() as d:
                self._page_dir(d, **over)
                self.assertEqual(run(d, 1, 5)[0], 2, over)
        # The largest safe value is still an integer.
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, to_block=2 ** 53 - 1)
            code, out, _ = run(d, 1, 5)
            self.assertEqual(code, 0)
            self.assertTrue(json.loads(out)["complete"])
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, to_block=2 ** 53 - 1)
            self.assertEqual(run(d, 1, 2 ** 53)[0], 2)
            self.assertEqual(run(d, 2 ** 53, 2 ** 53 + 1)[0], 2)

    def test_unsafe_event_integers_are_malformed(self):
        base = {"block_number": 2, "block_hash": "0x" + "01" * 32, "finalized": True, "index": 0,
                "section": "hasStation", "method": "EscrowOpened", "data": {"who": "a"}}
        evs = [dict(base, index=2 ** 53), dict(base, block_number=2 ** 53), dict(base, block_number=-2 ** 53),
               dict(base, index=2 ** 53 - 1, block_hash="0x" + "02" * 32, block_number=3)]
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, events=evs)
            code, out, _ = run(d, 1, 5)
            r = json.loads(out)
            self.assertEqual(r["malformed_dropped"], 3)
            self.assertEqual(r["totals"]["escrows_opened"], 1)

    def test_non_page_entries_refuse(self):
        for name in (".01.json", "01.txt", "01.json.bak", ".json", "README"):
            with tempfile.TemporaryDirectory() as d:
                self._page_dir(d, name=name)
                code, out, err = run(d, 1, 5)
                self.assertEqual(code, 2, name)
                self.assertIn(name, err)
        with tempfile.TemporaryDirectory() as d:  # folder, including one named like a page
            self._page_dir(d)
            os.makedirs(os.path.join(d, "event-pages", "sub.json"))
            self.assertEqual(run(d, 1, 5)[0], 2)
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d)
            os.makedirs(os.path.join(d, "event-pages", "sub"))
            self.assertEqual(run(d, 1, 5)[0], 2)

    def test_block_hash_must_be_lower_case_64_hex(self):
        base = {"block_number": 2, "finalized": True, "index": 0,
                "section": "hasStation", "method": "EscrowOpened", "data": {"who": "a"}}
        good = "0x" + "ab" * 32
        evs = [dict(base, block_hash=good),
               dict(base, block_hash="0x" + "AB" * 32, index=1),
               dict(base, block_hash="0x" + "ab" * 31, index=2),
               dict(base, block_hash="0x" + "ab" * 33, index=3),
               dict(base, block_hash="ab" * 32, index=4),
               dict(base, block_hash=good + "\n", index=5)]
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, events=evs)
            r = json.loads(run(d, 1, 5)[1])
            self.assertEqual(r["malformed_dropped"], 5)
            self.assertEqual(r["totals"]["escrows_opened"], 1)

    def test_symlinks_in_event_pages_refuse(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as other:
            self._page_dir(other, name="real.json")
            os.makedirs(os.path.join(d, "event-pages"))
            os.symlink(os.path.join(other, "event-pages", "real.json"),
                       os.path.join(d, "event-pages", "link.json"))
            code, out, err = run(d, 1, 5)
            self.assertEqual(code, 2)
            self.assertIn("link.json", err)
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as other:
            self._page_dir(d)
            os.symlink(other, os.path.join(d, "event-pages", "dirlink.json"))
            self.assertEqual(run(d, 1, 5)[0], 2)
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as other:
            self._page_dir(d)
            os.symlink(other, os.path.join(d, "event-pages", "dirlink"))
            self.assertEqual(run(d, 1, 5)[0], 2)

    def test_output_is_deterministic(self):
        a = run(os.path.join(DATA, "gap"), 1, 30)[1]
        b = run(os.path.join(DATA, "gap"), 1, 30)[1]
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
