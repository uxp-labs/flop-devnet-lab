# Second review of the fix round: progress

Reviewer 2, branch `claude/review2-encoder-devnet-test`, from the builder's head `e18e725`.
No builder file is changed. My tests are `review2-*.test.mjs` in this folder.

## Findings so far

None proved yet. Reading done: sign-device, record, judge, record-step, pane-runner, explorer-reader, device-key, plan.

## Leads to prove next

- record-step start opens the key before its owner and runtime checks (Q4).
- sign-device opens the key before the runtime check of the encoder (Q4).
- send-file and record-step take any signed file of a research signer step (Q7).
- explorer reading: success that disagrees with the names is recorded (Q3).
- runner: a status word that is an Object.prototype name ends the watch (Q5).
- refused-at-submission of an immortal step: nextOf waits forever, no tool reaches the cleanup (Q2, Q8).
- check: "passed as planned, left" is not a C3 verdict; exit 1 covers four verdicts (Q9).

## Held

Nothing written down yet.
