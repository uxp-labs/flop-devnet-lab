# Review of P5b (session grant, revoke, show): progress

Reviewer branch `claude/review-p5b-session-commands`, at the builder's head c8cc4ab.
Built: observatory and imd-flop (npm ci and npm run build, under setpriv).

## Done

- Read the review brief, the builder's brief, the record (deviations 1 to 8, L1 to L4), every file of src/session and the cli diff.
- test/review-p5b-caps.test.ts (attacks 1, 2): 21 HOLDS pass; RP5B-1 fails (3 tests).
- test/review-p5b-guard.test.ts (attacks 3, 4, 7): 89 pass; RP5B-2 (6) and RP5B-3 (7) fail.
- test/review-p5b-state.test.ts (attacks 5, 6, 8): 38 pass; RP5B-4 (L3), RP5B-5 (L1), RP5B-6 (L4, 2 tests) fail.
- README read against the code (attack 10); P14 holds (diff list, encoder importers).
- Mutants: /tmp/rev-p5b/mutants.json, runner /tmp/rev-p5b/run-mutants.mjs, copy /tmp/rev-p5b/base (git archive). Results in /tmp/rev-p5b/builder-run.txt.

- Mutants: 38 plus 3 restated; 7 alive under the builder's tests (M18, M26, M27, M28, M30, M34, M36), all killed by review HOLDS tests (test/review-p5b-fields.test.ts added for four).
- L2: test/review-p5b-days-table.test.ts (a mocked table, half the MaxSessionDuration): RP5B-7.
- Whole npm test at f17f996: 114 files, 2878 tests, 21 failed (all DEFECT RP5B), 2856 passed, 1 skipped.

## Next

1. Read the GitHub checks of the last commit and hand back the report.
