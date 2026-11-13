# Second review of the fix round: progress

Reviewer 2, branch `claude/review2-encoder-devnet-test`, from the builder's head `e18e725`.
No builder file is changed. My tests are `review2-*.test.mjs` in this folder.

## Findings so far (each test fails on e18e725)

1. Q4: the key file is opened before checks that refuse: sign-device before RUNTIME_UNKNOWN and
   the genesis; record-step start before the owner and runtime checks. `review2-key-order.test.mjs` (4).
2. Q7: send-file and record-step step take a signed/T2.json signed by the device, with a nonce gap
   and a transfer's call. `review2-record.test.mjs` (2).
3. Q3: an explorer reading whose success disagrees with its names is recorded, and the judge goes
   on. `review2-record.test.mjs` (3).
4. Q3 low: fromSs58 takes "1" + an SS58 text as the account. `review2-record.test.mjs` (1).
5. Q5: a status word that is an Object.prototype name ends the watch. `review2-pane.test.mjs` (5).
6. Q5: after finalized, a node that does not answer locate makes send wait forever (1).
7. Q5: a socket that opens after the deadline is written to after send said deadline (1).
8. Q5: ws.send that throws leaves the extrinsic marked as sent, outcome refused-at-submission (1).
9. Q6: the explorer reader follows a redirect to another host and reports found (1).

10. Q3 low: a stop after both renames of retire, nothing recorded: T3 is signed without --again
    and the new record forgets copy A. `review2-two-copies.test.mjs` (1).
11. Q8: T2 refused at submission: nextOf waits on T2 for ever, no tool reaches T9, FUND stays on
    the device; the stop table row says nothing is left. `review2-next.test.mjs` (2).
12. Q9: the top up left after T6 gives "passed as planned, left: ...", none of C3's verdicts,
    exit 1 like a wrong record. `review2-next.test.mjs` (1).

## Next (older list)

- Attack A: the bad minutes through sign-device with a test key (held tests), retire crash states.
- refused-at-submission of an immortal step: nextOf waits forever, T9 never reached (Q2, Q8).
- check: "passed as planned, left" and the exit codes (Q9).
- mutants of my own.

## Held (tests that pass)

- Attack A, through sign-device with a test key: deadline, connection-lost, ended with A in the
  pool; refused at submission; included and not recorded; never sent; explorer not yet; old reads
  again; a stop after the first rename of retire. No second copy with another nonce in any.
- nextOf over the 45 cells of table F; a cleanup step refused three times.
- No form of the seed on the key paths. `node plan.mjs md` changes nothing. The sha256s match.
- Mutants: review2-mutants.json, running against the builder's tests and mine.
