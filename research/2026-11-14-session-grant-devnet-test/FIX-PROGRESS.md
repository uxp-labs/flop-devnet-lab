# Fix round of the G-19 review findings: progress

Brief: /mnt/user-data/outputs/briefs/2026-11-14-fix-g19-review-findings.md
Record: /mnt/user-data/outputs/reviews/2026-11-14-review-g19-batch-harness.md
Worktree /home/claude/wt-review-a1, branch claude/session-grant-devnet-test.
Run tests under setpriv (CLAUDE.md rule 5). Push after every commit.

## Done

- Fast forward to the reviewers' bc97e1f. node --test: 121 tests, 106 pass, 15 fail, the 15 DEFECT tests.

- F1: outcomes.mjs (rows and actionOf), next.mjs actOf, plan.mjs waitLines and leadStopLines, record-step stop --case. outcomes.test.mjs; RG19-8 HOLDS.
- F13: plan.mjs nextOutput and the CLI exit. word.test.mjs.
- F2: record-step.mjs recordSigned holds to the record call_hex and the call file; plan.mjs sign line names the record call. send-guard.test.mjs; RG19-3 HOLDS.
- F3: record-step recordSigned keeps send_sha256; plan.mjs checkedSend and FileStop (STOP, no send line). send-guard.test.mjs; RG19-4 HOLDS.
- F4: next.mjs entriesStops and planIds, before P0. entries.test.mjs; RG19-9 HOLDS.

## Next

- F5, then the rest.

## Points where a rule cannot be met as written (stop, for the lead)

- none yet
