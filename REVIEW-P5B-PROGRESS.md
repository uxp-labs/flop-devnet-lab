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

## Next

1. Read the mutant results; run the alive ones against the review tests.
2. L2 in a copy with a shorter MaxSessionDuration (/tmp/rev-p5b/l2).
3. Whole npm test once, push, read the checks, report.
