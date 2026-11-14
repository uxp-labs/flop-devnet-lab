# Review A1 progress

Started 2026-11-14 05:00 UTC. Reviewer of 27df5cc. Copies outside the repo: /tmp/rev-a1-main (main 3639e23), /tmp/rev-a1-at-<commit>.

Done:
- attack 1: scripts rerun on copies at 9676cd8 and 27df5cc reproduce both generated files; suite at 9676cd8 passes (1908 tests, 1 skipped)
- attack 3 and 4 probed (scratch, not committed): class instance signer and inherited runtime id now refused; SIGNER_THREW leaks nothing
- attack 6: test/review-a1-block-arg.test.ts (DEFECT RA1-1, instanceof on a thrown Proxy); plain block log equal to main over 69 cases

- attack 7: test/review-a1-rpc.test.ts (DEFECT RA1-2 timeout overflow, RA1-3 node cap with whitespace frame)
- attack 5: test/review-a1-frozen.test.ts (own walk HOLDS over 30 files; DEFECT RA1-4 info, ByteReader methods open)
- attack 8: scratch probe, 3000 generated frames, branch rpcCall equals main answerOf(readOutsideJson) in every case
- attack 2: scratch probe, 4000 random and hostile inputs, 24 differences from main, all accessors on the signer or runtime id names (allowed by P4, P5)
- attack 9: source read; research tests 328 and 44 pass
- attack 10: test/review-a1-findings.test.ts, 6 HOLDS pass on branch, all 6 fail on main copy
- attack 3 and 4: test/review-a1-signer.test.ts, 14 HOLDS
- attack 12: scope holds (only imd-flop src, test, README, two script lines); src typechecks; changed and new tests typecheck but for errors that are on main too
- attack 11 running: /tmp/rev-a1-scripts/mutate.mjs over 25 mutants, results in /tmp/rev-a1-scripts/results.jsonl
- attack 11 done: 25 mutants; only M9f (FRAME_WRAPPER_CHARS 256 to 36) survives every test of the author and of the reviewer HOLDS
- whole npm test: 2411 tests, 5 failed (the five DEFECT tests), 2405 passed, 1 skipped
- GitHub checks of ac6cc08: build and offline tests red with the five DEFECT tests only (2403 passed, 3 skipped); viewer and spend-guard green
- report sent to the lead
Next: nothing; the report is done.
- mutations (11), words and scope (12, 13)
