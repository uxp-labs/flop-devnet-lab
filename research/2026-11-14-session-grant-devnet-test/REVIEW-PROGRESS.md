# Review of the G-19 batch harness: progress

Reviewer on Opus, from 2026-11-14 12:00 UTC. Branch `claude/review-session-grant-devnet-test`, at the
builder's head 091bf5f. Tests of the review are `review-*.test.mjs` in this folder. No source file
is changed. Mutants are run in copies under /tmp/rev-g19/.

## Done

- Read the brief, CLAUDE.md, the builder's brief, the plan with B-1 to B-12, the record.
- Built observatory and imd-flop. The builder's tests: 79 pass.

- Attack 1: review-pane.test.mjs (RG19-1).
- Attack 2: review-signed.test.mjs (RG19-2, RG19-3, RG19-4).
- Attack 3: review-tape.test.mjs (RG19-5, RG19-6).
- Attack 4: review-next.test.mjs (RG19-7, RG19-8, RG19-9).
- Attacks 5: review-fence.test.mjs (all HOLDS).
- Attack 6: review-judge.test.mjs (RG19-10 to RG19-13).
- Attacks 7 and 9: review-scan.test.mjs (all HOLDS).

## Next

1. G9 mutants in /tmp/rev-g19/mut, against the builder's tests only
2. G11 words and printed lines; attacks 11 and 12
3. The report
