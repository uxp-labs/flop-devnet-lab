# Review A1 progress

Started 2026-11-14 05:00 UTC. Reviewer of 27df5cc. Copies outside the repo: /tmp/rev-a1-main (main 3639e23), /tmp/rev-a1-at-<commit>.

Done:
- attack 1: scripts rerun on copies at 9676cd8 and 27df5cc reproduce both generated files; suite at 9676cd8 passes (1908 tests, 1 skipped)
- attack 3 and 4 probed (scratch, not committed): class instance signer and inherited runtime id now refused; SIGNER_THREW leaks nothing
- attack 6: test/review-a1-block-arg.test.ts (DEFECT RA1-1, instanceof on a thrown Proxy); plain block log equal to main over 69 cases

- attack 7: test/review-a1-rpc.test.ts (DEFECT RA1-2 timeout overflow, RA1-3 node cap with whitespace frame)
Next:
- answerOf over generated JSON (attack 8), frozen walk (5), era (9), findings (10), mutations (11), words and scope (12, 13)
