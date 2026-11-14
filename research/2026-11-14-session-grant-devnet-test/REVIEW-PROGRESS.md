# Review of the G-19 batch harness: progress

Reviewer on Opus, from 2026-11-14 12:00 UTC. Branch `claude/review-session-grant-devnet-test`, at the
builder's head 091bf5f. Tests of the review are `review-*.test.mjs` in this folder. No source file
is changed. Mutants are run in copies under /tmp/rev-g19/.

## Done

- Read the brief, CLAUDE.md, the builder's brief, the plan with B-1 to B-12, the record.
- Built observatory and imd-flop. The builder's tests: 79 pass.

## Next

1. review-pane.test.mjs (attack 1, G1)
2. review-signed.test.mjs (attack 2, G2)
3. review-tape.test.mjs (attack 3, G3)
4. review-next.test.mjs (attack 4, G4)
5. review-fence.test.mjs (attacks 5, G5 and G6)
6. review-judge.test.mjs (attack 6, G7)
7. G8 scan, G9 mutants, G10 signer bytes, G11 words
