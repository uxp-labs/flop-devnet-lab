# List 5 progress, second part (builder, branch claude/observatory-list-5)

Removed in the commit before the last one. The first part ended at ae31282 (reported).

## Done
- A4: run-2026-11-13/ (SHA256SUMS, calls/ 4, signed/ 16) copied byte for byte, sums checked before and after; run-files.test.mjs, 4 tests; README names the files for the mortal era and says what the folder is.

- B10 core: kind "block" in core.ts, one test in encoder-requests.test.ts, mutant core-block-asks-header; lists 3 and 4 tests unchanged and green.

- B10, B11: list-5.ts asks chain_getBlock at each step block and the birth hash of T3 to T6, 32 calls; inputs 30; encoder-requests.test.ts 21 tests; 5 new list5 mutants. Three encoder tests fail until the last commit.

## Next
- B10: core.ts kind "block" (own commit, lists 3 and 4 unchanged); list-5.ts gains chain_getBlock per step block and the birth hash for T3 to T6; inputs; 32 calls.
- B11: tests, mutants, counts; README, RULES, round 31 say 32 calls.
- Remove this file; requests.json alone in the last commit.

## Decided
- The lead's rules of 17:14 UTC (A4, B10 to B12) in the brief's added section.
