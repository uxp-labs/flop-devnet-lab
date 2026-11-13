# Review of piece F (final record of the encoder devnet test): progress

Reviewer branch claude/review-encoder-test-final-record, reviewing 4ab11aa (from main 3d4e297).

## Done
- Attack 1: third way decode with polkadot-api from the raw tape, nine blocks, every read and the events of all eight steps. Holds. observatory/test/review-final-thirdway.test.ts
- Attack 2: balances walked by fees and named movements. Holds. Frozen 0 at every block, flags the default top bit.
- Attack 12: fixture byte for byte with observatory-data 210688b; request list and inputs equal main and c153eb2.

## Next
- Attacks 3 to 11.

## Notes
- Adding a test file under observatory/test breaks test-counts.json on this branch: expected, not updated.
