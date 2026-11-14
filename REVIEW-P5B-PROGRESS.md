# Review of P5b (session grant, revoke, show): progress

Reviewer branch `claude/review-p5b-session-commands`, at the builder's head c8cc4ab.
Built: observatory and imd-flop (npm ci and npm run build, under setpriv).

## Done

- Read the review brief, the builder's brief, the record (deviations 1 to 8, L1 to L4), every file of src/session and the cli diff.

## Next

1. test/review-p5b-caps.test.ts: attack 1 to 2 (grid by own arithmetic, floats, sentence vs bytes).
2. test/review-p5b-guard.test.ts: attacks 3, 4, 7 (key, owner, genesis, days).
3. test/review-p5b-state.test.ts: attacks 5, 6, 8 (edges, room, L1, L3, L4, words vs JSON).
4. Mutants in /tmp/rev-p5b (attack 9), L2 in a copy, README and P14 (attack 10), deviations (attack 11).
5. Whole npm test once, push, read the checks, report.
