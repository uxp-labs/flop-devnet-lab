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

- T5 next.test.mjs; record-flow.test.mjs (walk.mjs); record-step.test.mjs (refusals, lead stop).
- judge.mjs, check.mjs and T6. replay.mjs (H16) over rehearsal-run/ (written by node walk.mjs).
- README.md, plan.md (H17), plan.test.mjs (values, printed blocks, seat lines).
- T8 by hand in /tmp/g19/copy (git archive of HEAD, node_modules and dist linked): 49 rules
  undone, 49 killed (5 lived at first; tests added for each, then killed).

## Next

- The full check once at the end; read the GitHub checks of the last commit; the report.

## Open questions

- B-1 says "as its next version". The brief says one line and nothing else in that file. The
  file's head still says Version 3. Kept to one line; reported.
- The worst case by H12 (each revoke three tries) is 8 x MAX_FEE = 84467887880000000 raw, not
  B-10's 63350915910000000 (which counts two retries in all). Both are under the fence.
- research-offline.yml lists its folders by name: this folder is not run on GitHub until the
  lead adds a step (a builder does not change workflows).
- No tool records the owner's balances, so check.mjs's balance claim is "not run" at run time.
