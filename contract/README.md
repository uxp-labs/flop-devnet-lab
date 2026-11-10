# Shared rules contract (PR6 refactor step 1)

`rules.json` and `vectors/*.json` record how imd-flop (TS), spend-guard (Python) and the viewer
(`build-lane.py`) behave **today, at 3ae1cdf**. Every expectation was taken from running today's code.
This is a behavior lock for the refactor, not a specification: quirks and residuals (a)-(e) are listed
in `rules.json` as `current behavior`, not as fixes.

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
