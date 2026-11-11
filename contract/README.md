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
