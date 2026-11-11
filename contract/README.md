# Shared rules contract (PR6 refactor step 1)

`rules.json` and `vectors/*.json` record how imd-flop (TS), spend-guard (Python) and the viewer
(`build-lane.py`) behave. They were first written at 3ae1cdf as a behavior lock for the refactor, not a
specification: every expectation was taken from running that day's code, and quirks and residuals (a)-(e)
were listed in `rules.json` as `current behavior`, not as fixes.

Since then the files also record fixes. A fix moves the expectations it changes and marks its quirk or
known defect `fixed`, with the new behavior next to the old summary. An entry still marked
`current behavior` is a snapshot of the code, not a statement of intent.

This folder holds data and its format only; the loaders are test code outside it. Each part loads these same files:

| Part | Test | Loader |
|---|---|---|
| imd-flop | `imd-flop/test/contract.test.ts` | `imd-flop/test/lib/contract-vectors.ts` |
| spend-guard | `spend-guard/test_contract_vectors.py` | `testlib/contract_vectors.py` |
| viewer | `viewer/test_contract_vectors.py` | `testlib/contract_vectors.py` |

## Vector shape

```json
{ "id": "unique-id", "rule": "quote.pad", "input": { ... },
  "expect": { "imd-flop": { ... }, "spend-guard": { ... }, "viewer": { "not_applicable": "why" } },
  "quirks": ["Q-..."] }
```

- `expect` names all three parts. A part either has an expectation, which its test asserts, or
  `{"not_applicable": "<reason>"}`. Nothing is skipped silently; every suite checks the shape.
- `rule` selects the adapter in each part's test (one adapter per rule per part).
- `{"$float": "nan" | "inf" | "-inf"}` stands for a non-finite float.
- `quirks` link to `rules.json` quirks. Every quirk there must be pinned by at least one vector.
- `label_rules` (optional) lists FIXER viewer rule ids from `rules.json` `viewer_label_rules`. Every rule
  id must be named by at least one vector; on a known_defect vector they are the rules its target follows.
- `status: "known_defect"` (with `defect` and `target`): `expect` is today's exact output and is
  asserted; `target` is the agreed label and is **not** asserted. The commit that fixes the defect moves
  `target` into `expect` and sets `status: "fixed"` (keeping `defect`, dropping `target`). See `rules.json` `vector_status` and `known_defects`.

The viewer's 24-case row matrix lives next to the viewer (`viewer/fixtures/c7-matrix.json`,
`viewer/snapshots/c7-matrix/`, `viewer/test_c7_matrix_snapshot.py`) because only the viewer renders rows.

## Money stage 1

Money stage 1 records the exact amount the gateway already gives, in base units (10^18 per FLOP), beside
the float figures. The cap still runs on the float figures.

- `rules.json` constants `EXACT_AMOUNT_BOUND` (2^128, a digit string because a JSON number cannot hold it
  exactly) and `FLOP_DECIMALS` (18) are the two constants the exact amount rule rests on.
- `vectors/exact-amount.json` (rule `amount.exact`) pins the exact amount rule for imd-flop and the viewer.
  An exact amount is a JSON string. A vector whose input has no `value` key stands for a missing field.
- `vectors/rounding.json` (rule `rounding.floor6`) pins room left rounding down, for imd-flop and the viewer
  (known defect KD-10, fixed).
- The `amount.min_cap` vectors in `vectors/amount-text.json` pin the refusal of a cap or budget below
  `MIN_CAP` in imd-flop (known defect KD-11, fixed).
- The settlement vectors carry `spend_raw`, the ledger row's exact spend, and the `viewer.exact_spend`
  vectors in `vectors/viewer-labels.json` pin how the viewer shows it.

## Review fixes 2

- `rules.json` constant `AMOUNT_MAX`: a float amount above it is unknown in imd-flop
  (`amount.ts knownAmount`) and the viewer (`build-lane.py amount`). The `amount.json` vectors and
  `reconcile-amounts-above-2-53-are-unknown` pin it. It was 2^53 - 1. Since the swarm audit of 33f3b9f
  (finding 5) it is 1e9 FLOP. Up to there an amount x is on the 6 decimal grid when
  `n = floor(x * 1e6 + 0.5)` gives back the same double (`n / 1e6 === x`), and then n is its exact count of
  millionths. Day and job totals are exact sums of those counts, with no tolerance anywhere (review of the
  audit 33f3b9f fixes, defect 1). A total of exactly `AMOUNT_MAX` is a known amount, one millionth above is not.
- `vectors/cap-compare.json` rule `cap.daily_left` (finding 9) pins one daily cap decision for imd-flop and the
  viewer, made in millionths: over when the charge is above the cap less the spend. `fixtures/cap-triples/`
  holds 2000 random triples around the cap that both parts must answer the same way.
- `rules.json` constant `LEDGER_PROVIDERS` and `vectors/ledger-placement.json` (rule `ledger.placement`) pin
  a ledger row that cannot be placed in a total: imd-flop refuses the next call and names the line, and the
  viewer flags the row and never shows it green.
- `vectors/rounding.json` rule `rounding.ceil6` pins the total already charged rounding up, and residual
  `R-g` says what rounding can still do to amounts off the 6 decimal grid.

## Review fixes 3

- `vectors/ledger-placement.json` gains the request id and year 0000 vectors, and `vectors/viewer-labels.json`
  the `viewer.past_admitted` rule.

## The ledger text contract (review fixes 4)

imd-flop and the viewer read the same ledger.jsonl. They read its text by one rule, and implement nothing else
(imd-flop `src/ledger-text.ts`, the viewer `build-lane.py read_ledger_text`). `rules.json` constants
`LEDGER_TEXT` and `REQUEST_ID` hold it.

- The file is bytes. Each line is decoded as UTF-8 the way Node does it: an invalid byte becomes U+FFFD, and it
  never aborts the file.
- Lines end at `\n` only. A `\r` is an ordinary character (and JSON whitespace between tokens).
- Lines are numbered from 1, blank ones included. A final empty piece after the last `\n` is not a line.
- A line is blank when every character is in `LEDGER_TEXT.blank`: exactly the characters JavaScript's
  `String.prototype.trim` removes, which is what imd-flop already did. So `\x1c` to `\x1f` and U+0085 are not
  blank.
- A line nested deeper than 32 levels (`LEDGER_TEXT.max_depth`) is an unreadable line: `nested too deep`. The row
  object itself is level 1. Depth is counted on the line's text before parsing, so the answer is the same
  whether or not the line is valid JSON: `{` and `[` outside a JSON string open a level, `}` and `]` close one,
  and a string runs from an unescaped `"` to the next unescaped `"`. Without a limit `JSON.parse` read a far
  deeper line and Python's `json` did not (swarm audit 33f3b9f, finding 8).
- Any other line that is not blank is one JSON value in `JSON.parse`'s grammar, and it must be an object.
  Anything else is an unreadable line: `not valid JSON` (NaN, Infinity and -Infinity included, and a BOM before
  the value) or `not a JSON object`.
- A number is a double in both parts. The viewer parses a JSON integer as `float(text)` and keeps it as an int
  only when that double is integral and at most 2^53 - 1. So a 4300 digit integer is Infinity in both parts, an
  unknown amount, and never meets Python's limit on digits.
- A boolean is never a number: `false` is not 0.
- Rows are grouped by `REQUEST_ID` (1 to 128 printable ASCII characters, no space). A row without such a request
  id is a group of its own, keyed by its line.
- A receipt file is the whole file decoded the same way: one JSON value in `JSON.parse`'s grammar that must be an
  object, nested at most 32 levels like a line (`fixtures/receipt-text/`, read by both parts).
- The writer rule: imd-flop starts every row it appends on a fresh line, so when the file is not empty and its
  last byte is not `\n`, it writes `\n` before the row in the same write (`imd-flop/src/store.ts`
  `appendJsonlSafe`).

`fixtures/ledger-text/` holds the cases as raw bytes, one file each, and `expectations.json` says for each file
how many lines it has, which are blank, which are unreadable and why, how the readable rows group, and each
readable row's `cap_charge` as a known amount. `imd-flop/test/ledger-text.test.ts` and
`viewer/test_ledger_text.py` both read every fixture and check those expectations. The cases: an empty file, a
torn last line, a torn line with a row the writer appended after it, a last line with no newline, a bare `\r` joining two rows and between tokens, `\r\n`, `\x1c` to
`\x1f`, U+0085 and a bare 0x85 byte, every blank character, a BOM, invalid UTF-8 inside a string and between
tokens, NaN and Infinity, numbers past a double (4300 digits, 2^53 + 1, 1e400), booleans, values that are not
objects, a raw control character in a string, escaped surrogates, grouping, unusable request ids, duplicate
keys, nesting at 32, 33 and 10000 levels, and brackets inside strings.
