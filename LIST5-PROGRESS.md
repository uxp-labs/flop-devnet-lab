# List 5 progress (builder, branch claude/observatory-list-5)

Removed in the commit before the last one.

## Done
- A1: research/2026-11-12-encoder-devnet-test/results.json copied byte for byte (sha256 a0c853cd...c7267f, checked before and after).
- A2: results.test.mjs, 4 tests (sha256, check word and exit 3, verdicts, T7 null). All 4 fail without results.json.
- A3: README section "The run of 2026-11-13", one line in "Not done here"; 2 tests in results.test.mjs hold its values to their fields and the balance sum.
- Move (lead's yes, 17:05 UTC): reviewedMetadata(spec, lines) in recorded-upgrade.ts with 3 tests in upgrade-recording.test.ts; RERUN_RESULTS, RERUN_SPEC_FIELD, rerunMetadata moved to recorded-rerun.ts.
- 9457ffd also holds a draft of list-5.ts by my error (git add -A). A force push of the corrected history was refused by the permission system; reported to the lead; local branch list5-fix holds it.
- B7, list 4 part: rerun-requests, rerun-recording, record-run read the fixture copies; the writer test moves to the list 5 test.
- B1 to B4, B6, B7: list-5.ts, recordings/requests-inputs.json (22 sources), requests-list.ts on list 5, test/encoder-requests.test.ts (18 tests), record-run sends the current list. Three encoder tests fail until the last commit.
- flop-sign.mjs keys run by hand (FLOP_SIGN_LIBS = built imd-flop): all five keys agree with the list's batch keys 3 to 7.

## Next
- B8: mutants for list-5.ts, README, RULES, REVIEW-LOG round 31.
- Remove this file; then requests.json alone in the last commit.

## Decided
- B9: the lead's rule of 16:55 UTC, option (b): requests-inputs.json comes with list-5.ts in an earlier commit; requests.json alone in the last commit; the tests that compare recordings/requests.json with list 5 fail until then, named in that commit's message.
