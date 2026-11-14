# Review R2 progress

Reviewer of claude/settle-recording-receipt-vector at ccca328.

Done:
- read the briefs, the plan, the record.
- attack 1 (P1): fixture files equal data branch e18a5e6 and the revision c307d89 (cmp); meta.json sums and run id hold.
- attack 2: imd-flop/test/review-r2-third-reading.test.ts, 10 HOLDS pass.
- attack 3: 13 layout mutants of transcript.ts (tools in /tmp/rev-r2/tools/p6.json); 9 killed by the vector test, 4 alive (upper half of u128); the other receipt test files kill all 4. RR2-1 (low) in imd-flop/test/review-r2-receipt-negatives.test.ts.
- attack 4: 8 HOLDS in the same file; negatives differ in the one thing named.
- attack 5: 17 tape mutants (/tmp/rev-r2/tools/fixmut.py), all killed by settle-recording.test.ts, each by its bullet's test.
- attack 6: 17 library mutants (/tmp/rev-r2/tools/lib.json); 6 rules alive under the branch's tests (L4a L4b L5a L5b L5c L7), 5 equivalent on the data (L3a L3c L6a L6b L8 L9: see report). RR2-2. imd-flop/test/review-r2-library-rules.test.ts, 7 HOLDS, kills all 6.
- attack 7: P3 no literal where a file gives it (folder names, 125, field names only); P10 file list clean, no push path.
- attack 8: SDK leaf and fold layout same (source only). 12 mutants of the turn test's lines (/tmp/rev-r2/tools/p8.json): 8 killed, 4 alive (turn index byte order, g_n upper half, fold side, no fold). RR2-3, RR2-4 in imd-flop/test/review-r2-turn-vector.test.ts.
- attack 9: P7 holds (review-p4-verify 9 passed, none skipped). RR2-5 (L1) and RR2-1 words in imd-flop/test/review-r2-words.test.ts, 3 DEFECT. Note RR2-6: escrow before equals escrow at the block, so 'before' is not told apart (held by settle-recording.test.ts line 266).

Next:
- attack 10 (whole runs: imd-flop npx vitest run; observatory npx vitest run with json report + test-report-check), then GitHub checks and report.
