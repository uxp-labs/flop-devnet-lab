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

- Attack 8: 38 mutants in /tmp/rev-g19/mut against the builder's 12 test files (review-mutants.json).
  Alive: M2, M8 (equivalent for the bytes), M18, M19, M27, M38. review-mutants.test.mjs kills the five.
- Whole folder: 117 tests, 104 pass, 13 fail (the 13 DEFECT tests).

## Second reviewer (Opus, from 2026-11-14 after the first stopped)

- Built trees found in place. Reran the whole folder: 117 tests, 104 pass, 13 fail, the 13 DEFECT tests.
- Read each DEFECT test and the source it names.
- Attack 4, the hand edited record: review-record.test.mjs RG19-14 (replay holds no runner reading
  to its sent_sha256 and no block to its block tape).
- Attack 10: plan.mjs next over every state of the rehearsal's walk (driver in /tmp/rev-g19/att10)
  and over the committed rehearsal-run and an empty run folder. RG19-15 (G2 refused with a fee above
  the most is the end, not a stop). HOLDS: no balances is "not run", exit 4; the printed lines name
  only $LAB and $KEY_OWNER and files that exist.
- Attacks 11 and 12: read, in the report.
- Whole folder: 121 tests, 106 pass, 15 fail (the 15 DEFECT tests).

## Next

1. Nothing. The report is handed back.
