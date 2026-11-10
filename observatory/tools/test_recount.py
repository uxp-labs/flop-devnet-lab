"""Tests for tools/recount.py. Run from the package root:
python3 -I -m unittest tools/test_recount.py
"""
import ast
import builtins
import json
import os
import re
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


ALLOWED_IMPORTS = {"json", "os", "re", "stat", "sys"}
# Every use of a module, as the full dotted name. Each is a read, a parse or a print; anything
# else, an alias of a module or of part of one included, is not on the list.
ALLOWED_CHAINS = {
    "json.dumps", "json.loads", "os.fsencode", "os.listdir", "os.lstat", "os.path.isdir",
    "os.path.join", "re.compile", "re.fullmatch", "stat.S_ISDIR", "stat.S_ISREG", "sys.argv",
    "sys.exit", "sys.stderr",
}
# The builtins recount.py uses, and no others: type, help, vars, memoryview and the rest reach
# objects, pagers and files a recount has no use for (round 8 review L6). A builtin off this list
# is refused wherever its name appears, as a name of the module's own too, so it cannot be kept
# under its own name (type = type) or as a parameter's default.
ALLOWED_BUILTINS = {
    "Exception", "FileNotFoundError", "OSError", "RecursionError", "UnicodeDecodeError", "ValueError",
    "__name__", "all", "any", "bool", "chr", "dict", "float", "int", "isinstance", "len", "list", "max",
    "min", "open", "ord", "print", "set", "sorted", "str", "sum", "super",
}
BUILTIN_NAMES = set(dir(builtins))
BANNED_NAMES = {"eval", "exec", "compile", "__import__", "__builtins__", "builtins", "getattr", "setattr",
                "delattr", "globals", "locals", "vars", "breakpoint", "input", "importlib", "subprocess", "socket"}
# Frame, code and traceback attributes: a generator's or a coroutine's frame holds the module's
# globals and builtins, so g().gi_frame.f_globals["os"] reaches os without naming it (r8 L6).
FRAME_ATTR = re.compile(r"(?:gi|cr|ag|f|tb|co)_")
# open takes a file and a mode, by position or as mode=, and only these words besides.
OPEN_KEYWORDS = {"mode", "encoding", "errors", "newline"}
# A class's method resolution order hands over object, which every value is an instance of
# (round 9 review L1).
BANNED_ATTRS = {"mro"}
# The attributes recount.py uses, and no others (Fable review r10 I5): an attribute off this list,
# sys.stderr.buffer.raw say, reaches what a recount has no use for. A new one is added here, read.
ALLOWED_ATTRS = {
    "S_ISDIR", "S_ISREG", "__init__", "add", "append", "argv", "compile", "count", "decode", "dumps",
    "encode", "endswith", "exit", "extend", "fsencode", "fullmatch", "get", "is_integer", "isdir",
    "items", "join", "kind", "listdir", "loads", "lstat", "lstrip", "path", "pop", "read",
    "setdefault", "st_mode", "startswith", "stderr", "values",
}


def _dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    return ".".join([node.id] + parts[::-1]) if isinstance(node, ast.Name) else None


def _bound(tree):
    """Every name the code binds anywhere: imports, definitions, parameters, assignment, loop and
    with targets, except and match names, global and nonlocal names."""
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names |= {(a.asname or a.name).split(".")[0] for a in node.names}
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names |= set(node.names)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            names.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            names.add(node.rest)
    return names


def scan_problems(code):
    """What the read-only scan finds in Python source (Fable review r7 L5 and r8 L6): an import
    outside the allow-list, any from-import, a module used other than through one of the allowed
    dotted names (so an alias, argparse._os or os.path kept in a variable all fail), a name that is
    neither one the code binds nor an allowed builtin, a builtin off the list wherever it appears,
    an attribute that starts with an underscore (but super().__init__) or names a frame, code or
    traceback field, a name that runs code or reaches processes and sockets, and open used other
    than in a direct call for reading with a plain file and mode."""
    tree = ast.parse(code)
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    bound = _bound(tree)
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found += ["import " + a.name for a in node.names if a.name.split(".")[0] not in ALLOWED_IMPORTS]
            # An alias is a module under a name the dotted name rule never reads (round 9 review M2),
            # and a dotted import loads a submodule off the list (r10 I5).
            found += ["imports %s as %s" % (a.name, a.asname) for a in node.names if a.asname is not None]
            found += ["imports the submodule %s" % a.name for a in node.names if "." in a.name]
        elif isinstance(node, ast.ImportFrom):
            found.append("from %s import" % node.module)
        elif isinstance(node, ast.Match):
            # A class pattern reads any attribute by its keyword, out of reach of the attribute
            # rules below (round 9 review L1); recount.py has no use for match.
            found.append("a match statement")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.arg)):
            name = node.arg if isinstance(node, ast.arg) else node.name
            if name in BUILTIN_NAMES and name not in ALLOWED_BUILTINS:
                found.append("binds the builtin name %s" % name)
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("_"):
                own_init = node.attr == "__init__" and isinstance(node.value, ast.Call) \
                    and isinstance(node.value.func, ast.Name) and node.value.func.id == "super"
                if not own_init:
                    found.append("reaches ." + node.attr)
            elif FRAME_ATTR.match(node.attr):
                found.append("reaches the frame, code or traceback field ." + node.attr)
            elif node.attr in BANNED_ATTRS:
                found.append("reaches ." + node.attr)
            elif node.attr not in ALLOWED_ATTRS:
                found.append("reaches .%s, an attribute recount.py does not use" % node.attr)
        if not isinstance(node, ast.Name):
            continue
        if node.id in ALLOWED_IMPORTS:
            top = node
            while isinstance(parents.get(top), ast.Attribute) and parents[top].value is top:
                top = parents[top]
            if _dotted(top) not in ALLOWED_CHAINS:
                found.append("uses %s" % (_dotted(top) or node.id))
            continue
        if node.id in BANNED_NAMES:
            found.append(node.id)
        elif node.id in BUILTIN_NAMES and node.id not in ALLOWED_BUILTINS:
            found.append("uses the builtin %s" % node.id)
        elif node.id not in BUILTIN_NAMES and node.id not in bound:
            found.append("uses %s, which the code never binds" % node.id)
        if node.id == "open":
            call = parents.get(node)
            if not (isinstance(call, ast.Call) and call.func is node):
                found.append("open used other than in a call")
                continue
            if any(isinstance(a, ast.Starred) for a in call.args) or any(k.arg is None for k in call.keywords):
                found.append("open with a starred argument")
                continue
            if len(call.args) > 2 or any(k.arg not in OPEN_KEYWORDS for k in call.keywords):
                found.append("open with more than a file, a mode, an encoding, errors and newline")
            mode = call.args[1] if len(call.args) > 1 else next((k.value for k in call.keywords if k.arg == "mode"), None)
            if mode is not None and not (isinstance(mode, ast.Constant) and mode.value in ("r", "rb")):
                found.append("open for writing")
    return found


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

    def test_request_numbers_are_ascii_digits_only(self):
        # Python's int() takes all of these; the TypeScript command refuses them (Fable review L11).
        for text in (" 0", "0 ", "+5", "1_0", "-1", "0x10", "1e3", "\u0663", ""):
            code, out, err = run(os.path.join(DATA, "complete"), text, 10)
            self.assertEqual(code, 2, repr(text))
            self.assertEqual(out, "", repr(text))
            # An empty value is a flag with no value (Fable review r9 L3), a request problem too.
            why = "--from needs a value" if text == "" else "--from must be a non-negative integer"
            self.assertIn("census refused (request): " + why, err, repr(text))
        code, _, err = run(os.path.join(DATA, "complete"), 1, "1_0")
        self.assertEqual(code, 2)
        self.assertIn("census refused (request): --to must be a non-negative integer", err)
        self.assertEqual(run(os.path.join(DATA, "complete"), "01", "10")[0], 0)
        # Fable review r7 L4: a number too long for int(), refused as a request, never a traceback.
        code, out, err = run(os.path.join(DATA, "complete"), 1, "9" * 5000)
        self.assertEqual((code, out), (2, ""))
        self.assertIn("census refused (request): --to is too large to be a safe integer", err)
        self.assertEqual(run(os.path.join(DATA, "complete"), "0" * 30 + "1", "10")[0], 0)

    def test_an_empty_genesis_is_a_flag_with_no_value(self):
        # Fable review r9 L3: an empty value (an unset shell variable) is a flag with no value,
        # a request problem on both sides, never the flag left out.
        code, out, err = run(os.path.join(DATA, "complete"), 1, 10, genesis="")
        self.assertEqual((code, out), (2, ""))
        self.assertIn("census refused (request): --genesis needs a value", err)

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

    def test_duplicate_key_refuses(self):
        ev = '{"block_number": 2, "block_hash": "0x%s", "finalized": true, "index": 0, "section": "hasStation", ' \
             '"method": "EscrowOpened", "method": "EscrowReleased", "data": {"who": "a"}}' % ("01" * 32)
        page = '{"genesis": "%s", "from_block": 1, "to_block": 5, "page": 0, "next_page": null, "events": [%s]}' % (G, ev)
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, text=page)
            code, _, err = run(d, 1, 5)
            self.assertEqual(code, 2)
            self.assertIn('the key "method" appears twice in one object', err)
        # The same key in two sibling objects is fine, and so is an escaped key that differs.
        evs = '{"index": 0, "a": 1}, {"index": 1, "\\u0062": 2, "a": 3}'
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, text='{"genesis": "%s", "from_block": 1, "to_block": 5, "page": 0, "next_page": null, "events": [%s]}' % (G, evs))
            self.assertEqual(run(d, 1, 5)[0], 0)
        # An escaped copy of a key is the same key.
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, text='{"genesis": "%s", "from_block": 1, "to_block": 5, "page": 0, "\\u0070age": 0, "next_page": null, "events": []}' % G)
            self.assertEqual(run(d, 1, 5)[0], 2)

    def test_page_name_not_utf8_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, name="00.json")
            try:
                with open(os.path.join(os.fsencode(d), b"event-pages", b"01-\xff.json"), "w") as f:
                    f.write("{}")
            except OSError:
                self.skipTest("this filesystem refuses names that are not UTF-8")
            code, _, err = run(d, 1, 5)
            self.assertEqual(code, 2)
            self.assertTrue(err.startswith("census refused (page-file): event-pages/01-%FF.json: not a page file (its name is not valid UTF-8)"), err)

    def test_refusal_names_its_reason_file_problems_first(self):
        # Clause 16: a page file problem is named before a page structure problem, whatever the order.
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, name="00.json", page=-1)
            self._page_dir(d, name="01.json", text='{"genesis": ')
            code, _, err = run(d, 1, 5)
            self.assertEqual(code, 2)
            self.assertTrue(err.startswith("census refused (page-file): event-pages/01.json: cannot read"), err)
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, name="00.json", page=-1)
            code, _, err = run(d, 1, 5)
            self.assertTrue(err.startswith("census refused (page-structure): 00.json"), err)
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, name="00.json", text='{"genesis": ')
            code, _, err = run(d, 5, 1)
            self.assertTrue(err.startswith("census refused (request): "), err)

    def test_negative_from_block_refuses(self):
        ev = {"block_number": -5, "block_hash": "0x" + "01" * 32, "finalized": True, "index": 0,
              "section": "hasStation", "method": "EscrowOpened", "data": {"who": "a"}}
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, from_block=-10, events=[ev])
            code, _, err = run(d, 0, 5)
            self.assertEqual(code, 2)
            self.assertIn("bad page number or block range", err)
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, from_block=0)
            self.assertEqual(run(d, 0, 5)[0], 0)

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

    def _ev(self, bn, idx=0, h="ab", **kw):
        e = {"block_number": bn, "block_hash": "0x" + h * 32, "finalized": True, "index": idx,
             "section": "hasStation", "method": "EscrowOpened", "data": {"who": "a"}}
        e.update(kw)
        return e

    def test_mixed_copies_are_malformed_all_outside_skipped(self):
        # Page covers 1..10, request 1..10. Copies of one key: block 5 (inside) and 50 (outside).
        mixed1 = [self._ev(5), self._ev(50)]
        mixed2 = [self._ev(5, idx=1, h="cd"), self._ev(50, idx=1, h="cd"), self._ev(60, idx=1, h="cd")]
        outside = [self._ev(70, idx=2, h="ef"), self._ev(71, idx=2, h="ef")]
        fine = [self._ev(3, idx=3, h="12")]
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, to_block=10, events=mixed1 + mixed2 + outside + fine)
            r = json.loads(run(d, 1, 10)[1])
            self.assertEqual(r["malformed_dropped"], 2)
            self.assertEqual(r["duplicates_dropped"], 1 + 2)
            self.assertEqual(r["totals"]["escrows_opened"], 1)
            self.assertEqual(r["pending_unfinalized"], 0)

    def test_mixed_by_request_range(self):
        # Page covers 1..10 but the request is 1..4; copies at 3 and 8 straddle the request.
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, to_block=10, events=[self._ev(3), self._ev(8)])
            r = json.loads(run(d, 1, 4)[1])
            self.assertEqual((r["malformed_dropped"], r["duplicates_dropped"]), (1, 1))
            self.assertEqual(r["totals"]["escrows_opened"], 0)

    def test_malformed_and_out_of_range_is_skipped(self):
        bad = self._ev(50)
        del bad["section"]
        inside_bad = self._ev(5, idx=1)
        del inside_bad["section"]
        with tempfile.TemporaryDirectory() as d:
            self._page_dir(d, to_block=10, events=[bad, inside_bad])
            r = json.loads(run(d, 1, 10)[1])
            self.assertEqual(r["malformed_dropped"], 1)

    def test_event_pages_must_be_a_folder(self):
        with tempfile.TemporaryDirectory() as d:  # regular file
            with open(os.path.join(d, "event-pages"), "w") as f:
                f.write("x")
            code, out, err = run(d, 1, 5)
            self.assertEqual(code, 2)
            self.assertIn("event-pages", err)
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as other:  # link to a folder
            self._page_dir(other)
            os.symlink(os.path.join(other, "event-pages"), os.path.join(d, "event-pages"))
            self.assertEqual(run(d, 1, 5)[0], 2)
        with tempfile.TemporaryDirectory() as d:  # missing folder is still just no pages
            code, out, _ = run(d, 1, 5)
            self.assertEqual(code, 0)
            self.assertFalse(json.loads(out)["complete"])

    def test_recount_reads_files_only(self):
        """recount.py, read as a syntax tree: it imports exactly the five modules it needs and makes
        no call that could start a process, open a socket, run code from a string or write a file."""
        with open(RECOUNT, encoding="utf-8") as fh:
            code = fh.read()
        self.assertEqual(scan_problems(code), [])
        names = {a.name.split(".")[0] for n in ast.walk(ast.parse(code)) if isinstance(n, ast.Import) for a in n.names}
        self.assertEqual(names, ALLOWED_IMPORTS)

    def test_the_scan_catches_every_form(self):
        # Fable review L12 and r7 L5: the old line scan read only the first name of an import line
        # and five os calls. Each of these must be found; each of the good ones must pass.
        bad = ("import json, socket", "import os, subprocess", "from os import system", "x = 1; import socket",
               "if True: import socket", "import urllib.request", "import http.client", "import importlib",
               'os.posix_spawn("/bin/sh", [], {})', 'getattr(os, "sys" + "tem")("id")', 'os.system("id")',
               'os.popen("id")', 'os.remove("x")', 'eval("1")', 'exec("1")', '__import__("socket")',
               'open("x", "w")', 'open("x", mode="a")', 'open("x", "r+")',
               # Fable review r7 L5: reached through another module, an alias, or open kept in a name.
               'argparse._os.system("id")', 'argparse._os.popen("id")', 'p = os.path\nq = p.os\nq.system("id")',
               'argparse._sys.modules["o" "s"].system("id")', 'f = open\nf("x", "w")', 'argparse.FileType("w")("x")',
               'json.decoder.scanner.__loader__.load_module("sock" "et")', 'm = os', 'x = (1).__class__',
               # Fable review r8 L6: a frame's globals and builtins, open with starred arguments
               # or an opener, and builtins that reach a file type or a pager.
               'def g():\n    yield\nfr = g().gi_frame\nfr.f_globals["os"].system("id")',
               'def g():\n    yield\ng().gi_frame.f_builtins["exec"]("x = 1")',
               'async def c():\n    pass\nc().cr_frame.f_globals["os"].popen("id")',
               'tb = None\ntb.tb_frame.f_back', 'open("x", **{"mode": "w"})', 'open(*["x", "w"])',
               'open("x", "r", opener=os.open)', 'open("x", "r", 1)', 'e = sys.stderr\ntype(e.buffer.raw)("x", "w")',
               'help("os")', 'type = 1', 'def f(t=type):\n    return t', 'def f(type):\n    return 1',
               'x = memoryview(b"")', 'import argparse', 'argparse.FileType("w")', 'x = y',
               # Fable review r9 M2 and L1: a module under an alias, and a match class pattern
               # that reads attributes by keyword.
               'import os as o\no.system("id")', 'import json, os as o\no.popen("id")',
               'import os.path as p\nx = p.os\nx.system("id")', 'import sys as s\ns.modules',
               'import re as r, stat as st\nr.compile("x")',
               'O = Exception.mro()[2]\nmatch os.path.join:\n    case O(__globals__=gl):\n        gl["os"].system("id")',
               'O = str.mro()[1]\nmatch os.listdir:\n    case O(__self__=m):\n        m.system("id")',
               'def g():\n    yield\nmatch g():\n    case object(gi_frame=fr):\n        pass',
               'match sys.stderr:\n    case Exception(__traceback__=tb):\n        pass',
               'x = Exception.mro()',
               # Fable review r10 I5: a submodule import, and a write reached through stderr.
               'import json.tool', 'import re, json.decoder', 'e = sys.stderr\ne.buffer.raw.truncate(0)')
        for code in bad:
            self.assertNotEqual(scan_problems(code), [], code)
        good = ("import os", 'os.path.join("a", "b")', 'open("x", "r", encoding="utf-8")', 'os.lstat("x")',
                "class E(Exception):\n    def __init__(self, m):\n        super().__init__(m)",
                "for i in [1, 2]:\n    print(len(str(i)), file=sys.stderr)", 'with open("x", "rb") as fh:\n    data = fh.read()')
        for code in good:
            self.assertEqual(scan_problems(code), [], code)

    def test_arguments_read_like_the_typescript_command(self):
        """RULES.md 3.1 clause 16 and Fable review r8 L7: every flag is --name and then its value,
        so each of these is a request problem, as src/cli.ts reads it, and none reaches the pages."""
        d = os.path.join(DATA, "complete")
        cases = {
            "value after =": ["--dir", d, "--genesis=" + G, "--from", "1", "--to", "30"],
            "abbreviated flag": ["--dir", d, "--gen", G, "--from", "1", "--to", "30"],
            "unknown flag": ["--dir", d, "--genesis", G, "--from", "1", "--to", "30", "--form", "5"],
            "value that starts with a dash": ["--dir", d, "--genesis", G, "--from", "-a", "--to", "30"],
            "negative number": ["--dir", d, "--genesis", G, "--from", "-5", "--to", "30"],
            "flag with no value at the end": ["--dir", d, "--genesis", G, "--from", "1", "--to"],
            "flag whose value is a flag": ["--dir", d, "--genesis", G, "--from", "--to", "30"],
            "flag with an empty value": ["--dir", "", "--genesis", G, "--from", "1", "--to", "30"],
            "flag given twice": ["--dir", d, "--genesis", G, "--from", "1", "--from", "2", "--to", "30"],
            "argument that is no flag's value": ["--dir", d, "--genesis", G, "--from", "1", "--to", "30", "extra"],
            "flag left out": ["--dir", d, "--from", "1", "--to", "30"],
            "help": ["--help"],
            "nothing": [],
        }
        for name, args in cases.items():
            p = subprocess.run([sys.executable, "-I", RECOUNT, *args], capture_output=True, text=True)
            self.assertEqual(p.returncode, 2, name)
            self.assertTrue(p.stderr.startswith("census refused (request): "), (name, p.stderr))
            self.assertEqual(p.stdout, "", name)
        # The same flags in another order are read the same.
        p = subprocess.run([sys.executable, "-I", RECOUNT, "--to", "30", "--genesis", G, "--from", "1", "--dir", d],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout), census("complete", 1, 30))

    def test_file_names_show_specials_as_bytes(self):
        """Fable review r9 I2 and r10 I2: a page file name that is UTF-8 is shown as itself but for
        %, control characters and line separators, each as %XX of its UTF-8 bytes, as the
        TypeScript loader shows it."""
        for name, shown in (("01%FF.json", "01%25FF.json"), ("02\na.json", "02%0Aa.json"),
                            ("03\u0085b.json", "03%C2%85b.json"), ("04\u2028c.json", "04%E2%80%A8c.json"),
                            ("05\u00e9d.json", "05\u00e9d.json"), ("06\u001fe.json", "06%1Fe.json"),
                            ("07\u007ff.json", "07%7Ff.json"), ("08\u2029g.json", "08%E2%80%A9g.json"),
                            ("09\u009fh.json", "09%C2%9Fh.json")):
            with tempfile.TemporaryDirectory() as d:
                os.mkdir(os.path.join(d, "event-pages"))
                with open(os.path.join(d, "event-pages", name), "w", encoding="utf-8") as fh:
                    fh.write("{ not json")
                code, out, err = run(d, 0, 10)
                self.assertEqual((code, out), (2, ""), name)
                self.assertTrue(err.startswith("census refused (page-file): event-pages/%s: cannot read" % shown), (name, err))
                self.assertEqual(len(err.rstrip("\n").split("\n")), 1, name)

    def test_page_structure_names_show_specials_as_bytes(self):
        """Sixth rerun U3: each of the six page structure refusals names its file the same way as
        the page file refusals above."""
        g = '"genesis": "x"'
        cases = (
            ("01%x.json", "01%25x.json", "[]", "page is not an object"),
            ("02\na.json", "02%0Aa.json", "{}", "genesis missing or not a string"),
            ("03\u007fb.json", "03%7Fb.json", "{%s}" % g, "from_block missing or not an integer"),
            ("04\u2029c.json", "04%E2%80%A9c.json", '{%s, "from_block": 5, "to_block": 1, "page": 0}' % g, "bad page number or block range"),
            ("05\u0085d.json", "05%C2%85d.json", '{%s, "from_block": 0, "to_block": 1, "page": 0}' % g, "next_page missing or not an integer or null"),
            ("06\u001fe.json", "06%1Fe.json", '{%s, "from_block": 0, "to_block": 1, "page": 0, "next_page": null}' % g, "events missing or not a list"),
        )
        for name, shown, body, reason in cases:
            with tempfile.TemporaryDirectory() as d:
                os.mkdir(os.path.join(d, "event-pages"))
                with open(os.path.join(d, "event-pages", name), "w", encoding="utf-8") as fh:
                    fh.write(body)
                code, out, err = run(d, 0, 10)
                self.assertEqual((code, out), (2, ""), name)
                self.assertEqual(err, "census refused (page-structure): %s: %s\n" % (shown, reason), name)

    def test_missing_folder_is_named_in_one_line(self):
        """Sixth rerun U8: a scenario folder that does not exist is named as a page file is, so a
        line break in its name is shown as %0A."""
        with tempfile.TemporaryDirectory() as d:
            code, out, err = run(os.path.join(d, "no\nsuch-folder"), 0, 10)
            self.assertEqual((code, out), (2, ""))
            self.assertEqual(err, "census refused (input): scenario dir not found: %s\n" % os.path.join(d, "no%0Asuch-folder"))

    def test_event_pages_not_a_folder_is_named_in_one_line(self):
        """Seventh rerun U4: the folder an event-pages refusal names is shown as a page file is."""
        with tempfile.TemporaryDirectory() as d:
            scenario = os.path.join(d, "a\nb")
            os.mkdir(scenario)
            with open(os.path.join(scenario, "event-pages"), "w", encoding="utf-8") as fh:
                fh.write("not a folder")
            code, out, err = run(scenario, 0, 10)
            self.assertEqual((code, out), (2, ""))
            self.assertEqual(err, "census refused (page-file): event-pages: not a folder (%s)\n" % os.path.join(d, "a%0Ab", "event-pages"))

    def test_event_pages_that_cannot_be_read_or_listed_refuse_as_a_page_file_problem(self):
        """Third IMD audit J8: a folder the recount may not open is a page file problem, as the
        TypeScript census reads it, never a folder with no pages. Root opens any folder, so here the
        call fails on purpose, in the recount's own process."""
        import importlib.util
        from unittest import mock
        spec = importlib.util.spec_from_file_location("recount_under_test", RECOUNT)
        rc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rc)
        real_lstat = os.lstat

        def denied(*args):
            raise PermissionError(13, "Permission denied")

        def lstat_denied_on_event_pages(path, *args):
            if str(path).endswith("event-pages"):
                denied()
            return real_lstat(path, *args)

        for name, fake, words in [("listdir", denied, "event-pages: cannot list"),
                                  ("lstat", lstat_denied_on_event_pages, "event-pages: cannot stat")]:
            with self.subTest(call=name), mock.patch.object(rc.os, name, side_effect=fake):
                with self.assertRaises(rc.Unreadable) as caught:
                    rc.load_pages(os.path.join(DATA, "complete"))
                self.assertEqual(caught.exception.kind, "page-file")
                self.assertTrue(str(caught.exception).startswith(words), str(caught.exception))

    def test_output_is_deterministic(self):
        a = run(os.path.join(DATA, "gap"), 1, 30)[1]
        b = run(os.path.join(DATA, "gap"), 1, 30)[1]
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
