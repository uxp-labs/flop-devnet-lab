# List 5 progress (builder, branch claude/observatory-list-5)

Removed in the commit before the last one.

## Done
- A1: research/2026-11-12-encoder-devnet-test/results.json copied byte for byte, sha256 a0c853cd...c7267f checked before and after. node --test in that folder: 281 pass with it present.

- A2: results.test.mjs, 4 tests (sha256, check word and exit 3, verdicts, T7 null). All 4 fail without results.json.
- A3: README section "The run of 2026-11-13", one line in "Not done here"; 2 tests in results.test.mjs hold its values to their fields and the balance sum.
- Move (lead's yes, 17:05 UTC): reviewedMetadata(spec, lines) in recorded-upgrade.ts with 3 tests in upgrade-recording.test.ts (control, unknown spec, sha not on tape); RERUN_RESULTS, RERUN_SPEC_FIELD, rerunMetadata moved to recorded-rerun.ts; requests-list.ts still list 4. Affected files' tests pass, no name changed.

## Next
- B7 (list 4 part) done: rerun-requests, rerun-recording, record-run read the fixture copies; the writer test leaves rerun-requests for the list 5 test.
- B: list-5.ts, inputs and tests; test counts, mutants, README, RULES, REVIEW-LOG round 31; last commit requests.json alone.

## Decided
- B9: the lead's rule of 16:55 UTC, option (b): requests-inputs.json comes with list-5.ts in an earlier commit; requests.json alone in the last commit; the tests that compare recordings/requests.json with list 5 fail until then, named in that commit's message.
