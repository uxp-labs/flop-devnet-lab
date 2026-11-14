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
- F5 and F12: next.mjs showSays and activeAfter (cleanup revoke at a stop), G2 refused fee is a stop; plan.mjs prints the cleanup lines at such a stop. end-words.test.mjs; RG19-7 and RG19-15 HOLDS.
- F9: owner-call.mjs SIGNED_FIELDS, held in checkOwnerSigned. send-guard.test.mjs; RG19-2 HOLDS.
- F8 and F15: session-reads.js timed, whole, probe at a 32 byte hash only (new sha256 0e637aa57e603faf8d250d478e7efad877e8af36b6e90cfe5ef75fcb86a285f9; steps.json does not hold it, plan.md does). tape.mjs takes no_answer entries as unknown. pane-timers.test.mjs; RG19-1 HOLDS. session-reads.test T3 probe: its node is given a hash for the old block (setup only).
- F11: replay.mjs holds readings to sent_sha256 and block tapes to the record block. replay.test.mjs; RG19-14 HOLDS.
- F6: judge.mjs evidenceOf (outcome, error, fee, sources from events and readings; a derived word not theirs differs), G2 other error differs, passed only at the end. check.mjs exit words. records.mjs: a made failed step's error bytes are its named error (the form record-step writes); asPlanned takes G2's error. check.test T6 "G2 refused with another error": setup now asPlanned("refused", TooManySessions) (it edited only the derived word). judge-evidence.test.mjs; RG19-10, 12, 13 HOLDS.
- F10 (part): tape.mjs takeTape refuses two different answers, no answer, a read the time ended; tool-run.mjs atPhase. Setups given records at their phase (records.mjs forDevice, atR1Call; the delegate of made events is the record device): owner-signed, rehearsal T1, tool-run T2 passes and used twice, review-tape order, review-mutants M2, review-pane lying. tape-fresh.test.mjs; RG19-5, RG19-6 HOLDS.

## Next

- F7 as ruled again (no balance claim), F14, F16, words, the last steps.

- F10 node error half (the lead's rule, 13:03 UTC): tape.mjs refuses a node error in the tape or the metadata. rehearsal T1 A10 show replaced (refusal, nothing written, fresh tape taken) plus the null case; A2 and A10 tapes elsewhere set null as the walk does (rehearsal T1 A2 grant, A10 grant, R1 call at A10 and A2; record-step H3).

## Points where a rule could not be met as written (both ruled by the lead at 13:03 UTC)

- F7 (RG19-11, L1): not done. (1) lab.accountReads of pane-runner.js (the last batch's, byte for byte)
  relays { account, runtime, finalized, account_nonce }: no free balance, so no balance can come from
  the start read or an end read of it. (2) review-judge.test.mjs "HOLDS: both branches as planned
  pass" needs judge(asPlanned(...)).exit 0, and "DEFECT RG19-11" needs the batch claim of the same
  asPlanned("taken") (balances source "made") not to pass: under F6 (exit 0 only when every claim
  passes) both cannot hold.
- F10, the node error half: rehearsal.test.mjs "T1: session show at the revoked state (A10) ... so
  exit 1" runs the tool over an A10 tape that holds the node's error for the nonce and the breaker and
  asserts exit 1. A tape with a node error refused makes that assertion impossible.
