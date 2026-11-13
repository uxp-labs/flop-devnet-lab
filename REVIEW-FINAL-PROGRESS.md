# Review of piece F (final record of the encoder devnet test): progress

Reviewer branch claude/review-encoder-test-final-record, reviewing 4ab11aa (from main 3d4e297).

## Done
- Attack 1: third way decode with polkadot-api from the raw tape, nine blocks, every read and the events of all eight steps. Holds. observatory/test/review-final-thirdway.test.ts
- Attack 2: balances walked by fees and named movements. Holds. Frozen 0 at every block, flags the default top bit.
- Attack 12: fixture byte for byte with observatory-data 210688b; request list and inputs equal main and c153eb2.

- Attack 3: tape tampered in a copy (/tmp/rf/copy): every case fills nothing or is caught by B2, B5, meta tape_sha256 and the byte for byte test.
- Attacks 6, 7, 11, 12 hold (rerun refills 47292f1e..., no imd-flop import, tests load without imd-flop/node_modules).
- Attack 10: mutants/encoder-fill.json 17 of 17 killed. Three rules alive under the author's tests: observatory/test/review-final-mutants.test.ts, mutants/review-final.json (5 of 5 killed).
- Attack 8, 9: research/2026-11-12-encoder-devnet-test/review5-words.test.mjs. DEFECT W-1, W-2: What is not known is stale.

## Next
- Report.

## Notes
- Adding a test file under observatory/test breaks test-counts.json on this branch: expected, not updated.
