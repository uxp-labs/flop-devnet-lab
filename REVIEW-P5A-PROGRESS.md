# Review P5a progress (reviewer)

Done:
- All thirteen attacks. Test files: imd-flop/test/review-p5a-{bytes,input,session,table,script}.test.ts, mutants imd-flop/test/review-p5a-mutants.json.
- Findings: RP5A-1 (global TextEncoder builds the one allow list), RP5A-2 (call name String() runs caller code), RP5A-3 (script sequence branch untested by author), RP5A-4 (checkShape bytesList line top level only), notes.
- Full npm test: 102 files, 2555 passed, 2 failed (the two DEFECT tests), 1 skipped.
- Harnesses in /tmp/rev-p5a/h (diff.mjs, reduce.mjs, table-mut.mjs, mutate.mjs).

Next:
- Read GitHub checks of the last commit and hand the report to the lead.
