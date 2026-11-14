# Progress of the builder (G-19 batch harness)

Brief: /mnt/user-data/outputs/briefs/2026-11-14-g19-grant-devnet-batch-harness.md
Plan and decisions B-1 to B-12: /mnt/user-data/outputs/reviews/2026-11-14-g19-grant-devnet-batch-plan.md
Worktree /home/claude/wt-review-a1, branch claude/session-grant-devnet-test. Push with
`git push -u origin claude/session-grant-devnet-test`. Run tests under setpriv (CLAUDE.md rule 5).

## Done

- X2 checked: no test or record pins flop-sign.mjs by bytes, sha256 or version. Only
  encoder sign-device.test.mjs S6 reads its text, for the keygen line, which is unchanged.
- H2: MAX_SESSION_BLOCKS 14400 to 86400 (one line), T7 in signer-guard.test.mjs. Fails without.
- lib.mjs, steps.json, fixtures.mjs (test keys from fixed seeds).
- session-reads.js (H4) and T3; tape.mjs, tool-run.mjs (H5, H6), T1 (rehearsal), T2.
- owner-call.mjs (H1, H3) and T4.
- next.mjs (H10), record-step.mjs (H13, H14), plan.mjs (H9, H12): written, smoke run only.

## Next

- T5: plan.mjs next over made records; a whole walk of the record-step commands.
- check.mjs (H15), test T6. Committed tapes loader (H16).
- README.md, plan.md (H17). T8 by hand in /tmp/g19.

## Open questions

- B-1 says "as its next version". The brief says one line and nothing else in that file. The
  file's head still says Version 3. Kept to one line; reported.
