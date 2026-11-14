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

Next:
- attack 7 (literals, P3; diff list, P10), then 8 to 10.
